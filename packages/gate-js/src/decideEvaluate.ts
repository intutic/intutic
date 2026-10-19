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
 * And the latency budget: with the engine's per-call p95 (`q95Ms`, which
 * `intutic doctor` measures and stores in engine.json), a rule whose
 * estimate does not fit the time left is not asked. An enforcing one
 * escalates, as an unknown answer does; a shadow one is logged and allowed.
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
  DECIDE_JS_SOURCE,
  decideAtoms,
  decideCallOutcome,
  decideOptions,
  decideRuleHash,
  decideRuleOutcome,
  selectDecideRules,
  validateDecideRule,
  type DecideAnswerInput,
  type DecideCallOutcome,
  type DecideCombiner,
  type DecideRule,
  type DecideRuleResult,
} from './decide.js'
import { DECIDE_RECORD_JS_SOURCE, type DecidePin, type DecideRecord, type DecideStamp } from './decideRecord.js'
import {
  buildDecideToolCallState,
  DECIDE_ENGINE_JS_SOURCE,
  DecideEngineError,
  decideEngineErrorOutcome,
  decideModuleSource,
  runDecideCanary,
  type DecideAnswer,
  type DecideEngine,
  type DecideEngineErrorCode,
  type DecideModelIdentity,
  type DecideQuestionCall,
} from './decideEngine.js'
import { DECIDE_HOST_GUARD_JS_SOURCE } from './decideHostGuard.js'
import { DECIDE_LOG_JS_SOURCE } from './decideLog.js'

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
  /**
   * The verdict of every tier before decide (the order of
   * evidence): deterministic refusals, then consequence (a lane or revert
   * hold not released by an approved bypass). Anything but `allow` returns
   * at once, asking nothing: a decide `allow` never releases a hold.
   */
  deterministic: 'allow' | 'refuse' | 'hold'
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
  /**
   * The engine's per-call p95 in milliseconds, as `intutic doctor` stored it
   * in engine.json ({@link decideStoredQ95Ms}). Null or absent: not measured,
   * and every rule is asked.
   */
  q95Ms?: number | null
  /** The engine's `parallel`, for the estimate; 1 when absent. */
  parallel?: number
}

export interface DecideRuleReport {
  ref: string
  ruleHash: string
  effective: 'enforce' | 'shadow'
  why: DecideShadowWhy | null
  outcome: 'allow' | 'refuse' | 'escalate' | 'unavailable'
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | null
  via: 'ask' | 'review' | null
  /**
   * The engine error that made the rule unavailable or unknown, or
   * `budget_skip`: its estimate did not fit the time left, so it was not asked.
   */
  error: DecideEngineErrorCode | 'budget_skip' | null
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
  /**
   * `cached`: a fresh passed result; `ok` / `failed`: run on this call and
   * answered (`failed`: answered wrongly); null: not needed, or it got no
   * answer (the engine could not be reached or errored).
   */
  canary: 'ok' | 'cached' | 'failed' | null
}

const ALLOW: DecideCallOutcome = { outcome: 'allow', code: null, ruleRef: null, via: null, reason: null }

function errorCode(err: unknown): DecideEngineErrorCode {
  return err instanceof DecideEngineError ? err.code : 'bad_response'
}

/**
 * A call's verdict in the order of evidence: deterministic
 * refusals, then consequence (holds), then trajectory, then model judgement
 * last. `before` is the verdict of everything before decide; `decide` is
 * what the decide rules answered, or null when none was asked. A hold or a
 * refusal before decide stands whatever decide says; inside an open lane a
 * decide refusal or escalation still applies.
 */
export function decideVerdictInOrder(before: 'allow' | 'refuse' | 'hold', decide: Pick<DecideCallOutcome, 'outcome'> | null): 'allow' | 'refuse' | 'hold' | 'escalate' {
  if (before !== 'allow') return before
  return decide === null ? 'allow' : decide.outcome
}

// ---------------------------------------------------------------------------
// The latency budget
// ---------------------------------------------------------------------------

/** The engine calls one evaluation of `rule` makes: a yes/no question one, a choice two, or three past three options (none_of_these counted). */
export function decideRuleCalls(rule: DecideRule): number {
  let n = 0
  for (const q of Object.values(rule.questions)) n += q.type === 'yes_no' ? 1 : decideOptions(q).length > 3 ? 3 : 2
  return n
}

/** The estimated time to evaluate `rule`: the per-call p95 times its calls over `parallel`. */
export function decideRuleEstimateMs(rule: DecideRule, q95Ms: number, parallel: number): number {
  return Math.round(q95Ms * Math.ceil(decideRuleCalls(rule) / Math.max(1, parallel)))
}

/** The per-call p95 `intutic doctor` stored in engine.json (`q95Ms`, parsed), or null when there is none. */
export function decideStoredQ95Ms(file: unknown): number | null {
  const v = file !== null && typeof file === 'object' && !Array.isArray(file) ? (file as Record<string, unknown>).q95Ms : undefined
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Evaluates the decide rules a tool call matches. Never throws: an engine
 * error is an unavailable rule (or, for `too_large`, an unknown one), which
 * refuses with GOVERNANCE_UNAVAILABLE when the rule enforces.
 *
 * With the engine's p95 (`deps.q95Ms`), a rule whose estimate does not fit
 * the time left before `deadlineMs` is not asked: its report carries
 * `budget_skip`, and it is unknown. An enforcing one escalates (or refuses,
 * with `escalate: refuse`); a shadow one is allowed. The rest are asked.
 */
export async function evaluateDecideCall(input: DecideEvaluateInput, deps: DecideEvaluateDeps): Promise<DecideEvaluation> {
  const q95 = deps.q95Ms ?? null
  if (q95 === null || input.deterministic !== 'allow') return evaluateDecideRules(input, deps)
  const leftMs = input.deadlineMs - (deps.now ?? Date.now)()
  const inBudget: DecideRuleEntry[] = []
  const overBudget: DecideRuleEntry[] = []
  for (const r of input.rules) {
    const v = validateDecideRule(r.ir)
    const named = r.ir.on === 'tool_call' && (r.ir.tools ?? []).includes(input.tool)
    if (named && v.ok && decideRuleEstimateMs(v.rule, q95, deps.parallel ?? 1) > leftMs) overBudget.push(r)
    else inBudget.push(r)
  }
  const ev = await evaluateDecideRules({ ...input, rules: inBudget }, deps)
  if (overBudget.length === 0) return ev

  const digest = ev.engine?.modelDigest ?? null
  const skipped: DecideRuleReport[] = overBudget.map((r) => {
    const v = validateDecideRule(r.ir)
    const pins = v.ok && decideRuleHash(v.rule, deps.sha256Hex) === r.ruleHash ? r.pins : []
    const eff = decideEffectiveRollout({ ...r, pins }, digest)
    const escalate = v.ok ? v.rule.escalate ?? 'ask' : 'ask'
    const report = { ref: r.ref, ruleHash: r.ruleHash, effective: eff.effective, why: eff.why, error: 'budget_skip' as const, modelDigest: digest, answers: null }
    if (eff.effective === 'shadow') return { ...report, outcome: 'allow', code: null, via: null }
    if (escalate === 'refuse') return { ...report, outcome: 'refuse', code: 'DECIDE_ESCALATED', via: null }
    return { ...report, outcome: 'escalate', code: 'DECIDE_ESCALATED', via: escalate }
  })
  const rules = [...ev.rules, ...skipped]
  // A refusal for too many rules on the tool comes before any rule is asked, and stands.
  const call = ev.rules.length === 0 && ev.call.outcome !== 'allow' ? ev.call : decideCallOutcome({ unavailable: null }, rules)
  return { ...ev, call, rules }
}

/** {@link evaluateDecideCall} on every rule it is given, with no budget estimate. */
async function evaluateDecideRules(input: DecideEvaluateInput, deps: DecideEvaluateDeps): Promise<DecideEvaluation> {
  const now = deps.now ?? Date.now
  if (input.deterministic !== 'allow') {
    const reason = input.deterministic === 'hold' ? 'the call is held for a person; a decide answer never releases a hold' : 'a deterministic rule refused the call'
    return {
      call: { outcome: 'refuse', code: null, ruleRef: null, via: null, reason },
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
  // `canary_failed` only when the canary was answered and the answer was
  // wrong; an engine that did not answer it at all carries its own error
  // (`upstream`, `timeout`, …).
  let canaryRun: Promise<DecideEngineErrorCode | null> = Promise.resolve(null)
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
          return r.ok ? null : 'canary_failed'
        },
        (err: unknown) => errorCode(err),
      )
    }
  }
  const [canaryError, asked] = await Promise.all([canaryRun, Promise.all(selection.evaluate.map((c) => askRule(c.e)))])
  if (canary === null && engine && !engineError && identity) canary = canaryError === null ? 'ok' : canaryError === 'canary_failed' ? 'failed' : null

  const reports: DecideRuleReport[] = selection.evaluate.map((c, i) => {
    const e = c.e
    const a = asked[i]!
    const digest = a.modelDigest ?? identity?.modelDigest ?? null
    const eff = decideEffectiveRollout(e.entry, digest)
    const base = { ref: e.entry.ref, ruleHash: e.entry.ruleHash, effective: eff.effective, why: eff.why, modelDigest: digest }
    if (canaryError !== null) {
      // A canary that got no answer: the rule's own engine error when it has
      // one (it asked the same engine), else the canary's.
      const error = canaryError !== 'canary_failed' && a.error && decideEngineErrorOutcome(a.error) === 'unavailable' ? a.error : canaryError
      return { ...base, outcome: 'unavailable', code: null, via: null, error, answers: null }
    }
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

// ---------------------------------------------------------------------------
// What a gate says
// ---------------------------------------------------------------------------

/** A call's decide outcome as a gate acts on it. */
export interface DecideDecision {
  outcome: 'allow' | 'refuse' | 'escalate'
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | 'GOVERNANCE_UNAVAILABLE' | null
  /** `decide.<ruleRef>`; null on an allow, or when no one rule decided. */
  ruleId: string | null
  /** How an escalation reaches a person: `ask`, or `review` (open core asks). */
  via: 'ask' | 'review' | null
  /** The refusal, or the question for a person, without the rule id. Empty on an allow. */
  reason: string
}

/**
 * The questions a rule could not answer: a yes/no question between its bands,
 * a choice none of whose options cleared `yes_at` while one stayed unknown.
 * Every question when none can be named (no answers came back).
 */
function unknownQuestions(entry: DecideRuleEntry, answers: Record<string, DecideAnswer> | null): string[] {
  const v = validateDecideRule(entry.ir)
  if (!v.ok) return []
  const names = Object.keys(v.rule.questions)
  if (answers) {
    const inputs: Record<string, DecideAnswerInput> = {}
    for (const [name, ans] of Object.entries(answers)) inputs[name] = { p: ans.p, perOrder: ans.perOrder }
    const atoms = decideAtoms(v.rule, inputs)
    const unknown = names.filter((name) => {
      if (atoms.yes[name] !== undefined) return atoms.yes[name] === 'U'
      const values = Object.values(atoms.eq[name] ?? {})
      return !values.includes('T') && values.includes('U')
    })
    if (unknown.length > 0) return unknown.map((name) => v.rule.questions[name]!.ask)
  }
  return names.map((name) => v.rule.questions[name]!.ask)
}

/** What one evaluated rule says, for a refusal, a question or a shadow record. */
function decideRuleReason(report: DecideRuleReport, entry: DecideRuleEntry): string {
  const title = entry.ir.title ?? entry.sopTitle
  if (report.error === 'budget_skip' && report.outcome !== 'allow') {
    return `Needs a person: ${title} — the decide engine cannot answer rule ${entry.ir.id} within this call's time budget`
  }
  if (report.outcome === 'unavailable') {
    return `GOVERNANCE_UNAVAILABLE — the decide engine could not evaluate rule ${entry.ir.id} (${title}): ${report.error ?? 'unavailable'}`
  }
  if (report.code === 'DECIDE_REFUSED') return `Decide rule ${entry.ir.id} (${title}) refused this call`
  return `Needs a person: ${title} — ${unknownQuestions(entry, report.answers).join(' ')}`
}

/**
 * The decision a gate acts on for a call's evaluation of `rules` (the records
 * it passed in), with the reason it refuses or asks with.
 */
export function decideDecision(ev: DecideEvaluation, rules: readonly DecideRuleEntry[]): DecideDecision {
  const call = ev.call
  if (call.outcome === 'allow') return { outcome: 'allow', code: null, ruleId: null, via: null, reason: '' }
  const ruleId = call.ruleRef === null ? null : `decide.${call.ruleRef}`
  const entry = rules.find((r) => r.ref === call.ruleRef)
  const report = ev.rules.find((r) => r.ref === call.ruleRef)
  const reason =
    entry && report
      ? decideRuleReason(report, entry)
      : `GOVERNANCE_UNAVAILABLE — ${call.reason ?? 'the decide rules for this call could not be evaluated'}`
  return { outcome: call.outcome, code: call.code, ruleId, via: call.outcome === 'escalate' ? call.via ?? 'ask' : null, reason }
}

/**
 * The evaluated shadow rules that would have refused, escalated or found the
 * engine unavailable: what a gate records, while the call goes on.
 */
export function decideShadowFindings(ev: DecideEvaluation, rules: readonly DecideRuleEntry[]): Array<{ ruleId: string; reason: string }> {
  const out: Array<{ ruleId: string; reason: string }> = []
  for (const report of ev.rules) {
    if (report.effective !== 'shadow' || report.outcome === 'allow') continue
    const entry = rules.find((r) => r.ref === report.ref)
    if (entry) out.push({ ruleId: `decide.${report.ref}`, reason: decideRuleReason(report, entry) })
  }
  return out
}

/**
 * The decision when the evaluation itself could not run or finish (the CLI
 * failed, the budget ran out): refuse with GOVERNANCE_UNAVAILABLE, under the
 * first matched rule its snapshot record stamped `enforce`, unless every rule
 * on the tool is stamped `shadow`, which allows.
 */
export function decideUnavailableDecision(rules: readonly DecideRuleEntry[], tool: string, why: string): DecideDecision {
  const matched = rules.filter((r) => r.ir.on === 'tool_call' && (r.ir.tools ?? []).includes(tool))
  const enforcing = matched.find((r) => r.rollout === 'enforce')
  if (!enforcing) return { outcome: 'allow', code: null, ruleId: null, via: null, reason: '' }
  return { outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleId: `decide.${enforcing.ref}`, via: null, reason: `GOVERNANCE_UNAVAILABLE — ${why}` }
}

// ---------------------------------------------------------------------------
// As source
// ---------------------------------------------------------------------------

/**
 * This module as JavaScript source, for the hook gates to embed. The
 * embedding scope supplies what it imports from `decide.ts`
 * (`DECIDE_DEFAULT_BAND`, `decideAtoms`, `decideCallOutcome`,
 * `decideOptions`, `decideRuleHash`, `decideRuleOutcome`, `selectDecideRules`,
 * `validateDecideRule`) and `decideEngine.ts` (`buildDecideToolCallState`,
 * `DecideEngineError`, `decideEngineErrorOutcome`, `runDecideCanary`). A
 * test holds the list to the functions this file declares.
 */
export const DECIDE_EVALUATE_JS_SOURCE = decideModuleSource([
  `const DECIDE_CANARY_TTL_MS = ${DECIDE_CANARY_TTL_MS};`,
  `const DECIDE_CANARY_FILE = ${JSON.stringify(DECIDE_CANARY_FILE)};`,
  `const CANARY_ENTRIES_MAX = ${CANARY_ENTRIES_MAX};`,
  `const ALLOW = ${JSON.stringify(ALLOW)};`,
  decideEffectiveRollout,
  decideCanaryFresh,
  canaryEntry,
  createDecideCanaryFileStore,
  errorCode,
  decideRuleCalls,
  decideRuleEstimateMs,
  decideStoredQ95Ms,
  decideVerdictInOrder,
  evaluateDecideCall,
  evaluateDecideRules,
  unknownQuestions,
  decideRuleReason,
  decideDecision,
  decideShadowFindings,
  decideUnavailableDecision,
])

/**
 * Every decide module a hook gate needs, as one JavaScript function
 * expression: called with the gate's `sha256(text)` (hex), it returns the
 * snapshot decoders (`format`, `record`), the engine (`resolveConfig`,
 * `createEngine`, `EngineError`), the canary cache (`canaryStore(file, fs)`),
 * the tier (`evaluate`, `decision`, `shadowFindings`, `unavailable`,
 * `storedQ95`, the p95 an engine.json holds, and `verdictInOrder`, the order
 * of evidence of the loops, graphs and gates release), and the decide log
 * (`writeLog`, `logEngine`, `logDeps`).
 * Each module has a scope of its own, since their private helpers share
 * names, and receives what it imports as parameters.
 */
export const DECIDE_GATE_JS_SOURCE = `(function (sha256) {
const decide = (function () {
${DECIDE_JS_SOURCE}
${DECIDE_RECORD_JS_SOURCE}
  return { choiceOrders, DECIDE_DEFAULT_BAND, decideAtoms, decideCallOutcome, decideOptions, decideRuleHash, decideRuleOutcome,
    selectDecideRules, validateDecideRule, decodeSnapshotFormatRecord, decodeDecideRecord, bandValue, choiceAtoms,
    decideQuestionBand, parseWhen };
})();
const guard = (function () {
${DECIDE_HOST_GUARD_JS_SOURCE}
  return { checkSelfHostedDecisionHost };
})();
const engine = (function (choiceOrders, checkSelfHostedDecisionHost) {
${DECIDE_ENGINE_JS_SOURCE}
  return { DecideEngineError, resolveDecideEngineConfig, createDecideEngine, buildDecideToolCallState, decideEngineErrorOutcome, runDecideCanary,
    decideCanonicalJson };
})(decide.choiceOrders, guard.checkSelfHostedDecisionHost);
const evaluate = (function (DECIDE_DEFAULT_BAND, decideAtoms, decideCallOutcome, decideOptions, decideRuleHash, decideRuleOutcome,
    selectDecideRules, validateDecideRule, buildDecideToolCallState, DecideEngineError, decideEngineErrorOutcome, runDecideCanary) {
${DECIDE_EVALUATE_JS_SOURCE}
  return { createDecideCanaryFileStore, evaluateDecideCall, decideDecision, decideShadowFindings, decideUnavailableDecision, decideStoredQ95Ms,
    decideVerdictInOrder };
})(decide.DECIDE_DEFAULT_BAND, decide.decideAtoms, decide.decideCallOutcome, decide.decideOptions, decide.decideRuleHash,
  decide.decideRuleOutcome, decide.selectDecideRules, decide.validateDecideRule, engine.buildDecideToolCallState,
  engine.DecideEngineError, engine.decideEngineErrorOutcome, engine.runDecideCanary);
const log = (function (bandValue, choiceAtoms, decideOptions, decideQuestionBand, parseWhen, validateDecideRule, buildDecideToolCallState,
    decideCanonicalJson) {
${DECIDE_LOG_JS_SOURCE}
  return { writeDecideCallLog, decideLogEngine, decideLogDeps };
})(decide.bandValue, decide.choiceAtoms, decide.decideOptions, decide.decideQuestionBand, decide.parseWhen, decide.validateDecideRule,
  engine.buildDecideToolCallState, engine.decideCanonicalJson);
const check = function (ir) {
  const v = decide.validateDecideRule(ir);
  return v.ok ? decide.decideRuleHash(v.rule, sha256) : null;
};
return {
  format: decide.decodeSnapshotFormatRecord,
  record: function (line) { return decide.decodeDecideRecord(line, check); },
  EngineError: engine.DecideEngineError,
  resolveConfig: engine.resolveDecideEngineConfig,
  createEngine: engine.createDecideEngine,
  canaryStore: evaluate.createDecideCanaryFileStore,
  evaluate: evaluate.evaluateDecideCall,
  decision: evaluate.decideDecision,
  shadowFindings: evaluate.decideShadowFindings,
  unavailable: evaluate.decideUnavailableDecision,
  storedQ95: evaluate.decideStoredQ95Ms,
  verdictInOrder: evaluate.decideVerdictInOrder,
  writeLog: log.writeDecideCallLog,
  logEngine: log.decideLogEngine,
  logDeps: log.decideLogDeps,
};
})`
