/**
 * The engine protections around one call's decide rules, held to the
 * `rollout` and `evaluate` groups of `fixtures/decide-engine-vectors.json`,
 * which the Python and Rust ports run too. Engine cases go through the mock
 * engine; no model runs.
 */
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideRuleHash, validateDecideRule, type DecideRule } from '../decide.js'
import type { DecidePin, DecideStamp } from '../decideRecord.js'
import { createDecideEngine, DecideEngineError, runDecideCanary, type DecideEngine, type DecideEngineConfig } from '../decideEngine.js'
import {
  createDecideCanaryFileStore,
  DECIDE_CANARY_FILE,
  DECIDE_CANARY_TTL_MS,
  decideCanaryFresh,
  decideEffectiveRollout,
  evaluateDecideCall,
  type DecideEvaluateDeps,
  type DecideRuleEntry,
} from '../decideEvaluate.js'
// @ts-expect-error -- a plain ESM fixture without types
import { closedPort, startDecideMockEngine } from '../../fixtures/decide-mock-engine.mjs'

const VECTORS = JSON.parse(fs.readFileSync(join(__dirname, '../../fixtures/decide-engine-vectors.json'), 'utf8'))
const sha256Hex = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

type Mock = Awaited<ReturnType<typeof startDecideMockEngine>>
let mocks: Mock[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()))
  mocks = []
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
async function mock(replay: unknown[]): Promise<Mock> {
  const m = await startDecideMockEngine(replay)
  mocks.push(m)
  return m
}
function canaryFile(): string {
  const d = fs.mkdtempSync(join(tmpdir(), 'intutic-decide-canary-'))
  dirs.push(d)
  return join(d, 'decide', DECIDE_CANARY_FILE)
}

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
  return { ref: r.ref, ruleHash: r.ruleHash ?? decideRuleHash(v.rule, sha256Hex), rollout: r.rollout, stampedBy: r.stampedBy, ir: v.rule, sopTitle: r.sopTitle, ruleText: r.ruleText, pins: r.pins }
}

function config(url: string, c: Record<string, unknown>): DecideEngineConfig {
  return { url, adapter: c.adapter as DecideEngineConfig['adapter'], model: c.model as string, timeoutMs: 5000, parallel: 1, structured: false, ollama: (c.ollama as boolean) ?? false }
}

describe('effective rollout', () => {
  it.each(VECTORS.rollout.map((c: { name: string }) => [c.name, c]))('%s', (_n, c) => {
    const e = c.entry
    const got = decideEffectiveRollout({ ir: e.irRollout ? { rollout: e.irRollout } : {}, rollout: e.rollout, stampedBy: e.stampedBy, pins: e.pins }, c.modelDigest)
    expect({ effective: got.effective, why: got.why, evalRunId: got.pin?.evalRunId ?? null }).toEqual(c.expect)
  })
})

describe('evaluate', () => {
  it.each(VECTORS.evaluate.map((c: { name: string }) => [c.name, c]))('%s', async (_n, c) => {
    const m = c.down ? null : await mock(c.replay)
    const url = m ? m.url : `http://127.0.0.1:${await closedPort()}`
    const file = canaryFile()
    const store = createDecideCanaryFileStore(file, fs)
    if (c.canaryCache) {
      const k = c.canaryCache
      store.write({ url, modelDigest: k.modelDigest, ok: k.ok, atMs: Date.now() - k.ageMs, pViolation: 0.99, pClean: 0.01, choiceTop: 'delete_files' })
    }
    const deps: DecideEvaluateDeps = { engine: createDecideEngine(config(url, c.engine)), engineUrl: url, canary: store, sha256Hex }
    const got = await evaluateDecideCall(
      {
        deterministic: c.deterministic,
        tool: c.tool,
        toolInput: c.toolInput,
        cwd: c.cwd,
        lastUserTurn: c.lastUserTurn,
        rules: c.rules.map(entry),
        deadlineMs: Date.now() + 5000,
      },
      deps,
    )
    expect({
      outcome: got.call.outcome,
      code: got.call.code,
      ruleRef: got.call.ruleRef,
      rules: got.rules.map((r) => ({ ref: r.ref, effective: r.effective, why: r.why, outcome: r.outcome, error: r.error })),
      canary: got.canary,
    }).toEqual({ outcome: c.expect.outcome, code: c.expect.code, ruleRef: c.expect.ruleRef, rules: c.expect.rules, canary: c.expect.canary })
    expect(m ? m.requests.length : 0).toBe(c.expect.requests)
    const digest = got.engine?.modelDigest
    expect(digest ? (store.read(url, digest)?.ok ?? null) : null).toBe(c.expect.canaryStored)
    if (m) expect(m.unmatched).toEqual([])
    if (c.expect.sent) {
      const systems = m!.requests.filter((r: { path: string }) => r.path === '/v1/chat/completions').map((r: { body: { messages: Array<{ content: string }> } }) => r.body.messages[0]!.content)
      expect(systems.length).toBeGreaterThan(0)
      for (const text of systems) {
        for (const want of c.expect.sent.contains) expect(text).toContain(want)
        for (const not of c.expect.sent.excludes) expect(text).not.toContain(not)
      }
    }
  })

  it('treats an engine that could not be created as unavailable', async () => {
    const r = VECTORS.evaluate.find((c: { name: string }) => c.name.startsWith('an enforcing rule refuses'))
    const got = await evaluateDecideCall(
      { deterministic: 'allow', tool: 'Bash', toolInput: {}, cwd: '/', rules: r.rules.map(entry), deadlineMs: Date.now() + 5000 },
      { engine: new DecideEngineError('not_configured', 'no model'), engineUrl: '', canary: createDecideCanaryFileStore(canaryFile(), fs), sha256Hex },
    )
    expect(got.call).toMatchObject({ outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE' })
    expect(got.rules[0]).toMatchObject({ outcome: 'unavailable', error: 'not_configured' })
  })
})

describe('the canary catches an always-allow fault in this client', () => {
  /**
   * The client with a fault injected: it reads the other answer token, so a
   * model's yes comes back as a no and each choice's mass lands on the next
   * option. Every rule would allow; the canary asks through the same path.
   */
  function readsTheWrongToken(engine: DecideEngine): DecideEngine {
    const ask: DecideEngine['ask'] = async (state, questions, deadlineMs) => {
      const r = await engine.ask(state, questions, deadlineMs)
      const answers = Object.fromEntries(
        Object.entries(r.answers).map(([name, a]) => {
          const perOrder = a.perOrder?.map((order) => {
            const keys = Object.keys(order)
            return Object.fromEntries(keys.map((k, i) => [k, order[keys[(i + 1) % keys.length]!]!]))
          })
          return [name, { ...a, ...(a.p !== undefined ? { p: 1 - a.p } : {}), ...(perOrder ? { perOrder } : {}) }]
        }),
      )
      return { ...r, answers }
    }
    return { ask, describe: (d) => engine.describe(d), canary: (d) => runDecideCanary(ask, d) }
  }

  const c = VECTORS.evaluate.find((v: { name: string }) => v.name.startsWith('with no cached canary'))

  async function run(fault: boolean) {
    const m = await mock(c.replay)
    const engine = createDecideEngine(config(m.url, c.engine))
    return evaluateDecideCall(
      { deterministic: 'allow', tool: c.tool, toolInput: c.toolInput, cwd: c.cwd, rules: c.rules.map(entry), deadlineMs: Date.now() + 5000 },
      { engine: fault ? readsTheWrongToken(engine) : engine, engineUrl: m.url, canary: createDecideCanaryFileStore(canaryFile(), fs), sha256Hex },
    )
  }

  it('without the fault the rule refuses', async () => {
    expect((await run(false)).call).toMatchObject({ outcome: 'refuse', code: 'DECIDE_REFUSED' })
  })

  it('with it the canary fails, the allow is discarded and the enforcing rule refuses GOVERNANCE_UNAVAILABLE', async () => {
    const got = await run(true)
    expect(got.canary).toBe('failed')
    expect(got.call).toMatchObject({ outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleRef: 'local:data.md#prod-data-export' })
    expect(got.rules[0]).toMatchObject({ outcome: 'unavailable', error: 'canary_failed', answers: null })
  })
})

describe('canary file', () => {
  const entry = (url: string, ok = true, atMs = Date.now()) => ({ url, modelDigest: 'sha256:' + 'a'.repeat(64), ok, atMs, pViolation: 0.97, pClean: 0.02, choiceTop: 'delete_files' })

  it('round-trips an entry in a private file, replacing the one for the same engine and digest', () => {
    const file = canaryFile()
    const store = createDecideCanaryFileStore(file, fs)
    expect(store.read('http://127.0.0.1:11434', 'sha256:' + 'a'.repeat(64))).toBeNull()
    store.write(entry('http://127.0.0.1:11434', false))
    store.write(entry('http://127.0.0.1:11434', true))
    expect(store.read('http://127.0.0.1:11434', 'sha256:' + 'a'.repeat(64))?.ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(1)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the newest sixteen engines', () => {
    const store = createDecideCanaryFileStore(canaryFile(), fs)
    for (let i = 0; i < 20; i++) store.write(entry(`http://10.0.0.${i}:8000`))
    expect(store.read('http://10.0.0.3:8000', 'sha256:' + 'a'.repeat(64))).toBeNull()
    expect(store.read('http://10.0.0.4:8000', 'sha256:' + 'a'.repeat(64))).not.toBeNull()
  })

  it('reads a damaged file as empty', () => {
    const file = canaryFile()
    fs.mkdirSync(join(file, '..'), { recursive: true })
    fs.writeFileSync(file, '{"v":1,"entries":[{"url":1}]')
    expect(createDecideCanaryFileStore(file, fs).read('x', 'y')).toBeNull()
  })

  it('counts a pass as fresh for ten minutes, and a failure never', () => {
    const now = 1_800_000_000_000
    expect(decideCanaryFresh(entry('u', true, now - 1000), now)).toBe(true)
    expect(decideCanaryFresh(entry('u', true, now - DECIDE_CANARY_TTL_MS), now)).toBe(false)
    expect(decideCanaryFresh(entry('u', false, now - 1000), now)).toBe(false)
    expect(decideCanaryFresh(entry('u', true, now + 60_000), now)).toBe(false)
    expect(decideCanaryFresh(null, now)).toBe(false)
  })
})
