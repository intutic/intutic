/**
 * The decide modules as the JavaScript hook gates embed them
 * (`DECIDE_GATE_JS_SOURCE`): each module in a scope of its own, wired by
 * parameters. The `evaluate` vectors run through the embedded copy and must
 * come out as they do through the module, the decision a gate acts on reads
 * as the gates print it, and the decide log a gate writes is the module's.
 */
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideRuleHash, validateDecideRule, type DecideRule } from '../decide.js'
import type { DecidePin, DecideStamp } from '../decideRecord.js'
import { DECIDE_ENGINE_JS_SOURCE, type DecideEngineConfig } from '../decideEngine.js'
import { DECIDE_HOST_GUARD_JS_SOURCE } from '../decideHostGuard.js'
import {
  DECIDE_EVALUATE_JS_SOURCE,
  DECIDE_GATE_JS_SOURCE,
  decideDecision,
  decideShadowFindings,
  decideUnavailableDecision,
  type DecideEvaluation,
  type DecideRuleEntry,
} from '../decideEvaluate.js'
import { DECIDE_LOG_JS_SOURCE, decideLogDeps, decideLogEngine, readDecideEvalRunBaseline, writeDecideCallLog } from '../decideLog.js'
import { decideLogRedactionSources } from '../decideLogRedaction.js'
// @ts-expect-error -- a plain ESM fixture without types
import { closedPort, startDecideMockEngine } from '../../fixtures/decide-mock-engine.mjs'

const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../fixtures/decide-engine-vectors.json'), 'utf8'))
const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

type Mock = Awaited<ReturnType<typeof startDecideMockEngine>>
let mocks: Mock[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()))
  mocks = []
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface VectorRule {
  ref: string
  rule: DecideRule
  rollout: 'shadow' | 'enforce'
  stampedBy: DecideStamp
  sopTitle: string
  ruleText: string
  pins: DecidePin[]
  ruleHash?: string
}

function entry(r: VectorRule): DecideRuleEntry {
  const v = validateDecideRule(r.rule)
  if (!v.ok) throw new Error(`vector rule does not validate: ${v.reason}`)
  return { ref: r.ref, ruleHash: r.ruleHash ?? decideRuleHash(v.rule, sha256), rollout: r.rollout, stampedBy: r.stampedBy, ir: v.rule, sopTitle: r.sopTitle, ruleText: r.ruleText, pins: r.pins }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the embedded copy is untyped JavaScript
const lib = new Function(`return ${DECIDE_GATE_JS_SOURCE}`)()(sha256) as any

describe('the sources list every function their modules declare', () => {
  const declared = (file: string) => {
    const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    return [...src.matchAll(/^(?:export )?(?:async )?(?:function|class) (\w+)/gm)].map((m) => m[1]!)
  }

  it('decideEngine.ts', () => {
    const names = declared('decideEngine.ts').filter((n) => n !== 'decideModuleSource')
    expect(names.length).toBeGreaterThan(25)
    for (const name of names) expect(DECIDE_ENGINE_JS_SOURCE, name).toMatch(new RegExp(`(?:function|class) ${name}\\b`))
  })

  it('decideEvaluate.ts', () => {
    for (const name of declared('decideEvaluate.ts')) expect(DECIDE_EVALUATE_JS_SOURCE, name).toMatch(new RegExp(`function ${name}\\b`))
  })

  it('decideLog.ts', () => {
    const names = declared('decideLog.ts')
    expect(names.length).toBeGreaterThan(20)
    for (const name of names) expect(DECIDE_LOG_JS_SOURCE, name).toMatch(new RegExp(`function ${name}\\b`))
  })

  it('decideHostGuard.ts, as far as the check reads', () => {
    const writerOnly = ['DecideHostRefusedError', 'assertSelfHostedDecisionHost']
    for (const name of declared('decideHostGuard.ts').filter((n) => !writerOnly.includes(n))) {
      expect(DECIDE_HOST_GUARD_JS_SOURCE, name).toMatch(new RegExp(`function ${name}\\b`))
    }
  })

  it('carries no import, require or module reference', () => {
    expect(DECIDE_GATE_JS_SOURCE).not.toMatch(/\bimport\b|\brequire\(|_js_\d+\.|__vite_ssr_import_|\bexports\./)
  })
})

describe('the embedded copy evaluates the vectors as the module does', () => {
  it.each(VECTORS.evaluate.map((c: { name: string }) => [c.name, c]))('%s', async (_n, c) => {
    const m: Mock | null = c.down ? null : await startDecideMockEngine(c.replay)
    if (m) mocks.push(m)
    const url = m ? m.url : `http://127.0.0.1:${await closedPort()}`
    const d = fs.mkdtempSync(join(tmpdir(), 'intutic-decide-gate-src-'))
    dirs.push(d)
    const store = lib.canaryStore(join(d, 'canary.json'), fs)
    if (c.canaryCache) {
      const k = c.canaryCache
      store.write({ url, modelDigest: k.modelDigest, ok: k.ok, atMs: Date.now() - k.ageMs, pViolation: 0.99, pClean: 0.01, choiceTop: 'delete_files' })
    }
    const cfg: DecideEngineConfig = { url, adapter: c.engine.adapter, model: c.engine.model, timeoutMs: 5000, parallel: 1, structured: false, ollama: c.engine.ollama ?? false }
    const got = await lib.evaluate(
      { deterministic: c.deterministic, tool: c.tool, toolInput: c.toolInput, cwd: c.cwd, lastUserTurn: c.lastUserTurn, rules: c.rules.map(entry), deadlineMs: Date.now() + 5000 },
      { engine: lib.createEngine(cfg), engineUrl: url, canary: store, sha256Hex: sha256 },
    )
    expect({
      outcome: got.call.outcome,
      code: got.call.code,
      ruleRef: got.call.ruleRef,
      rules: got.rules.map((r: { ref: string; effective: string; why: string | null; outcome: string; error: string | null }) => ({ ref: r.ref, effective: r.effective, why: r.why, outcome: r.outcome, error: r.error })),
      canary: got.canary,
    }).toEqual({ outcome: c.expect.outcome, code: c.expect.code, ruleRef: c.expect.ruleRef, rules: c.expect.rules, canary: c.expect.canary })
    expect(m ? m.requests.length : 0).toBe(c.expect.requests)
  })

  it('refuses a hosted engine before any request', () => {
    expect(() => lib.createEngine({ url: 'https://api.openai.com', adapter: 'logprobs', model: 'm', timeoutMs: 5000, parallel: 1, structured: false, ollama: false })).toThrow(lib.EngineError)
  })
})

describe('the decision a gate acts on', () => {
  const rule = (over: Partial<DecideRuleEntry> = {}, ir: Partial<DecideRule> = {}): DecideRuleEntry => ({
    ref: 'local:data.md#prod-data-export',
    ruleHash: 'h',
    rollout: 'enforce',
    stampedBy: 'rule',
    sopTitle: 'Production data handling',
    ruleText: '',
    pins: [],
    ir: {
      id: 'prod-data-export',
      on: 'tool_call',
      tools: ['Bash'],
      questions: {
        exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' },
        dest: { type: 'choice', ask: 'Where does the data go?', options: ['local_file', 'external_host'] },
      },
      when: 'exports AND dest != none_of_these',
      rollout: 'enforce',
      ...ir,
    } as DecideRuleEntry['ir'],
    ...over,
  })
  const ev = (call: DecideEvaluation['call'], reports: Array<Partial<DecideEvaluation['rules'][number]>>): DecideEvaluation => ({
    call,
    rules: reports.map((r) => ({ ref: rule().ref, ruleHash: 'h', effective: 'enforce', why: null, outcome: 'allow', code: null, via: null, error: null, modelDigest: null, answers: null, ...r })),
    skipped: [],
    engine: null,
    canary: null,
  })
  const a = (p: number) => ({ name: 'exports', type: 'yes_no' as const, p, latencyMs: 1 })
  const choice = (perOrder: Array<Record<string, number>>) => ({ name: 'dest', type: 'choice' as const, perOrder, latencyMs: 1 })
  const sure = [{ local_file: 0.01, external_host: 0.98, none_of_these: 0.01 }, { none_of_these: 0.01, external_host: 0.98, local_file: 0.01 }]

  it('names the rule that refused', () => {
    const d = decideDecision(ev({ outcome: 'refuse', code: 'DECIDE_REFUSED', ruleRef: rule().ref, via: null, reason: null }, [{ outcome: 'refuse', code: 'DECIDE_REFUSED' }]), [rule()])
    expect(d).toEqual({ outcome: 'refuse', code: 'DECIDE_REFUSED', ruleId: 'decide.local:data.md#prod-data-export', via: null, reason: 'Decide rule prod-data-export (Production data handling) refused this call' })
  })

  it('asks a person the questions it could not answer, under the rule title', () => {
    const answers = { exports: a(0.5), dest: choice(sure) }
    const d = decideDecision(
      ev({ outcome: 'escalate', code: 'DECIDE_ESCALATED', ruleRef: rule().ref, via: 'ask', reason: null }, [{ outcome: 'escalate', code: 'DECIDE_ESCALATED', via: 'ask', answers }]),
      [rule({}, { title: 'Customer data export' })],
    )
    expect(d).toEqual({
      outcome: 'escalate',
      code: 'DECIDE_ESCALATED',
      ruleId: 'decide.local:data.md#prod-data-export',
      via: 'ask',
      reason: 'Needs a person: Customer data export — Does this command copy customer data out of the production database?',
    })
  })

  it('names a choice that cleared no band, and every question when no answer came back', () => {
    const split = [{ local_file: 0.5, external_host: 0.45, none_of_these: 0.05 }, { none_of_these: 0.05, external_host: 0.45, local_file: 0.5 }]
    const call = { outcome: 'refuse' as const, code: 'DECIDE_ESCALATED' as const, ruleRef: rule().ref, via: null, reason: null }
    expect(decideDecision(ev(call, [{ outcome: 'refuse', code: 'DECIDE_ESCALATED', answers: { exports: a(0.99), dest: choice(split) } }]), [rule()]).reason).toBe(
      'Needs a person: Production data handling — Where does the data go?',
    )
    expect(decideDecision(ev(call, [{ outcome: 'refuse', code: 'DECIDE_ESCALATED', error: 'too_large' }]), [rule()]).reason).toBe(
      'Needs a person: Production data handling — Does this command copy customer data out of the production database? Where does the data go?',
    )
  })

  it('says why the engine could not answer', () => {
    const d = decideDecision(
      ev({ outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleRef: rule().ref, via: null, reason: null }, [{ outcome: 'unavailable', error: 'timeout' }]),
      [rule()],
    )
    expect(d).toMatchObject({ code: 'GOVERNANCE_UNAVAILABLE', ruleId: 'decide.local:data.md#prod-data-export' })
    expect(d.reason).toBe('GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule prod-data-export (Production data handling): timeout')
    const many = decideDecision(ev({ outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleRef: null, via: null, reason: 'more than 4 decide rules name Bash' }, []), [rule()])
    expect(many).toEqual({ outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleId: null, via: null, reason: 'GOVERNANCE_UNAVAILABLE — more than 4 decide rules name Bash' })
  })

  it('allows with no reason', () => {
    expect(decideDecision(ev({ outcome: 'allow', code: null, ruleRef: null, via: null, reason: null }, []), [rule()])).toEqual({ outcome: 'allow', code: null, ruleId: null, via: null, reason: '' })
  })

  it('records what a shadow rule would have done, and nothing for an allow', () => {
    const e = ev({ outcome: 'allow', code: null, ruleRef: null, via: null, reason: null }, [
      { effective: 'shadow', outcome: 'refuse', code: 'DECIDE_REFUSED' },
      { ref: 'local:x.md#other', effective: 'shadow', outcome: 'allow' },
    ])
    expect(decideShadowFindings(e, [rule()])).toEqual([{ ruleId: 'decide.local:data.md#prod-data-export', reason: 'Decide rule prod-data-export (Production data handling) refused this call' }])
  })

  it('refuses when the tier could not run, unless every rule on the tool is stamped shadow', () => {
    expect(decideUnavailableDecision([rule({ rollout: 'shadow' }), rule({ ref: 'local:x.md#y', rollout: 'enforce' })], 'Bash', 'the decide check did not answer')).toEqual({
      outcome: 'refuse',
      code: 'GOVERNANCE_UNAVAILABLE',
      ruleId: 'decide.local:x.md#y',
      via: null,
      reason: 'GOVERNANCE_UNAVAILABLE — the decide check did not answer',
    })
    expect(decideUnavailableDecision([rule({ rollout: 'shadow' })], 'Bash', 'x').outcome).toBe('allow')
    expect(decideUnavailableDecision([rule()], 'Read', 'x').outcome).toBe('allow')
  })

  it('is the same function in the embedded copy', () => {
    const e = ev({ outcome: 'refuse', code: 'DECIDE_REFUSED', ruleRef: rule().ref, via: null, reason: null }, [{ outcome: 'refuse', code: 'DECIDE_REFUSED' }])
    expect(lib.decision(e, [rule()])).toEqual(decideDecision(e, [rule()]))
    expect(lib.unavailable([rule()], 'Bash', 'x')).toEqual(decideUnavailableDecision([rule()], 'Bash', 'x'))
  })
})

describe('the embedded decide log writes what the module writes', () => {
  const v = validateDecideRule({
    id: 'prod-data-export',
    on: 'tool_call',
    tools: ['Bash'],
    questions: {
      exports: { type: 'yes_no', ask: 'Does this command copy customer data out of the production database?' },
      dest: { type: 'choice', ask: 'Where does the data go?', options: ['local_file', 'cloud_bucket', 'external_host'] },
    },
    when: 'exports AND dest != none_of_these',
    rollout: 'enforce',
  })
  if (!v.ok) throw new Error(v.reason)
  const ruleHash = decideRuleHash(v.rule, sha256)
  const rule: DecideRuleEntry = {
    ref: 'local:data.md#prod-data-export',
    ruleHash,
    rollout: 'enforce',
    stampedBy: 'rule',
    ir: v.rule,
    sopTitle: 'Production data handling',
    ruleText: 'Customer data never leaves production.',
    pins: [{ modelDigest: 'sha256:aa', evalRunId: 'eval_local_01', source: 'local' }],
  }
  const evaluation = (): DecideEvaluation => ({
    call: { outcome: 'escalate', code: 'DECIDE_ESCALATED', ruleRef: rule.ref, via: 'ask', reason: null },
    rules: [
      {
        ref: rule.ref,
        ruleHash,
        effective: 'enforce',
        why: null,
        outcome: 'escalate',
        code: 'DECIDE_ESCALATED',
        via: 'ask',
        error: null,
        modelDigest: 'sha256:aa',
        answers: {
          exports: { name: 'exports', type: 'yes_no', p: 0.5, latencyMs: 5 },
          dest: {
            name: 'dest',
            type: 'choice',
            perOrder: [
              { local_file: 0.6, cloud_bucket: 0.3, external_host: 0.05, none_of_these: 0.05 },
              { local_file: 0.64, cloud_bucket: 0.32, external_host: 0.03, none_of_these: 0.01 },
            ],
            latencyMs: 5,
          },
        },
      },
    ],
    skipped: [],
    engine: { model: 'm', modelDigest: 'sha256:aa', digestStrength: 'strong' },
    canary: 'cached',
  })
  const cfg = { adapter: 'logprobs', url: 'http://127.0.0.1:11434/v1', model: 'm' }
  const ctx = (atMs: number, engine: unknown) => ({
    atMs,
    harness: 'claude-code',
    workspaceId: 'ws_1',
    sessionId: 's1',
    tool: 'Bash',
    toolInput: { command: 'pg_dump -h prod | mail dev.one@example.com' },
    cwd: '/repo',
    budgetMs: 7300,
    latencyMs: 12,
    engine,
    redact: decideLogRedactionSources(),
  })
  /** A home directory holding the eval run the rule's pin names, which drift compares against. */
  const home = () => {
    const d = fs.mkdtempSync(join(tmpdir(), 'intutic-decide-gate-log-'))
    dirs.push(d)
    const runs = join(d, '.intutic', 'decide', 'evals', ruleHash, 'runs')
    fs.mkdirSync(runs, { recursive: true })
    const baseline = { evalRunId: 'eval_local_01', escalationRate: 0, questions: {} }
    fs.writeFileSync(join(runs, 'eval_local_01.json'), JSON.stringify({ v: 1, evalRunId: 'eval_local_01', baseline }))
    return d
  }

  it('the same lines, stats and drift, under the same home layout', () => {
    const a = home()
    const b = home()
    const t0 = Date.parse('2026-10-20T09:00:00.000Z')
    let moduleDrifts = 0
    let embeddedDrifts = 0
    for (let i = 0; i < 25; i++) {
      const ev = evaluation()
      moduleDrifts += writeDecideCallLog(ev, [rule], ctx(t0 + i, decideLogEngine(cfg, ev)) as never, decideLogDeps(fs, a, sha256)).length
      embeddedDrifts += lib.writeLog(ev, [rule], ctx(t0 + i, lib.logEngine(cfg, ev)), lib.logDeps(fs, b, sha256)).length
    }
    expect(moduleDrifts).toBe(1)
    expect(embeddedDrifts).toBe(1)
    const log = (h: string) => fs.readFileSync(join(h, '.intutic', 'logs', 'decide-2026-10-20.jsonl'), 'utf8')
    expect(log(b)).toBe(log(a))
    const lines = log(a).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].engine).toEqual({ adapter: 'logprobs', host: '127.0.0.1:11434', model: 'm', digest: 'sha256:aa', digestStrength: 'strong', canary: 'cached' })
    expect(lines[0].argsExcerpt).toBe('{"command":"pg_dump -h prod | mail [REDACTED]"}')
    expect(lines.filter((l) => l.event === 'decide.drift')).toEqual([expect.objectContaining({ evalRunId: 'eval_local_01', measure: 'escalation_rate', n: 20 })])
    const stats = (h: string) => fs.readFileSync(join(h, '.intutic', 'decide', 'stats', `${ruleHash}.json`), 'utf8')
    expect(stats(b)).toBe(stats(a))
  })

  it('reads an eval run only by a plain name', () => {
    const decideDir = join(home(), '.intutic', 'decide')
    expect(readDecideEvalRunBaseline(fs, decideDir, ruleHash, 'eval_local_01')).toEqual({ evalRunId: 'eval_local_01', escalationRate: 0, questions: {} })
    expect(readDecideEvalRunBaseline(fs, decideDir, ruleHash, '../runs/eval_local_01')).toBeNull()
    expect(readDecideEvalRunBaseline(fs, decideDir, '..', 'eval_local_01')).toBeNull()
    expect(readDecideEvalRunBaseline(fs, decideDir, ruleHash, 'missing')).toBeNull()
  })

  it('names an unconfigured engine with no host', () => {
    expect(decideLogEngine(null, { engine: null, canary: null })).toEqual({ adapter: '', host: '', model: null, digest: null, digestStrength: null, canary: null })
  })
})
