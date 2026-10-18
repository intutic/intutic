// Runs one case of decide-sdk-vectors.json through a `decide(state,
// questions, opts)` and lists every way the result differs from the case's
// `expect`; an empty list is a pass. The shared-types, gate SDK and clawde SDK
// tests all run their own decide() through it, so the three read the vectors
// the same way. The Python SDK's test reads them the same way in Python.
import { startDecideMockEngine } from './decide-mock-engine.mjs'

const TOLERANCE = 1e-12

function expand(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === 'repeat,times') return v.repeat.repeat(v.times)
  return v
}

function withMock(v, url) {
  if (typeof v === 'string') return v === '$MOCK' ? url : v
  if (Array.isArray(v)) return v.map((x) => withMock(x, url))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withMock(x, url)]))
  return v
}

/** The options a case passes to decide(), against a mock engine at `url`. */
export function decideSdkOptions(c, url) {
  const opts = { env: withMock(c.env ?? {}, url) }
  for (const k of ['when', 'band', 'escalate']) if (c[k] !== undefined) opts[k] = c[k]
  if (c.engine) {
    opts.engine = {
      url: c.engine.url ?? url,
      adapter: c.engine.adapter,
      model: c.engine.model,
      timeoutMs: 5000,
      parallel: 1,
      structured: false,
      ollama: c.engine.ollama ?? false,
    }
  } else {
    opts.engineFile = withMock(c.engineFile ?? null, url)
  }
  return opts
}

function close(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= TOLERANCE
}

function compareAnswer(name, got, want, out) {
  if (!got) return void out.push(`answers.${name}: missing`)
  if (got.type !== want.type) out.push(`answers.${name}.type: ${got.type} != ${want.type}`)
  if ('p' in want && !(want.p === null ? got.p === null : close(got.p, want.p))) out.push(`answers.${name}.p: ${got.p} != ${want.p}`)
  if ('value' in want && got.value !== want.value) out.push(`answers.${name}.value: ${got.value} != ${want.value}`)
  if ('choice' in want && got.choice !== want.choice) out.push(`answers.${name}.choice: ${got.choice} != ${want.choice}`)
  if (want.perOrder) {
    const per = got.perOrder ?? []
    if (per.length !== want.perOrder.length) out.push(`answers.${name}.perOrder: ${per.length} orders != ${want.perOrder.length}`)
    want.perOrder.forEach((m, k) => {
      for (const [o, p] of Object.entries(m)) if (!close(per[k]?.[o], p)) out.push(`answers.${name}.perOrder[${k}].${o}: ${per[k]?.[o]} != ${p}`)
      if (Object.keys(per[k] ?? {}).length !== Object.keys(m).length) out.push(`answers.${name}.perOrder[${k}]: other options`)
    })
  }
  if (want.values) {
    for (const [o, v] of Object.entries(want.values)) if (got.options?.[o]?.value !== v) out.push(`answers.${name}.options.${o}.value: ${got.options?.[o]?.value} != ${v}`)
    if (Object.keys(got.options ?? {}).length !== Object.keys(want.values).length) out.push(`answers.${name}.options: other options`)
  }
}

/** Runs case `c` through `decide`; resolves to the list of mismatches. */
export async function runDecideSdkCase(c, decide) {
  const mock = await startDecideMockEngine(c.replay)
  const out = []
  const want = c.expect
  try {
    let result
    let thrown
    try {
      result = await decide(expand(c.state), c.questions, decideSdkOptions(c, mock.url))
    } catch (err) {
      thrown = err
    }
    if (want.invalid !== undefined) {
      if (!(thrown instanceof TypeError) || thrown.message !== want.invalid) out.push(`expected TypeError ${JSON.stringify(want.invalid)}, got ${thrown ? `${thrown.name}: ${thrown.message}` : 'a result'}`)
    } else if (want.error !== undefined && result === undefined) {
      if (thrown?.code !== want.error) out.push(`expected engine error ${want.error}, got ${thrown ? `${thrown.name} ${thrown.code}: ${thrown.message}` : 'a result'}`)
    } else if (thrown) {
      out.push(`unexpected ${thrown.name} ${thrown.code ?? ''}: ${thrown.message}`)
    } else {
      for (const k of ['value', 'outcome', 'code', 'via', 'error', 'model', 'modelDigest', 'digestStrength']) {
        if (k in want && result[k] !== want[k]) out.push(`${k}: ${JSON.stringify(result[k])} != ${JSON.stringify(want[k])}`)
      }
      for (const [name, a] of Object.entries(want.answers ?? {})) compareAnswer(name, result.answers?.[name], a, out)
      if (want.answers && Object.keys(result.answers ?? {}).length !== Object.keys(want.answers).length) out.push('answers: other questions')
    }
    if (mock.requests.length !== want.requests) out.push(`requests: ${mock.requests.length} != ${want.requests}`)
    if (want.sentModels) {
      const sent = mock.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body?.model)
      if (JSON.stringify(sent) !== JSON.stringify(want.sentModels)) out.push(`sentModels: ${JSON.stringify(sent)}`)
    }
  } finally {
    await mock.close()
  }
  return out
}
