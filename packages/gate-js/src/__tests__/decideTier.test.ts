/**
 * Tier D of {@link Gate.guard}: the snapshot's decide rules on the tool, asked
 * of the self-hosted engine after every deterministic tier allowed the call.
 * The engine is the shared mock (`fixtures/decide-mock-engine.mjs`); no model
 * runs. HOME moves to a temp directory, so the canary cache and any
 * `engine.json` are the test's own.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAN_EVALUATE_DECIDE, Gate } from '../gate.js'
import { IntuticGateEscalation, IntuticGateRefusal } from '../errors.js'
import { DECIDE_BUDGET_MS } from '../limits.js'
import { decideFallbackId, encodeDecideRecord, type DecideRecord } from '../decideRecord.js'
import { decideRuleHash, validateDecideRule } from '../decide.js'
import { createPreExecuteListener } from '../dsh.js'
// @ts-expect-error -- a plain ESM fixture without types
import { closedPort, startDecideMockEngine } from '../../../shared-types/fixtures/decide-mock-engine.mjs'

const WS = 'ws_demo'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const sha256 = (t: string) => createHash('sha256').update(t, 'utf-8').digest('hex')
const ENV_KEYS = ['HOME', 'INTUTIC_SNAPSHOT_RULES', 'INTUTIC_DECIDE_ENGINE_URL', 'INTUTIC_DECIDE_MODEL', 'INTUTIC_DECIDE_MODEL_DIGEST', 'INTUTIC_DECIDE_BUDGET_MS'] as const
const RULE_ID = 'decide.local:data.md#prod-data-export'

let dir: string
let saved: Record<string, string | undefined>
type Mock = Awaited<ReturnType<typeof startDecideMockEngine>>
let mocks: Mock[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'intutic-gate-decide-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.HOME = dir
})
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()))
  mocks = []
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A snapshot holding one decide rule on Bash (its record, and its fallback line when it enforces) and a deterministic block rule. */
function snapshotWith(rollout: 'shadow' | 'enforce'): string {
  const v = validateDecideRule({
    id: 'prod-data-export',
    on: 'tool_call',
    tools: ['Bash'],
    questions: { exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' } },
    when: 'exports',
    rollout,
  })
  if (!v.ok) throw new Error(v.reason)
  const fallbackId = rollout === 'enforce' ? decideFallbackId('prod-data-export', 'local:data.md', sha256) : null
  const record: DecideRecord = {
    v: 1,
    ref: 'local:data.md#prod-data-export',
    ruleHash: decideRuleHash(v.rule, sha256),
    fallbackId,
    rollout,
    stampedBy: 'rule',
    ir: v.rule,
    sopTitle: 'Production data handling',
    ruleText: 'Customer data never leaves production.',
    pins: [{ modelDigest: DIGEST, evalRunId: 'eval_local_01', source: 'local' }],
  } as DecideRecord
  const lines = ['@format\t2', encodeDecideRecord(record)]
  if (fallbackId) lines.push([fallbackId, 'block', '-', 'tool', 'Decide rule prod-data-export (Production data handling): upgrade to Intutic 3.0 to evaluate this rule', ' (Bash) '].join('\t'))
  lines.push(['d.rm', 'block', '-', 'command', 'Destructive', 'rm -rf'].join('\t'))
  const p = join(dir, 'policy-snapshot.rules')
  const digest = sha256(lines.join('\n')).slice(0, 32)
  writeFileSync(p, [`#workspace ${WS}`, `#digest ${digest}`, ...lines].join('\n') + '\n', 'utf-8')
  return p
}

function logprobs(top: Array<[string, number]>): unknown {
  return { choices: [{ logprobs: { content: [{ top_logprobs: top.map(([token, logprob]) => ({ token, logprob })) }] } }] }
}

async function engine(answer: 'yes' | 'no' | 'unsure'): Promise<Mock> {
  const rule: Array<[string, number]> =
    answer === 'yes' ? [['yes', -0.01], ['no', -5]] : answer === 'no' ? [['no', -0.01], ['yes', -5]] : [['yes', Math.log(0.5)], ['no', Math.log(0.5)]]
  const r = (match: string, top: Array<[string, number]>) => ({ method: 'POST', path: '/v1/chat/completions', match, status: 200, times: 100, body: logprobs(top) })
  const m = await startDecideMockEngine([
    r('QUESTION: Does this command copy customer data', rule),
    r('--no-preserve-root\\"}\\n\\nQUESTION: Does', [['yes', -0.01], ['no', -5]]),
    r('ls -la\\"}\\n\\nQUESTION: Does', [['no', -0.01], ['yes', -5]]),
    r('A) delete_files', [['A', -0.02], ['C', -4]]),
    r('A) none_of_these', [['C', -0.02], ['A', -4]]),
  ])
  mocks.push(m)
  process.env.INTUTIC_DECIDE_ENGINE_URL = m.url
  process.env.INTUTIC_DECIDE_MODEL = 'm'
  process.env.INTUTIC_DECIDE_MODEL_DIGEST = DIGEST
  return m
}

function gate(rollout: 'shadow' | 'enforce' = 'enforce'): Gate {
  process.env.INTUTIC_SNAPSHOT_RULES = snapshotWith(rollout)
  return new Gate({ repoRoot: dir, workspaceId: WS, useHookGate: false, useSopRules: false }, null)
}

const COMMAND = { command: 'pg_dump -h prod > /tmp/x.sql' }
const outcome = (p: Promise<void>) => p.then(() => null, (e: unknown) => e)

describe('Tier D', () => {
  it('is on, with the shared budget', () => {
    expect(CAN_EVALUATE_DECIDE).toBe(true)
    const shared = readFileSync(join(__dirname, '../../../shared-types/src/gateLimits.ts'), 'utf-8')
    expect(shared).toContain(`export const DECIDE_SDK_BUDGET_MS = ${DECIDE_BUDGET_MS}`)
  })

  it('refuses DECIDE_REFUSED when the engine says the rule covers the call', async () => {
    await engine('yes')
    const err = await outcome(gate().guard('Bash', COMMAND))
    expect(err).toBeInstanceOf(IntuticGateRefusal)
    expect(err).not.toBeInstanceOf(IntuticGateEscalation)
    expect((err as IntuticGateRefusal).code).toBe('DECIDE_REFUSED')
    expect((err as IntuticGateRefusal).reason).toBe(`Decide rule prod-data-export (Production data handling) refused this call [${RULE_ID}]`)
  })

  it('allows what the engine says the rule does not cover', async () => {
    await engine('no')
    expect(await outcome(gate().guard('Bash', COMMAND))).toBeNull()
  })

  it('throws IntuticGateEscalation, a refusal, when the rule cannot decide', async () => {
    await engine('unsure')
    const err = await outcome(gate().guard('Bash', COMMAND))
    expect(err).toBeInstanceOf(IntuticGateEscalation)
    expect(err).toBeInstanceOf(IntuticGateRefusal)
    expect((err as IntuticGateEscalation).code).toBe('DECIDE_ESCALATED')
    expect((err as IntuticGateEscalation).ruleId).toBe(RULE_ID)
    expect((err as IntuticGateEscalation).reason).toBe(
      `Needs a person: Production data handling — Does this command copy customer data out of the production database? [${RULE_ID}]`,
    )
  })

  it('asks the engine nothing about a call a deterministic tier refused', async () => {
    const m = await engine('no')
    const err = await outcome(gate().guard('Bash', { command: 'rm -rf build' }))
    expect((err as IntuticGateRefusal).code).toBe('SNAPSHOT')
    expect(m.requests).toEqual([])
  })

  it('refuses GOVERNANCE_UNAVAILABLE when the engine does not answer, and lets a shadow rule\'s call on', async () => {
    process.env.INTUTIC_DECIDE_ENGINE_URL = `http://127.0.0.1:${await closedPort()}`
    process.env.INTUTIC_DECIDE_MODEL = 'm'
    process.env.INTUTIC_DECIDE_MODEL_DIGEST = DIGEST
    const err = await outcome(gate().guard('Bash', COMMAND))
    expect((err as IntuticGateRefusal).code).toBe('GOVERNANCE_UNAVAILABLE')
    expect(await outcome(gate('shadow').guard('Bash', COMMAND))).toBeNull()
  })

  it('asks nothing for a tool no decide rule names', async () => {
    const m = await engine('yes')
    expect(await outcome(gate().guard('Read', { file_path: '/tmp/notes.txt' }))).toBeNull()
    expect(m.requests).toEqual([])
  })

  it('stops at INTUTIC_DECIDE_BUDGET_MS', async () => {
    const m = await startDecideMockEngine([{ method: 'POST', path: '/v1/chat/completions', status: 200, times: 100, delayMs: 2000, body: logprobs([['no', -0.01]]) }])
    mocks.push(m)
    process.env.INTUTIC_DECIDE_ENGINE_URL = m.url
    process.env.INTUTIC_DECIDE_MODEL = 'm'
    process.env.INTUTIC_DECIDE_MODEL_DIGEST = DIGEST
    process.env.INTUTIC_DECIDE_BUDGET_MS = '300'
    const started = Date.now()
    const err = await outcome(gate().guard('Bash', COMMAND))
    expect((err as IntuticGateRefusal).code).toBe('GOVERNANCE_UNAVAILABLE')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  /** engine.json as `intutic doctor` leaves it, with the per-call p95 it measured. */
  function storedP95(q95Ms: number): void {
    mkdirSync(join(dir, '.intutic', 'decide'), { recursive: true })
    writeFileSync(join(dir, '.intutic', 'decide', 'engine.json'), JSON.stringify({ q95Ms, q95MeasuredAt: '2026-10-17T09:00:00.000Z' }))
  }

  it('escalates without asking the engine when the p95 doctor stored does not fit the budget', async () => {
    // One call at a p95 of 8 s is over the 7,300 ms budget.
    const m = await engine('yes')
    storedP95(8000)
    const err = await outcome(gate().guard('Bash', COMMAND))
    expect(err).toBeInstanceOf(IntuticGateEscalation)
    expect((err as IntuticGateEscalation).code).toBe('DECIDE_ESCALATED')
    expect((err as IntuticGateEscalation).ruleId).toBe(RULE_ID)
    expect((err as IntuticGateEscalation).reason).toBe(
      `Needs a person: Production data handling — the decide engine cannot answer rule prod-data-export within this call's time budget [${RULE_ID}]`,
    )
    expect(m.requests).toEqual([])
    // A shadow rule the budget cannot fit is skipped, and the call goes on.
    expect(await outcome(gate('shadow').guard('Bash', COMMAND))).toBeNull()
    expect(m.requests).toEqual([])
  })

  it('asks as usual when the stored p95 fits the budget', async () => {
    await engine('yes')
    storedP95(20)
    expect(((await outcome(gate().guard('Bash', COMMAND))) as IntuticGateRefusal).code).toBe('DECIDE_REFUSED')
    // A larger budget fits a p95 the default does not.
    storedP95(8000)
    process.env.INTUTIC_DECIDE_BUDGET_MS = '20000'
    expect(((await outcome(gate().guard('Bash', COMMAND))) as IntuticGateRefusal).code).toBe('DECIDE_REFUSED')
  })
})

describe('the decide log', () => {
  const v = validateDecideRule({
    id: 'prod-data-export',
    on: 'tool_call',
    tools: ['Bash'],
    questions: { exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' } },
    when: 'exports',
  })
  if (!v.ok) throw new Error(v.reason)
  const RULE_HASH = decideRuleHash(v.rule, sha256)

  /** Every line of every decide log file under HOME. */
  function logLines(): Array<Record<string, unknown>> {
    const logs = join(dir, '.intutic', 'logs')
    let names: string[]
    try {
      names = readdirSync(logs).filter((n) => /^decide-\d{4}-\d\d-\d\d\.jsonl$/.test(n))
    } catch {
      return []
    }
    return names.flatMap((n) => readFileSync(join(logs, n), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>))
  }

  it('writes one decide.decision record per decision, as `intutic decide check` does', async () => {
    await engine('yes')
    await outcome(gate().guard('Bash', { command: 'pg_dump -h prod | mail dev.one@example.com' }))
    await engine('no')
    expect(await outcome(gate().guard('Bash', COMMAND))).toBeNull()
    const records = logLines().filter((l) => l.event === 'decide.decision')
    expect(records.map((r) => r.outcome)).toEqual(['refuse', 'allow'])
    const [first] = records
    expect(first).toMatchObject({ v: 1, harness: 'sdk', workspaceId: WS, sessionId: '', tool: 'Bash', code: 'DECIDE_REFUSED', budgetMs: DECIDE_BUDGET_MS })
    expect(first!.argsExcerpt).toBe('{"command":"pg_dump -h prod | mail [REDACTED]"}')
    expect(first!.engine).toMatchObject({ adapter: 'logprobs', model: 'm', digest: DIGEST, digestStrength: 'strong' })
    expect((first!.rules as Array<Record<string, unknown>>)[0]).toMatchObject({ ref: 'local:data.md#prod-data-export', ruleHash: RULE_HASH, effective: 'enforce', when: 'T', outcome: 'refuse' })
    const logs = join(dir, '.intutic', 'logs')
    expect(statSync(join(logs, readdirSync(logs)[0]!)).mode & 0o777).toBe(0o600)
    // Each answered decision is kept for drift.
    const stats = JSON.parse(readFileSync(join(dir, '.intutic', 'decide', 'stats', `${RULE_HASH}.json`), 'utf-8'))
    expect(stats.decisions.map((d: { outcome: string }) => d.outcome)).toEqual(['refuse', 'allow'])
  })

  it('raises decide.drift from the records it writes, against the eval run of the pin', async () => {
    const runs = join(dir, '.intutic', 'decide', 'evals', RULE_HASH, 'runs')
    mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'eval_local_01.json'), JSON.stringify({ v: 1, evalRunId: 'eval_local_01', baseline: { evalRunId: 'eval_local_01', escalationRate: 0, questions: {} } }))
    await engine('unsure')
    const g = gate()
    for (let i = 0; i < 22; i++) expect(await outcome(g.guard('Bash', COMMAND))).toBeInstanceOf(IntuticGateEscalation)
    const drift = logLines().filter((l) => l.event === 'decide.drift')
    expect(drift).toEqual([expect.objectContaining({ ruleRef: 'local:data.md#prod-data-export', ruleHash: RULE_HASH, evalRunId: 'eval_local_01', measure: 'escalation_rate', n: 20 })])
  })

  it('never fails a call when the log cannot be written', async () => {
    mkdirSync(join(dir, '.intutic'), { recursive: true })
    writeFileSync(join(dir, '.intutic', 'logs'), 'not a directory')
    await engine('no')
    expect(await outcome(gate().guard('Bash', COMMAND))).toBeNull()
    await engine('yes')
    expect(((await outcome(gate().guard('Bash', COMMAND))) as IntuticGateRefusal).code).toBe('DECIDE_REFUSED')
  })
})

describe('dsh', () => {
  it('asks through dsh\'s approval when a rule cannot decide, and denies its refusals', async () => {
    await engine('unsure')
    const listener = createPreExecuteListener(gate())
    const next = async () => ({ kind: 'allow' as const })
    expect(await listener({ name: 'Bash', arguments: COMMAND }, next)).toEqual({
      kind: 'ask',
      reason: `Needs a person: Production data handling — Does this command copy customer data out of the production database? [${RULE_ID}]`,
    })
    expect((await listener({ name: 'Bash', arguments: { command: 'rm -rf build' } }, next)).kind).toBe('deny')
  })
})
