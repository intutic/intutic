/**
 * The `@rule` records at every gate (gate body v23): a qualified
 * `requires_before`, `scope_paths_mode: enforce` and `plan_approval:`, each
 * compiled from a local SOP by the snapshot writer and decided by the
 * rendered gates; the post-tool outcome replayed from the payloads captured
 * from each harness (`fixtures/post-tool/`); the tier order; and the old
 * gates' fallback lines.
 *
 * Every gate is driven for real, its writer run into a temp root that is
 * its HOME and workspace (with a `.git`, so the scope check finds the
 * workspace root). Asynchronous spawns only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { GATES, type GateEntry } from './gateRegistry.js'
import { runInProcessGate, inProcessShellTool } from './inProcessGates.js'
import { GATE_PY_LIB, POST_TOOL_OBSERVABLE, GATE_VERSION, HOOK_REFUSAL_CODES, ACTION_NEEDLES } from '../../src/harness/gateBody.js'
import { writePolicySnapshot, buildSnapshotRules, compileGateRecords, type ResolvedPolicy } from '../../src/lib/policySnapshot.js'
import { writeApprovedPlans } from '../../src/lib/approvedPlans.js'
import { createHash } from 'node:crypto'
import {
  compileSopGateRecords as compileShared,
  decodeGateRuleRecord,
  encodeGateRuleRecord,
  decideTestOutcome,
  extractExitCode,
  gateRulePayload,
  isWithinScope,
  changeTargets,
  laneHoldTokens,
  parseFrontMatterEnforcing,
  splitFrontMatter,
  type SyncSopEntry,
} from '@intutic/shared-types'

const sha256Hex = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
/** One SOP's front matter, as the snapshot writer parses it. */
const frontOf = (entry: SyncSopEntry) => parseFrontMatterEnforcing(splitFrontMatter(entry.content).front)
/** The records one SOP compiles to (`compileSopGateRecords`, @intutic/shared-types), with its parse errors. */
function compileSopGateRecords(entry: SyncSopEntry) {
  const fm = frontOf(entry)
  return { ...compileShared({ sopId: entry.sopId, sopTitle: entry.title }, fm, sha256Hex), errors: fm.errors }
}

const WORKSPACE_ID = 'ws_test'
const home = mkdtempSync(join(tmpdir(), 'intutic-rules-'))
const roots = new Map<string, string>()

const DRIVABLE = GATES.filter((g) => g.migrated && (g.contract === 'exit2' || g.contract === 'stdout-cancel' || g.contract === 'stdout-decision-deny'))
const IN_PROCESS = GATES.filter((g) => g.migrated && (g.contract === 'plugin-throw' || g.contract === 'plugin-block'))
const ALL = [...DRIVABLE, ...IN_PROCESS]

/** The harness id a registry entry's gate is emitted for (its POST_TOOL_OBSERVABLE key). */
const HARNESS_OF: Record<string, keyof typeof POST_TOOL_OBSERVABLE> = {
  goose: 'goose', openhands: 'openhands', hermes: 'hermes', antigravity: 'gemini-cli', antigravityCli: 'antigravity',
  claudeCode: 'claude-code', cursor: 'cursor', windsurf: 'windsurf', codex: 'codex', museCode: 'muse-code',
  githubCopilot: 'github-copilot', cline: 'cline', grok: 'grok', opencode: 'opencode', pi: 'pi', openclaw: 'openclaw',
}

function sop(sopId: string, front: string, title = 'Ship safely'): SyncSopEntry {
  return { sopId, title, content: `---\n${front}\n---\n# ${title}\n\nBody.\n`, contentHash: '', harnessTargets: [] }
}

function policy(extra: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return { workspaceId: WORKSPACE_ID, interventionMode: 'TRANSPARENT', sopRules: [], mcpAllowedServers: [], sqlDropStrictBlock: false, ...extra }
}

const OUTCOME_SOP = sop('local:ship.md', 'requires_before: action:run_tests[ok] -> action:deploy')
const SCOPE_SOP = sop('local:scope.md', 'scope_paths: src/, docs/guide\nscope_paths_mode: enforce', 'Stay in scope')
const PLAN_SOP = sop('local:plan.md', 'plan_approval: strict', 'Plan first')
const LANE_SOP = sop('local:lanes.md', 'closed_lanes: irreversible', 'No one-way doors')

async function snapshotFor(name: string, sops: SyncSopEntry[], extra: Partial<ResolvedPolicy> = {}): Promise<string> {
  const dir = join(home, 'snapshots', name)
  await writePolicySnapshot(policy(extra), dir, [], 'hold', sops)
  return join(dir, 'policy-snapshot.rules')
}

const snaps: Record<string, string> = {}

beforeAll(async () => {
  snaps.outcome = await snapshotFor('outcome', [OUTCOME_SOP])
  snaps.scope = await snapshotFor('scope', [SCOPE_SOP])
  snaps.plan = await snapshotFor('plan', [PLAN_SOP])
  snaps.lanes = await snapshotFor('lanes', [LANE_SOP])
  for (const g of ALL) {
    const root = join(home, g.name)
    mkdirSync(join(root, '.git'), { recursive: true })
    roots.set(g.name, root)
    const prevHome = process.env.HOME
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      await g.invoke(await import(g.module), root)
    } finally {
      process.env.HOME = prevHome
    }
  }
}, 180_000)

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* the goose writer hardens its files */ }
})

interface Run { refused: boolean; stdout: string; stderr: string; status: number }

function spawnGate(g: GateEntry, payload: unknown, env: NodeJS.ProcessEnv, args: string[] = []): Promise<Run> {
  const root = roots.get(g.name)!
  return new Promise((resolve, reject) => {
    const child = spawn(g.runner === 'node' ? process.execPath : g.runner, [join(root, g.artifact), ...args], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const status = code === null ? -1 : code
      let refused = status === 2
      if (g.contract === 'stdout-cancel' || g.contract === 'stdout-decision-deny') {
        refused = stdout.split('\n').some((l) => {
          try { const o = JSON.parse(l); return o?.cancel === true || o?.decision === 'deny' } catch { return false }
        })
      }
      resolve({ refused, stdout, stderr, status })
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

/**
 * One call through any gate. Session ids ride in each harness's own field:
 * `session_id` (Claude Code, Codex, Muse, the bash gates), `conversation_id`
 * (Cursor), `taskId` (Cline); the in-process drivers pass `sess_test`.
 */
async function call(g: GateEntry, tool: string, input: Record<string, unknown>, snapshot: string, session = 'sess_test'): Promise<{ refused: boolean; text: string }> {
  const root = roots.get(g.name)!
  const env = { INTUTIC_SNAPSHOT_RULES: snapshot }
  if (IN_PROCESS.includes(g)) {
    const t = tool === 'Bash' ? inProcessShellTool(g) : tool.toLowerCase()
    const args = { ...input, ...(typeof input.file_path === 'string' ? { path: input.file_path, filePath: input.file_path } : {}) }
    const r = await runInProcessGate(g, root, t, args, { ...env, PWD: root })
    return { refused: r.refused, text: r.stderr }
  }
  const r = await spawnGate(g, { tool_name: tool, tool_input: input, session_id: session, conversation_id: session, taskId: session, cwd: root }, env)
  expect([0, 2], `${g.name} exited ${r.status}: ${r.stderr.slice(0, 300)}`).toContain(r.status)
  return { refused: r.refused, text: r.stderr + r.stdout }
}

function auditLog(g: GateEntry): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.jsonl') && name !== 'review-requests.jsonl') out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(roots.get(g.name)!)
  return out.join('\n')
}

// ─── The record, the outcome and the scope (interim shared logic) ────────

/** Runs the bash gates' Python over the same inputs: the library they emit. */
function python(fn: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', 'import os, sys, json\nlib = {}\nexec(os.environ["INTUTIC_PY_LIB"], lib)\nargs = json.load(sys.stdin)\nprint(json.dumps(lib[sys.argv[1]](*args)))', fn], {
      env: { ...process.env, INTUTIC_PY_LIB: GATE_PY_LIB },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))))
    child.stdin.end(JSON.stringify(args))
  })
}

describe('@rule records', () => {
  it('a SOP compiles to records that round-trip, and JavaScript and Python decode them alike', async () => {
    const { records, errors } = compileSopGateRecords(sop('local:all.md', [
      'requires_before: action:run_tests[ok] -> action:deploy, action:run_tests[ok] ~> action:publish',
      'scope_paths: src/',
      'scope_paths_mode: enforce',
      'plan_approval: required',
    ].join('\n')))
    expect(errors).toEqual([])
    expect(records.map((r) => [r.kind, r.rollout])).toEqual([
      ['requires_outcome', 'enforce'], ['requires_outcome', 'enforce'], ['scope_paths', 'enforce'], ['plan_approval', 'enforce'],
    ])
    for (const r of records) {
      const line = encodeGateRuleRecord(r)
      expect(decodeGateRuleRecord(line)).toEqual(r)
      expect(await python('decode_gate_rule_record', [line])).toEqual(r)
    }
  })

  it('a damaged, mistyped or inconsistent record decodes to null in both languages', async () => {
    const [r] = compileSopGateRecords(OUTCOME_SOP).records
    const good = encodeGateRuleRecord(r!)
    const f = good.split('\t')
    const payload = gateRulePayload(r!) as Record<string, unknown>
    const canon = (o: Record<string, unknown>) => Buffer.from('{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(o[k])).join(',') + '}').toString('base64')
    const bad = [
      f.slice(0, 4).join('\t'),
      [...f.slice(0, 4), f[4]!.slice(0, -4)].join('\t'),
      [f[0], f[1], 'scope_paths', f[3], f[4]].join('\t'),
      [f[0], f[1], f[2], 'shadow', f[4]].join('\t'),
      [f[0], '-', f[2], 'enforce', f[4]].join('\t'),
      [...f.slice(0, 4), canon({ ...payload, first: 'action:deploy' })].join('\t'),
      [...f.slice(0, 4), canon({ ...payload, extra: 1 })].join('\t'),
      [...f.slice(0, 4), canon({ ...payload, mode: 'strict' })].join('\t'),
      [...f.slice(0, 4), canon({ ...payload, ref: 'local:ship.md#requires_outcome:2' })].join('\t'),
      '@rule\t-\tunknown_kind\tshadow\t' + f[4],
    ]
    for (const line of bad) {
      expect(decodeGateRuleRecord(line), line).toBeNull()
      expect(await python('decode_gate_rule_record', [line]), line).toBeNull()
    }
  })

  it('a qualifier anywhere but on action:run_tests is a rule error and compiles nothing', () => {
    const { records, errors } = compileSopGateRecords(sop('local:bad.md', 'requires_before: action:deploy[ok] -> action:publish'))
    expect(errors.join('\n')).toMatch(/\[ok\] qualifies only action:run_tests, on the left of ->/)
    expect(records).toEqual([])
  })

  it('an unknown mode value enforces; advise and a SOP with roles compile nothing; mode: shadow has no fallback', () => {
    expect(compileSopGateRecords(sop('a', 'scope_paths: src/\nscope_paths_mode: enforec')).records.map((r) => r.kind)).toEqual(['scope_paths'])
    expect(compileSopGateRecords(sop('a', 'scope_paths: src/\nscope_paths_mode: advise')).records).toEqual([])
    expect(compileSopGateRecords(sop('a', 'plan_approval: strcit')).records.map((r) => (r as { mode?: string }).mode)).toEqual(['strict'])
    expect(compileSopGateRecords(sop('a', 'roles: reviewer\nplan_approval: required')).records).toEqual([])
    const shadow = compileSopGateRecords(sop('a', 'mode: shadow\nplan_approval: required')).records
    expect(shadow.map((r) => [r.rollout, r.fallbackId])).toEqual([['shadow', null]])
  })

  it('a snapshot with no rule record is byte-identical to one written before them; one with a record is format 3', async () => {
    const plainDir = join(home, 'snapshots', 'plain')
    await writePolicySnapshot(policy(), plainDir, [], 'hold', [sop('local:none.md', 'review_before: action:deploy')])
    const plain = readFileSync(join(plainDir, 'policy-snapshot.rules'), 'utf8')
    expect(plain).not.toMatch(/^@format/m)
    expect(plain).not.toMatch(/^@rule/m)
    const json = JSON.parse(readFileSync(join(plainDir, 'policy-snapshot.json'), 'utf8'))
    expect(json.version).toBe(1)
    expect(json.gateRecords).toBeUndefined()

    const text = readFileSync(snaps.outcome!, 'utf8')
    const data = text.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(data[0]).toBe('@format\t3')
    expect(data.filter((l) => l.startsWith('@rule\t'))).toHaveLength(1)
    expect(data.some((l) => l.startsWith('requires_outcome-fallback:1@'))).toBe(true)
    expect(JSON.parse(readFileSync(snaps.outcome!.replace(/\.rules$/, '.json'), 'utf8')).version).toBe(3)
  })

  it('SILENT_LOG stamps every record shadow, with no fallback line', () => {
    const c = compileGateRecords(policy({ interventionMode: 'SILENT_LOG' }), [OUTCOME_SOP, PLAN_SOP])
    expect(c.records.every((r) => r.rollout === 'shadow' && r.fallbackId === null)).toBe(true)
    expect(c.fallbacks).toEqual([])
  })

  it('fallback lines sit after the SSO-group rules and decide fallbacks, and name the gated call', () => {
    const rules = buildSnapshotRules(policy(), [], 'hold', [OUTCOME_SOP, SCOPE_SOP, PLAN_SOP, sop('local:mig.md', 'requires_before: action:run_tests[ok] -> action:migrate')])
    const fb = rules.filter((r) => /-fallback:/.test(r.id))
    expect(rules.slice(0, fb.length)).toEqual(fb)
    const byKind = Object.fromEntries(fb.map((r) => [r.id.split('-fallback:')[0] + ':' + r.subject, r.source]))
    expect(byKind['requires_outcome:action']).toBe(' (action:deploy) ')
    expect(byKind['requires_outcome:phrase']).toBe(ACTION_NEEDLES.find(([t]) => t === 'action:migrate')![1].join('|'))
    expect(byKind['scope_paths:tool']).toMatch(/^ \[\^ \]\*\(write\|/)
    expect(byKind['plan_approval:tool']).toBe(' [^ ]+ ')
    expect(fb.every((r) => r.severity === 'block')).toBe(true)
  })
})

describe('test outcomes and scope (the shared ports, JavaScript and Python alike)', () => {
  const OUTCOME_CASES: Array<[Parameters<typeof decideTestOutcome>[0], 'ok' | 'failed' | 'unknown']> = [
    [{ exitCode: 0, output: '' }, 'ok'],
    [{ exitCode: 1, output: '=== 3 passed in 0.1s ===' }, 'failed'],
    [{ isError: true, output: '' }, 'failed'],
    [{ output: '=== 1 failed, 2 passed in 0.12s ===' }, 'failed'],
    [{ output: '=== 2 passed in 0.12s ===' }, 'ok'],
    [{ output: '=== no tests ran in 0.01s ===' }, 'failed'],
    [{ output: 'Tests:       1 failed, 4 passed, 5 total' }, 'failed'],
    [{ output: 'Tests:       5 passed, 5 total' }, 'ok'],
    [{ output: '      Tests  1 failed | 2 passed (3)' }, 'failed'],
    [{ output: '      Tests  3 passed (3)' }, 'ok'],
    [{ output: 'ok  \tgithub.com/x/y\t0.1s' }, 'ok'],
    [{ output: 'ok  \tx\t0.1s\n--- FAIL: TestA (0.00s)\nFAIL' }, 'failed'],
    [{ output: 'test result: ok. 3 passed; 0 failed; 0 ignored\ntest result: ok. 0 passed; 0 failed; 0 ignored' }, 'ok'],
    [{ output: 'test result: FAILED. 2 passed; 1 failed; 0 ignored' }, 'failed'],
    [{ output: 'test result: ok. 0 passed; 0 failed; 0 ignored' }, 'failed'],
    [{ output: '  12 passing (30ms)\n  1 failing' }, 'failed'],
    [{ output: '3 examples, 0 failures' }, 'ok'],
    [{ output: 'BUILD SUCCESSFUL' }, 'unknown'],
    [{ exitCode: 0, output: 'Tests:       0 total' }, 'failed'],
  ]

  it.each(OUTCOME_CASES)('%j is %s', async (input, outcome) => {
    expect(decideTestOutcome(input).outcome).toBe(outcome)
    const o = (await python('decide_test_outcome', [input])) as { outcome: string }
    expect(o.outcome).toBe(outcome)
  })

  it('reads an exit code from the shapes the captured harnesses print', async () => {
    for (const [text, code] of [
      ['Exit code 1\n=== 1 failed ===', 1],
      ['Output: x\nExit Code: 2\nProcess Group PGID: 1', 2],
      ['{"output":"x","metadata":{"exit_code":3}}', 3],
      ['exit status 4', 4],
      ['Process exited with code 5', 5],
      ['all good', null],
    ] as const) {
      expect(extractExitCode(text)).toBe(code)
      expect(await python('extract_exit_code', [text])).toBe(code)
    }
  })

  it('finishes an adversarial output quickly', () => {
    const t = Date.now()
    decideTestOutcome({ output: ('=' + ' in 1s'.repeat(150)).repeat(800) + '\n' + 'Tests  ' + '|'.repeat(1000) })
    expect(Date.now() - t).toBeLessThan(200)
  })

  it('scope is a segment prefix match, and only mutation tools change paths', async () => {
    for (const [target, scopes, inside] of [
      ['packages/proxy/src/main.rs', ['packages/proxy'], true],
      ['packages/proxy-extras/x.rs', ['packages/proxy'], false],
      ['./SRC/a.ts', ['src/'], true],
      ['docs/a.md', ['src'], false],
    ] as const) {
      expect(isWithinScope(target, [...scopes])).toBe(inside)
      expect(await python('is_within_scope', [target, scopes])).toBe(inside)
    }
    for (const [tool, input, paths] of [
      ['Write', { file_path: 'a.ts' }, ['a.ts']],
      ['MultiEdit', { file_path: 'b.ts' }, ['b.ts']],
      ['str_replace_editor', { command: 'view', path: 'c.ts' }, []],
      ['str_replace_editor', { command: 'create', path: 'c.ts' }, ['c.ts']],
      ['move_file', { source: 'a', destination: 'b' }, ['a', 'b']],
      ['Bash', { command: 'echo > x' }, []],
      ['Read', { file_path: 'a.ts' }, []],
    ] as const) {
      expect(changeTargets(tool, input).map((t) => t.target)).toEqual(paths)
      expect(((await python('change_targets', [tool, input])) as Array<{ target: string }>).map((t) => t.target)).toEqual(paths)
    }
  })
})

describe('reversibility lanes', () => {
  it('closed classes, risk tier, top-level open_actions and workspace lanes', () => {
    const tokens = (front: string, workspaceLanes: string[] = []) =>
      laneHoldTokens({ sops: [frontOf(sop('l', front))].filter((fm) => fm.roles.length === 0), workspaceLanes })
    expect(tokens('closed_lanes: irreversible')).toEqual(['action:publish', 'action:destroy', 'action:force_push', 'action:payment'])
    expect(tokens('closed_lanes: irreversible\nopen_actions: action:publish')).toEqual(['action:destroy', 'action:force_push', 'action:payment'])
    // An indented open_actions: does not weaken the SOP.
    expect(tokens('closed_lanes: irreversible\n  open_actions: action:publish')).toContain('action:publish')
    expect(tokens('closed_lanes: irreversible\nrisk_tier: HIGH')).toContain('action:deploy')
    expect(tokens('risk_tier: CRITICAL')).toEqual([])
    expect(tokens('closed_lanes: irreversible\nopen_actions: action:publish', ['irreversible'])).toContain('action:publish')
    expect(frontOf(sop('l', 'closed_lanes: everything')).errors.join('\n')).toMatch(/is not a lane \(irreversible, reversible_wide\)/)
    expect(laneHoldTokens({ sops: [frontOf(sop('l', 'roles: ci\nclosed_lanes: irreversible'))].filter((fm) => fm.roles.length === 0) })).toEqual([])
  })

  it('compiles phrase-subject hold rules sop.lane.<class>.<token>; force push and destroy add an action rule under the same id', () => {
    const rules = buildSnapshotRules(policy(), [], 'hold', [LANE_SOP]).filter((r) => r.id.startsWith('sop.lane.'))
    expect(rules.map((r) => [r.id, r.subject, r.severity])).toEqual([
      ['sop.lane.irreversible.action:publish', 'phrase', 'hold'],
      ['sop.lane.irreversible.action:destroy', 'phrase', 'hold'],
      ['sop.lane.irreversible.action:destroy', 'action', 'hold'],
      ['sop.lane.irreversible.action:force_push', 'action', 'hold'],
      ['sop.lane.irreversible.action:force_push', 'phrase', 'hold'],
      ['sop.lane.irreversible.action:payment', 'phrase', 'hold'],
    ])
    // Resolve's rules are taken as served; an id outside the lane and revert
    // families is not shipped.
    const served = buildSnapshotRules(policy({ holdRules: [
      { id: 'revert.action:migrate', source: 'prisma migrate deploy', subject: 'phrase', ignoreCase: true, severity: 'shadow', reason: 'r' },
      { id: 'sop.other.x', source: 'x', subject: 'phrase', severity: 'hold', reason: 'r' } as never,
    ] }))
    expect(served.filter((r) => r.id.startsWith('revert.') || r.id.startsWith('sop.other')).map((r) => [r.id, r.severity])).toEqual([['revert.action:migrate', 'shadow']])
    // With no control plane a lane hold refuses.
    expect(buildSnapshotRules(policy(), [], 'block', [LANE_SOP]).filter((r) => r.id.startsWith('sop.lane.')).every((r) => r.severity === 'block')).toBe(true)
  })
})

// ─── At every gate ────────────────────────────────────────────────────────

describe('requires_before: action:run_tests[ok] at every gate', () => {
  it('registers the refusal codes the gates use', () => {
    for (const code of ['PREREQUISITE_UNMET', 'OUT_OF_SCOPE', 'PLAN_NOT_APPROVED', 'OFF_PLAN']) expect(HOOK_REFUSAL_CODES).toContain(code)
    expect(GATE_VERSION).toBe(23)
  })

  for (const g of ALL) {
    const observable = POST_TOOL_OBSERVABLE[HARNESS_OF[g.name]!]
    it(`${g.name}: refuses a deploy with no passing run (${observable ? 'none ran' : 'not observable'}), and lets an unrelated call through`, async () => {
      const deploy = await call(g, 'Bash', { command: 'git push origin main' }, snaps.outcome!)
      expect(deploy.refused, `${g.name} let a deploy through with no passing test run: ${deploy.text.slice(0, 300)}`).toBe(true)
      if (g.name !== 'pi') {
        expect(deploy.text).toContain('action:deploy needs a passing action:run_tests first')
        expect(deploy.text).toContain(observable ? 'none ran in this session' : 'cannot be observed here')
      }
      const build = await call(g, 'Bash', { command: 'npm run build' }, snaps.outcome!)
      expect(build.refused, `${g.name} refused an ungated call: ${build.text.slice(0, 300)}`).toBe(false)
    }, 60_000)
  }
})

/** A captured post-tool payload, its command made a test run. */
function fixtureEvent(harness: 'claude-code' | 'gemini-cli', index: number, command: string): Record<string, unknown> {
  const fx = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'post-tool', `${harness}.json`), 'utf8')) as { events: Array<Record<string, unknown>> }
  const e = structuredClone(fx.events[index]!)
  ;(e.tool_input as Record<string, unknown>).command = command
  return e
}

describe('post-tool outcomes replayed from the captured payloads', () => {
  for (const [name, harness, okIndex, failIndex] of [['claudeCode', 'claude-code', 0, 1], ['antigravity', 'gemini-cli', 0, 1]] as const) {
    it(`${name}: a failing run refuses the deploy, a passing one lets it through, and a later write makes it stale`, async () => {
      const g = GATES.find((x) => x.name === name)!
      const ok = fixtureEvent(harness, okIndex, 'cargo test')
      const failed = fixtureEvent(harness, failIndex, 'pytest -q')
      const session = String(ok.session_id)
      expect(String(failed.session_id)).toBe(session)
      const env = { INTUTIC_SNAPSHOT_RULES: snaps.outcome! }
      const deploy = () => call(g, 'Bash', { command: 'git push origin main' }, snaps.outcome!, session)

      const post = async (event: Record<string, unknown>) => {
        const r = await spawnGate(g, event, env, ['--event', 'post'])
        expect(r.status, `${name} post-tool handler exited ${r.status}: ${r.stderr}`).toBe(0)
        expect(r.stdout.trim(), 'a post-tool handler prints no decision').toBe('')
      }

      await post(failed)
      const afterFail = await deploy()
      expect(afterFail.refused).toBe(true)
      expect(afterFail.text).toMatch(/the last action:run_tests failed \((exit_code|is_error)\)/)

      await post(ok)
      const afterOk = await deploy()
      expect(afterOk.refused, `${name} refused a deploy after a passing run: ${afterOk.text.slice(0, 400)}`).toBe(false)

      // Q1: an [ok] goes stale on a later file change in the session.
      const write = await call(g, 'Write', { file_path: 'src/x.ts', content: 'x' }, snaps.outcome!, session)
      expect(write.refused).toBe(false)
      const afterWrite = await deploy()
      expect(afterWrite.refused).toBe(true)
      expect(afterWrite.text).toContain('files changed after the last passing action:run_tests')
    }, 60_000)

    it(`${name}: a post-tool handler that cannot read its payload exits 0`, async () => {
      const g = GATES.find((x) => x.name === name)!
      const r = await new Promise<number>((resolve) => {
        const child = spawn(g.runner === 'node' ? process.execPath : g.runner, [join(roots.get(g.name)!, g.artifact), '--event', 'post'], {
          env: { ...process.env, HOME: roots.get(g.name)! },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        child.on('close', (code) => resolve(code ?? -1))
        child.stdin.end('not json')
      })
      expect(r).toBe(0)
    })
  }

  it('claudeCode: ~> needs the passing run right before the deploy', async () => {
    const g = GATES.find((x) => x.name === 'claudeCode')!
    const snap = await snapshotFor('adjacent', [sop('local:adj.md', 'requires_before: action:run_tests[ok] ~> action:deploy')])
    const ok = fixtureEvent('claude-code', 0, 'cargo test')
    ok.session_id = 'sess_adjacent'
    const env = { INTUTIC_SNAPSHOT_RULES: snap }
    expect((await spawnGate(g, ok, env, ['--event', 'post'])).status).toBe(0)
    expect((await call(g, 'Bash', { command: 'ls' }, snap, 'sess_adjacent')).refused).toBe(false)
    const between = await call(g, 'Bash', { command: 'git push origin main' }, snap, 'sess_adjacent')
    expect(between.refused).toBe(true)
    expect(between.text).toContain('action:deploy must come directly after it, and another call came between')
    expect((await spawnGate(g, ok, env, ['--event', 'post'])).status).toBe(0)
    expect((await call(g, 'Bash', { command: 'git push origin main' }, snap, 'sess_adjacent')).refused).toBe(false)
  }, 60_000)

  it('goose: a post-tool invocation no longer re-runs the pre-tool gate (the EVENT fix)', async () => {
    const g = GATES.find((x) => x.name === 'goose')!
    // A call the floor refuses before: as a post event it is not evaluated.
    const r = await spawnGate(g, { tool_name: 'Bash', tool_input: { command: 'chflags nouchg .intutic/hooks/x' }, session_id: 's' }, {}, ['--event', 'post'])
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/BLOCKED/)
    const pre = await spawnGate(g, { tool_name: 'Bash', tool_input: { command: 'chflags nouchg .intutic/hooks/x' }, session_id: 's' }, {})
    expect(pre.status).toBe(2)
  })
})

describe('scope_paths_mode: enforce at every gate', () => {
  for (const g of ALL) {
    it(`${g.name}: refuses a file change outside scope_paths, and allows one inside`, async () => {
      const inside = await call(g, 'Write', { file_path: 'src/a.ts', content: 'x' }, snaps.scope!)
      expect(inside.refused, `${g.name} refused an in-scope write: ${inside.text.slice(0, 300)}`).toBe(false)
      const nested = await call(g, 'Write', { file_path: 'docs/guide/a.md', content: 'x' }, snaps.scope!)
      expect(nested.refused, `${g.name} refused an in-scope write: ${nested.text.slice(0, 300)}`).toBe(false)
      for (const target of ['docs/other.md', '../outside.ts', '/etc/hosts.d/x', `${roots.get(g.name)!}/README.md`]) {
        const out = await call(g, 'Write', { file_path: target, content: 'x' }, snaps.scope!)
        expect(out.refused, `${g.name} let a write to ${target} through`).toBe(true)
        if (g.name !== 'pi') expect(out.text).toMatch(/outside scope_paths|OUT_OF_SCOPE/)
      }
      const shell = await call(g, 'Bash', { command: 'echo hi > docs/other.md' }, snaps.scope!)
      expect(shell.refused, 'a shell command is never read as a path').toBe(false)
    }, 90_000)
  }
})

describe('plan_approval: strict at every gate', () => {
  for (const g of ALL) {
    it(`${g.name}: refuses before the session's plan is approved, then holds the call to the plan's steps`, async () => {
      const root = roots.get(g.name)!
      rmSync(join(root, '.intutic', 'hooks', 'approved-plans.jsonl'), { force: true })
      const before = await call(g, 'Bash', { command: 'npm run build' }, snaps.plan!)
      expect(before.refused, `${g.name} allowed a call with no approved plan`).toBe(true)
      if (g.name !== 'pi') expect(before.text).toMatch(/PLAN_NOT_APPROVED|no APPROVED or EXECUTING plan|no session id/)
      const read = await call(g, 'Read', { file_path: 'src/a.ts' }, snaps.plan!)
      expect(read.refused, 'a read is exempt').toBe(false)

      const shell = IN_PROCESS.includes(g) ? inProcessShellTool(g) : 'Bash'
      await writeApprovedPlans(
        [{ sessionId: 'sess_test', planId: 'plan_1', state: 'APPROVED', tools: [shell], updatedAt: new Date().toISOString() }],
        WORKSPACE_ID,
        join(root, '.intutic', 'hooks'),
      )
      const after = await call(g, 'Bash', { command: 'npm run build' }, snaps.plan!)
      const offPlan = await call(g, 'Write', { file_path: 'src/a.ts', content: 'x' }, snaps.plan!)
      expect(offPlan.refused, 'strict refuses a tool the plan does not name').toBe(true)
      // The gates whose writer passes the harness's session id read the plan.
      const sessioned = !['antigravityCli', 'githubCopilot', 'grok', 'windsurf'].includes(g.name)
      expect(after.refused, `${g.name}: ${after.text.slice(0, 300)}`).toBe(!sessioned)
      if (sessioned && g.name !== 'pi') expect(offPlan.text).toMatch(/OFF_PLAN|not a step of the approved plan/)

      // An expired cache is no plan.
      await writeApprovedPlans(
        [{ sessionId: 'sess_test', planId: 'plan_1', state: 'APPROVED', tools: [shell], updatedAt: new Date().toISOString() }],
        WORKSPACE_ID,
        join(root, '.intutic', 'hooks'),
        { now: new Date(Date.now() - 3_600_000) },
      )
      expect((await call(g, 'Bash', { command: 'npm run build' }, snaps.plan!)).refused).toBe(true)
    }, 90_000)
  }
})

describe('the tier order', () => {
  for (const g of ALL) {
    it(`${g.name}: a closed lane holds terraform destroy, a force push and a Stripe charge`, async () => {
      for (const command of ['terraform destroy', 'git push origin main --force', 'curl -X POST https://api.stripe.com/v1/charges -d amount=1']) {
        const r = await call(g, 'Bash', { command }, snaps.lanes!)
        expect(r.refused, `${g.name} let \`${command}\` through a closed lane`).toBe(true)
        if (g.name !== 'pi') expect(r.text).toMatch(/HELD/)
      }
      const lease = await call(g, 'Bash', { command: 'git push --force-with-lease origin main' }, snaps.lanes!)
      expect(lease.refused, '--force-with-lease is not a force push').toBe(false)
    }, 60_000)
  }

  it('a deterministic refusal is decided before a hold: no hold record for a call a rule refuses', async () => {
    const g = GATES.find((x) => x.name === 'claudeCode')!
    const snap = await snapshotFor('order', [LANE_SOP, OUTCOME_SOP])
    const holds = join(roots.get(g.name)!, '.intutic', 'events', 'review-requests.jsonl')
    const before = existsSync(holds) ? readFileSync(holds, 'utf8') : ''
    // `terraform destroy && git push` is held by the lane and refused by the
    // unmet prerequisite: the refusal wins, and nothing is queued for review.
    const r = await call(g, 'Bash', { command: 'terraform destroy && git push origin main' }, snap, 'sess_order')
    expect(r.refused).toBe(true)
    expect(r.text).toContain('PREREQUISITE_UNMET')
    expect(existsSync(holds) ? readFileSync(holds, 'utf8') : '').toBe(before)
  })

  it('a hold is decided before the decide tier: a held call never reaches the engine', async () => {
    const g = GATES.find((x) => x.name === 'claudeCode')!
    const snap = await snapshotFor('decide-order', [LANE_SOP], {
      decideRules: [{
        sopId: 'local:d.md', sopTitle: 'Allow all', ruleText: 'x',
        ir: JSON.stringify({
          id: 'allow-all', on: 'tool_call', tools: ['Bash'],
          questions: { fine: { type: 'yes_no', ask: 'Is this call fine?' } }, when: 'fine', rollout: 'shadow',
        }),
        pins: [],
      }],
    })
    const r = await call(g, 'Bash', { command: 'terraform destroy' }, snap, 'sess_decide')
    expect(r.refused).toBe(true)
    expect(r.text).toMatch(/HELD/)
    expect(auditLog(g)).not.toMatch(/GOVERNANCE_UNAVAILABLE[^\n]*allow-all/)
  })
})

describe('the 2.9.0 gate (body v21) on a format 3 snapshot', () => {
  const OLD = join(__dirname, '..', 'fixtures', 'gate-2.9.0', 'claude-code-check.js')

  function runOld(command: string, snapshot: string): Promise<Run> {
    const root = join(home, 'old-gate')
    mkdirSync(join(root, '.intutic', 'events'), { recursive: true })
    const gate = join(root, 'claude-code-check.js')
    // As decideOldGate.test.ts runs it: the fixture names its root by placeholder.
    writeFileSync(gate, readFileSync(OLD, 'utf8').split('__INTUTIC_TEST_ROOT__').join(root))
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [gate], {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root, INTUTIC_SNAPSHOT_RULES: snapshot },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', reject)
      child.on('close', (code) => resolve({ refused: code === 2, stdout, stderr, status: code ?? -1 }))
      child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's' }))
    })
  }

  it('refuses a deploy through requires_outcome-fallback:, and nothing else', async () => {
    const deploy = await runOld('git push origin main', snaps.outcome!)
    expect(deploy.refused, deploy.stderr).toBe(true)
    expect(deploy.stderr).toContain('requires_outcome-fallback:1@')
    expect((await runOld('npm run build', snaps.outcome!)).refused).toBe(false)
  })

  it('refuses every call through plan_approval-fallback:', async () => {
    expect((await runOld('npm run build', snaps.plan!)).stderr).toContain('plan_approval-fallback:1@')
  })

  it('holds terraform destroy through the lane\'s phrase rule', async () => {
    const r = await runOld('terraform destroy', snaps.lanes!)
    expect(r.refused).toBe(true)
    expect(r.stderr).toMatch(/HELD/)
    expect(r.stderr).toContain('sop.lane.irreversible.action:destroy')
  })
})

describe('shell writes make a passing run stale', () => {
  for (const [name, harness] of [['claudeCode', 'claude-code'], ['antigravity', 'gemini-cli']] as const) {
    it(`${name}: sed -i after a passing run refuses the next deploy, and an unrelated shell call does not`, async () => {
      const g = GATES.find((x) => x.name === name)!
      const ok = fixtureEvent(harness, 0, 'cargo test')
      const session = `sess_shellwrite_${name}`
      ok.session_id = session
      const env = { INTUTIC_SNAPSHOT_RULES: snaps.outcome! }
      const deploy = () => call(g, 'Bash', { command: 'git push origin main' }, snaps.outcome!, session)
      expect((await spawnGate(g, ok, env, ['--event', 'post'])).status).toBe(0)
      expect((await call(g, 'Bash', { command: 'ls -la' }, snaps.outcome!, session)).refused).toBe(false)
      expect((await deploy()).refused, 'an unrelated shell call keeps the pass').toBe(false)
      expect((await call(g, 'Bash', { command: "sed -i 's/a/b/' src/x.ts" }, snaps.outcome!, session)).refused).toBe(false)
      const after = await deploy()
      expect(after.refused).toBe(true)
      expect(after.text).toContain('files changed after the last passing action:run_tests')
    }, 60_000)
  }
})

describe('a forced recursive remove outside the tree is destroy at every gate', () => {
  const rm = 'r' + 'm'
  for (const g of ALL) {
    it(`${g.name}: a closed irreversible lane holds it outside the tree, not inside`, async () => {
      for (const command of [`${rm} -rf /var/lib/app`, `${rm} -fr ../sibling-repo`, `${rm} -r -f ~/old`]) {
        const r = await call(g, 'Bash', { command }, snaps.lanes!)
        expect(r.refused, `${g.name} let \`${command}\` through a closed lane`).toBe(true)
        if (g.name !== 'pi') expect(r.text).toMatch(/HELD/)
      }
      for (const command of [`${rm} -rf build/`, `${rm} -rf node_modules dist`]) {
        expect((await call(g, 'Bash', { command }, snaps.lanes!)).refused, `${g.name} held \`${command}\``).toBe(false)
      }
    }, 60_000)
  }
})

describe('scope on a rule-record refusal', () => {
  const OUT = 'docs/other.md'
  let opaque: string
  beforeAll(async () => {
    opaque = await snapshotFor('scope-opaque', [SCOPE_SOP], { interventionMode: 'OPAQUE' })
  })

  for (const g of DRIVABLE) {
    it(`${g.name}: names the out-of-scope path where the harness reads it, and nothing in OPAQUE`, async () => {
      const r = await call(g, 'Write', { file_path: OUT, content: 'x' }, snaps.scope!)
      expect(r.refused).toBe(true)
      const decision = r.text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((o) => o && (o.cancel === true || o.decision === 'deny'))
      if (g.contract === 'exit2') {
        expect(r.text).toContain(`[Intutic] Retry scope: ${OUT}`)
      } else if (g.name !== 'antigravityCli') {
        // A JSON decision carries scope beside code and ruleId (Cline, Grok);
        // Antigravity's CLI takes documented fields only.
        expect(decision?.scope).toEqual({ paths: [OUT] })
        expect(decision?.code).toBe('OUT_OF_SCOPE')
      }
      const hidden = await call(g, 'Write', { file_path: OUT, content: 'x' }, opaque)
      expect(hidden.refused).toBe(true)
      expect(hidden.text).not.toContain('Retry scope')
      expect(hidden.text).not.toContain(OUT)
    }, 60_000)
  }
})
