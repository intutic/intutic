/**
 * Tier R of {@link Gate.guard}: the snapshot's `@rule` records —
 * a qualified `requires_before`, `scope_paths_mode: enforce` and
 * `plan_approval:` — with the outcomes {@link wrapTool} records, and the
 * fallback lines an older gate refuses with. Also the shared modules this
 * package carries as byte-identical copies, run on the shared vectors, and
 * the order of evidence: a closed lane's hold stands whatever a decide rule
 * would answer.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classify, DESTROY_PATTERNS, MIGRATE_PATTERNS, PAYMENT_PATTERNS, PROD_WRITE_PATTERNS, DEPLOY_PATTERNS, PUBLISH_PATTERNS, RELEASE_PATTERNS, DB_WRITE_PATTERNS, HTTP_POST_PATTERNS, TEST_PATTERNS } from '../actions.js'
import { CAN_EVALUATE_RULE_RECORDS, Gate } from '../gate.js'
import { GateClient } from '../client.js'
import { IntuticGateHold, IntuticGateRefusal } from '../errors.js'
import { compileSopGateRecords, decodeGateRuleRecord, encodeGateRuleRecord, evaluateGateRuleRecords, gateRuleFallback, type GateRuleRecord } from '../gateRuleRecord.js'
import { LANE_PHRASES, laneHoldPatterns, laneHoldRuleId } from '../lanes.js'
import { decideFallbackId, encodeDecideRecord, type DecideRecord } from '../decideRecord.js'
import { decideRuleHash, validateDecideRule } from '../decide.js'
import { decideTestOutcome, extractExitCode } from '../testOutcome.js'
import { loadSnapshot } from '../snapshot.js'
import { wrapTool } from '../wrapTools.js'
import { expectLinearTime } from './linearTime.js'
// @ts-expect-error -- a plain ESM fixture without types
import { startDecideMockEngine } from '../../../shared-types/fixtures/decide-mock-engine.mjs'

const SHARED = join(__dirname, '../../../shared-types')
const sha256 = (t: string) => createHash('sha256').update(t, 'utf-8').digest('hex')
const WS = 'ws_demo'
const SOP = 'local:release.md'
const ENV_KEYS = ['HOME', 'INTUTIC_SNAPSHOT_RULES', 'INTUTIC_DECIDE_ENGINE_URL', 'INTUTIC_DECIDE_MODEL', 'INTUTIC_DECIDE_MODEL_DIGEST'] as const

let dir: string
let saved: Record<string, string | undefined>
let cwd: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-gate-rules-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.HOME = dir
  cwd = process.cwd()
  mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
  mkdirSync(join(dir, 'repo', 'infra'), { recursive: true })
  mkdirSync(join(dir, 'repo', '.intutic'), { recursive: true })
  // The image tier reads an allowlist on a deploy or an infrastructure write; an empty one approves no image.
  writeFileSync(join(dir, 'repo', '.intutic', 'image-allowlist.json'), JSON.stringify({ require_digest: true, registries_allowed: [], images: {} }))
  process.chdir(join(dir, 'repo'))
})
afterEach(() => {
  process.chdir(cwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Writes a snapshot of these data lines, digest and workspace included, and points the gate at it. */
function writeSnapshot(lines: string[]): string {
  const p = join(dir, 'policy-snapshot.rules')
  writeFileSync(p, [`#workspace ${WS}`, `#digest ${sha256(lines.join('\n')).slice(0, 32)}`, ...lines].join('\n') + '\n', 'utf-8')
  process.env.INTUTIC_SNAPSHOT_RULES = p
  return p
}

/** A `.rules` line for a fallback as toRulesLine writes it. */
function rulesLine(f: NonNullable<ReturnType<typeof gateRuleFallback>>): string {
  return [f.id, f.severity, f.ignoreCase ? 'i' : '-', f.subject, f.reason, f.source].join('\t')
}

/** The records and fallback lines one SOP compiles to, as a format 3 snapshot. */
function snapshotFor(front: { requiresBefore?: Array<[string, string, boolean]>; scopePaths?: string[]; planApproval?: 'required' | 'strict' | null }, mode: 'shadow' | 'enforce' = 'enforce'): GateRuleRecord[] {
  const compiled = compileSopGateRecords(
    { sopId: SOP, sopTitle: 'Release gate' },
    { roles: [], mode, requiresBefore: front.requiresBefore ?? [], scopePaths: front.scopePaths ?? [], scopePathsMode: front.scopePaths ? 'enforce' : 'advise', planApproval: front.planApproval ?? null },
    sha256,
  )
  writeSnapshot(['@format\t3', ...compiled.records.map(encodeGateRuleRecord), ...compiled.fallbacks.map(rulesLine)])
  return compiled.records
}

function client(sessionId = 's1'): GateClient {
  return new GateClient({ sessionId, harness: 'vitest' })
}

const outcome = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
const DEPLOY = { command: 'git push origin main' }

describe('the shared modules this package carries', () => {
  it.each(['testOutcome.ts', 'scopeMatch.ts', 'gateRuleRecord.ts', 'lanes.ts', 'refusalDetail.ts'])('carries a byte-identical copy of %s', (file) => {
    expect(readFileSync(join(__dirname, '..', file), 'utf-8')).toBe(readFileSync(join(SHARED, 'src', file), 'utf-8'))
  })

  it('runs the rule-record vectors', () => {
    const V = JSON.parse(readFileSync(join(SHARED, 'fixtures/rule-record-vectors.json'), 'utf-8'))
    for (const c of V.valid) {
      expect(encodeGateRuleRecord(c.record), c.name).toBe(c.line)
      expect(decodeGateRuleRecord(c.line), c.name).toEqual(c.record)
    }
    for (const c of V.damaged) expect(decodeGateRuleRecord(c.line), c.name).toBeNull()
    for (const c of V.evaluate) expect(evaluateGateRuleRecords(c.records, c.call), c.name).toEqual({ refusal: c.refusal, shadow: c.shadow })
  })

  it('decides test outcomes in linear time', () => {
    const V = JSON.parse(readFileSync(join(SHARED, 'fixtures/test-outcome-vectors.json'), 'utf-8'))
    for (const [name, , unit, times] of V.adversarial as Array<[string, string, string, number]>) {
      const outputs = { 1: unit.repeat(Math.ceil(times / 4)), 4: unit.repeat(Math.ceil(times / 4) * 4) }
      expectLinearTime(name, (scale) => {
        decideTestOutcome({ output: outputs[scale] })
        extractExitCode(outputs[scale])
      })
    }
  })
})

describe('the classifier and the lanes', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
  const LANES = JSON.parse(readFileSync(join(SHARED, 'fixtures/lane-vectors.json'), 'utf-8')) as any

  it.each(LANES.classify as Array<[string, string[]]>)('classifies %j as %j', (command, tokens) => {
    expect(classify('bash', { command })).toEqual(tokens)
  })

  it("gives each lane token's phrases from the classifier's own lists", () => {
    const lists: Record<string, readonly string[]> = {
      'action:deploy': DEPLOY_PATTERNS,
      'action:publish': PUBLISH_PATTERNS,
      'action:release': RELEASE_PATTERNS,
      'action:db_write': DB_WRITE_PATTERNS,
      'action:http_post': HTTP_POST_PATTERNS,
      'action:run_tests': TEST_PATTERNS,
      'action:migrate': MIGRATE_PATTERNS,
      'action:prod_write': PROD_WRITE_PATTERNS,
      'action:destroy': DESTROY_PATTERNS,
      'action:payment': PAYMENT_PATTERNS,
    }
    for (const [token, list] of Object.entries(lists)) expect([...LANE_PHRASES[token]!], token).toEqual([...list])
  })

  it('classifies an rm -rf outside the tree in linear time', () => {
    const unit = 'rm -rf a '
    const commands = { 1: unit.repeat(5000), 4: unit.repeat(20000) }
    expectLinearTime('rm -rf words', (scale) => classify('bash', { command: commands[scale] }))
    const quotes = { 1: 'rm -rf "' + '"'.repeat(20000) + 'x', 4: 'rm -rf "' + '"'.repeat(80000) + 'x' }
    expectLinearTime('rm -rf quotes', (scale) => classify('bash', { command: quotes[scale] }))
  })
})

describe('Tier R', () => {
  it('is on', () => {
    expect(CAN_EVALUATE_RULE_RECORDS).toBe(true)
  })

  it('refuses a deploy until a passing test run, and again after a file change', async () => {
    snapshotFor({ requiresBefore: [['action:run_tests[ok]', 'action:deploy', false]] })
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client())
    const err = (await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal
    expect(err).toBeInstanceOf(IntuticGateRefusal)
    expect(err.code).toBe('PREREQUISITE_UNMET')
    expect(err.reason).toBe('action:deploy needs a passing action:run_tests first; none ran in this session [requires_before.action:run_tests[ok]->action:deploy]')
    expect(err.scope).toEqual({ tools: ['action:deploy'], step: 'action:run_tests' })

    // A failing run, recorded by the wrapped tool.
    const bash = wrapTool(async (_input: { command: string }) => ({ exitCode: 1, stdout: '==== 1 failed, 2 passed in 0.10s ====' }), { gate, name: 'Bash' })
    await bash({ command: 'pytest -q' })
    expect(((await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal).reason).toContain('the last action:run_tests failed (exit_code)')

    // A passing run lets the deploy through.
    const passing = wrapTool(async (_input: { command: string }) => '==== 3 passed in 0.10s ====', { gate, name: 'Bash' })
    await passing({ command: 'pytest -q' })
    expect(await outcome(gate.guard('Bash', DEPLOY))).toBeNull()

    // A write after it makes the pass stale (Q1).
    const write = wrapTool(async (_input: { file_path: string; content: string }) => 'ok', { gate, name: 'Write' })
    await write({ file_path: 'src/a.ts', content: 'x' })
    expect(((await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal).reason).toContain('files changed after the last passing action:run_tests')
  })

  it('counts a thrown test run as a failure', async () => {
    snapshotFor({ requiresBefore: [['action:run_tests[ok]', 'action:deploy', false]] })
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client())
    const bash = wrapTool(async (_input: { command: string }) => {
      throw new Error('boom')
    }, { gate, name: 'Bash' })
    await expect(bash({ command: 'npm test' })).rejects.toThrow('boom')
    expect(((await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal).reason).toContain('failed (is_error)')
  })

  it('refuses with no session id, whatever ran', async () => {
    snapshotFor({ requiresBefore: [['action:run_tests[ok]', 'action:deploy', false]] })
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client(''))
    gate.recordOutcome('Bash', { command: 'pytest' }, { exitCode: 0 })
    const err = (await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal
    expect(err.reason).toContain('vitest sent no session id')
  })

  it('refuses a write outside the scope, relative to the workspace root', async () => {
    snapshotFor({ scopePaths: ['infra'] })
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client())
    expect(await outcome(gate.guard('Write', { file_path: 'infra/main.tf', content: 'x' }))).toBeNull()
    for (const target of ['src/app.ts', '/etc/hosts', '../outside.txt']) {
      const err = (await outcome(gate.guard('Write', { file_path: target, content: 'x' }))) as IntuticGateRefusal
      expect(err.code, target).toBe('OUT_OF_SCOPE')
      expect(err.scope, target).toEqual({ paths: [target] })
    }
    process.chdir(join(dir, 'repo', 'infra'))
    expect(await outcome(gate.guard('Edit', { file_path: 'k8s/a.yaml' }))).toBeNull()
  })

  it('reads the session plan for plan_approval, and refuses until it is approved', async () => {
    snapshotFor({ planApproval: 'strict' })
    const c = new GateClient({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9', workspaceId: WS, sessionId: 's1', harness: 'vitest' })
    vi.spyOn(c, 'emit').mockResolvedValue(true)
    const answers: Array<{ status: number | null; body: unknown }> = [{ status: 404, body: { error: 'Plan not found' } }]
    const read = vi.spyOn(c, 'sessionPlan').mockImplementation(async () => answers[0]!)
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, c)
    expect(((await outcome(gate.guard('Bash', { command: 'ls' }))) as IntuticGateRefusal).code).toBe('PLAN_NOT_APPROVED')
    // An exempt tool runs before approval.
    expect(await outcome(gate.guard('Grep', { pattern: 'x' }))).toBeNull()
    // Cached: no second read inside the window.
    expect(read).toHaveBeenCalledTimes(1)
    const fresh = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, c)
    answers[0] = { status: 200, body: { lifecycleState: 'APPROVED', steps: [{ tool: 'Bash' }] } }
    expect(await outcome(fresh.guard('Bash', { command: 'ls' }))).toBeNull()
    const off = (await outcome(fresh.guard('WebFetch', { url: 'https://example.com' }))) as IntuticGateRefusal
    expect(off.code).toBe('OFF_PLAN')
    // An unreadable feed refuses, and is asked again on the next call.
    const down = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, c)
    answers[0] = { status: null, body: null }
    expect(((await outcome(down.guard('Bash', { command: 'ls' }))) as IntuticGateRefusal).reason).toContain('the approved plans could not be read')
  })

  it('reports a shadow record and lets the call on', async () => {
    snapshotFor({ requiresBefore: [['action:run_tests[ok]', 'action:deploy', false]] }, 'shadow')
    const c = new GateClient({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9', workspaceId: WS, sessionId: 's1' })
    const emit = vi.spyOn(c, 'emit').mockResolvedValue(true)
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, c)
    expect(await outcome(gate.guard('Bash', DEPLOY))).toBeNull()
    expect(emit.mock.calls.some((call) => call[0] === 'tool_would_block' && String(call[2]).includes('none ran in this session'))).toBe(true)
  })

  it('drops scope and evidence in an OPAQUE workspace', async () => {
    const compiled = compileSopGateRecords({ sopId: SOP, sopTitle: 'Scope' }, { roles: [], mode: 'enforce', requiresBefore: [], scopePaths: ['infra'], scopePathsMode: 'enforce', planApproval: null }, sha256)
    writeSnapshot(['@format\t3', '@intervention_mode\tOPAQUE', ...compiled.records.map(encodeGateRuleRecord), ...compiled.fallbacks.map(rulesLine)])
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client())
    const err = (await outcome(gate.guard('Write', { file_path: 'src/a.ts', content: 'x' }))) as IntuticGateRefusal
    expect(err.code).toBe('OUT_OF_SCOPE')
    expect(err.scope).toBeUndefined()
    expect(err.evidence).toBeUndefined()
    expect(err.reason).not.toContain('src/a.ts')
  })
})

describe('fallback lines', () => {
  it('are skipped only for a decoded record, and refuse otherwise', async () => {
    const records = snapshotFor({ requiresBefore: [['action:run_tests[ok]', 'action:deploy', false]] })
    const p = process.env.INTUTIC_SNAPSHOT_RULES!
    // A reader that does not evaluate rule records keeps the fallback line: it refuses the deploy.
    const older = loadSnapshot(WS, p)
    expect(older.rules.map((r) => r.id)).toEqual([records[0]!.fallbackId])
    expect(loadSnapshot(WS, p, { evaluatesRules: true }).rules).toEqual([])
    // A damaged record (its digest recomputed, as the writer would) leaves the fallback in force.
    const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l && !l.startsWith('#'))
    const damaged = lines.map((l) => (l.startsWith('@rule\t') ? l.slice(0, -4) + 'AAAA' : l))
    writeSnapshot(damaged)
    const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, client())
    gate.recordOutcome('Bash', { command: 'pytest' }, { exitCode: 0 })
    const err = (await outcome(gate.guard('Bash', DEPLOY))) as IntuticGateRefusal
    expect(err.code).toBe('SNAPSHOT')
    expect(err.reason).toContain('cannot read test results')
  })

  it('keeps a snapshot with no rule record byte-identical: no @format 3 line is needed to read one', () => {
    writeSnapshot([['d.rm', 'block', '-', 'command', 'Destructive', 'rm -rf'].join('\t')])
    const snap = loadSnapshot(WS, process.env.INTUTIC_SNAPSHOT_RULES, { evaluatesRules: true })
    expect(snap.formatVersion).toBe(1)
    expect(snap.ruleRecords).toEqual([])
  })
})

describe('the order of evidence', () => {
  it('holds a closed-lane call even when a decide rule would allow it, and asks the engine nothing', async () => {
    const DIGEST = 'sha256:' + 'a'.repeat(64)
    const body = (top: Array<[string, number]>) => ({ choices: [{ logprobs: { content: [{ top_logprobs: top.map(([token, logprob]) => ({ token, logprob })) }] } }] })
    const r = (match: string, top: Array<[string, number]>) => ({ method: 'POST', path: '/v1/chat/completions', match, status: 200, times: 100, body: body(top) })
    // The known-answer canary's cases first, then every rule question answered no: the rule would allow.
    const m = await startDecideMockEngine([
      r('--no-preserve-root\\"}\\n\\nQUESTION: Does', [['yes', -0.01], ['no', -5]]),
      r('A) delete_files', [['A', -0.02], ['C', -4]]),
      r('A) none_of_these', [['C', -0.02], ['A', -4]]),
      r('QUESTION: Does', [['no', -0.01], ['yes', -5]]),
    ])
    try {
      process.env.INTUTIC_DECIDE_ENGINE_URL = m.url
      process.env.INTUTIC_DECIDE_MODEL = 'm'
      process.env.INTUTIC_DECIDE_MODEL_DIGEST = DIGEST
      const v = validateDecideRule({ id: 'allow-all', on: 'tool_call', tools: ['Bash'], questions: { harmful: { type: 'yes_no', ask: 'Does this command destroy data that cannot be recovered?' } }, when: 'harmful', rollout: 'enforce' })
      if (!v.ok) throw new Error(v.reason)
      const fallbackId = decideFallbackId('allow-all', 'local:lanes.md', sha256)
      const record = { v: 1, ref: 'local:lanes.md#allow-all', ruleHash: decideRuleHash(v.rule, sha256), fallbackId, rollout: 'enforce', stampedBy: 'rule', ir: v.rule, sopTitle: 'Lanes', ruleText: 'x', pins: [{ modelDigest: DIGEST, evalRunId: 'e', source: 'local' }] } as DecideRecord
      const token = 'action:destroy'
      const holds = laneHoldPatterns(token).map((p) => [laneHoldRuleId(token), 'hold', p.ignoreCase ? 'i' : '-', p.subject, `Held for review: ${token} — closed_lanes: irreversible`, p.source].join('\t'))
      writeSnapshot(['@format\t2', encodeDecideRecord(record), ...holds, [fallbackId, 'block', '-', 'tool', 'upgrade', ' (Bash) '].join('\t')])
      const gate = new Gate({ repoRoot: join(dir, 'repo'), workspaceId: WS, useHookGate: false, useSopRules: false }, null)
      const err = await outcome(gate.guard('Bash', { command: 'terraform destroy -auto-approve' }))
      expect(err).toBeInstanceOf(IntuticGateHold)
      expect(m.requests).toEqual([])
      // An open lane: the same rule is asked, and its allow lets an ordinary call on.
      expect(await outcome(gate.guard('Bash', { command: 'ls -la' }))).toBeNull()
      expect(m.requests.length).toBeGreaterThan(0)
    } finally {
      await m.close()
    }
  })
})
