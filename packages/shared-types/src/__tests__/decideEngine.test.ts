/**
 * The decide engine client and its host guard, held to
 * `fixtures/decide-engine-vectors.json`, which the Python and Rust clients
 * run too. Engine cases go through a mock engine that replays recorded
 * responses; no model runs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDecideResponseState,
  buildDecideToolCallState,
  createDecideEngine,
  decideEngineErrorOutcome,
  decideQuestionPrompts,
  DecideEngineError,
  DECIDE_UNAVAILABLE_REFUSAL,
  resolveDecideEngineConfig,
  type DecideEngineConfig,
  type DecideEngineErrorCode,
  type DecideQuestionCall,
} from '../decideEngine.js'
import { checkSelfHostedDecisionHost } from '../decideHostGuard.js'
// @ts-expect-error -- a plain ESM fixture without types
import { closedPort, startDecideMockEngine } from '../../fixtures/decide-mock-engine.mjs'

const VECTORS = JSON.parse(readFileSync(join(__dirname, '../../fixtures/decide-engine-vectors.json'), 'utf8'))

type Repeat = { repeat: string; times: number }
const isRepeat = (v: unknown): v is Repeat =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === 'repeat,times'

/** Expands {repeat, times} anywhere in a vector value. */
function expand(v: unknown): unknown {
  if (isRepeat(v)) return v.repeat.repeat(v.times)
  if (Array.isArray(v)) return v.map(expand)
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  return v
}
const joined = (v: unknown): string => (Array.isArray(v) ? (expand(v) as string[]).join('') : (expand(v) as string))

type Mock = Awaited<ReturnType<typeof startDecideMockEngine>>
let mocks: Mock[] = []
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()))
  mocks = []
})
async function mock(replay: unknown[]): Promise<Mock> {
  const m = await startDecideMockEngine(replay)
  mocks.push(m)
  return m
}

function config(url: string, c: Record<string, unknown>): DecideEngineConfig {
  return {
    url,
    adapter: c.adapter as DecideEngineConfig['adapter'],
    model: c.model as string,
    timeoutMs: (c.timeoutMs as number) ?? 5000,
    parallel: 1,
    structured: (c.structured as boolean) ?? false,
    ollama: (c.ollama as boolean) ?? false,
    ...(c.modelDigest ? { modelDigest: c.modelDigest as string } : {}),
  }
}

async function caught<T>(p: Promise<T> | (() => T)): Promise<DecideEngineError> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (err) {
    expect(err).toBeInstanceOf(DecideEngineError)
    return err as DecideEngineError
  }
  throw new Error('expected a DecideEngineError')
}

describe('host guard', () => {
  it.each(VECTORS.host.map((c: { name: string }) => [c.name, c]))('%s', (_n, c) => {
    const v = checkSelfHostedDecisionHost(c.url, c.listed)
    expect({ ok: v.ok, reason: v.reason }).toEqual({ ok: c.ok, reason: c.reason })
  })

  it('logs a refused host, never the key', () => {
    const events: Array<[string, Record<string, unknown>]> = []
    const key = ['sk', 'test', 'decide'].join('-')
    expect(() =>
      createDecideEngine(
        { ...resolveDecideEngineConfig({ model: 'm', url: 'https://api.fireworks.ai/inference' }, {}), apiKey: key },
        { log: (e, f) => events.push([e, f]) },
      ),
    ).toThrow(DecideEngineError)
    expect(events).toEqual([['decide_engine_not_self_hosted', { host: 'api.fireworks.ai', reason: 'denylist' }]])
    expect(JSON.stringify(events)).not.toContain(key)
  })
})

describe('configuration', () => {
  it.each(VECTORS.config.map((c: { name: string }) => [c.name, c]))('%s', async (_n, c) => {
    const run = () => {
      const cfg = resolveDecideEngineConfig(c.file, c.env)
      createDecideEngine(cfg)
      return cfg
    }
    if (c.error) expect((await caught(run)).code).toBe(c.error)
    else expect(run()).toEqual(c.expect)
  })
})

describe('state', () => {
  it.each(VECTORS.state.map((c: { name: string }) => [c.name, c]))('%s', async (_n, c) => {
    const input = expand(c.input) as Record<string, unknown> & { kind: string }
    const build = () =>
      input.kind === 'response'
        ? buildDecideResponseState(input as never)
        : buildDecideToolCallState(input as never)
    if (c.error) expect((await caught(build)).code).toBe(c.error)
    else expect(build()).toBe(joined(c.expect))
  })
})

describe('question prompts', () => {
  it.each(VECTORS.prompts.map((c: { name: string }) => [c.name, c]))('%s', (_n, c) => {
    expect(decideQuestionPrompts(c.question)).toEqual(c.expect)
  })
})

describe('engine', () => {
  it.each(VECTORS.engine.map((c: { name: string }) => [c.name, c]))('%s', async (_n, c) => {
    const m = await mock(c.replay)
    const url = c.down ? `http://127.0.0.1:${await closedPort()}` : m.url
    const engine = createDecideEngine(config(url, c))
    const ask = engine.ask(joined(c.state), c.questions, Date.now() + (c.budgetMs ?? 5000))
    if (c.expect.error) {
      const err = await caught(ask)
      expect(err.code).toBe(c.expect.error)
      expect(err.status).toBe(c.expect.status)
    } else {
      const r = await ask
      expect({ model: r.model, modelDigest: r.modelDigest, digestStrength: r.digestStrength, adapter: r.adapter }).toEqual({
        model: c.expect.model,
        modelDigest: c.expect.modelDigest,
        digestStrength: c.expect.digestStrength,
        adapter: c.adapter,
      })
      for (const [name, want] of Object.entries(c.expect.answers) as Array<[string, Record<string, unknown>]>) {
        const got = r.answers[name]
        expect(got.type).toBe(want.type)
        if (want.p !== undefined) expect(got.p).toBeCloseTo(want.p as number, 9)
        if (want.perOrder !== undefined) {
          const orders = want.perOrder as Array<Record<string, number>>
          expect(got.perOrder).toHaveLength(orders.length)
          orders.forEach((o, k) => {
            expect(Object.keys(got.perOrder![k]).sort()).toEqual(Object.keys(o).sort())
            for (const [opt, p] of Object.entries(o)) expect(got.perOrder![k][opt]).toBeCloseTo(p, 9)
          })
        }
      }
      expect(m.unmatched).toEqual([])
    }
    if (c.requests) {
      const sent = m.requests.map((q: { method: string; path: string; body: unknown }) =>
        q.body === undefined ? { method: q.method, path: q.path } : { method: q.method, path: q.path, body: q.body },
      )
      expect(sent).toHaveLength(c.requests.length)
      for (const want of c.requests) expect(sent).toContainEqual(want)
    }
  })

  it('caps the requests in flight at parallel', async () => {
    const top = [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.4 }]
    const reply = { choices: [{ logprobs: { content: [{ token: 'yes', logprob: -0.1, top_logprobs: top }] } }] }
    const questions: DecideQuestionCall[] = Array.from({ length: 6 }, (_, i) => ({ name: `q${i}`, type: 'yes_no', ask: `Question number ${i}?` }))
    const m = await mock(questions.map((q) => ({ method: 'POST', path: '/v1/chat/completions', match: q.ask, status: 200, body: reply, delayMs: 60 })))
    const engine = createDecideEngine({ ...config(m.url, { adapter: 'logprobs', model: 'm' }), parallel: 2 })
    const r = await engine.ask('STATE', questions, Date.now() + 5000)
    expect(Object.keys(r.answers)).toHaveLength(6)
    expect(m.maxInFlight).toBe(2)
  })

  it('sends the key as a bearer token', async () => {
    const key = ['test', 'decide', 'key'].join('-')
    const m = await mock([{ method: 'POST', path: '/v1/systemone', status: 200, body: { model: 'k', answers: { a: { type: 'noul', noul: 0.2 } } } }])
    await createDecideEngine({ ...config(m.url, { adapter: 'systemone', model: 'k' }), apiKey: key }).ask(
      'S',
      [{ name: 'a', type: 'yes_no', ask: 'Is it?' }],
      Date.now() + 5000,
    )
    expect(m.requests[0].headers.authorization).toBe(`Bearer ${key}`)
  })
})

describe('prefix bytes', () => {
  const state = buildDecideToolCallState({
    ruleId: 'prod-data-export',
    sopTitle: 'Production data handling',
    ruleText: 'Never copy customer data out of production.',
    tool: 'Bash',
    cwd: '/repo',
    toolInput: { command: 'pg_dump -h prod > /tmp/x.sql' },
  })
  const questions: DecideQuestionCall[] = [
    ...Array.from({ length: 6 }, (_, i): DecideQuestionCall => ({ name: `q${i}`, type: 'yes_no', ask: `Yes or no question ${i}?` })),
    { name: 'dest', type: 'choice', ask: 'Where does the data go?', options: ['local_file', 'cloud_bucket', 'external_host', 'none_of_these'] },
    { name: 'kind', type: 'choice', ask: 'What kind of data?', options: ['customer', 'internal', 'none_of_these'] },
  ]

  it('every logprobs call starts with the same state bytes, then its question', async () => {
    const yes = [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.4 }]
    const letter = [{ token: 'A', logprob: -0.1 }, { token: 'B', logprob: -2.4 }]
    const reply = (top: unknown) => ({ choices: [{ logprobs: { content: [{ top_logprobs: top }] } }] })
    const m = await mock(
      questions.flatMap((q) =>
        decideQuestionPrompts(q).map(() => ({ method: 'POST', path: '/v1/chat/completions', match: q.ask, status: 200, body: reply(q.type === 'yes_no' ? yes : letter) })),
      ),
    )
    await createDecideEngine({ ...config(m.url, { adapter: 'logprobs', model: 'm' }), parallel: 4 }).ask(state, questions, Date.now() + 5000)
    const contents = m.requests.map((r: { body: { messages: Array<{ content: string }> } }) => r.body.messages[0].content)
    const expected = questions.flatMap((q) => decideQuestionPrompts(q).map((p) => state + p))
    expect(contents).toHaveLength(6 + 3 + 2)
    expect([...contents].sort()).toEqual([...expected].sort())
    for (const c of contents) expect(Buffer.from(c).subarray(0, Buffer.byteLength(state)).equals(Buffer.from(state))).toBe(true)
  })

  it('every systemone and decisions request carries the same state', async () => {
    const choices = questions.filter((q) => q.type === 'choice')
    const flat = (o: string[]) => Object.fromEntries(o.map((x) => [x, 1 / o.length]))
    const bodies = {
      systemone: {
        model: 'm',
        answers: Object.fromEntries(
          questions.map((q) => [q.name, q.type === 'yes_no' ? { type: 'noul', noul: 0.5 } : { type: 'choice', probabilities: flat(q.options!) }]),
        ),
      },
      decisions: {
        model: 'm',
        answers: [
          ...questions.filter((q) => q.type === 'yes_no').map((q) => ({ type: 'predicate', name: q.name, probability: 0.5 })),
          ...choices.map((q) => ({ type: 'choice', name: q.name, probabilities: q.options!.map((value) => ({ value, probability: 0.25 })) })),
        ],
      },
    }
    for (const adapter of ['systemone', 'decisions'] as const) {
      const path = `/v1/${adapter}`
      const m = await mock([0, 1, 2].map(() => ({ method: 'POST', path, status: 200, body: bodies[adapter] })))
      const r = await createDecideEngine(config(m.url, { adapter, model: 'm' })).ask(state, questions, Date.now() + 5000)
      expect(r.answers.dest.perOrder).toHaveLength(3)
      expect(r.answers.kind.perOrder).toHaveLength(2)
      expect(m.requests).toHaveLength(3)
      for (const r of m.requests) expect(adapter === 'systemone' ? r.body.state : r.body.input).toBe(state)
    }
  })
})

describe('canary', () => {
  const reply = (top: Array<[string, number]>) => ({
    choices: [{ logprobs: { content: [{ top_logprobs: top.map(([token, logprob]) => ({ token, logprob })) }] } }],
  })
  const replay = (pV: Array<[string, number]>, pC: Array<[string, number]>) => [
    { method: 'POST', path: '/v1/chat/completions', match: '--no-preserve-root\\"}\\n\\nQUESTION: Does', status: 200, body: reply(pV) },
    { method: 'POST', path: '/v1/chat/completions', match: 'ls -la', status: 200, body: reply(pC) },
    { method: 'POST', path: '/v1/chat/completions', match: 'A) delete_files', status: 200, body: reply([['A', -0.02], ['C', -4]]) },
    { method: 'POST', path: '/v1/chat/completions', match: 'A) none_of_these', status: 200, body: reply([['C', -0.02], ['A', -4]]) },
  ]

  it('passes a model that knows the answers', async () => {
    const m = await mock(replay([['yes', -0.01], ['no', -5]], [['no', -0.01], ['yes', -5]]))
    const r = await createDecideEngine(config(m.url, { adapter: 'logprobs', model: 'm' })).canary(Date.now() + 5000)
    expect(r).toMatchObject({ ok: true, choiceTop: 'delete_files' })
    expect(m.unmatched).toEqual([])
  })

  it('fails an always-allow model', async () => {
    const m = await mock(replay([['no', -0.01], ['yes', -5]], [['no', -0.01], ['yes', -5]]))
    const r = await createDecideEngine(config(m.url, { adapter: 'logprobs', model: 'm' })).canary(Date.now() + 5000)
    expect(r.ok).toBe(false)
    expect(r.pViolation).toBeLessThan(0.15)
  })
})

describe('error outcomes', () => {
  it.each(VECTORS.outcome.map((c: { code: string }) => [c.code, c]))('%s', (_n, c) => {
    const outcome = decideEngineErrorOutcome(c.code as DecideEngineErrorCode)
    expect(outcome).toBe(c.outcome)
    expect(outcome === 'unavailable' ? DECIDE_UNAVAILABLE_REFUSAL : null).toBe(c.refusal)
  })
})
