/**
 * Evaluating one tool call's decide rules against the engine, inside the
 * engine protections:
 *
 * 1. Decisions only add friction: nothing is asked unless the deterministic
 *    tiers allowed the call, and a decide outcome can refuse or escalate,
 *    never lower another rule's verdict. Shadow rules never change the call.
 * 2. The state is built from the call's own fields and the rule's text only
 *    (`buildDecideToolCallState`); a context field goes in quoted and marked
 *    untrusted.
 * 3. Choice questions are asked in every order and averaged; orders that
 *    disagree make the answer unknown (`decide.ts`).
 * 4. A rule enforces only under a pin for the model digest the engine
 *    reports on this call; any other digest runs it as shadow.
 * 5. Pins belong to a rule hash: pins earned by another wording are not this
 *    rule's.
 * 6. A known-answer canary, cached per engine URL and model digest for
 *    {@link DECIDE_CANARY_TTL_MS}, runs beside the rule's questions when the
 *    cache is missing, failed or stale. A failed canary discards every
 *    answer: the engine is unavailable, which refuses an enforcing rule.
 *
 * Self-contained but for the decide modules beside it, so `@intutic/gate`
 * carries a byte-identical copy. The canary cache's file is reached through
 * the `fs` its caller passes ({@link createDecideCanaryFileStore}). The Python
 * (`intutic_clawde/gate/decide_evaluate.py`) and Rust
 * (`proxy/src/decide/evaluate.rs`) ports run the same `rollout` and
 * `evaluate` cases of `fixtures/decide-engine-vectors.json`.
 *
 * @module
 */

import {
  DECIDE_DEFAULT_BAND,
  decideCallOutcome,
  decideOptions,
  decideRuleHash,
  decideRuleOutcome,
  selectDecideRules,
  validateDecideRule,
  type DecideAnswerInput,
  type DecideCallOutcome,
  type DecideCombiner,
  type DecideRuleResult,
} from './decide.js'
import type { DecidePin, DecideRecord, DecideStamp } from './decideRecord.js'
import {
  buildDecideToolCallState,
  DecideEngineError,
  decideEngineErrorOutcome,
  runDecideCanary,
  type DecideAnswer,
  type DecideEngine,
  type DecideEngineErrorCode,
  type DecideModelIdentity,
  type DecideQuestionCall,
} from './decideEngine.js'

// ---------------------------------------------------------------------------
// Effective rollout (protections 4 and 5)
// ---------------------------------------------------------------------------

/** Why a rule runs as shadow: its own rollout, the snapshot writer's stamp, or no pin for the engine's digest. */
export type DecideShadowWhy = 'rollout' | Exclude<DecideStamp, 'rule'> | 'not_evaluated'

export interface DecideEffectiveRollout {
  effective: 'enforce' | 'shadow'
  why: DecideShadowWhy | null
  /** The pin the rule enforces under. */
  pin: DecidePin | null
}

/**
 * Whether a rule enforces on this call. Only when its author wrote `enforce`,
 * the snapshot stamped it `enforce`, and one of its pins is for `modelDigest`;
 * otherwise it runs as shadow and `why` says which condition failed. A null
 * digest (the engine could not say) leaves a stamped rule enforcing, so the
 * engine's unavailability refuses rather than opening the call.
 */
export function decideEffectiveRollout(
  entry: { ir: { rollout?: 'shadow' | 'enforce' }; rollout: 'shadow' | 'enforce'; stampedBy: DecideStamp; pins: readonly DecidePin[] },
  modelDigest: string | null,
): DecideEffectiveRollout {
  if (entry.ir.rollout !== 'enforce') return { effective: 'shadow', why: 'rollout', pin: null }
  if (entry.rollout !== 'enforce') return { effective: 'shadow', why: entry.stampedBy === 'rule' ? 'rollout' : entry.stampedBy, pin: null }
  if (entry.pins.length === 0) return { effective: 'shadow', why: 'no-pins', pin: null }
  if (modelDigest === null) return { effective: 'enforce', why: null, pin: null }
  const pin = entry.pins.find((p) => p.modelDigest === modelDigest)
  return pin ? { effective: 'enforce', why: null, pin } : { effective: 'shadow', why: 'not_evaluated', pin: null }
}

// ---------------------------------------------------------------------------
// The canary cache (protection 6)
// ---------------------------------------------------------------------------

/** A canary result older than this is run again. */
export const DECIDE_CANARY_TTL_MS = 600_000
/** The cache's file name in `~/.intutic/decide/`. */
export const DECIDE_CANARY_FILE = 'canary.json'
/** The most engine and digest pairs the file keeps, newest last. */
const CANARY_ENTRIES_MAX = 16

export interface DecideCanaryEntry {
  url: string
  modelDigest: string
  ok: boolean
  /** When it ran, in epoch milliseconds. */
  atMs: number
  pViolation: number
  pClean: number
  choiceTop: string
}

export interface DecideCanaryStore {
  read(url: string, modelDigest: string): DecideCanaryEntry | null
  write(entry: DecideCanaryEntry): void
}

/** A passed result younger than {@link DECIDE_CANARY_TTL_MS}. A failed one is never fresh: it runs again. */
export function decideCanaryFresh(entry: DecideCanaryEntry | null, nowMs: number): boolean {
  return entry !== null && entry.ok && entry.atMs <= nowMs && nowMs - entry.atMs < DECIDE_CANARY_TTL_MS
}

/** The parts of `node:fs` the file store uses. */
export interface DecideCanaryFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, options: { mode: number }): void
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown
  renameSync(from: string, to: string): void
}

function canaryEntry(v: unknown): DecideCanaryEntry | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x)
  if (typeof e.url !== 'string' || typeof e.modelDigest !== 'string' || typeof e.ok !== 'boolean') return null
  if (!num(e.atMs) || !num(e.pViolation) || !num(e.pClean) || typeof e.choiceTop !== 'string') return null
  return { url: e.url, modelDigest: e.modelDigest, ok: e.ok, atMs: e.atMs as number, pViolation: e.pViolation as number, pClean: e.pClean as number, choiceTop: e.choiceTop }
}

/**
 * The canary cache as one JSON file, `{"v":1,"entries":[…]}`, mode 0600 in a
 * 0700 directory, replaced whole by a rename so a reader never sees half of
 * it. A file that does not read is an empty cache, and the canary runs.
 */
export function createDecideCanaryFileStore(file: string, fs: DecideCanaryFs): DecideCanaryStore {
  const readAll = (): DecideCanaryEntry[] => {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: unknown; entries?: unknown }
      if (doc.v !== 1 || !Array.isArray(doc.entries)) return []
      return doc.entries.map(canaryEntry).filter((e): e is DecideCanaryEntry => e !== null)
    } catch {
      return []
    }
  }
  return {
    read(url, modelDigest) {
      return readAll().find((e) => e.url === url && e.modelDigest === modelDigest) ?? null
    },
    write(entry) {
      const entries = [...readAll().filter((e) => e.url !== entry.url || e.modelDigest !== entry.modelDigest), entry].slice(-CANARY_ENTRIES_MAX)
      const dir = file.replace(/[\\/][^\\/]*$/, '')
      if (dir && dir !== file) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
  }
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

/** A rule as a snapshot record carries it. */
export type DecideRuleEntry = Pick<DecideRecord, 'ref' | 'ruleHash' | 'rollout' | 'stampedBy' | 'ir' | 'sopTitle' | 'ruleText' | 'pins'>

export interface DecideEvaluateInput {
  /** The deterministic tiers' verdict. Anything but `allow` returns at once, asking nothing. */
  deterministic: 'allow' | 'refuse'
  tool: string
  toolInput: unknown
  cwd: string
  /** Only rules with `context: [last_user_turn]` see it. */
  lastUserTurn?: string | null
  /** In snapshot order. */
  rules: readonly DecideRuleEntry[]
  /** An absolute `Date.now()` time. */
  deadlineMs: number
}

export interface DecideEvaluateDeps {
  /** The engine, or the error creating it raised (`not_configured`, `host_refused`). */
  engine: DecideEngine | DecideEngineError
  /** The engine's URL, which keys the canary cache. */
  engineUrl: string
  canary: DecideCanaryStore
  sha256Hex: (text: string) => string
  now?: () => number
}

export interface DecideRuleReport {
  ref: string
  ruleHash: string
  effective: 'enforce' | 'shadow'
  why: DecideShadowWhy | null
  outcome: 'allow' | 'refuse' | 'escalate' | 'unavailable'
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | null
  via: 'ask' | 'review' | null
  /** The engine error that made the rule unavailable or unknown. */
  error: DecideEngineErrorCode | null
  /** The digest the engine reported for this rule's questions, or before them. */
  modelDigest: string | null
  /** Null when nothing came back, or when a failed canary discarded it. */
  answers: Record<string, DecideAnswer> | null
}

export interface DecideEvaluation {
  call: DecideCallOutcome
  /** The evaluated rules, in evaluation order. */
  rules: DecideRuleReport[]
  /** Shadow rules past the per-call limit, not asked. */
  skipped: string[]
  /** The engine's identity before the questions, or null. */
  engine: DecideModelIdentity | null
  /** `cached`: a fresh passed result; `ok` / `failed`: run on this call; null: not needed. */
  canary: 'ok' | 'cached' | 'failed' | null
}

const ALLOW: DecideCallOutcome = { outcome: 'allow', code: null, ruleRef: null, via: null, reason: null }

function errorCode(err: unknown): DecideEngineErrorCode {
  return err instanceof DecideEngineError ? err.code : 'bad_response'
}

/**
 * Evaluates the decide rules a tool call matches. Never throws: an engine
 * error is an unavailable rule (or, for `too_large`, an unknown one), which
 * refuses with GOVERNANCE_UNAVAILABLE when the rule enforces.
 */
export async function evaluateDecideCall(input: DecideEvaluateInput, deps: DecideEvaluateDeps): Promise<DecideEvaluation> {
  const now = deps.now ?? Date.now
  if (input.deterministic !== 'allow') {
    return {
      call: { outcome: 'refuse', code: null, ruleRef: null, via: null, reason: 'a deterministic rule refused the call' },
      rules: [],
      skipped: [],
      engine: null,
      canary: null,
    }
  }
  const matched = input.rules.filter((r) => r.ir.on === 'tool_call' && (r.ir.tools ?? []).includes(input.tool))
  if (matched.length === 0) return { call: ALLOW, rules: [], skipped: [], engine: null, canary: null }

  const engine = deps.engine instanceof DecideEngineError ? null : deps.engine
  let engineError: DecideEngineErrorCode | null = deps.engine instanceof DecideEngineError ? deps.engine.code : null
  let identity: DecideModelIdentity | null = null
  if (engine) {
    try {
      identity = await engine.describe(input.deadlineMs)
    } catch (err) {
      engineError = errorCode(err)
    }
  }

  const entries = matched.map((r) => {
    const v = validateDecideRule(r.ir)
    // Pins are earned by one rule hash: a rule whose hash is not the one its
    // pins were stored under has none.
    const pins = v.ok && decideRuleHash(v.rule, deps.sha256Hex) === r.ruleHash ? r.pins : []
    const entry = { ...r, pins }
    return { entry, v, pre: decideEffectiveRollout(entry, identity?.modelDigest ?? null) }
  })
  const selection = selectDecideRules(
    entries.map((e) => ({ ref: e.entry.ref, on: e.entry.ir.on, tools: e.entry.ir.tools, effective: e.pre.effective, e })),
    input.tool,
  )
  const skipped = selection.skipped.map((c) => c.ref)
  if (selection.unavailable) {
    return { call: decideCallOutcome(selection, []), rules: [], skipped, engine: identity, canary: null }
  }

  type Asked = { answers: Record<string, DecideAnswer> | null; error: DecideEngineErrorCode | null; modelDigest: string | null }
  const askRule = async (e: (typeof entries)[number]): Promise<Asked> => {
    if (!engine || engineError) return { answers: null, error: engineError ?? 'not_configured', modelDigest: null }
    if (!e.v.ok) return { answers: null, error: 'bad_response', modelDigest: null }
    const rule = e.v.rule
    const questions: DecideQuestionCall[] = Object.keys(rule.questions).map((name) => {
      const q = rule.questions[name]!
      return q.type === 'choice' ? { name, type: 'choice', ask: q.ask, options: decideOptions(q) } : { name, type: 'yes_no', ask: q.ask }
    })
    try {
      const state = buildDecideToolCallState({
        ruleId: rule.id,
        sopTitle: e.entry.sopTitle,
        ruleText: e.entry.ruleText,
        tool: input.tool,
        cwd: input.cwd,
        toolInput: input.toolInput,
        ...((rule.context ?? []).includes('last_user_turn') ? { lastUserTurn: input.lastUserTurn ?? null } : {}),
      })
      const res = await engine.ask(state, questions, input.deadlineMs)
      return { answers: res.answers, error: null, modelDigest: res.modelDigest }
    } catch (err) {
      return { answers: null, error: errorCode(err), modelDigest: null }
    }
  }

  let canary: DecideEvaluation['canary'] = null
  let canaryRun: Promise<boolean> = Promise.resolve(true)
  if (engine && !engineError && identity) {
    const key = identity.modelDigest
    if (decideCanaryFresh(deps.canary.read(deps.engineUrl, key), now())) {
      canary = 'cached'
    } else {
      canaryRun = runDecideCanary(engine.ask, input.deadlineMs).then(
        (r) => {
          try {
            deps.canary.write({ url: deps.engineUrl, modelDigest: key, ok: r.ok, atMs: now(), pViolation: r.pViolation, pClean: r.pClean, choiceTop: r.choiceTop })
          } catch {
            // An unwritable cache only means the canary runs again next call.
          }
          return r.ok
        },
        () => false,
      )
    }
  }
  const [canaryOk, asked] = await Promise.all([canaryRun, Promise.all(selection.evaluate.map((c) => askRule(c.e)))])
  if (canary === null && engine && !engineError && identity) canary = canaryOk ? 'ok' : 'failed'

  const reports: DecideRuleReport[] = selection.evaluate.map((c, i) => {
    const e = c.e
    const a = asked[i]!
    const digest = a.modelDigest ?? identity?.modelDigest ?? null
    const eff = decideEffectiveRollout(e.entry, digest)
    const base = { ref: e.entry.ref, ruleHash: e.entry.ruleHash, effective: eff.effective, why: eff.why, modelDigest: digest }
    if (!canaryOk) return { ...base, outcome: 'unavailable', code: null, via: null, error: 'canary_failed', answers: null }
    if (a.error && decideEngineErrorOutcome(a.error) === 'unavailable') {
      return { ...base, outcome: 'unavailable', code: null, via: null, error: a.error, answers: null }
    }
    if (!e.v.ok) return { ...base, outcome: 'unavailable', code: null, via: null, error: 'bad_response', answers: null }
    const inputs: Record<string, DecideAnswerInput> = {}
    for (const [name, ans] of Object.entries(a.answers ?? {})) inputs[name] = { p: ans.p, perOrder: ans.perOrder }
    // A pin's fitted combiner replaces `when`. Its per-question temperatures
    // are not applied here.
    const pin = eff.pin
    const combiner: DecideCombiner | null = pin?.combiner
      ? { bias: pin.combiner.bias, weights: pin.combiner.weights, band: pin.band ?? e.v.rule.band ?? DECIDE_DEFAULT_BAND }
      : null
    const o = decideRuleOutcome(e.v.rule, e.v.expr, inputs, combiner)
    return { ...base, outcome: o.outcome, code: o.code, via: o.via, error: a.error, answers: a.answers }
  })
  const results: DecideRuleResult[] = reports.map((r) => ({ ref: r.ref, effective: r.effective, outcome: r.outcome, code: r.code, via: r.via }))
  return { call: decideCallOutcome(selection, results), rules: reports, skipped, engine: identity, canary }
}
