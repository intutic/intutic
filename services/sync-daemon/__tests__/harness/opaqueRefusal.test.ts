/**
 * The OPAQUE intervention mode in the emitted gates.
 *
 * An OPAQUE workspace's snapshot carries the `@intervention_mode` record, and
 * every gate that refuses on workspace policy then tells the agent
 * `OPAQUE_REFUSAL_MESSAGE` instead of the rule: on stderr, in a JSON
 * decision's reason (with `ruleId: null`), in a thrown error. The code and the
 * exit status are unchanged, and the audit line keeps the full reason. The
 * same calls against a TRANSPARENT snapshot still name the rule. Every
 * snapshot is written by the real `writePolicySnapshot`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { encodeInterventionModeRecord, OPAQUE_REFUSAL_MESSAGE } from '@intutic/shared-types'
import { toRulesLine } from '../../src/harness/gateBody.js'
import { GATES, type GateEntry } from './gateRegistry.js'
import { writePolicySnapshot, SNAPSHOT_RULES, SNAPSHOT_JSON, type ResolvedPolicy } from '../../src/lib/policySnapshot.js'

const home = mkdtempSync(join(tmpdir(), 'intutic-opaque-'))
const roots = new Map<string, string>()
const snapshots: Record<string, string> = {}

const policy = (interventionMode: string): ResolvedPolicy => ({
  workspaceId: 'ws_test',
  interventionMode,
  sopRules: [{ id: 's_edit', toolPattern: 'Edit', action: 'block', reason: 'no edits to the billing module' }],
  mcpAllowedServers: ['github', 'pastebin'],
  sqlDropStrictBlock: false,
  ssoGroupPolicy: { highRiskTools: ['Bash'], requiredGroups: ['sre'], requireOboFor: [] },
  principal: { memberId: 'mem_1', ssoGroups: [] },
  mcpRegistry: { defaultPolicy: 'allow', approvedServers: [], blockedServers: ['pastebin'], heldServers: [], disabledTools: {} },
})

const CHOSEN = ['hermes', 'claudeCode', 'cline', 'grok', 'antigravityCli', 'openWebui', 'n8n'] as const
const gates = Object.fromEntries(
  CHOSEN.map((n) => [n, GATES.find((g) => g.name === n)]).filter((e): e is [string, GateEntry] => e[1] !== undefined),
)

beforeAll(async () => {
  for (const mode of ['TRANSPARENT', 'OPAQUE', 'SILENT_LOG']) {
    const dir = join(home, `snapshot-${mode}`)
    await writePolicySnapshot(policy(mode), dir, ['NotebookEdit'])
    snapshots[mode] = join(dir, SNAPSHOT_RULES)
  }
  for (const g of Object.values(gates)) {
    const root = join(home, g.name)
    mkdirSync(root, { recursive: true })
    process.env.HOME = root
    process.env.USERPROFILE = root
    await g.invoke(await import(g.module), root)
    roots.set(g.name, root)
  }
}, 120_000)

afterAll(() => {
  spawnSync('chflags', ['-R', 'nouchg', home])
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not worth failing a run over.
  }
})

/** Async spawn, never spawnSync: see the note in generatedGateBehaviour.test.ts. */
function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin = '',
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? -1, stdout, stderr }) })
    child.stdin.end(stdin)
  })
}

function envFor(g: GateEntry, mode: string): NodeJS.ProcessEnv {
  const root = roots.get(g.name)!
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    INTUTIC_SNAPSHOT_RULES: snapshots[mode],
    INTUTIC_REVIEW_REQUESTS: join(root, 'holds.jsonl'),
  }
}

const call = (tool: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ tool_name: tool, tool_input: input, session_id: 'sess_opaque' })

/** Every hook event line under a gate's root. */
function events(g: GateEntry): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          try {
            const ev = JSON.parse(line) as Record<string, unknown>
            if (typeof ev['event'] === 'string') out.push(ev)
          } catch { /* not an event line */ }
        }
      }
    }
  }
  walk(roots.get(g.name)!)
  return out
}

/** Policy refusals: [code, stdin, the rule id, a fragment of the rule's reason]. */
const POLICY_CASES: Array<[string, string, string, string]> = [
  ['SNAPSHOT', call('Edit'), 'sop.s_edit', 'no edits to the billing module'],
  ['SSO_GROUP', call('Bash', { command: 'ls' }), 'sso_group.high_risk.Bash', 'sre'],
  ['HELD', call('NotebookEdit'), 'sop.local.review_before.NotebookEdit', 'review_before'],
  ['SERVER_BLOCKED', call('mcp__pastebin__paste'), 'mcp_registry.pastebin', 'pastebin'],
  ['SERVER_NOT_ALLOWED', call('mcp__other__query'), 'mcp_allowlist', 'allowlist'],
  ['BUILT_IN_RULE', call('Write', { file_path: '.claude/settings.json', content: '{}' }), '', 'governance'],
]

describe('the snapshot of an OPAQUE workspace', () => {
  it('carries the @intervention_mode record inside the digest, and only for OPAQUE', () => {
    const rules = (mode: string) => readFileSync(snapshots[mode]!, 'utf8')
    expect(rules('OPAQUE')).toMatch(/^@intervention_mode\tOPAQUE$/m)
    expect(rules('TRANSPARENT')).not.toContain('@intervention_mode')
    expect(rules('SILENT_LOG')).not.toContain('@intervention_mode')
    // Only the record and the digest differ: OPAQUE refuses exactly what
    // TRANSPARENT refuses.
    const body = (mode: string) =>
      rules(mode)
        .split('\n')
        // @sso_groups carries its own issue time.
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('@intervention_mode') && !l.startsWith('@sso_groups'))
    expect(body('OPAQUE')).toEqual(body('TRANSPARENT'))
    const json = JSON.parse(readFileSync(join(home, 'snapshot-OPAQUE', SNAPSHOT_JSON), 'utf8')) as Record<string, unknown>
    expect(json['interventionMode']).toBe('OPAQUE')
  })
})

describe('a JSON decision in an OPAQUE workspace', () => {
  for (const name of ['cline', 'grok', 'antigravityCli'] as const) {
    it(`${name}: the generic sentence, the same code, no rule id; the audit line keeps the rule`, async () => {
      const g = gates[name]!
      const artifact = join(roots.get(g.name)!, g.artifact)
      for (const [code, stdin, ruleId, fragment] of POLICY_CASES) {
        for (const mode of ['TRANSPARENT', 'OPAQUE']) {
          const before = events(g).length
          const res = await run(g.runner, [artifact], envFor(g, mode), stdin)
          const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
          const label = `${name} ${mode} ${code}: ${JSON.stringify(out).slice(0, 400)}`
          const text = String(g.contract === 'stdout-cancel' ? out['errorMessage'] : out['reason'])
          if (name === 'antigravityCli') {
            expect(text, label).toMatch(new RegExp(`\\(refusal code ${code}\\)$`))
          } else {
            expect(out['code'], label).toBe(code)
            if (code === 'HELD') expect(String(out['holdId']), label).toMatch(/^hold_/)
          }
          if (mode === 'OPAQUE') {
            expect(text, label).toContain(OPAQUE_REFUSAL_MESSAGE)
            if (ruleId) expect(text, label).not.toContain(ruleId)
            expect(text, label).not.toContain(fragment)
            if (name !== 'antigravityCli') expect(out['ruleId'], label).toBeNull()
            if (code === 'HELD') expect(text, label).toContain('intutic decision approve hold_')
          } else {
            expect(text, label).not.toContain(OPAQUE_REFUSAL_MESSAGE)
            if (ruleId) expect(text, label).toContain(`[${ruleId}]`)
            if (ruleId && name !== 'antigravityCli') expect(out['ruleId'], label).toBe(ruleId)
          }
          // The audit line names the rule in both modes.
          const added = events(g).slice(before).filter((e) => e['event'] === 'tool_blocked' || e['event'] === 'tool_held')
          expect(added.length, label).toBeGreaterThan(0)
          const reason = String(added[added.length - 1]!['reason'])
          expect(reason, label).not.toContain(OPAQUE_REFUSAL_MESSAGE)
          if (ruleId) expect(reason, label).toContain(`[${ruleId}]`)
        }
      }
    }, 120_000)
  }

  it('leaves a refusal that says nothing about the policy as it was', async () => {
    const g = gates['grok']!
    const big = call('Bash', { command: `echo ${'x'.repeat(300 * 1024)}` })
    const res = await run(g.runner, [join(roots.get(g.name)!, g.artifact)], envFor(g, 'OPAQUE'), big)
    const out = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
    expect(out['code']).toBe('COMMAND_TOO_LARGE')
    expect(String(out['reason'])).toContain('COMMAND_TOO_LARGE')
    expect(String(out['reason'])).not.toContain(OPAQUE_REFUSAL_MESSAGE)
  }, 60_000)
})

describe('an exit-code gate in an OPAQUE workspace', () => {
  for (const name of ['hermes', 'claudeCode'] as const) {
    it(`${name}: exit 2 and the generic sentence on stderr; the audit line keeps the rule`, async () => {
      const g = gates[name]!
      const artifact = join(roots.get(g.name)!, g.artifact)
      for (const [code, stdin, ruleId, fragment] of POLICY_CASES) {
        for (const mode of ['TRANSPARENT', 'OPAQUE']) {
          const before = events(g).length
          const res = await run(g.runner, [artifact], envFor(g, mode), stdin)
          const label = `${name} ${mode} ${code}: ${res.stderr.slice(0, 400)}`
          expect(res.status, label).toBe(2)
          if (mode === 'OPAQUE') {
            expect(res.stderr, label).toContain(OPAQUE_REFUSAL_MESSAGE)
            if (ruleId) expect(res.stderr, label).not.toContain(ruleId)
            expect(res.stderr, label).not.toContain(fragment)
          } else {
            expect(res.stderr, label).not.toContain(OPAQUE_REFUSAL_MESSAGE)
            if (ruleId) expect(res.stderr, label).toContain(`[${ruleId}]`)
          }
          const added = events(g).slice(before).filter((e) => e['event'] === 'tool_blocked' || e['event'] === 'tool_held')
          expect(added.length, label).toBeGreaterThan(0)
          const reason = String(added[added.length - 1]!['reason'])
          expect(reason, label).not.toContain(OPAQUE_REFUSAL_MESSAGE)
          if (ruleId) expect(reason, label).toContain(`[${ruleId}]`)
        }
      }
    }, 120_000)
  }
})

describe('the in-process gates in an OPAQUE workspace', () => {
  it('Open WebUI: the raised refusal is the generic sentence; the event keeps the rule', async () => {
    const g = gates['openWebui']!
    const root = roots.get(g.name)!
    // A prompt has no tool name, so the filter applies only rules on the
    // command subject, which no SOP compiles to: a hand-built snapshot, with
    // the writer's own record and line encoders and a real digest.
    const lines = [
      encodeInterventionModeRecord(),
      toRulesLine({
        id: 'sop.s_canary', source: 'canary-string', subject: 'command', severity: 'block',
        reason: 'No canary strings', rationale: '', matches: [], notMatches: [],
      }),
    ]
    const snap = join(home, 'owui.rules')
    writeFileSync(
      snap,
      `#digest ${createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)}\n#workspace ws_test\n${lines.join('\n')}\n`,
    )
    const driver = join(root, 'drv.py')
    writeFileSync(
      driver,
      [
        'import sys, importlib.util',
        "spec = importlib.util.spec_from_file_location('f', sys.argv[1])",
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        "m.Filter().inlet({'model': 'x', 'messages': [{'role': 'user', 'content': sys.argv[2]}]})",
      ].join('\n'),
    )
    const before = events(g).length
    const res = await run('python3', [driver, join(root, g.artifact), 'here is a canary-string'], {
      ...process.env,
      HOME: root,
      INTUTIC_SNAPSHOT_RULES: snap,
    })
    expect(res.status, res.stderr).not.toBe(0)
    expect(res.stderr).toContain(`BLOCKED: ${OPAQUE_REFUSAL_MESSAGE}`)
    expect(res.stderr).not.toContain('s_canary')
    expect(res.stderr).not.toContain('No canary strings')
    const blocked = events(g).slice(before).filter((e) => e['event'] === 'tool_blocked')
    expect(String(blocked[0]?.['reason'])).toContain('No canary strings [sop.s_canary]')
  }, 60_000)

  it('n8n: the thrown refusal names the node, not the rule; the event keeps the rule', async () => {
    const g = gates['n8n']!
    const root = roots.get(g.name)!
    const dir = join(home, 'n8n')
    await writePolicySnapshot(
      { ...policy('OPAQUE'), sopRules: [{ id: 's_http', toolPattern: 'httpRequest', action: 'block', reason: 'No outbound HTTP' }] },
      dir,
    )
    const driver = join(root, 'wf-drv.cjs')
    writeFileSync(
      driver,
      [
        'const hook = require(process.argv[2]);',
        'const wf = JSON.parse(process.argv[3]);',
        'Promise.resolve().then(() => hook.workflow.preExecute[0](wf))',
        '  .then(() => process.exit(0), (e) => { console.error(String((e && e.message) || e)); process.exit(3); });',
      ].join('\n'),
    )
    const workflow = { id: 'wf1', name: 'W', connections: {}, nodes: [{ name: 'Fetch', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } }] }
    const before = events(g).length
    const res = await run('node', [driver, join(root, g.artifact), JSON.stringify(workflow)], {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      INTUTIC_SNAPSHOT_RULES: join(dir, SNAPSHOT_RULES),
    })
    expect(res.status, res.stderr).toBe(3)
    expect(res.stderr).toContain(`BLOCKED: ${OPAQUE_REFUSAL_MESSAGE} (node "Fetch")`)
    expect(res.stderr).not.toContain('s_http')
    expect(res.stderr).not.toContain('No outbound HTTP')
    const blocked = events(g).slice(before).filter((e) => e['event'] === 'tool_blocked')
    expect(String(blocked[0]?.['reason'])).toContain('No outbound HTTP [sop.s_http]')
  }, 60_000)
})
