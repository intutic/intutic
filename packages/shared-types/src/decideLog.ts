/**
 * The decide log, and the drift alarm it feeds.
 *
 * Every process that evaluates a call's decide rules appends one line to
 * `~/.intutic/logs/decide-YYYY-MM-DD.jsonl` (the UTC date), mode 0600, with
 * a single append write: what was asked, of which model, and what came back.
 * Stored by default: the hash of each state sent, the rule hashes, the model
 * digest, every answer's probability and band, the outcome and the mode, and
 * the call's arguments only after redaction, cut to
 * {@link DECIDE_ARGS_EXCERPT_MAX_BYTES}. A line is at most
 * {@link DECIDE_LOG_LINE_MAX_BYTES}; the excerpt is shortened first. The log
 * is its own file, never a trace file, so nothing that uploads and deletes
 * traces touches it.
 *
 * Drift (engine protection 8): each rule keeps its last
 * {@link DECIDE_STATS_KEEP} decisions in `~/.intutic/decide/stats/<ruleHash>.json`.
 * Against the eval run the rule's pin came from, `decide.drift` fires when
 * the escalation rate moves more than {@link DECIDE_DRIFT_ESCALATION_DELTA}
 * from the run's, or a question's median probability leaves the run's
 * [p10, p90], at most once per {@link DECIDE_DRIFT_INTERVAL_MS} per rule and
 * only once {@link DECIDE_DRIFT_MIN_DECISIONS} decisions are kept.
 *
 * Every gate that evaluates decide rules writes it, with the same record and
 * redaction and under the same home directory ({@link decideLogDeps}):
 * `intutic decide check` for the shell and n8n gates, the JavaScript hook
 * gates (which embed {@link DECIDE_LOG_JS_SOURCE}), and both gate SDKs. A
 * write that fails never changes the decision.
 *
 * Self-contained but for the decide modules beside it, so `@intutic/gate`
 * carries a byte-identical copy. Files are reached through the `fs` its
 * caller passes. The Python port is `intutic_clawde/gate/decide_log.py`; both
 * run `fixtures/decide-log-vectors.json`.
 *
 * @module
 */

import { bandValue, choiceAtoms, decideOptions, decideQuestionBand, parseWhen, validateDecideRule, type DecideExpr, type DecideRule } from './decide.js'
import { buildDecideToolCallState, decideCanonicalJson, decideModuleSource, type DecideAnswer } from './decideEngine.js'
import type { DecideEvaluation, DecideRuleEntry, DecideRuleReport } from './decideEvaluate.js'

/** The longest line the log holds, in UTF-8 bytes. */
export const DECIDE_LOG_LINE_MAX_BYTES = 8192
/** The longest arguments excerpt, in UTF-8 bytes, cut on a character boundary. */
export const DECIDE_ARGS_EXCERPT_MAX_BYTES = 2048
/** Days a decide log file is kept before housekeeping deletes it. */
export const DECIDE_LOG_RETENTION_DAYS = 30
/** Decisions kept per rule for the drift alarm. */
export const DECIDE_STATS_KEEP = 200
/** Fewer kept decisions than this never raise drift: one escalation in three is noise, not drift. */
export const DECIDE_DRIFT_MIN_DECISIONS = 20
/** An escalation rate this far (absolute) from the eval run's is drift. */
export const DECIDE_DRIFT_ESCALATION_DELTA = 0.15
/** At most one `decide.drift` per rule in this window. */
export const DECIDE_DRIFT_INTERVAL_MS = 86_400_000
/** What a redacted match is replaced with. */
export const DECIDE_REDACTED = '[REDACTED]'

export type DecideLogEvent = 'decide.decision' | 'decide.unavailable' | 'decide.canary_failed' | 'decide.drift' | 'decide.not_evaluated'

// ---------------------------------------------------------------------------
// Files and text
// ---------------------------------------------------------------------------

/** `decide-YYYY-MM-DD.jsonl` for the UTC date of `atMs`; `decide-state-…` for raw states. */
export function decideLogFileName(atMs: number, kind: 'decide' | 'decide-state' = 'decide'): string {
  return `${kind}-${new Date(atMs).toISOString().slice(0, 10)}.jsonl`
}

/** The UTC date a decide log file name carries, as epoch milliseconds at midnight, or null when the name is not one. */
export function decideLogFileDate(name: string): number | null {
  const m = /^decide(?:-state)?-([0-9]{4}-[0-9]{2}-[0-9]{2})\.jsonl$/.exec(name)
  if (!m) return null
  const t = Date.parse(`${m[1]}T00:00:00.000Z`)
  return Number.isNaN(t) ? null : t
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

/** The longest prefix of whole characters within `max` UTF-8 bytes. */
export function decideUtf8Prefix(s: string, max: number): string {
  let bytes = 0
  let end = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + n > max) break
    bytes += n
    end += ch.length
  }
  return s.slice(0, end)
}

/**
 * `text` with every match of each source replaced by {@link DECIDE_REDACTED},
 * the sources applied in order. A source that does not compile is skipped.
 */
export function decideRedact(text: string, sources: readonly string[]): string {
  let out = text
  for (const source of sources) {
    let re: RegExp
    try {
      re = new RegExp(source, 'g')
    } catch {
      continue
    }
    out = out.replace(re, DECIDE_REDACTED)
  }
  return out
}

/** The call's arguments as canonical JSON, redacted, then cut to `maxBytes`. */
export function decideArgsExcerpt(toolInput: unknown, sources: readonly string[], maxBytes: number = DECIDE_ARGS_EXCERPT_MAX_BYTES): string {
  return decideUtf8Prefix(decideRedact(decideCanonicalJson(toolInput ?? {}), sources), maxBytes)
}

// ---------------------------------------------------------------------------
// The decision record
// ---------------------------------------------------------------------------

export interface DecideLogEngine {
  adapter: string
  /** `host:port` of the engine URL; never the key. */
  host: string
  model: string | null
  digest: string | null
  digestStrength: 'strong' | 'weak' | null
  canary: 'ok' | 'cached' | 'failed' | null
}

export interface DecideLogContext {
  /** Epoch milliseconds. */
  atMs: number
  harness: string
  workspaceId: string
  sessionId: string
  tool: string
  toolInput: unknown
  cwd: string
  lastUserTurn?: string | null
  budgetMs: number
  latencyMs: number
  engine: DecideLogEngine
  /** Regex sources the arguments excerpt is redacted with. */
  redact: readonly string[]
  /**
   * The call's reversibility class (`laneOf` of the tokens it
   * classifies to, lanes.ts), or null when it has none or the caller cannot
   * say. Logged so calibrations can be stratified by consequence.
   */
  lane?: 'irreversible' | 'reversible_wide' | 'reversible_contained' | null
  /** The subject's role-level revert or rejection rate, or null when none is published. */
  revertRate?: number | null
}

/** One question's answer as the log keeps it. */
export type DecideLogAnswer =
  | { type: 'yes_no'; p: number | null; pRaw: number | null; value: 'T' | 'F' | 'U'; band: [number, number] }
  | {
      type: 'choice'
      p: Record<string, number>
      spread: Record<string, number>
      atoms: Record<string, 'T' | 'F' | 'U'>
      band: [number, number]
    }

export interface DecideLogRule {
  ref: string
  ruleHash: string
  /** The record's stamp. */
  rollout: 'shadow' | 'enforce'
  effective: 'enforce' | 'shadow'
  why: string | null
  /** sha256 of the exact state bytes sent for this rule, `sha256:<hex>`. */
  stateHash: string | null
  modelDigest: string | null
  answers: Record<string, DecideLogAnswer> | null
  when: 'T' | 'F' | 'U' | null
  outcome: DecideRuleReport['outcome']
  escalate: 'ask' | 'review' | 'refuse'
  error: string | null
}

export interface DecideDecisionRecord {
  v: 1
  event: 'decide.decision'
  at: string
  harness: string
  workspaceId: string
  sessionId: string
  tool: string
  /** The call's reversibility class, or null. Readers ignore fields they do not know. */
  lane: 'irreversible' | 'reversible_wide' | 'reversible_contained' | null
  /** The subject's revert or rejection rate, or null. */
  revertRate: number | null
  stateHash: string | null
  argsExcerpt: string
  engine: DecideLogEngine
  budgetMs: number
  latencyMs: number
  outcome: 'allow' | 'refuse' | 'escalate'
  code: string | null
  rules: DecideLogRule[]
  skipped: string[]
  truncated?: true
}

/** The `q == o` atoms a `when` names, as `"q == o"` strings, in order of appearance. */
function eqAtoms(e: DecideExpr, out: string[] = []): string[] {
  if (e.op === 'eq') {
    const key = `${e.q} == ${e.o}`
    if (!out.includes(key)) out.push(key)
  } else if (e.op === 'not') eqAtoms(e.a, out)
  else if (e.op === 'and' || e.op === 'or') {
    eqAtoms(e.a, out)
    eqAtoms(e.b, out)
  }
  return out
}

function logAnswer(rule: DecideRule, expr: DecideExpr | null, name: string, a: DecideAnswer): DecideLogAnswer | null {
  const q = rule.questions[name]
  if (!q) return null
  const band = decideQuestionBand(rule, name)
  const pair: [number, number] = [band.no_below, band.yes_at]
  if (q.type === 'yes_no') {
    const p = typeof a.p === 'number' ? a.p : null
    return { type: 'yes_no', p, pRaw: p, value: p === null ? 'U' : bandValue(p, band), band: pair }
  }
  const atoms = choiceAtoms(decideOptions(q), a.perOrder ?? [], band)
  const used = expr ? eqAtoms(expr).filter((k) => k.startsWith(`${name} == `)) : []
  return {
    type: 'choice',
    p: Object.fromEntries(Object.entries(atoms).map(([o, c]) => [o, c.p])),
    spread: Object.fromEntries(Object.entries(atoms).map(([o, c]) => [o, c.spread])),
    atoms: Object.fromEntries(used.map((k) => [k, atoms[k.slice(name.length + 4)]?.value ?? 'U'])),
    band: pair,
  }
}

function whenValue(r: DecideRuleReport): 'T' | 'F' | 'U' | null {
  if (r.outcome === 'unavailable') return null
  if (r.outcome === 'allow') return 'F'
  return r.code === 'DECIDE_REFUSED' ? 'T' : 'U'
}

/**
 * The `decide.decision` record of one evaluated call. `rules` are the
 * entries the call was evaluated over; each report's state is rebuilt from
 * its entry and the call (it is deterministic) and hashed with `sha256Hex`.
 */
export function buildDecideDecisionRecord(
  evaluation: DecideEvaluation,
  rules: readonly DecideRuleEntry[],
  ctx: DecideLogContext,
  sha256Hex: (text: string) => string,
): DecideDecisionRecord {
  const byRef = new Map(rules.map((r) => [r.ref, r]))
  const logged: DecideLogRule[] = evaluation.rules.map((rep) => {
    const entry = byRef.get(rep.ref)
    const v = entry ? validateDecideRule(entry.ir) : null
    const rule = v && v.ok ? v.rule : null
    const expr = rule ? (parseWhen(rule.when) as { ok: true; expr: DecideExpr }).expr : null
    let stateHash: string | null = null
    if (entry && rule) {
      try {
        const state = buildDecideToolCallState({
          ruleId: rule.id,
          sopTitle: entry.sopTitle,
          ruleText: entry.ruleText,
          tool: ctx.tool,
          cwd: ctx.cwd,
          toolInput: ctx.toolInput,
          ...((rule.context ?? []).includes('last_user_turn') ? { lastUserTurn: ctx.lastUserTurn ?? null } : {}),
        })
        stateHash = `sha256:${sha256Hex(state)}`
      } catch {
        stateHash = null
      }
    }
    let answers: Record<string, DecideLogAnswer> | null = null
    if (rule && rep.answers) {
      answers = {}
      for (const name of Object.keys(rep.answers).sort()) {
        const a = logAnswer(rule, expr, name, rep.answers[name]!)
        if (a) answers[name] = a
      }
    }
    return {
      ref: rep.ref,
      ruleHash: rep.ruleHash,
      rollout: entry?.rollout ?? 'shadow',
      effective: rep.effective,
      why: rep.why,
      stateHash,
      modelDigest: rep.modelDigest,
      answers,
      when: whenValue(rep),
      outcome: rep.outcome,
      escalate: entry?.ir.escalate ?? 'ask',
      error: rep.error,
    }
  })
  return {
    v: 1,
    event: 'decide.decision',
    at: new Date(ctx.atMs).toISOString(),
    harness: ctx.harness,
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    tool: ctx.tool,
    lane: ctx.lane ?? null,
    revertRate: typeof ctx.revertRate === 'number' && Number.isFinite(ctx.revertRate) ? ctx.revertRate : null,
    stateHash: logged[0]?.stateHash ?? null,
    argsExcerpt: decideArgsExcerpt(ctx.toolInput, ctx.redact),
    engine: ctx.engine,
    budgetMs: ctx.budgetMs,
    latencyMs: ctx.latencyMs,
    outcome: evaluation.call.outcome,
    code: evaluation.call.code,
    rules: logged,
    skipped: [...evaluation.skipped],
  }
}

/** An event other than a decision, in the same envelope. */
export function buildDecideEventRecord(
  event: Exclude<DecideLogEvent, 'decide.decision'>,
  ctx: Pick<DecideLogContext, 'atMs' | 'harness' | 'workspaceId' | 'sessionId'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { v: 1, event, at: new Date(ctx.atMs).toISOString(), harness: ctx.harness, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, ...body }
}

/**
 * The record as one JSON line (with its newline) of at most `max` bytes.
 * Over it, the arguments excerpt is shortened first, by halves down to
 * nothing; then each choice answer keeps only its atoms; then the answers
 * go. Whatever was cut, `truncated` says so.
 */
export function decideLogLine(record: Record<string, unknown>, max: number = DECIDE_LOG_LINE_MAX_BYTES): string {
  const fits = (r: Record<string, unknown>) => {
    const line = JSON.stringify(r) + '\n'
    return utf8Length(line) <= max ? line : null
  }
  const whole = fits(record)
  if (whole) return whole
  const r: Record<string, unknown> = { ...record, truncated: true }
  if (typeof r.argsExcerpt === 'string') {
    let excerpt = r.argsExcerpt as string
    while (excerpt.length > 0) {
      excerpt = decideUtf8Prefix(excerpt, Math.floor(utf8Length(excerpt) / 2))
      const line = fits({ ...r, argsExcerpt: excerpt })
      if (line) return line
    }
    r.argsExcerpt = ''
  }
  if (Array.isArray(r.rules)) {
    const slim = (r.rules as DecideLogRule[]).map((rule) => ({
      ...rule,
      answers: rule.answers
        ? Object.fromEntries(
            Object.entries(rule.answers).map(([n, a]) => [n, a.type === 'choice' ? { type: 'choice', atoms: a.atoms, band: a.band } : a]),
          )
        : null,
    }))
    const line = fits({ ...r, rules: slim })
    if (line) return line
    const bare = fits({ ...r, rules: slim.map((rule) => ({ ...rule, answers: null })) })
    if (bare) return bare
  }
  // Nothing smaller is a record; the envelope alone always fits.
  return JSON.stringify({ v: 1, event: record.event, at: record.at, truncated: true }) + '\n'
}

/** The parts of `node:fs` the log and the stats use. */
export interface DecideLogFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown
  openSync(path: string, flags: string, mode: number): number
  writeSync(fd: number, data: string): number
  closeSync(fd: number): void
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, options: { mode: number }): void
  renameSync(from: string, to: string): void
}

/** Appends one line to `dir/file` with a single write to a file opened for append, mode 0600 in a 0700 directory. */
export function appendDecideLogLine(fs: DecideLogFs, dir: string, file: string, line: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fd = fs.openSync(`${dir}/${file}`, 'a', 0o600)
  try {
    fs.writeSync(fd, line)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Drift (protection 8)
// ---------------------------------------------------------------------------

/** One kept decision: the rule's own outcome and each question's probability. */
export interface DecideStatsDecision {
  atMs: number
  outcome: 'allow' | 'refuse' | 'escalate'
  /** p(yes) for a yes/no question; the top option's averaged probability for a choice. */
  p: Record<string, number>
}

export interface DecideStats {
  v: 1
  ruleHash: string
  decisions: DecideStatsDecision[]
  /** When `decide.drift` last fired for this rule. */
  lastDriftAtMs: number | null
}

/** What an eval run measured, as drift compares against it. */
export interface DecideEvalRunBaseline {
  evalRunId: string
  escalationRate: number
  /** Per question: the 10th and 90th percentile of its probability over the run's cases. */
  questions: Record<string, { p10: number; p90: number }>
}

export interface DecideDrift {
  measure: 'escalation_rate' | 'median_p'
  question: string | null
  value: number
  /** The run's escalation rate, or its [p10, p90]. */
  expected: number | [number, number]
  threshold: number | null
  n: number
}

/** The probability a question's answer is tracked by, or null when it has none. */
export function decideTrackedP(rule: DecideRule, name: string, a: DecideAnswer): number | null {
  const q = rule.questions[name]
  if (!q) return null
  if (q.type === 'yes_no') return typeof a.p === 'number' ? a.p : null
  const atoms = choiceAtoms(decideOptions(q), a.perOrder ?? [], decideQuestionBand(rule, name))
  const ps = Object.values(atoms).map((c) => c.p)
  return ps.length === 0 ? null : Math.max(...ps)
}

/** `stats` with `d` appended and only the last {@link DECIDE_STATS_KEEP} kept. */
export function recordDecideStats(stats: DecideStats | null, ruleHash: string, d: DecideStatsDecision): DecideStats {
  const prior = stats && stats.ruleHash === ruleHash ? stats : { v: 1 as const, ruleHash, decisions: [], lastDriftAtMs: null }
  return { ...prior, decisions: [...prior.decisions, d].slice(-DECIDE_STATS_KEEP) }
}

/** The median of a non-empty list. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * Whether the kept decisions have drifted from the eval run. Null below
 * {@link DECIDE_DRIFT_MIN_DECISIONS}, inside {@link DECIDE_DRIFT_INTERVAL_MS}
 * of the last drift, or when nothing moved. The escalation rate is checked
 * first, then each question in name order.
 */
export function checkDecideDrift(stats: DecideStats, run: DecideEvalRunBaseline, nowMs: number): DecideDrift | null {
  const n = stats.decisions.length
  if (n < DECIDE_DRIFT_MIN_DECISIONS) return null
  if (stats.lastDriftAtMs !== null && nowMs - stats.lastDriftAtMs < DECIDE_DRIFT_INTERVAL_MS) return null
  const rate = stats.decisions.filter((d) => d.outcome === 'escalate').length / n
  if (Math.abs(rate - run.escalationRate) > DECIDE_DRIFT_ESCALATION_DELTA) {
    return { measure: 'escalation_rate', question: null, value: rate, expected: run.escalationRate, threshold: DECIDE_DRIFT_ESCALATION_DELTA, n }
  }
  for (const name of Object.keys(run.questions).sort()) {
    const range = run.questions[name]!
    const ps = stats.decisions.map((d) => d.p[name]).filter((p): p is number => typeof p === 'number')
    if (ps.length < DECIDE_DRIFT_MIN_DECISIONS) continue
    const m = median(ps)
    if (m < range.p10 || m > range.p90) return { measure: 'median_p', question: name, value: m, expected: [range.p10, range.p90], threshold: null, n: ps.length }
  }
  return null
}

function statsOf(v: unknown, ruleHash: string): DecideStats | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  if (s.v !== 1 || s.ruleHash !== ruleHash || !Array.isArray(s.decisions)) return null
  const decisions = s.decisions.filter(
    (d): d is DecideStatsDecision =>
      typeof d === 'object' && d !== null && typeof (d as DecideStatsDecision).atMs === 'number' &&
      ['allow', 'refuse', 'escalate'].includes((d as DecideStatsDecision).outcome) &&
      typeof (d as DecideStatsDecision).p === 'object' && (d as DecideStatsDecision).p !== null,
  )
  return { v: 1, ruleHash, decisions, lastDriftAtMs: typeof s.lastDriftAtMs === 'number' ? s.lastDriftAtMs : null }
}

/** A rule's stats file, `dir/<ruleHash>.json`, replaced whole by a rename. A file that does not read is no stats. */
export function readDecideStats(fs: DecideLogFs, dir: string, ruleHash: string): DecideStats | null {
  try {
    return statsOf(JSON.parse(fs.readFileSync(`${dir}/${ruleHash}.json`, 'utf8')), ruleHash)
  } catch {
    return null
  }
}

export function writeDecideStats(fs: DecideLogFs, dir: string, stats: DecideStats): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dir}/${stats.ruleHash}.json.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(stats) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, `${dir}/${stats.ruleHash}.json`)
}

// ---------------------------------------------------------------------------
// One call, written
// ---------------------------------------------------------------------------

export interface DecideLogWriteDeps {
  fs: DecideLogFs
  /** `~/.intutic/logs`. */
  logsDir: string
  /** `~/.intutic/decide/stats`. */
  statsDir: string
  sha256Hex: (text: string) => string
  /** The baseline of an eval run a rule's pin names, or null when there is none on this machine. */
  evalRun: (ruleHash: string, evalRunId: string) => DecideEvalRunBaseline | null
}

/**
 * Writes one evaluated call: its `decide.decision` line, a `decide.canary_failed`,
 * `decide.unavailable` or `decide.not_evaluated` line when one applies, then
 * each answered rule's stats, and a `decide.drift` line for each rule that
 * drifted from the eval run of the pin it ran under. Returns the drifts.
 * Throws on a write error; a caller on the decision path catches it, because
 * a log that cannot be written must not change the decision.
 */
export function writeDecideCallLog(
  evaluation: DecideEvaluation,
  rules: readonly DecideRuleEntry[],
  ctx: DecideLogContext,
  deps: DecideLogWriteDeps,
): DecideDrift[] {
  if (evaluation.rules.length === 0 && evaluation.skipped.length === 0 && evaluation.call.outcome === 'allow') return []
  const file = decideLogFileName(ctx.atMs)
  const append = (r: Record<string, unknown>) => appendDecideLogLine(deps.fs, deps.logsDir, file, decideLogLine(r))
  const record = buildDecideDecisionRecord(evaluation, rules, ctx, deps.sha256Hex)
  append(record as unknown as Record<string, unknown>)
  const head = { atMs: ctx.atMs, harness: ctx.harness, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }
  if (evaluation.canary === 'failed') {
    append(buildDecideEventRecord('decide.canary_failed', head, { engineHost: ctx.engine.host, modelDigest: ctx.engine.digest }))
  }
  const unavailable = evaluation.rules.filter((r) => r.outcome === 'unavailable')
  if (unavailable.length > 0) {
    append(buildDecideEventRecord('decide.unavailable', head, { tool: ctx.tool, rules: unavailable.map((r) => ({ ref: r.ref, effective: r.effective, error: r.error })) }))
  }
  const notEvaluated = evaluation.rules.filter((r) => r.why === 'not_evaluated')
  if (notEvaluated.length > 0) {
    append(buildDecideEventRecord('decide.not_evaluated', head, { modelDigest: ctx.engine.digest, rules: notEvaluated.map((r) => ({ ref: r.ref, ruleHash: r.ruleHash })) }))
  }

  const drifts: DecideDrift[] = []
  const byRef = new Map(rules.map((r) => [r.ref, r]))
  for (const rep of evaluation.rules) {
    const entry = byRef.get(rep.ref)
    if (!entry || !rep.answers || rep.outcome === 'unavailable') continue
    const v = validateDecideRule(entry.ir)
    if (!v.ok) continue
    const p: Record<string, number> = {}
    for (const [name, a] of Object.entries(rep.answers)) {
      const x = decideTrackedP(v.rule, name, a)
      if (x !== null) p[name] = x
    }
    let stats = recordDecideStats(readDecideStats(deps.fs, deps.statsDir, rep.ruleHash), rep.ruleHash, { atMs: ctx.atMs, outcome: rep.outcome, p })
    const pin = entry.pins.find((x) => x.modelDigest === rep.modelDigest)
    const run = pin ? deps.evalRun(rep.ruleHash, pin.evalRunId) : null
    const drift = run ? checkDecideDrift(stats, run, ctx.atMs) : null
    if (drift) {
      stats = { ...stats, lastDriftAtMs: ctx.atMs }
      drifts.push(drift)
      append(buildDecideEventRecord('decide.drift', head, { ruleRef: rep.ref, ruleHash: rep.ruleHash, modelDigest: rep.modelDigest, evalRunId: pin!.evalRunId, ...drift }))
    }
    writeDecideStats(deps.fs, deps.statsDir, stats)
  }
  return drifts
}

// ---------------------------------------------------------------------------
// Where a gate writes it
// ---------------------------------------------------------------------------

/** `host:port` of an engine URL, as the log records it; never its path, query or credentials. */
export function decideEngineHost(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return ''
  }
}

/**
 * The engine as a call's record names it: the configured adapter, host and
 * model (`cfg` is null when the engine is not configured), and the model,
 * digest and canary the evaluation reported.
 */
export function decideLogEngine(
  cfg: { adapter: string; url: string; model: string } | null,
  evaluation: Pick<DecideEvaluation, 'engine' | 'canary'>,
): DecideLogEngine {
  return {
    adapter: cfg?.adapter ?? '',
    host: cfg ? decideEngineHost(cfg.url) : '',
    model: evaluation.engine?.model ?? cfg?.model ?? null,
    digest: evaluation.engine?.modelDigest ?? null,
    digestStrength: evaluation.engine?.digestStrength ?? null,
    canary: evaluation.canary,
  }
}

/**
 * The drift baseline of the eval run `intutic decide eval` stored at
 * `decideDir/evals/<ruleHash>/runs/<evalRunId>.json`, or null when there is
 * none, it does not read, or either name is not a plain file name.
 */
export function readDecideEvalRunBaseline(
  fs: Pick<DecideLogFs, 'readFileSync'>,
  decideDir: string,
  ruleHash: string,
  evalRunId: string,
): DecideEvalRunBaseline | null {
  if (!/^[0-9a-f]+$/.test(ruleHash) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(evalRunId)) return null
  try {
    const run = JSON.parse(fs.readFileSync(`${decideDir}/evals/${ruleHash}/runs/${evalRunId}.json`, 'utf8')) as { baseline?: DecideEvalRunBaseline } | null
    const b = run?.baseline
    if (!b || typeof b.escalationRate !== 'number' || typeof b.questions !== 'object' || b.questions === null) return null
    return b
  } catch {
    return null
  }
}

/**
 * Where a gate writes the decide log and its drift stats under the home
 * directory `home`, as `intutic decide check` does: `~/.intutic/logs`,
 * `~/.intutic/decide/stats`, and the eval runs `decide eval` stored under
 * `~/.intutic/decide/evals`.
 */
export function decideLogDeps(fs: DecideLogFs, home: string, sha256Hex: (text: string) => string): DecideLogWriteDeps {
  const intutic = `${home}/.intutic`
  return {
    fs,
    logsDir: `${intutic}/logs`,
    statsDir: `${intutic}/decide/stats`,
    sha256Hex,
    evalRun: (ruleHash, evalRunId) => readDecideEvalRunBaseline(fs, `${intutic}/decide`, ruleHash, evalRunId),
  }
}

// ---------------------------------------------------------------------------
// As source
// ---------------------------------------------------------------------------

/**
 * This module as JavaScript source, for the hook gates to embed: every
 * constant and every function above. The embedding scope supplies what it
 * imports from `decide.ts` (`bandValue`, `choiceAtoms`, `decideOptions`,
 * `decideQuestionBand`, `parseWhen`, `validateDecideRule`) and
 * `decideEngine.ts` (`buildDecideToolCallState`, `decideCanonicalJson`). A
 * test holds the list to the functions this file declares.
 */
export const DECIDE_LOG_JS_SOURCE = decideModuleSource([
  `const DECIDE_LOG_LINE_MAX_BYTES = ${DECIDE_LOG_LINE_MAX_BYTES};`,
  `const DECIDE_ARGS_EXCERPT_MAX_BYTES = ${DECIDE_ARGS_EXCERPT_MAX_BYTES};`,
  `const DECIDE_LOG_RETENTION_DAYS = ${DECIDE_LOG_RETENTION_DAYS};`,
  `const DECIDE_STATS_KEEP = ${DECIDE_STATS_KEEP};`,
  `const DECIDE_DRIFT_MIN_DECISIONS = ${DECIDE_DRIFT_MIN_DECISIONS};`,
  `const DECIDE_DRIFT_ESCALATION_DELTA = ${DECIDE_DRIFT_ESCALATION_DELTA};`,
  `const DECIDE_DRIFT_INTERVAL_MS = ${DECIDE_DRIFT_INTERVAL_MS};`,
  `const DECIDE_REDACTED = ${JSON.stringify(DECIDE_REDACTED)};`,
  decideLogFileName,
  decideLogFileDate,
  utf8Length,
  decideUtf8Prefix,
  decideRedact,
  decideArgsExcerpt,
  eqAtoms,
  logAnswer,
  whenValue,
  buildDecideDecisionRecord,
  buildDecideEventRecord,
  decideLogLine,
  appendDecideLogLine,
  decideTrackedP,
  recordDecideStats,
  median,
  checkDecideDrift,
  statsOf,
  readDecideStats,
  writeDecideStats,
  writeDecideCallLog,
  decideEngineHost,
  decideLogEngine,
  readDecideEvalRunBaseline,
  decideLogDeps,
])
