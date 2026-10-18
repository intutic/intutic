/**
 * `decide(state, questions, opts)` for people building their own agents: ask
 * a self-hosted model a few narrow questions about a state, and get each
 * answer's probability, its three-valued reading through a band and, with a
 * `when`, the outcome a decide rule would reach.
 *
 * The questions are written as a decide rule's `questions` and validated
 * the same way, so wording that asks the model for approval is refused. Every
 * call goes through the engine client and its host guard: a hosted decision
 * API is refused before anything is sent, and there is no way to pass an
 * engine object that skips the guard.
 *
 * Errors are {@link DecideEngineError}s and are thrown, so a caller cannot
 * read an unavailable engine as an answer. The one exception is
 * `too_large`: a state over the limit is never truncated, every answer is
 * unknown, and with a `when` the outcome escalates.
 *
 * Self-contained but for the decide modules beside it, so `@intutic/gate` and
 * `@intutic/clawde` carry byte-identical copies; each wraps it in a `decide()`
 * that reads `~/.intutic/decide/engine.json` and the process environment. The
 * Python port is `intutic_clawde/gate/decide_sdk.py`. All three run
 * `fixtures/decide-sdk-vectors.json`.
 *
 * @module
 */

import {
  bandValue,
  choiceAtoms,
  decideOptions,
  decideQuestionBand,
  decideRuleOutcome,
  NONE_OF_THESE,
  validateDecideRule,
  type ChoiceAtom,
  type DecideAnswerInput,
  type DecideBand,
  type DecideQuestion,
  type DecideRule,
  type Tri,
} from './decide.js'
import {
  createDecideEngine,
  DECIDE_MAX_STATE_BYTES,
  DecideEngineError,
  resolveDecideEngineConfig,
  type DecideAdapter,
  type DecideEngineConfig,
  type DecideEngineResult,
} from './decideEngine.js'

/** The budget when neither `budgetMs` nor `INTUTIC_DECIDE_BUDGET_MS` sets one. */
export const DECIDE_SDK_DEFAULT_BUDGET_MS = 7_300
/** The engine configuration's path under the home directory. */
export const DECIDE_ENGINE_FILE_PATH = ['.intutic', 'decide', 'engine.json'] as const

export interface DecideSdkOptions {
  /** A `when` over the questions. With it, the result carries the rule's outcome. */
  when?: string
  /** The band for every question without its own (default `{yes_at: 0.85, no_below: 0.15}`). */
  band?: DecideBand
  /** What an unknown `when` does (default `ask`). */
  escalate?: 'ask' | 'review' | 'refuse'
  /** The engine's configuration. Without it, `engineFile` and `env` give it. */
  engine?: DecideEngineConfig
  /** The parsed `engine.json`, or null when there is none. */
  engineFile?: unknown
  /** The environment, which overrides `engineFile`. */
  env?: Record<string, string | undefined>
  /** Milliseconds for the whole call (default `INTUTIC_DECIDE_BUDGET_MS`, else 7,300). */
  budgetMs?: number
}

export type DecideSdkAnswer =
  | { type: 'yes_no'; p: number | null; value: Tri }
  | {
      type: 'choice'
      perOrder: Array<Record<string, number>> | null
      /** Each option's atom `q == o`: the mean over the orders, their spread, and its value. */
      options: Record<string, ChoiceAtom>
      /** The option whose atom is T, or null. At most one can be, because `yes_at` is above 0.5. */
      choice: string | null
    }

export interface DecideSdkResult {
  answers: Record<string, DecideSdkAnswer>
  /** `when`'s value, or null without a `when`. */
  value: Tri | null
  outcome: 'allow' | 'refuse' | 'escalate' | null
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | null
  via: 'ask' | 'review' | null
  /** `too_large` when the state was over 16,384 bytes, a tool call's limit, and nothing was asked. */
  error: 'too_large' | null
  model: string | null
  modelDigest: string | null
  digestStrength: 'strong' | 'weak' | null
  adapter: DecideAdapter
  latencyMs: number
}

/**
 * The rule the questions are checked as: an `on: response` rule whose `when`
 * is the caller's, or one naming every question once.
 */
function sdkRule(questions: Record<string, DecideQuestion>, opts: DecideSdkOptions): DecideRule {
  const when =
    opts.when ??
    Object.keys(questions)
      .sort()
      .map((n) => (questions[n]?.type === 'choice' ? `${n} == ${NONE_OF_THESE}` : n))
      .join(' OR ')
  const rule: DecideRule = { id: 'sdk', on: 'response', questions, when }
  if (opts.band !== undefined) rule.band = opts.band
  if (opts.escalate !== undefined) rule.escalate = opts.escalate
  return rule
}

function budgetFrom(opts: DecideSdkOptions, env: Record<string, string | undefined>): number {
  if (opts.budgetMs !== undefined) return opts.budgetMs
  const raw = env.INTUTIC_DECIDE_BUDGET_MS?.trim()
  if (!raw) return DECIDE_SDK_DEFAULT_BUDGET_MS
  if (!/^[0-9]+$/.test(raw)) throw new DecideEngineError('not_configured', 'INTUTIC_DECIDE_BUDGET_MS must be a whole number')
  return Number(raw)
}

/**
 * `engine.json`'s parsed content through `read`, or null when the file does
 * not exist. A file that does not parse leaves the engine not configured.
 */
export function loadDecideEngineFile(read: (path: string) => string, path: string): unknown {
  let text: string
  try {
    text = read(path)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw new DecideEngineError('not_configured', `${path} cannot be read`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DecideEngineError('not_configured', `${path} is not JSON`)
  }
}

/**
 * Asks `questions` about `state`. Throws a `TypeError` for questions (or a
 * `when`) a decide rule would refuse, and a {@link DecideEngineError} when
 * the engine is not configured, its host is refused, or it cannot answer.
 */
export async function decideQuestions(
  state: string,
  questions: Record<string, DecideQuestion>,
  opts: DecideSdkOptions = {},
): Promise<DecideSdkResult> {
  if (typeof state !== 'string') throw new TypeError('decide: state must be a string')
  const v = validateDecideRule(sdkRule(questions, opts))
  if (!v.ok) throw new TypeError(v.reason)
  const rule = v.rule
  const env = opts.env ?? {}
  const cfg = opts.engine ?? resolveDecideEngineConfig(opts.engineFile ?? null, env)
  const budgetMs = budgetFrom(opts, env)
  const engine = createDecideEngine(cfg)

  const names = Object.keys(rule.questions).sort()
  const calls = names.map((name) => {
    const q = rule.questions[name]!
    return q.type === 'choice' ? { name, type: 'choice' as const, ask: q.ask, options: decideOptions(q) } : { name, type: 'yes_no' as const, ask: q.ask }
  })
  const started = Date.now()
  let res: DecideEngineResult | null = null
  // A caller's state is held to the tool-call limit: the engine takes larger
  // ones, up to an `on: response` state's limit, from the state builders only.
  if (new TextEncoder().encode(state).length <= DECIDE_MAX_STATE_BYTES) {
    try {
      res = await engine.ask(state, calls, started + budgetMs)
    } catch (err) {
      if (!(err instanceof DecideEngineError) || err.code !== 'too_large') throw err
    }
  }

  const inputs: Record<string, DecideAnswerInput> = {}
  const answers: Record<string, DecideSdkAnswer> = {}
  for (const name of names) {
    const q = rule.questions[name]!
    const a = res?.answers[name]
    const band = decideQuestionBand(rule, name)
    inputs[name] = { p: a?.p, perOrder: a?.perOrder }
    if (q.type === 'yes_no') {
      const p = typeof a?.p === 'number' ? a.p : null
      answers[name] = { type: 'yes_no', p, value: p === null ? 'U' : bandValue(p, band) }
    } else {
      const options = choiceAtoms(decideOptions(q), a?.perOrder ?? [], band)
      const choice = Object.keys(options).find((o) => options[o]!.value === 'T') ?? null
      answers[name] = { type: 'choice', perOrder: a?.perOrder ?? null, options, choice }
    }
  }

  const ruled = opts.when === undefined ? null : decideRuleOutcome(rule, v.expr, inputs)
  return {
    answers,
    value: ruled?.value ?? null,
    outcome: ruled?.outcome ?? null,
    code: ruled?.code ?? null,
    via: ruled?.via ?? null,
    error: res ? null : 'too_large',
    model: res?.model ?? null,
    modelDigest: res?.modelDigest ?? null,
    digestStrength: res?.digestStrength ?? null,
    adapter: cfg.adapter,
    latencyMs: res?.latencyMs ?? Date.now() - started,
  }
}
