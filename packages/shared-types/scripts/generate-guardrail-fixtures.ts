/**
 * Regenerates the Guardrail IR parity fixtures:
 *
 *   fixtures/hook-rule-vectors.json        IR → rendered hook rule → (tool, tool_input) → fires?
 *   fixtures/guardrail-ir/<name>.md        a SOP file whose front matter is rendered from IRs
 *   fixtures/guardrail-ir/<name>.expected.json
 *                                          the fields the proxy must parse out of that file
 *   fixtures/guardrail-layer-vectors.json  guardrails (status + IR) → what the control plane
 *                                          serves each layer → one tool call → the decision
 *                                          every enforcing layer must reach
 *
 * The expectations are authored here, by hand, from what the IR means. The
 * renderer produces the bytes. Every consumer — `matchSopRule`, the real
 * `PolicyClient.matchRule`, the emitted JS harness gate, and `sops.rs` — must
 * agree with the authored expectation; that agreement is the parity being
 * pinned. Before writing, this script checks its own expectations against a
 * plain evaluation of the rendered patterns and against the TypeScript
 * front-matter parser, so an authoring slip fails here, not in four suites.
 *
 * Run from the repository root:
 *   npx tsx packages/shared-types/scripts/generate-guardrail-fixtures.ts
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizeIr, validateGuardrailIr, type FrontMatterIr, type HookRuleIr } from '../src/guardrailIr.js'
import { frontMatterToIrs, parseFrontMatterEnforcing, proxyHookRule, renderFrontMatterLines, renderGuardrailSopFile, renderHookRule, renderHookRuleFrontMatterLine, splitFrontMatter } from '../src/guardrailRender.js'
import { GUARDRAIL_SOP_TITLE_PREFIX } from '../src/policyGuardrails.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'fixtures')
const IR_DIR = join(FIXTURES, 'guardrail-ir')
const GENERATED_BY = 'packages/shared-types/scripts/generate-guardrail-fixtures.ts'

// ─── Hook-rule vectors ────────────────────────────────────────────────

interface HookCase {
  tool: string
  toolInput: Record<string, unknown>
  fires: boolean
}

interface HookVector {
  name: string
  ir: HookRuleIr
  citation: { quote: string; sourceUrl: string | null }
  cases: HookCase[]
}

const WIKI = 'https://wiki.acme.dev/pages/viewpage.action?pageId='

const HOOK_VECTORS: HookVector[] = [
  {
    name: 'one tool, one literal',
    ir: { kind: 'hook_rule', title: 'Reviewed plan before terraform apply', tools: ['Bash'], argContains: ['terraform apply'] },
    citation: { quote: 'Engineers must never run terraform apply against production without a reviewed plan.', sourceUrl: `${WIKI}101` },
    cases: [
      { tool: 'Bash', toolInput: { command: 'terraform apply -auto-approve' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'cd infra && terraform apply' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'terraform plan' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'terraform\napply' }, fires: false },
      { tool: 'Write', toolInput: { command: 'terraform apply' }, fires: false },
      { tool: 'Bash', toolInput: {}, fires: false },
    ],
  },
  {
    name: 'two tools, a path literal',
    ir: { kind: 'hook_rule', title: 'Workflow files are owned by platform', tools: ['Write', 'Edit'], argContains: ['.github/workflows/'] },
    citation: { quote: 'Changes under .github/workflows/ are made only by the platform team.', sourceUrl: `${WIKI}102` },
    cases: [
      { tool: 'Write', toolInput: { file_path: '.github/workflows/ci.yml', content: 'x' }, fires: true },
      { tool: 'Edit', toolInput: { file_path: 'repo/.github/workflows/release.yml' }, fires: true },
      { tool: 'Write', toolInput: { file_path: 'src/index.ts' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'cat .github/workflows/ci.yml' }, fires: false },
      { tool: 'Writer', toolInput: { file_path: '.github/workflows/ci.yml' }, fires: false },
    ],
  },
  {
    name: 'dotted tool name, no literal',
    ir: { kind: 'hook_rule', title: 'terraform.apply is held', tools: ['terraform.apply'] },
    citation: { quote: 'The terraform.apply tool is not to be used from an agent session.', sourceUrl: null },
    cases: [
      { tool: 'terraform.apply', toolInput: {}, fires: true },
      { tool: 'terraform.apply', toolInput: { anything: 'at all' }, fires: true },
      { tool: 'terraformXapply', toolInput: {}, fires: false },
      { tool: 'terraform.apply.now', toolInput: {}, fires: false },
    ],
  },
  {
    name: 'contains and not-contains',
    ir: { kind: 'hook_rule', title: 'kubectl apply must be a dry run', tools: ['Bash'], argContains: ['kubectl apply'], argNotContains: ['--dry-run'] },
    citation: { quote: 'kubectl apply from an agent session must use --dry-run.', sourceUrl: `${WIKI}103` },
    cases: [
      { tool: 'Bash', toolInput: { command: 'kubectl apply -f deploy.yaml' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'kubectl apply --dry-run=client -f deploy.yaml' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'kubectl get pods' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'kubectl apply -f a.yaml', description: 'not a --dry-run' }, fires: false },
      // The excluded fragment before the required one: an unanchored exclusion
      // fired here, because a search that starts past `--dry-run` never sees it.
      { tool: 'Bash', toolInput: { description: 'a --dry-run first', command: 'kubectl apply -f a.yaml' }, fires: false },
    ],
  },
  {
    name: 'mcp tool, any input',
    ir: { kind: 'hook_rule', title: 'Issues are filed by humans', tools: ['mcp__github__create_issue'] },
    citation: { quote: 'Agents do not file GitHub issues; a human files them after review.', sourceUrl: `${WIKI}104` },
    cases: [
      { tool: 'mcp__github__create_issue', toolInput: { title: 'x' }, fires: true },
      { tool: 'mcp__github__create_issue', toolInput: {}, fires: true },
      { tool: 'mcp__github__create_pull_request', toolInput: {}, fires: false },
      { tool: 'mcp__github__create_issue_comment', toolInput: {}, fires: false },
    ],
  },
  {
    name: 'two literals, order-free',
    ir: { kind: 'hook_rule', title: 'No force push', tools: ['Bash'], argContains: ['git push', '--force'] },
    citation: { quote: 'A force push (git push --force) to any shared branch is prohibited.', sourceUrl: `${WIKI}105` },
    cases: [
      { tool: 'Bash', toolInput: { command: 'git push --force origin main' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'git push origin main --force-with-lease' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'git push origin main' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'rm --force x && git push' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'git pull --force' }, fires: false },
    ],
  },
  {
    name: 'literal full of regex metacharacters',
    ir: { kind: 'hook_rule', title: 'No in-place edits across every config', tools: ['Bash'], argContains: ['sed -i.bak s/x/y/ *.conf'] },
    citation: { quote: 'Bulk in-place rewrites such as sed -i.bak s/x/y/ *.conf are made through the config repository, not on hosts.', sourceUrl: `${WIKI}106` },
    cases: [
      { tool: 'Bash', toolInput: { command: 'sed -i.bak s/x/y/ *.conf' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'cd /etc/app && sed -i.bak s/x/y/ *.conf' }, fires: true },
      { tool: 'Bash', toolInput: { command: 'sed -i.bak s/x/y/ app.conf' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'sed -iXbak s/x/y/ *.conf' }, fires: false },
      { tool: 'Bash', toolInput: { command: 'sed -i.bak s/x/y/ aaconf' }, fires: false },
    ],
  },
  {
    name: 'literal with a single quote and a colon',
    ir: { kind: 'hook_rule', title: 'Latest tags are not deployable', tools: ['Bash'], argContains: ["image: 'latest'"] },
    citation: { quote: "A manifest declaring image: 'latest' may not be applied.", sourceUrl: `${WIKI}107` },
    cases: [
      { tool: 'Bash', toolInput: { command: "kubectl apply -f - <<< \"image: 'latest'\"" }, fires: true },
      { tool: 'Bash', toolInput: { command: "grep image: 'v1.2.3'" }, fires: false },
    ],
  },
]

function assertValid(ir: unknown, where: string): void {
  const v = validateGuardrailIr(ir)
  if (!v.ok) throw new Error(`${where}: IR is invalid — ${v.reason}`)
}

/** Exactly `matchSopRule`: both patterns tested as written, the input serialised the way the gates serialise it. */
function evaluates(rendered: { toolPattern: string; argPattern?: string }, c: HookCase): boolean {
  const toolOk = new RegExp(rendered.toolPattern).test(c.tool)
  const argOk = rendered.argPattern === undefined || new RegExp(rendered.argPattern).test(JSON.stringify(c.toolInput ?? {}))
  return toolOk && argOk
}

const vectors = HOOK_VECTORS.map((v) => {
  assertValid(v.ir, v.name)
  const rendered = renderHookRule(v.ir, v.citation)
  if (rendered.toolPattern.length === 0) throw new Error(`${v.name}: empty toolPattern`)
  for (const c of v.cases) {
    const got = evaluates(rendered, c)
    if (got !== c.fires) {
      throw new Error(`${v.name}: ${JSON.stringify(c)} evaluates to ${got} under the rendered patterns — the authored expectation or the renderer is wrong`)
    }
  }
  if (!v.cases.some((c) => c.fires) || !v.cases.some((c) => !c.fires)) throw new Error(`${v.name}: a vector needs at least one firing and one non-firing case`)
  return { name: v.name, ir: v.ir, citation: v.citation, rendered, cases: v.cases }
})

mkdirSync(FIXTURES, { recursive: true })
writeFileSync(join(FIXTURES, 'hook-rule-vectors.json'), `${JSON.stringify({ generatedBy: GENERATED_BY, vectors }, null, 2)}\n`)

// ─── Front-matter fixtures ────────────────────────────────────────────

interface IrFixture {
  name: string
  title: string
  irs: FrontMatterIr[]
  shadow: boolean
  source: string | null
  quote: string | null
}

interface ExpectedFrontMatter {
  deny_tools: string[]
  review_before: string[]
  requires_before: Array<{ first: string; then: string; adjacent: boolean }>
  forbid_after: Array<{ first: string; then: string; adjacent: boolean }>
  max_calls: Array<{ token: string; limit: number }>
  forbid_with: Array<{ taint: string; token: string }>
  roles: string[]
  mode: 'shadow' | 'enforce'
}

const IR_FIXTURES: IrFixture[] = [
  {
    name: '01-deny-and-review',
    title: 'Deployers use approved tools',
    irs: [
      { kind: 'deny_tools', tools: ['WebFetch', 'Bash'], roles: ['deployer'] },
      { kind: 'review_before', tokens: ['action:deploy'], roles: ['deployer'] },
    ],
    shadow: true,
    source: `${WIKI}201`,
    quote: 'Deployers may not use Bash or WebFetch, and every deploy is reviewed by a second engineer first.',
  },
  {
    name: '02-ordering',
    title: 'Sequence rules',
    irs: [
      { kind: 'requires_before', first: 'action:run_tests', then: 'action:deploy' },
      { kind: 'forbid_after', first: 'action:secret_read', then: 'action:http_post' },
      { kind: 'forbid_after', first: 'action:pii_export', then: 'action:db_write' },
    ],
    shadow: false,
    source: `${WIKI}202`,
    quote: 'Tests run before every deploy. A session that has read a secret does not post over HTTP.',
  },
  {
    name: '03-counts-and-taint',
    title: 'Bounds and taint',
    irs: [
      { kind: 'max_calls', token: 'action:deploy', limit: 1 },
      { kind: 'max_calls', token: 'Bash', limit: 20 },
      { kind: 'forbid_with', taint: 'secrets()', token: 'action:http_post' },
      { kind: 'forbid_with', taint: 'pii()', token: 'action:http_post' },
    ],
    shadow: true,
    source: null,
    quote: null,
  },
  {
    name: '04-informational-keys',
    title: 'Only the deny line enforces',
    irs: [{ kind: 'deny_tools', tools: ['kubectl'] }],
    shadow: true,
    source: `${WIKI}204`,
    quote: 'kubectl is not available to agent sessions.',
  },
  {
    name: '05-roles-union',
    title: 'Release engineering',
    irs: [
      { kind: 'deny_tools', tools: ['WebFetch'], roles: ['sre', 'deployer'] },
      { kind: 'max_calls', token: 'action:release', limit: 1, roles: ['sre', 'deployer'] },
      { kind: 'requires_before', first: 'action:run_tests', then: 'action:release', roles: ['sre', 'deployer'] },
    ],
    shadow: false,
    source: `${WIKI}205`,
    quote: 'SREs and deployers cut at most one release per session, after the test suite.',
  },
]

function expectedFromIrs(irs: readonly FrontMatterIr[], shadow: boolean): ExpectedFrontMatter {
  const e: ExpectedFrontMatter = { deny_tools: [], review_before: [], requires_before: [], forbid_after: [], max_calls: [], forbid_with: [], roles: [], mode: shadow ? 'shadow' : 'enforce' }
  const roles = new Set<string>()
  for (const ir of irs) {
    for (const r of ir.roles ?? []) roles.add(r.toLowerCase())
    switch (ir.kind) {
      case 'deny_tools':
        e.deny_tools.push(...ir.tools)
        break
      case 'review_before':
        e.review_before.push(...ir.tokens)
        break
      case 'requires_before':
        e.requires_before.push({ first: ir.first, then: ir.then, adjacent: false })
        break
      case 'forbid_after':
        e.forbid_after.push({ first: ir.first, then: ir.then, adjacent: false })
        break
      case 'max_calls':
        e.max_calls.push({ token: ir.token, limit: ir.limit })
        break
      case 'forbid_with':
        e.forbid_with.push({ taint: ir.taint, token: ir.token })
        break
    }
  }
  e.deny_tools = [...new Set(e.deny_tools)].sort()
  e.review_before = [...new Set(e.review_before)].sort()
  e.roles = [...roles].sort()
  const byJson = <T>(xs: T[]): T[] => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  e.requires_before = byJson(e.requires_before)
  e.forbid_after = byJson(e.forbid_after)
  e.max_calls = byJson(e.max_calls)
  e.forbid_with = byJson(e.forbid_with)
  return e
}

mkdirSync(IR_DIR, { recursive: true })
for (const f of readdirSync(IR_DIR)) {
  if (f.endsWith('.md') || f.endsWith('.expected.json')) unlinkSync(join(IR_DIR, f))
}

for (const fx of IR_FIXTURES) {
  for (const ir of fx.irs) assertValid(ir, fx.name)
  const lines = renderFrontMatterLines(fx.irs)
  if (lines.length === 0) throw new Error(`${fx.name}: rendered no front matter`)
  // The same function the control plane projects a front-matter guardrail
  // with, so the cargo fixture test covers the projection byte for byte.
  const md = renderGuardrailSopFile({
    lines,
    title: fx.title,
    body: `Generated by ${GENERATED_BY} from ${fx.name}.expected.json. Do not edit by hand.${fx.quote ? `\n\n> ${fx.quote}` : ''}`,
    sourceUrl: fx.source,
    cite: fx.quote ? createHash('sha256').update(fx.quote.normalize('NFC')).digest('hex') : null,
    shadow: fx.shadow,
  })

  // The TypeScript mirror of the proxy parser must read the authored expectation back.
  const { front } = splitFrontMatter(md)
  const parsed = parseFrontMatterEnforcing(front)
  if (parsed.errors.length > 0) throw new Error(`${fx.name}: the mirror parser reports ${parsed.errors.join('; ')}`)
  const expected = expectedFromIrs(fx.irs, fx.shadow)
  const back = frontMatterToIrs(parsed)
  const want = [...new Set(fx.irs.map(canonicalizeIr))].sort()
  const got = [...new Set(back.map(canonicalizeIr))].sort()
  if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`${fx.name}: parse(render(irs)) ≠ irs\n want ${JSON.stringify(want)}\n got  ${JSON.stringify(got)}`)
  if ((parsed.mode === 'shadow') !== fx.shadow) throw new Error(`${fx.name}: mode mismatch`)

  writeFileSync(join(IR_DIR, `${fx.name}.md`), md)
  writeFileSync(join(IR_DIR, `${fx.name}.expected.json`), `${JSON.stringify({ generatedBy: GENERATED_BY, ...expected }, null, 2)}\n`)
}

// ─── Layer vectors: one decision, every layer ─────────────────────────
//
// A hook-rule guardrail is enforced by the local hook gates (the emitted
// harness gates, gate-js, intutic-clawde), the MCP proxy, the hosted hook gate
// (and the AgentCore check, which shares its evaluator) and the LLM proxy.
// Each vector is a set of guardrails, what the control plane serves for them
// — the rendered rules `GET /api/v1/sop/rules` and `/policy/resolve` append,
// and the SOP entries `GET /api/v1/workspace/sops-policy` appends for the
// proxy — one tool call, and the decision. `block` names the ENFORCING rule
// that refuses the call; `warn` names the SHADOW rule that would have, while
// the call goes through; `allow` names none. A refusal wins over a shadow
// match wherever the rules sit in the list. No vector has two rules of the
// deciding severity matching one call, so the named rule is never a question
// of list order.

type LayerDecision = 'block' | 'warn' | 'allow'

interface LayerGuardrail {
  guardrailId: string
  status: 'SHADOW' | 'ENFORCING'
  ir: HookRuleIr
  citation: { quote: string; sourceUrl: string | null }
}

interface LayerVector {
  name: string
  guardrails: LayerGuardrail[]
  role: string
  toolCall: { tool: string; toolInput: Record<string, unknown> }
  expected: { decision: LayerDecision; ruleId: string | null }
}

const TF: HookRuleIr = { kind: 'hook_rule', title: 'Reviewed plan before terraform apply', tools: ['Bash'], argContains: ['terraform apply'] }
const TF_CITE = { quote: 'Engineers must never run terraform apply against production without a reviewed plan.', sourceUrl: `${WIKI}301` }
const PUSH: HookRuleIr = { kind: 'hook_rule', title: 'Pushes are reviewed', tools: ['Bash'], argContains: ['git push'] }
const PUSH_CITE = { quote: 'Every git push from an agent session is reviewed.', sourceUrl: `${WIKI}302` }
const FORCE: HookRuleIr = { kind: 'hook_rule', title: 'No force push', tools: ['Bash'], argContains: ['git push', '--force'] }
const FORCE_CITE = { quote: 'A force push (git push --force) to any shared branch is prohibited.', sourceUrl: `${WIKI}303` }
const DRY: HookRuleIr = { kind: 'hook_rule', title: 'kubectl apply must be a dry run', tools: ['Bash'], argContains: ['kubectl apply'], argNotContains: ['--dry-run'] }
const DRY_CITE = { quote: 'kubectl apply from an agent session must use --dry-run.', sourceUrl: `${WIKI}304` }
const RMRF: HookRuleIr = { kind: 'hook_rule', title: 'No recursive force delete', tools: ['Bash'], argContains: ['rm -rf'] }
const RMRF_CITE = { quote: 'Agents never run rm -rf on a workstation.', sourceUrl: null }
const ISSUE: HookRuleIr = { kind: 'hook_rule', title: 'Issues are filed by humans', tools: ['mcp__github__create_issue'] }
const ISSUE_CITE = { quote: 'Agents do not file GitHub issues; a human files them after review.', sourceUrl: `${WIKI}305` }
const WORKFLOWS: HookRuleIr = { kind: 'hook_rule', title: 'Workflow files are owned by platform', tools: ['Write', 'Edit'], argContains: ['.github/workflows/'] }
const WORKFLOWS_CITE = { quote: 'Changes under .github/workflows/ are made only by the platform team.', sourceUrl: `${WIKI}306` }
const DOTENV: HookRuleIr = { kind: 'hook_rule', title: 'Environment files stay unread', tools: ['Read'], argContains: ['.env'] }
const DOTENV_CITE = { quote: 'Agents do not read .env files; secrets come from the vault.', sourceUrl: `${WIKI}307` }
const PRODDB: HookRuleIr = { kind: 'hook_rule', title: 'No direct production database sessions', tools: ['Bash'], argContains: ['prod-db'] }
const PRODDB_CITE = { quote: 'Nobody opens a session against prod-db from an agent.', sourceUrl: `${WIKI}308` }

const gr = (guardrailId: string, status: LayerGuardrail['status'], ir: HookRuleIr, citation: LayerGuardrail['citation']): LayerGuardrail => ({ guardrailId, status, ir, citation })
const call = (tool: string, toolInput: Record<string, unknown>) => ({ tool, toolInput })
const blocks = (ruleId: string) => ({ decision: 'block' as const, ruleId })
const warns = (ruleId: string) => ({ decision: 'warn' as const, ruleId })
const allows = { decision: 'allow' as const, ruleId: null }

const LAYER_VECTORS: LayerVector[] = [
  { name: 'an enforcing literal refuses the call', guardrails: [gr('pgr_lv01', 'ENFORCING', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'terraform apply -auto-approve' }), expected: blocks('guardrail.pgr_lv01') },
  { name: 'an enforcing literal lets another command through', guardrails: [gr('pgr_lv02', 'ENFORCING', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'terraform plan' }), expected: allows },
  { name: 'a shadow literal flags and allows', guardrails: [gr('pgr_lv03', 'SHADOW', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'cd infra && terraform apply' }), expected: warns('guardrail.pgr_lv03') },
  { name: 'a refusal wins over an earlier shadow match', guardrails: [gr('pgr_lv04a', 'SHADOW', PUSH, PUSH_CITE), gr('pgr_lv04b', 'ENFORCING', FORCE, FORCE_CITE)], role: 'developer', toolCall: call('Bash', { command: 'git push --force origin main' }), expected: blocks('guardrail.pgr_lv04b') },
  { name: 'the shadow match stands when the refusal does not fire', guardrails: [gr('pgr_lv05a', 'SHADOW', PUSH, PUSH_CITE), gr('pgr_lv05b', 'ENFORCING', FORCE, FORCE_CITE)], role: 'developer', toolCall: call('Bash', { command: 'git push origin main' }), expected: warns('guardrail.pgr_lv05a') },
  { name: 'a refusal wins over a later shadow match', guardrails: [gr('pgr_lv06a', 'ENFORCING', FORCE, FORCE_CITE), gr('pgr_lv06b', 'SHADOW', PUSH, PUSH_CITE)], role: 'developer', toolCall: call('Bash', { command: 'git push origin main --force' }), expected: blocks('guardrail.pgr_lv06a') },
  { name: 'an exclusion lets the dry run through', guardrails: [gr('pgr_lv07', 'ENFORCING', DRY, DRY_CITE)], role: 'developer', toolCall: call('Bash', { command: 'kubectl apply --dry-run=client -f deploy.yaml' }), expected: allows },
  { name: 'an exclusion refuses without it', guardrails: [gr('pgr_lv08', 'ENFORCING', DRY, DRY_CITE)], role: 'developer', toolCall: call('Bash', { command: 'kubectl apply -f deploy.yaml' }), expected: blocks('guardrail.pgr_lv08') },
  { name: 'an exclusion anywhere in the input counts', guardrails: [gr('pgr_lv09', 'ENFORCING', DRY, DRY_CITE)], role: 'developer', toolCall: call('Bash', { description: 'a --dry-run first', command: 'kubectl apply -f a.yaml' }), expected: allows },
  { name: 'tool names are matched exactly, case included', guardrails: [gr('pgr_lv10', 'ENFORCING', RMRF, RMRF_CITE)], role: 'developer', toolCall: call('bash', { command: 'rm -rf build' }), expected: allows },
  { name: 'a longer tool name is another tool', guardrails: [gr('pgr_lv11', 'ENFORCING', RMRF, RMRF_CITE)], role: 'developer', toolCall: call('BashOutput', { command: 'rm -rf build' }), expected: allows },
  { name: 'a name-only rule refuses any input', guardrails: [gr('pgr_lv12', 'ENFORCING', ISSUE, ISSUE_CITE)], role: 'developer', toolCall: call('mcp__github__create_issue', { title: 'flaky test', body: 'see CI' }), expected: blocks('guardrail.pgr_lv12') },
  { name: 'a name-only rule ignores a neighbouring tool', guardrails: [gr('pgr_lv13', 'ENFORCING', ISSUE, ISSUE_CITE)], role: 'developer', toolCall: call('mcp__github__create_issue_comment', { body: 'x' }), expected: allows },
  { name: 'two tools, one path literal', guardrails: [gr('pgr_lv14', 'ENFORCING', WORKFLOWS, WORKFLOWS_CITE)], role: 'developer', toolCall: call('Edit', { file_path: 'repo/.github/workflows/release.yml', old_string: 'a', new_string: 'b' }), expected: blocks('guardrail.pgr_lv14') },
  { name: 'escaped quotes do not hide a literal', guardrails: [gr('pgr_lv15', 'ENFORCING', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'bash -c "terraform apply"' }), expected: blocks('guardrail.pgr_lv15') },
  { name: 'a newline between the words is not the literal', guardrails: [gr('pgr_lv16', 'ENFORCING', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'terraform\napply' }), expected: allows },
  { name: 'an empty input under a literal rule', guardrails: [gr('pgr_lv17', 'ENFORCING', TF, TF_CITE)], role: 'developer', toolCall: call('Bash', {}), expected: allows },
  { name: 'a caller with no role is refused like any other', guardrails: [gr('pgr_lv18', 'ENFORCING', TF, TF_CITE)], role: '', toolCall: call('Bash', { command: 'terraform apply' }), expected: blocks('guardrail.pgr_lv18') },
  { name: 'an admin is refused like any other', guardrails: [gr('pgr_lv19', 'ENFORCING', TF, TF_CITE)], role: 'admin', toolCall: call('Bash', { command: 'terraform apply' }), expected: blocks('guardrail.pgr_lv19') },
  { name: 'non-ASCII input around a literal', guardrails: [gr('pgr_lv20', 'ENFORCING', RMRF, RMRF_CITE)], role: 'developer', toolCall: call('Bash', { command: 'rm -rf ./données/été' }), expected: blocks('guardrail.pgr_lv20') },
  { name: 'two enforcing rules: the one that matches decides', guardrails: [gr('pgr_lv21a', 'ENFORCING', TF, TF_CITE), gr('pgr_lv21b', 'ENFORCING', PUSH, PUSH_CITE)], role: 'developer', toolCall: call('Bash', { command: 'git push origin feature' }), expected: blocks('guardrail.pgr_lv21b') },
  { name: 'a literal in a nested value', guardrails: [gr('pgr_lv22', 'ENFORCING', PRODDB, PRODDB_CITE)], role: 'developer', toolCall: call('Bash', { command: 'psql', env: { PGHOST: 'prod-db.internal', PGPORT: 5432 } }), expected: blocks('guardrail.pgr_lv22') },
  { name: 'a rule on Read', guardrails: [gr('pgr_lv23', 'ENFORCING', DOTENV, DOTENV_CITE)], role: 'developer', toolCall: call('Read', { file_path: '/repo/.env' }), expected: blocks('guardrail.pgr_lv23') },
  { name: 'a shadow rule that does not match', guardrails: [gr('pgr_lv24', 'SHADOW', DOTENV, DOTENV_CITE)], role: 'developer', toolCall: call('Read', { file_path: '/repo/README.md' }), expected: allows },
]

/** Exactly what `listProjectedHookRules` serves for these guardrails, in proposal order. */
function servedHookRules(gs: readonly LayerGuardrail[]) {
  return gs.map((x) => {
    const rendered = renderHookRule(x.ir, x.citation)
    return {
      id: `guardrail.${x.guardrailId}`,
      toolPattern: rendered.toolPattern,
      ...(rendered.argPattern ? { argPattern: rendered.argPattern } : {}),
      action: x.status === 'ENFORCING' ? ('block' as const) : ('warn' as const),
      reason: rendered.reason,
      origin: 'guardrail' as const,
    }
  })
}

/** The SOP entries `listProjectedGuardrailSops` serves the LLM proxy for these guardrails. */
function servedSops(gs: readonly LayerGuardrail[]) {
  return gs.map((x) => {
    const rendered = renderHookRule(x.ir, x.citation)
    const line = renderHookRuleFrontMatterLine(proxyHookRule(`guardrail.${x.guardrailId}`, x.ir, rendered.reason))
    return {
      title: `${GUARDRAIL_SOP_TITLE_PREFIX}${x.guardrailId} hook_rule: ${[...new Set(x.ir.tools)].sort().join(', ')}`,
      markdownContent: renderGuardrailSopFile({
        lines: line,
        title: x.ir.title,
        body: `> ${x.citation.quote}\n\nProjected from the cited policy passage above; the hook_rule line is what the proxy enforces.`,
        sourceUrl: x.citation.sourceUrl,
        cite: createHash('sha256').update(x.citation.quote.normalize('NFC')).digest('hex'),
        shadow: x.status === 'SHADOW',
      }),
      scope: 'workspace' as const,
    }
  })
}

/** Severity first, then list order: the decision every layer must reach. */
function decideLayer(matches: ReadonlyArray<{ id: string; action: 'block' | 'warn' }>): { decision: LayerDecision; ruleId: string | null } {
  const block = matches.find((m) => m.action === 'block')
  if (block) return { decision: 'block', ruleId: block.id }
  const warn = matches.find((m) => m.action === 'warn')
  return warn ? { decision: 'warn', ruleId: warn.id } : { decision: 'allow', ruleId: null }
}

const layerVectors = LAYER_VECTORS.map((v) => {
  for (const x of v.guardrails) assertValid(x.ir, `${v.name} / ${x.guardrailId}`)
  const hookRules = servedHookRules(v.guardrails)
  const sops = servedSops(v.guardrails)
  const haystack = JSON.stringify(v.toolCall.toolInput ?? {})
  const patternFires = (r: (typeof hookRules)[number]) => new RegExp(r.toolPattern).test(v.toolCall.tool) && (r.argPattern === undefined || new RegExp(r.argPattern).test(haystack))
  // The rendered regexes, as every hook gate tests them.
  const byPattern = decideLayer(hookRules.filter(patternFires))
  // The IR literals, as the LLM proxy tests them, read back from the served line.
  const byLiteral = decideLayer(
    sops.flatMap((s, i) => {
      const line = s.markdownContent.split('\n').find((l) => l.startsWith('hook_rule:'))
      if (!line) throw new Error(`${v.name}: served SOP ${i} carries no hook_rule line`)
      const r = JSON.parse(line.slice('hook_rule:'.length)) as { id: string; tools: string[]; argContains: string[]; argNotContains: string[] }
      const fires = r.tools.includes(v.toolCall.tool) && r.argContains.every((l) => haystack.includes(l)) && !r.argNotContains.some((l) => haystack.includes(l))
      return fires ? [{ id: r.id, action: v.guardrails[i]!.status === 'ENFORCING' ? ('block' as const) : ('warn' as const) }] : []
    }),
  )
  for (const [how, got] of [['the rendered patterns', byPattern], ['the IR literals', byLiteral]] as const) {
    if (got.decision !== v.expected.decision || got.ruleId !== v.expected.ruleId) {
      throw new Error(`${v.name}: ${how} decide ${JSON.stringify(got)}, the vector says ${JSON.stringify(v.expected)}`)
    }
  }
  const decidingAction = v.expected.decision === 'block' ? 'block' : 'warn'
  const deciding = v.expected.decision === 'allow' ? [] : hookRules.filter((r) => r.action === decidingAction && patternFires(r))
  if (deciding.length > 1) throw new Error(`${v.name}: ${deciding.length} rules of the deciding severity match — the named rule would depend on list order`)
  return { name: v.name, guardrails: v.guardrails, served: { hookRules, sops }, role: v.role, toolCall: v.toolCall, expected: v.expected }
})
for (const d of ['block', 'warn', 'allow'] as const) {
  if (!layerVectors.some((v) => v.expected.decision === d)) throw new Error(`the layer vectors have no ${d} case`)
}
writeFileSync(join(FIXTURES, 'guardrail-layer-vectors.json'), `${JSON.stringify({ generatedBy: GENERATED_BY, vectors: layerVectors }, null, 2)}\n`)

console.log(`wrote ${vectors.length} hook-rule vectors (${vectors.reduce((n, v) => n + v.cases.length, 0)} cases), ${IR_FIXTURES.length} front-matter fixtures and ${layerVectors.length} layer vectors`)
