/**
 * `intutic decide` — decide rules on this machine: the engine, the rules'
 * evidence, and the entry the shell gates call.
 *
 *   test <rule> --state <file>       ask a rule's questions about one call
 *   eval <rule> --labels <file>      measure a rule on labelled calls; with a
 *        [--preregister <file>]      pre-registration, a pass pins the model
 *        [--adversarial]             add the adversarial case families
 *   calibrate <rule> --labels <file> fit a combiner and band to labels
 *   models                           what the bake-off validated
 *   check --stdin                    one call, for the shell and n8n gates
 *   configure                        write ~/.intutic/decide/engine.json
 *   disable / enable                 every rule to shadow, and back
 *   lint                             read every local decide: line
 *
 * A rule enforces only under a pin for the engine's model digest, and a pin
 * comes only from a passing pre-registered `decide eval`: the band and pass
 * marks are written down before the labels are read, the set is not one an
 * earlier run used, and planted approvals are caught.
 *
 * `check` reads stdin and writes one JSON line, exit 0:
 *   in  {"v":1,"harness","tool","toolInput","cwd","sessionId","budgetMs","lastUserTurn"}
 *   out {"v":1,"outcome":"allow|refuse|escalate","code":null|"DECIDE_REFUSED"|"DECIDE_ESCALATED"|"GOVERNANCE_UNAVAILABLE","ruleId":"decide.<ref>"|null,"reason":"…"}
 * It never refuses for a shadow rule, and it refuses with
 * GOVERNANCE_UNAVAILABLE for an enforcing rule it cannot evaluate, a record
 * that does not decode, or input that does not read. Its start-up time is
 * part of the gate's budget, so it imports nothing it does not use.
 *
 * @module
 */

import * as node_fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import {
  appendDecideLogLine,
  buildDecideResponseState,
  buildDecideToolCallState,
  checkSelfHostedDecisionHost,
  createDecideCanaryFileStore,
  DECIDE_ADAPTERS,
  DECIDE_DEFAULT_ENGINE_URL,
  DECIDE_RECORD_TAG,
  decideEffectiveRollout,
  decideLogEngine,
  decideLogFileName,
  decideLogRedactionSources,
  decideOptions,
  decideQuestionBand,
  decideRuleHash,
  decideRuleOutcome,
  decideRuleRef,
  DecideEngineError,
  decodeDecideRecord,
  evaluateDecideCall,
  parseDecideLine,
  resolveDecideEngineConfig,
  runDecideCanary,
  validateDecideRule,
  writeDecideCallLog,
  type DecideAnswer,
  type DecideBand,
  type DecideCombiner,
  type DecideEngine,
  type DecideEngineConfig,
  type DecidePin,
  type DecideRecord,
  type DecideRule,
  type DecideRuleEntry,
} from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { parsePolicySnapshot, resolveSnapshotRulesPath } from '../lib/policySnapshot.js'
import {
  candidatesDir,
  canaryFile,
  digestFileName,
  disabledFile,
  engineFile,
  engineHost,
  evalsDir,
  loadEngine,
  logsDir,
  readEngineFile,
  decideRuleNotes,
  readEvalRunBaseline,
  readJson,
  runsDir,
  sha256Hex,
  statsDir,
  writeEngineFile,
  writeJson,
  type LoadedEngine,
} from '../lib/decideLocal.js'
import {
  adversarialCases,
  adversarialReport,
  auc,
  fitBand,
  fitCombiner,
  metrics,
  parseLabels,
  PASS_MARKS,
  quantile,
  splitOf,
  trackedP,
  withBand,
  type AnsweredCase,
  type EvalMetrics,
  type LabelledCase,
} from '../lib/decideEval.js'
import { decideBudgets, decideRuleEstimateMs } from '../lib/decideBudget.js'

const nodeFs = {
  readFileSync: node_fs.readFileSync,
  writeFileSync: node_fs.writeFileSync,
  mkdirSync: node_fs.mkdirSync,
  renameSync: node_fs.renameSync,
  openSync: node_fs.openSync,
  writeSync: (fd: number, data: string) => node_fs.writeSync(fd, data),
  closeSync: node_fs.closeSync,
} as Parameters<typeof writeDecideCallLog>[3]['fs'] & Parameters<typeof createDecideCanaryFileStore>[1]

function fail(message: string): void {
  log.error(message)
  process.exitCode = 1
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)

// ===========================================================================
// check --stdin
// ===========================================================================

export interface DecideCheckOutput {
  v: 1
  outcome: 'allow' | 'refuse' | 'escalate'
  code: null | 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | 'GOVERNANCE_UNAVAILABLE'
  ruleId: string | null
  reason: string
}

interface CheckInput {
  harness: string
  tool: string
  toolInput: unknown
  cwd: string
  sessionId: string
  budgetMs: number
  lastUserTurn: string | null
}

const UNAVAILABLE = (reason: string, ruleId: string | null = null): DecideCheckOutput => ({ v: 1, outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleId, reason })
const ALLOW = (reason: string): DecideCheckOutput => ({ v: 1, outcome: 'allow', code: null, ruleId: null, reason })
const MAX_BUDGET_MS = 60_000

function readCheckInput(raw: string): CheckInput | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v) || v.v !== 1) return null
  if (typeof v.tool !== 'string' || !v.tool) return null
  if (typeof v.budgetMs !== 'number' || !Number.isFinite(v.budgetMs)) return null
  return {
    harness: typeof v.harness === 'string' ? v.harness : '',
    tool: v.tool,
    toolInput: v.toolInput ?? {},
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
    budgetMs: Math.min(Math.max(v.budgetMs, 0), MAX_BUDGET_MS),
    lastUserTurn: typeof v.lastUserTurn === 'string' ? v.lastUserTurn : null,
  }
}

const checkRule = (ir: unknown): string | null => {
  const v = validateDecideRule(ir)
  return v.ok ? decideRuleHash(v.rule, sha256Hex) : null
}

/** The questions whose answers were unknown, for a person to look at. */
function unknownQuestions(entry: DecideRuleEntry, answers: Record<string, DecideAnswer> | null): string[] {
  const v = validateDecideRule(entry.ir)
  if (!v.ok || !answers) return Object.keys(entry.ir.questions)
  const o = decideRuleOutcome(v.rule, v.expr, Object.fromEntries(Object.entries(answers).map(([n, a]) => [n, { p: a.p, perOrder: a.perOrder }])))
  // A choice question is unknown when an option `when` names is unknown.
  const named = new Map<string, string[]>()
  const walk = (e: typeof v.expr): void => {
    if (e.op === 'eq') named.set(e.q, [...(named.get(e.q) ?? []), e.o])
    else if (e.op === 'not') walk(e.a)
    else if (e.op === 'and' || e.op === 'or') {
      walk(e.a)
      walk(e.b)
    }
  }
  walk(v.expr)
  const out: string[] = []
  for (const name of Object.keys(v.rule.questions).sort()) {
    if (o.atoms.yes[name] === 'U' || (named.get(name) ?? []).some((opt) => o.atoms.eq[name]?.[opt] === 'U')) out.push(name)
  }
  return out
}

function ruleName(entry: DecideRuleEntry): string {
  return `${entry.ir.id} (${entry.sopTitle})`
}

/**
 * One call's decide rules, for a gate that cannot evaluate them itself.
 * Never throws. `startMs` is when this process started, which the gate's
 * budget was computed against.
 */
export async function decideCheck(raw: string, opts: { startMs?: number } = {}): Promise<DecideCheckOutput> {
  const startMs = opts.startMs ?? performance.timeOrigin
  const input = readCheckInput(raw)
  if (!input) return UNAVAILABLE('decide check: the input is not a version 1 request')
  const deadlineMs = startMs + input.budgetMs

  let text: string
  const path = resolveSnapshotRulesPath()
  try {
    text = node_fs.readFileSync(path, 'utf8')
  } catch {
    return ALLOW('no policy snapshot on this machine')
  }
  const health = parsePolicySnapshot(text, { path })
  if (health.state === 'invalid') {
    // Every gate drops an invalid snapshot's dynamic tier, its decide records and fallback lines with it.
    return ALLOW('the policy snapshot does not verify; its decide rules are not in force')
  }

  const records: DecideRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${DECIDE_RECORD_TAG}\t`)) continue
    const f = line.split('\t')
    if (!(f[3] ?? '').split(',').includes(input.tool)) continue
    const record = decodeDecideRecord(line, checkRule)
    if (record) {
      records.push(record)
      continue
    }
    // A record a gate would leave its fallback line in force for refuses
    // here too; one stamped shadow with no fallback line refuses nowhere.
    if (f[1] !== '-' || f[2] !== 'shadow') return UNAVAILABLE(`a decide rule for ${input.tool} does not decode, so the call is refused until the snapshot is rewritten`)
  }
  if (records.length === 0) return ALLOW(`no decide rule names ${input.tool}`)

  const loaded = loadEngine()
  // A rule the engine cannot answer inside the budget (the p95 `doctor`
  // stored) is not asked: an enforcing one escalates, a shadow one is logged
  // and allowed. The gates' own decide tiers do the same.
  const merged = await evaluateDecideCall(
    { deterministic: 'allow', tool: input.tool, toolInput: input.toolInput, cwd: input.cwd, lastUserTurn: input.lastUserTurn, rules: records, deadlineMs },
    {
      engine: loaded.engine,
      engineUrl: loaded.cfg?.url ?? '',
      canary: createDecideCanaryFileStore(canaryFile(), nodeFs),
      sha256Hex,
      q95Ms: loaded.q95Ms,
      parallel: loaded.cfg?.parallel ?? 1,
    },
  )

  try {
    writeDecideCallLog(merged, records, {
      atMs: Date.now(),
      harness: input.harness,
      workspaceId: health.workspaceId,
      sessionId: input.sessionId,
      tool: input.tool,
      toolInput: input.toolInput,
      cwd: input.cwd,
      lastUserTurn: input.lastUserTurn,
      budgetMs: input.budgetMs,
      latencyMs: Math.round(Date.now() - startMs),
      // As every gate names it (decideLog.ts).
      engine: decideLogEngine(loaded.cfg, merged),
      redact: decideLogRedactionSources(),
    }, { fs: nodeFs, logsDir: logsDir(), statsDir: statsDir(), sha256Hex, evalRun: readEvalRunBaseline })
  } catch {
    // A log that cannot be written never changes the decision.
  }

  const call = merged.call
  const entry = call.ruleRef ? records.find((r) => r.ref === call.ruleRef) ?? null : null
  const ruleId = call.ruleRef ? `decide.${call.ruleRef}` : null
  if (call.outcome === 'allow') return { v: 1, outcome: 'allow', code: null, ruleId: null, reason: '' }
  if (call.code === 'GOVERNANCE_UNAVAILABLE') {
    const report = merged.rules.find((r) => r.ref === call.ruleRef)
    return UNAVAILABLE(
      entry ? `Decide rule ${ruleName(entry)} could not be evaluated: the decide engine is unavailable (${report?.error ?? 'unknown'})` : (call.reason ?? 'the decide engine is unavailable'),
      ruleId,
    )
  }
  const report = merged.rules.find((r) => r.ref === call.ruleRef)
  if (call.code === 'DECIDE_REFUSED') {
    return { v: 1, outcome: 'refuse', code: 'DECIDE_REFUSED', ruleId, reason: `Decide rule ${entry ? ruleName(entry) : call.ruleRef} refused this call` }
  }
  const title = entry ? entry.ir.title ?? entry.sopTitle : (call.ruleRef ?? '')
  const unknown =
    report?.error === 'budget_skip' ? `the engine cannot answer within this harness's ${input.budgetMs} ms` : entry ? unknownQuestions(entry, report?.answers ?? null).join(', ') || 'the combined answer' : ''
  return { v: 1, outcome: call.outcome, code: 'DECIDE_ESCALATED', ruleId, reason: `Needs a person: ${title} — ${unknown}` }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function runDecideCheck(opts: { stdin?: boolean }): Promise<void> {
  let out: DecideCheckOutput
  if (!opts.stdin) {
    out = UNAVAILABLE('decide check reads its request from stdin: pass --stdin')
  } else {
    try {
      out = await decideCheck(await readStdin())
    } catch (err) {
      out = UNAVAILABLE(`decide check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}

// ===========================================================================
// Shared by test / eval / calibrate
// ===========================================================================

async function localRule(spec: string, workspace?: string) {
  const { decideWorkspaceRoot, findDecideRule, loadLocalDecideLines } = await import('../lib/decideRules.js')
  return findDecideRule(await loadLocalDecideLines(decideWorkspaceRoot(workspace)), spec)
}

function engineOrFail(loaded: LoadedEngine): DecideEngine | null {
  if (loaded.engine instanceof DecideEngineError) {
    fail(`The decide engine is not usable: ${loaded.engine.message} (${loaded.engine.code}). Configure it with \`intutic decide configure\`.`)
    return null
  }
  return loaded.engine
}

function questionCalls(rule: DecideRule) {
  return Object.keys(rule.questions).map((name) => {
    const q = rule.questions[name]!
    return q.type === 'choice' ? { name, type: 'choice' as const, ask: q.ask, options: decideOptions(q) } : { name, type: 'yes_no' as const, ask: q.ask }
  })
}

/** What a case asks about: a call, or a response's text for an `on: response` rule. */
type Asked = { tool: string; toolInput: unknown; cwd: string; response?: string | null }

/**
 * The state a gate sends for this call, or the state the gateway sends for
 * this response: for an `on: response` rule, the SOP's text and the
 * response, held to the engine's response limit (`maxResponseStateBytes`,
 * 32,768 bytes by default). `context: ["last_user_turn"]` is reserved in
 * 3.0: no gate supplies the user's last turn, so a case's `lastUserTurn` is
 * never sent, and `test` and `eval` measure what a gate asks.
 */
function stateFor(rule: DecideRule, sopTitle: string, ruleText: string, c: Asked, maxResponseBytes?: number): string {
  if (rule.on === 'response') {
    return buildDecideResponseState({ ruleText, content: c.response ?? '', ...(maxResponseBytes !== undefined ? { maxBytes: maxResponseBytes } : {}) })
  }
  return buildDecideToolCallState({
    ruleId: rule.id,
    sopTitle,
    ruleText,
    tool: c.tool,
    cwd: c.cwd,
    toolInput: c.toolInput,
    ...((rule.context ?? []).includes('last_user_turn') ? { lastUserTurn: null } : {}),
  })
}

/** Says, once, that a `lastUserTurn` a state or labels file carries is not sent. */
function warnUnsentTurn(count: number, json: boolean | undefined): void {
  if (count === 0) return
  const message = `${count === 1 ? 'The call carries' : `${count} calls carry`} a lastUserTurn, which is not sent: context: ["last_user_turn"] is reserved in 3.0, and no gate supplies the user's last turn.`
  if (json) process.stderr.write(message + '\n')
  else log.warn(message)
}

function logState(ref: string, ruleHash: string, state: string): void {
  appendDecideLogLine(nodeFs, logsDir(), decideLogFileName(Date.now(), 'decide-state'), JSON.stringify({ v: 1, at: new Date().toISOString(), ref, ruleHash, state }) + '\n')
}

/** Asks every case, one after another (the engine runs each case's questions in parallel). */
async function askCases(
  engine: DecideEngine,
  rule: DecideRule,
  sopTitle: string,
  ruleText: string,
  cases: readonly LabelledCase[],
  timeoutMs: number,
  opts: { logState?: boolean; ref: string; ruleHash: string; maxResponseBytes?: number },
): Promise<AnsweredCase[]> {
  const qs = questionCalls(rule)
  const out: AnsweredCase[] = []
  for (const c of cases) {
    let answers: Record<string, DecideAnswer> | null
    try {
      const state = stateFor(rule, sopTitle, ruleText, c, opts.maxResponseBytes)
      if (opts.logState) logState(opts.ref, opts.ruleHash, state)
      answers = (await engine.ask(state, qs, Date.now() + timeoutMs * (qs.length * 3 + 1))).answers
    } catch {
      answers = null
    }
    out.push({ c, answers })
  }
  return out
}

// ===========================================================================
// test
// ===========================================================================

export async function runDecideTest(spec: string, opts: { state: string; json?: boolean; logState?: boolean; workspace?: string }): Promise<void> {
  let hit
  try {
    hit = await localRule(spec, opts.workspace)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  const rule = hit.decl.rule
  let c: Asked & { lastUserTurn: string | null }
  try {
    const v = JSON.parse(node_fs.readFileSync(resolve(opts.state), 'utf8')) as Record<string, unknown>
    if (rule.on === 'response') {
      if (typeof v.response !== 'string') throw new Error('it has no "response": an on: response rule is asked about a response\'s text')
      c = { tool: '', toolInput: {}, cwd: '', lastUserTurn: null, response: v.response }
    } else {
      if (typeof v.tool !== 'string') throw new Error('it has no "tool"')
      c = { tool: v.tool, toolInput: v.toolInput ?? {}, cwd: typeof v.cwd === 'string' ? v.cwd : process.cwd(), lastUserTurn: typeof v.lastUserTurn === 'string' ? v.lastUserTurn : null }
    }
  } catch (err) {
    return fail(`Could not read the state file ${opts.state}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const loaded = loadEngine()
  const engine = engineOrFail(loaded)
  if (!engine) return
  let state: string
  try {
    state = stateFor(rule, hit.sopTitle, hit.ruleText, c, loaded.cfg?.maxResponseStateBytes)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  if (opts.logState) logState(hit.ref!, hit.ruleHash!, state)
  warnUnsentTurn(c.lastUserTurn === null ? 0 : 1, opts.json)
  let result
  try {
    result = await engine.ask(state, questionCalls(rule), Date.now() + (loaded.cfg?.timeoutMs ?? 5000) * 4)
  } catch (err) {
    return fail(`The engine did not answer: ${err instanceof Error ? err.message : String(err)}`)
  }
  const inputs = Object.fromEntries(Object.entries(result.answers).map(([n, a]) => [n, { p: a.p, perOrder: a.perOrder }]))
  const v = validateDecideRule(rule)
  if (!v.ok) return fail(v.reason)
  const o = decideRuleOutcome(v.rule, v.expr, inputs)
  const pins = (readPins(hit.ruleHash!) ?? []).filter((p) => p.modelDigest === result.modelDigest)
  const report = {
    ref: hit.ref,
    ruleHash: hit.ruleHash,
    model: result.model,
    modelDigest: result.modelDigest,
    digestStrength: result.digestStrength,
    pinned: pins.length > 0,
    when: o.value,
    outcome: o.outcome,
    code: o.code,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([n, a]) => {
        const band = decideQuestionBand(v.rule, n)
        return [n, a.type === 'yes_no' ? { p: a.p, band: [band.no_below, band.yes_at], value: o.atoms.yes[n] } : { perOrder: a.perOrder, atoms: o.atoms.eq[n] }]
      }),
    ),
    latencyMs: result.latencyMs,
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  log.header(`intutic decide test ${hit.ref}`)
  log.field('Model', `${result.model} (${result.modelDigest}, ${result.digestStrength} digest)`)
  for (const [n, a] of Object.entries(report.answers)) {
    if ('p' in a) log.field(n, `p(yes) ${(a.p ?? 0).toFixed(3)} against [${(a.band ?? []).join(', ')}] → ${a.value}`)
    else log.field(n, Object.entries(a.atoms ?? {}).map(([opt, t]) => `${opt}=${t}`).join(' '))
  }
  log.field('when', o.value)
  log.field('Outcome', `${o.outcome}${o.code ? ` (${o.code})` : ''}${pins.length > 0 ? '' : ' — shadow: no pin for this model; run `intutic decide eval`'}`)
  log.field('Latency', `${result.latencyMs} ms`)
}

// ===========================================================================
// eval
// ===========================================================================

interface Preregistration {
  v: 1
  ruleRef: string
  ruleHash: string
  modelDigest: string
  band: Record<string, DecideBand>
  combiner: DecideCombiner | null
  passMarks: typeof PASS_MARKS
  adversarial: true
  registeredAt: string
  /**
   * The control-plane calibration this run is the companion of
   * (`--calibration`): its band and combiner as the control plane serves
   * them. The run is scored under them.
   */
  calibration?: ServedCalibration
  /** The eval run the control plane registered for this pre-registration, on a logged-in machine. */
  serverEvalRunId?: string
}

/** A calibration as `GET /api/v1/decide/calibrations` serves it: the fields a companion run pre-registers. */
interface ServedCalibration {
  calibrationId: string
  band: DecideBand
  /** As served, so the pre-registration names exactly this combiner; null for a band-only calibration. */
  combiner: { bias: number; weights: Record<string, number> } | null
}

/** How long one request to the control plane may take. */
const CONTROL_PLANE_TIMEOUT_MS = 10_000

interface ControlPlane {
  url: string
  apiKey: string
}

/** The control plane this machine is logged in to, or null when it is not. */
async function controlPlaneLogin(): Promise<ControlPlane | null> {
  const { loadCredentials } = await import('../config/store.js')
  const creds = await loadCredentials()
  if (!creds || !creds.controlPlaneUrl || !creds.apiKey) return null
  let end = creds.controlPlaneUrl.length
  while (end > 0 && creds.controlPlaneUrl.charCodeAt(end - 1) === 0x2f) end--
  return { url: creds.controlPlaneUrl.slice(0, end), apiKey: creds.apiKey }
}

/** One JSON request to the control plane. Throws when it gets no answer; a non-2xx answer is returned. */
async function controlPlaneRequest(cp: ControlPlane, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${cp.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cp.apiKey}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
  })
  const { unwrapToonEnvelope } = await import('../lib/api.js')
  let parsed: unknown = null
  try {
    parsed = unwrapToonEnvelope(await res.json())
  } catch {
    parsed = null
  }
  return { status: res.status, body: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null }
}

function errorText(r: { status: number; body: Record<string, unknown> | null }): string {
  return typeof r.body?.error === 'string' ? `${r.status}: ${r.body.error}` : `status ${r.status}`
}

/**
 * The candidate calibration `calibrationId` of this rule, fitted on
 * `modelDigest`, as the control plane serves it. Throws a message for the
 * user when there is none.
 */
async function fetchCalibration(cp: ControlPlane, ruleHash: string, calibrationId: string, modelDigest: string): Promise<ServedCalibration> {
  const r = await controlPlaneRequest(cp, 'GET', `/api/v1/decide/calibrations?ruleHash=${ruleHash}&limit=500`)
  if (r.status !== 200) throw new Error(`The control plane did not list this rule's calibrations (${errorText(r)})`)
  const list = Array.isArray(r.body?.calibrations) ? (r.body.calibrations as Array<Record<string, unknown>>) : []
  const c = list.find((x) => x.calibrationId === calibrationId)
  if (!c) throw new Error(`No calibration ${calibrationId} of this rule (rule hash ${ruleHash.slice(0, 12)}) on the control plane`)
  if (c.status !== 'candidate') throw new Error(`Calibration ${calibrationId} is ${String(c.status)}; a companion run is for a candidate`)
  if (c.modelDigest !== modelDigest) throw new Error(`Calibration ${calibrationId} was fitted on model ${String(c.modelDigest)}; the engine runs ${modelDigest}`)
  const band = c.band as Record<string, unknown> | null
  if (!band || typeof band.yes_at !== 'number' || typeof band.no_below !== 'number') throw new Error(`Calibration ${calibrationId} has no band`)
  const comb = c.combiner as Record<string, unknown> | null | undefined
  let combiner: ServedCalibration['combiner'] = null
  if (comb !== null && comb !== undefined) {
    const w = comb.weights
    if (typeof comb.bias !== 'number' || typeof w !== 'object' || w === null || Object.values(w).some((x) => typeof x !== 'number')) {
      throw new Error(`Calibration ${calibrationId} has a combiner this CLI does not read`)
    }
    combiner = comb as ServedCalibration['combiner']
  }
  return { calibrationId, band: { yes_at: band.yes_at, no_below: band.no_below }, combiner }
}

/**
 * The pre-registration as the control plane registers it: the local
 * document, and for a companion run its calibration's id, band and combiner
 * exactly as served, which is how the control plane recognises the run.
 */
export function serverPreregistration(doc: Preregistration): Record<string, unknown> {
  const { serverEvalRunId: _id, calibration, ...rest } = doc
  return calibration ? { ...rest, calibrationId: calibration.calibrationId, band: calibration.band, combiner: calibration.combiner } : rest
}

/** Registers the pre-registration with the control plane: its eval run's id, or why not. */
async function registerEvalRun(cp: ControlPlane, doc: Preregistration): Promise<{ evalRunId: string } | { error: string }> {
  try {
    const r = await controlPlaneRequest(cp, 'POST', '/api/v1/decide/eval-runs', { ruleHash: doc.ruleHash, modelDigest: doc.modelDigest, prereg: serverPreregistration(doc), source: 'cli' })
    const run = r.body?.evalRun as Record<string, unknown> | undefined
    if (r.status !== 201 || typeof run?.evalRunId !== 'string') return { error: errorText(r) }
    return { evalRunId: run.evalRunId }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function readPins(ruleHash: string): DecidePin[] | null {
  try {
    return node_fs
      .readdirSync(evalsDir(ruleHash))
      .filter((n) => n.endsWith('.json'))
      .map((n) => readJson<DecidePin>(join(evalsDir(ruleHash), n)))
      .filter((p): p is DecidePin => p !== null && typeof p.modelDigest === 'string')
  } catch {
    return null
  }
}

function questionBands(rule: DecideRule): Record<string, DecideBand> {
  return Object.fromEntries(Object.keys(rule.questions).sort().map((n) => [n, decideQuestionBand(rule, n)]))
}

function usedSetHashes(ruleHash: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const n of node_fs.readdirSync(runsDir(ruleHash))) {
      const r = readJson<{ setHash?: string; preregistered?: boolean }>(join(runsDir(ruleHash), n))
      if (r?.preregistered && typeof r.setHash === 'string') out.add(r.setHash)
    }
  } catch {
    // no runs yet
  }
  return out
}

export interface DecideEvalOptions {
  labels?: string
  preregister?: string
  /** A control-plane candidate calibration this run pre-registers and uploads as its companion. */
  calibration?: string
  adversarial?: boolean
  json?: boolean
  logState?: boolean
  workspace?: string
}

/**
 * What a pass on a logged-in machine means. The pin is written here, but a
 * connected machine's snapshot takes its decide rules and pins only from the
 * control plane, so the sync daemon does not carry it into the snapshot.
 */
export const DECIDE_EVAL_CONNECTED_PIN_NOTE =
  'This machine is logged in, and a connected machine\'s policy snapshot takes its decide rules and pins only from the control plane: ' +
  'this pin is not written into it. It applies to local use, on a machine with no login (`intutic gates install`).'

export async function runDecideEval(spec: string, opts: DecideEvalOptions): Promise<void> {
  let hit
  try {
    hit = await localRule(spec, opts.workspace)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  const rule = hit.decl.rule
  const ruleHash = hit.ruleHash!
  const loaded = loadEngine()
  const engine = engineOrFail(loaded)
  if (!engine) return
  let identity
  try {
    identity = await engine.describe(Date.now() + (loaded.cfg?.timeoutMs ?? 5000))
  } catch (err) {
    return fail(`The engine did not say which model it runs: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (opts.calibration && !opts.preregister) return fail('--calibration pre-registers a companion run: pass --preregister <file> too.')
  // On a logged-in machine a pre-registered run is registered with, and uploaded to, the control plane.
  const cp = opts.preregister ? await controlPlaneLogin() : null

  // Pre-registration: written before any label is read; a run under it must match it.
  let prereg: Preregistration | null = null
  if (opts.preregister) {
    const file = resolve(opts.preregister)
    if (!node_fs.existsSync(file)) {
      let calibration: ServedCalibration | undefined
      if (opts.calibration) {
        if (!cp) return fail('--calibration reads the calibration from the control plane: log in first (`intutic login`).')
        try {
          calibration = await fetchCalibration(cp, ruleHash, opts.calibration, identity.modelDigest)
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
      const candidate = readJson<{ modelDigest?: string; combiner?: { bias: number; weights: Record<string, number> }; band?: DecideBand }>(
        join(candidatesDir(ruleHash), digestFileName(identity.modelDigest)),
      )
      const combiner = calibration
        ? calibration.combiner
          ? { bias: calibration.combiner.bias, weights: calibration.combiner.weights, band: calibration.band }
          : null
        : candidate?.modelDigest === identity.modelDigest && candidate.combiner && candidate.band
          ? { ...candidate.combiner, band: candidate.band }
          : null
      const doc: Preregistration = {
        v: 1,
        ruleRef: hit.ref!,
        ruleHash,
        modelDigest: identity.modelDigest,
        band: questionBands(rule),
        combiner,
        passMarks: PASS_MARKS,
        adversarial: true,
        registeredAt: new Date().toISOString(),
        ...(calibration ? { calibration } : {}),
      }
      const registered = cp ? await registerEvalRun(cp, doc) : null
      if (registered && 'evalRunId' in registered) doc.serverEvalRunId = registered.evalRunId
      node_fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      log.success(`Pre-registered ${hit.ref} on ${identity.modelDigest} in ${opts.preregister} (sha256 ${sha256Hex(JSON.stringify(doc)).slice(0, 12)}). No label was read.`)
      if (calibration) log.dim(`It is the companion run of calibration ${calibration.calibrationId}: scored at its band${calibration.combiner ? ' and combiner' : ''}.`)
      if (registered && 'evalRunId' in registered) log.dim(`Registered with the control plane as eval run ${registered.evalRunId}.`)
      else if (registered) log.warn(`Not registered with the control plane (${registered.error}); it is registered when the run is evaluated.`)
      log.dim('Run the same command again to evaluate against it.')
      return
    }
    try {
      prereg = JSON.parse(node_fs.readFileSync(file, 'utf8')) as Preregistration
    } catch {
      return fail(`${opts.preregister} is not a pre-registration`)
    }
    if (prereg.v !== 1 || prereg.ruleHash !== ruleHash) return fail(`${opts.preregister} was registered for another version of this rule (rule hash ${String(prereg.ruleHash).slice(0, 12)}); pre-register again`)
    if (prereg.modelDigest !== identity.modelDigest) return fail(`${opts.preregister} was registered for model ${prereg.modelDigest}; the engine runs ${identity.modelDigest}`)
    if (!(Date.parse(prereg.registeredAt) < Date.now())) return fail(`${opts.preregister} has no registration time before now`)
    if (opts.calibration && prereg.calibration?.calibrationId !== opts.calibration) {
      return fail(`${opts.preregister} does not pre-register calibration ${opts.calibration}; pre-register a new file with --calibration`)
    }
  }
  // Registered before any label is read, when the pre-registration could not be.
  let serverRunId = prereg?.serverEvalRunId ?? null
  let serverError: string | null = null
  if (prereg && cp && !serverRunId) {
    const r = await registerEvalRun(cp, prereg)
    if ('evalRunId' in r) serverRunId = r.evalRunId
    else serverError = r.error
  }

  if (!opts.labels) return fail('Pass --labels <file.jsonl>.')
  let labelsText: string
  let cases: LabelledCase[]
  try {
    labelsText = node_fs.readFileSync(resolve(opts.labels), 'utf8')
    cases = parseLabels(labelsText, rule.on)
  } catch (err) {
    return fail(`Could not read ${opts.labels}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const setHash = sha256Hex(labelsText)
  warnUnsentTurn(cases.filter((c) => c.lastUserTurn !== null).length, opts.json)
  const adversarial = Boolean(opts.adversarial) || prereg !== null
  const extra = adversarial ? adversarialCases(cases) : []
  const timeoutMs = loaded.cfg?.timeoutMs ?? 5000
  const askOpts = { logState: opts.logState, ref: hit.ref!, ruleHash, maxResponseBytes: loaded.cfg?.maxResponseStateBytes }
  const answered = await askCases(engine, rule, hit.sopTitle, hit.ruleText, cases, timeoutMs, askOpts)
  const answeredAdv = await askCases(engine, rule, hit.sopTitle, hit.ruleText, extra, timeoutMs, askOpts)

  const combiner = prereg?.combiner ?? null
  let band: DecideBand | null = null
  let scored: readonly AnsweredCase[] = answered
  let fit = null
  let evalRule = rule
  if (!prereg) {
    const dev = answered.filter((a) => splitOf(a.c.id) === 'dev')
    scored = answered.filter((a) => splitOf(a.c.id) === 'test')
    fit = fitBand(rule, dev)
    if (fit) {
      band = fit.band
      evalRule = withBand(rule, band)
    }
  } else if (prereg.calibration && !prereg.calibration.combiner) {
    // A band-only calibration: the rule's own `when`, at the calibration's band.
    evalRule = withBand(rule, prereg.calibration.band)
  }
  const m = metrics(evalRule, scored, combiner)
  const adv = adversarial ? adversarialReport(evalRule, answeredAdv, combiner) : null
  const engineErrors = [...answered, ...answeredAdv].filter((a) => !a.answers).length

  // Per question: AUC against the label, and the p10/p90 drift compares with.
  const questions: Record<string, { auc: number | null; p10: number | null; p90: number | null }> = {}
  for (const name of Object.keys(rule.questions).sort()) {
    const pairs = answered
      .map((a) => ({ p: a.answers?.[name] ? trackedP(rule, name, a.answers[name]!) : null, y: a.c.label === 'refuse' }))
      .filter((x): x is { p: number; y: boolean } => x.p !== null)
    questions[name] = {
      auc: auc(pairs),
      p10: pairs.length ? quantile(pairs.map((x) => x.p), 0.1) : null,
      p90: pairs.length ? quantile(pairs.map((x) => x.p), 0.9) : null,
    }
  }

  const reusedSet = prereg !== null && usedSetHashes(ruleHash).has(setHash)
  const marks = prereg
    ? {
        preregistered: !reusedSet,
        size: m.n >= PASS_MARKS.minCases && m.refuseLabels >= PASS_MARKS.minRefuseLabels,
        recall: m.recall !== null && m.recall >= PASS_MARKS.recall,
        falseAlarms: m.falseAlarms === null || m.falseAlarms <= PASS_MARKS.falseAlarms,
        escalation: m.escalation !== null && m.escalation <= PASS_MARKS.escalation,
        plantedApprovals: adv !== null && adv.planted_approval.recall !== null && adv.planted_approval.recall >= PASS_MARKS.plantedApprovalRecall,
      }
    : null
  const passed = marks !== null && Object.values(marks).every(Boolean)
  // The results, uploaded to the eval run the control plane registered. Never the labels or a state.
  let server: { evalRunId: string | null; uploaded: boolean; error: string | null; marks: Record<string, boolean> | null } | null = null
  if (prereg && cp) {
    server = { evalRunId: serverRunId, uploaded: false, error: serverError, marks: null }
    if (serverRunId) {
      try {
        const r = await controlPlaneRequest(cp, 'POST', `/api/v1/decide/eval-runs/${encodeURIComponent(serverRunId)}/results`, { setHash, results: m, adversarial: adv })
        if (r.status === 200) {
          server.uploaded = true
          server.marks = (r.body?.marks as Record<string, boolean> | undefined) ?? null
        } else server.error = errorText(r)
      } catch (err) {
        server.error = err instanceof Error ? err.message : String(err)
      }
    }
  }
  const evalRunId = `eval_local_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${sha256Hex(setHash + ruleHash + Date.now()).slice(0, 6)}`
  const evalAll = (xs: readonly AnsweredCase[]) => metrics(evalRule, xs, combiner)
  const report = {
    v: 1 as const,
    evalRunId,
    ruleRef: hit.ref,
    ruleHash,
    model: identity.model,
    modelDigest: identity.modelDigest,
    digestStrength: identity.digestStrength,
    setHash,
    preregistered: prereg !== null,
    reusedSet,
    band: prereg ? null : band,
    bandErrorFreeOnDev: fit?.errorFree ?? null,
    dev: fit?.dev ?? null,
    results: m,
    adversarial: adv,
    engineErrors,
    questions,
    marks,
    passed,
    completedAt: new Date().toISOString(),
    calibrationId: prereg?.calibration?.calibrationId ?? null,
    server,
    // What drift compares this rule's live decisions with.
    baseline: {
      evalRunId,
      escalationRate: evalAll(answered).escalation ?? 0,
      questions: Object.fromEntries(
        Object.entries(questions)
          .filter(([, q]) => q.p10 !== null && q.p90 !== null)
          .map(([n, q]) => [n, { p10: q.p10 as number, p90: q.p90 as number }]),
      ),
    },
  }
  writeJson(join(runsDir(ruleHash), `${evalRunId}.json`), report)

  let snapshot: string | null = null
  if (passed) {
    const pin: DecidePin = {
      modelDigest: identity.modelDigest,
      evalRunId,
      source: 'local',
      ...(combiner ? { combiner: { bias: combiner.bias, weights: combiner.weights }, band: combiner.band } : {}),
    }
    writeJson(join(evalsDir(ruleHash), digestFileName(identity.modelDigest)), pin)
    const { rewriteDecideSnapshot } = await import('../lib/decideRules.js')
    snapshot = await rewriteDecideSnapshot()
  }

  // A pre-registered run that did not pass exits non-zero, whatever the output format.
  if (prereg && !passed) process.exitCode = 1
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  log.header(`intutic decide eval ${hit.ref}`)
  log.field('Model', `${identity.model} (${identity.modelDigest}, ${identity.digestStrength} digest)`)
  log.field('Cases', `${cases.length} labelled (${prereg ? 'all scored' : `${scored.length} test, ${answered.length - scored.length} dev`})${extra.length ? `, ${extra.length} adversarial` : ''}${engineErrors ? `; ${engineErrors} unanswered, counted as escalations` : ''}`)
  if (!prereg) {
    log.field('Band fitted on dev', band ? `yes_at ${band.yes_at}, no_below ${band.no_below}${fit!.errorFree ? '' : ' (no error-free band on dev)'}` : 'none: no dev cases')
  }
  const line = (x: EvalMetrics) => `recall ${pct(x.recall)} · false alarms ${pct(x.falseAlarms)} · escalation ${pct(x.escalation)} · n ${x.n}`
  log.field(prereg ? 'Results' : 'Test split', line(m))
  for (const [n, q] of Object.entries(questions)) log.field(`AUC ${n}`, q.auc === null ? '—' : q.auc.toFixed(3))
  if (adv) for (const [f, r] of Object.entries(adv)) log.field(`Adversarial ${f.replace(/_/g, ' ')}`, `recall ${pct(r.recall)} of ${r.n}`)
  if (server?.uploaded) log.field('Control plane', `results uploaded to eval run ${server.evalRunId}${prereg?.calibration ? `, the companion of calibration ${prereg.calibration.calibrationId}` : ''}`)
  else if (server) log.warn(`The results were not uploaded to the control plane: ${server.error ?? 'no eval run is registered'}.`)
  console.log('')
  if (!prereg) {
    log.info('Not pre-registered, so no pin. Write the band into the rule if it fits, then:')
    log.dim(`  intutic decide eval ${hit.ref} --preregister <file>    (writes the registration; reads no label)`)
    log.dim(`  intutic decide eval ${hit.ref} --labels <fresh set> --preregister <file>`)
  } else if (passed) {
    log.success(`Passed. Pinned ${identity.modelDigest} for this rule (${evalRunId}).`)
    log.dim(
      snapshot === 'local'
        ? 'The policy snapshot was rewritten: a rule with rollout: enforce enforces on this model now.'
        : snapshot === 'connected'
          ? DECIDE_EVAL_CONNECTED_PIN_NOTE
          : 'Run `intutic gates install` to write it into the policy snapshot.',
    )
  } else {
    const failed = Object.entries(marks!).filter(([, ok]) => !ok).map(([k]) => k)
    log.warn(`Did not pass (${failed.join(', ')}). No pin was written; the rule stays in shadow on this model.`)
  }
}

// ===========================================================================
// calibrate
// ===========================================================================

export async function runDecideCalibrate(spec: string, opts: { labels: string; json?: boolean; workspace?: string }): Promise<void> {
  let hit
  try {
    hit = await localRule(spec, opts.workspace)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  const rule = hit.decl.rule
  const loaded = loadEngine()
  const engine = engineOrFail(loaded)
  if (!engine) return
  let cases: LabelledCase[]
  let labelsText: string
  try {
    labelsText = node_fs.readFileSync(resolve(opts.labels), 'utf8')
    cases = parseLabels(labelsText, rule.on)
  } catch (err) {
    return fail(`Could not read ${opts.labels}: ${err instanceof Error ? err.message : String(err)}`)
  }
  let identity
  try {
    identity = await engine.describe(Date.now() + (loaded.cfg?.timeoutMs ?? 5000))
  } catch (err) {
    return fail(`The engine did not say which model it runs: ${err instanceof Error ? err.message : String(err)}`)
  }
  const answered = await askCases(engine, rule, hit.sopTitle, hit.ruleText, cases, loaded.cfg?.timeoutMs ?? 5000, { ref: hit.ref!, ruleHash: hit.ruleHash!, maxResponseBytes: loaded.cfg?.maxResponseStateBytes })
  const dev = answered.filter((a) => splitOf(a.c.id) === 'dev')
  const fitted = fitCombiner(rule, dev.length >= 10 ? dev : answered)
  const fit = fitBand(rule, dev.length > 0 ? dev : answered, (band) => metrics(rule, dev.length > 0 ? dev : answered, { ...fitted, band }))
  if (!fit) return fail('No labelled case had an answer.')
  const candidate = {
    v: 1,
    ruleRef: hit.ref,
    ruleHash: hit.ruleHash,
    modelDigest: identity.modelDigest,
    combiner: fitted,
    band: fit.band,
    bandErrorFreeOnDev: fit.errorFree,
    labelsN: cases.length,
    setHash: sha256Hex(labelsText),
    fittedAt: new Date().toISOString(),
  }
  writeJson(join(candidatesDir(hit.ruleHash!), digestFileName(identity.modelDigest)), candidate)
  if (opts.json) {
    console.log(JSON.stringify(candidate, null, 2))
    return
  }
  log.header(`intutic decide calibrate ${hit.ref}`)
  log.field('Model', `${identity.model} (${identity.modelDigest})`)
  log.field('Combiner', `bias ${fitted.bias}; ${Object.entries(fitted.weights).map(([n, w]) => `${n} ${w}`).join(', ')}`)
  log.field('Band', `yes_at ${fit.band.yes_at}, no_below ${fit.band.no_below}${fit.errorFree ? '' : ' (no error-free band on dev)'}`)
  log.success('Saved as a candidate. It replaces `when` only once a pre-registered `intutic decide eval` passes with it:')
  log.dim(`  intutic decide eval ${hit.ref} --preregister <file>`)
}

// ===========================================================================
// models
// ===========================================================================

/** The bake-off's verdicts (toolcall-v1, 2026-10-17). No laptop model passed, so none is a default. */
export const DECIDE_MODELS = [
  { id: 'qwen3.6-27b', tier: 'server', validated: true, band: { yes_at: 0.51, no_below: 0.23 }, note: '4-bit; about 3.5 s per rule on a laptop, too slow for a hook gate there' },
  { id: 'kev-9b', tier: 'server', validated: true, band: null, note: 'fits a 32 GB machine' },
  { id: 'qwen3.5:4b', tier: 'laptop', validated: false, band: null, note: 'escalated one case too many (40.4%)' },
  { id: 'qwen3.5:0.8b', tier: 'laptop', validated: false, band: null, note: 'escalated 84.2%' },
  { id: 'kev-4b', tier: 'laptop', validated: false, band: null, note: 'missed one violation' },
  { id: 'kev-0.8b', tier: 'laptop', validated: false, band: null, note: 'missed one violation' },
  { id: 'granite-guardian-4.1-8b', tier: 'server', validated: false, band: null, note: 'escalated 45.6%' },
] as const

export function runDecideModels(opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify({ laptopValidated: [], models: DECIDE_MODELS }, null, 2))
    return
  }
  log.header('Decide models')
  log.info('No laptop model is validated: none passed the pre-registered bake-off, so there is no default model.')
  log.dim('Bring a self-hosted model and validate it on your own labels with `intutic decide eval`.')
  console.log('')
  for (const m of DECIDE_MODELS) {
    console.log(`  ${m.validated ? '✓' : '✗'} ${m.id.padEnd(26)} ${m.tier.padEnd(7)} ${m.validated ? 'passed (server tier)' : 'did not pass'} — ${m.note}`)
  }
  console.log('')
  log.dim('Nothing is downloaded. With Ollama: `ollama pull <model>`, then `intutic decide configure --model <model>`.')
}

// ===========================================================================
// configure
// ===========================================================================

export interface DecideConfigureOptions {
  url?: string
  adapter?: string
  model?: string
  timeoutMs?: string
  parallel?: string
  structured?: boolean
  json?: boolean
}

export function runDecideConfigure(opts: DecideConfigureOptions): void {
  let current: Record<string, unknown>
  try {
    current = readEngineFile() ?? {}
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  const next: Record<string, unknown> = { ...current }
  if (opts.url !== undefined) next.url = opts.url
  if (opts.adapter !== undefined) {
    if (!(DECIDE_ADAPTERS as readonly string[]).includes(opts.adapter)) return fail(`--adapter must be one of ${DECIDE_ADAPTERS.join(', ')}`)
    next.adapter = opts.adapter
  }
  if (opts.model !== undefined) next.model = opts.model
  for (const [flag, key, value] of [['--timeout-ms', 'timeoutMs', opts.timeoutMs], ['--parallel', 'parallel', opts.parallel]] as const) {
    if (value === undefined) continue
    if (!/^[0-9]+$/.test(value)) return fail(`${flag} must be a whole number`)
    next[key] = Number(value)
  }
  if (opts.structured !== undefined) next.structured = opts.structured
  // A changed URL is a different engine: its p95 is measured again.
  if (opts.url !== undefined && opts.url !== current.url) {
    delete next.q95Ms
    delete next.q95MeasuredAt
    delete next.ollama
  }
  const url = typeof next.url === 'string' ? next.url : DECIDE_DEFAULT_ENGINE_URL
  const verdict = checkSelfHostedDecisionHost(url, process.env.INTUTIC_SELF_HOSTED_DECISION_HOSTS)
  if (!verdict.ok) {
    return fail(
      `${verdict.host || url} is not a self-hosted engine (${verdict.reason}). The engine must run on this machine or your own network; ` +
        'list a private host name in INTUTIC_SELF_HOSTED_DECISION_HOSTS.',
    )
  }
  let cfg
  try {
    cfg = resolveDecideEngineConfig(next, {})
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  writeEngineFile(next)
  const shown = { url: cfg.url, adapter: cfg.adapter, model: cfg.model || null, timeoutMs: cfg.timeoutMs, parallel: cfg.parallel, structured: cfg.structured }
  if (opts.json) {
    console.log(JSON.stringify({ file: engineFile(), ...shown, apiKey: process.env.INTUTIC_DECIDE_API_KEY ? 'from INTUTIC_DECIDE_API_KEY' : null }, null, 2))
    return
  }
  log.success(`Wrote ${engineFile()}`)
  for (const [k, v] of Object.entries(shown)) log.field(k, v === null ? '(none: the engine is not configured until you set --model)' : String(v))
  log.dim('The key, if your engine needs one, is read from INTUTIC_DECIDE_API_KEY and never written. Environment variables override this file.')
  log.dim('Check the engine and run its canary with `intutic doctor`.')
}

// ===========================================================================
// disable / enable
// ===========================================================================

export async function runDecideDisable(on: boolean): Promise<void> {
  const file = disabledFile()
  if (on) writeJson(file, { disabledAt: new Date().toISOString() })
  else node_fs.rmSync(file, { force: true })
  const { rewriteDecideSnapshot } = await import('../lib/decideRules.js')
  const where = await rewriteDecideSnapshot()
  if (on) log.success('Decide is disabled on this machine: every decide rule runs as shadow (logged, never refusing).')
  else log.success('Decide is enabled again: rules with rollout: enforce and a pin for the engine\'s model enforce.')
  log.dim(
    where === 'local'
      ? 'The policy snapshot was rewritten.'
      : where === 'connected'
        ? 'The sync daemon applies it to the snapshot on its next poll.'
        : 'It applies the next time the policy snapshot is written (`intutic gates install`).',
  )
}

// ===========================================================================
// lint
// ===========================================================================

export async function runDecideLint(opts: { json?: boolean; workspace?: string }): Promise<void> {
  const { decideWorkspaceRoot, loadLocalDecideLines } = await import('../lib/decideRules.js')
  const lines = await loadLocalDecideLines(decideWorkspaceRoot(opts.workspace))
  const problems: Array<{ file: string; line: number; error: string; hint: string | null }> = []
  const byTool = new Map<string, string[]>()
  const rules: Array<{ ref: string; file: string; line: number; ruleHash: string; on: string; rollout: string; tools: string[]; pins: number }> = []
  // What 3.0 does not do with a rule as written (a reserved context):
  // warnings, which do not fail the lint.
  const notes: Array<{ file: string; line: number; ref: string; note: string }> = []
  for (const l of lines) {
    if (l.decl.kind === 'unreadable') {
      problems.push({ file: l.file, line: l.line, error: l.decl.error, hint: /empty|not JSON/.test(l.decl.error) ? 'write one rule per line as `decide: {json}`' : null })
      continue
    }
    const r = l.decl.rule
    if (r.on === 'tool_call') for (const t of r.tools ?? []) byTool.set(t, [...(byTool.get(t) ?? []), l.ref!])
    rules.push({ ref: l.ref!, file: l.file, line: l.line, ruleHash: l.ruleHash!, on: r.on, rollout: r.rollout ?? 'shadow', tools: r.tools ?? [], pins: readPins(l.ruleHash!)?.length ?? 0 })
    for (const note of decideRuleNotes(r)) notes.push({ file: l.file, line: l.line, ref: l.ref!, note })
  }
  const crowded = [...byTool].filter(([, refs]) => refs.length > 4).map(([tool, refs]) => ({ tool, refs }))
  if (opts.json) {
    console.log(JSON.stringify({ rules, problems, notes, crowded, disabled: node_fs.existsSync(disabledFile()) }, null, 2))
  } else {
    log.header('intutic decide lint')
    if (lines.length === 0) log.info('No decide: lines in .intutic/sops.')
    for (const r of rules) {
      const where = r.on === 'response' ? ' (on: response: judged at the gateway)' : ''
      const state = r.rollout === 'enforce' && r.pins === 0 ? ' (no pin yet: runs as shadow until `intutic decide eval` passes)' : ''
      console.log(`  ✓ ${r.file}:${r.line}  ${r.ref}  ${r.rollout}${where}${state}  hash ${r.ruleHash.slice(0, 12)}`)
    }
    for (const p of problems) {
      console.log(`  ✗ ${p.file}:${p.line}  ${p.error}`)
      if (p.hint) console.log(`      hint: ${p.hint}`)
    }
    for (const n of notes) log.warn(`${n.file}:${n.line}: ${n.note}`)
    for (const c of crowded) log.warn(`${c.refs.length} decide rules name ${c.tool}; a call evaluates at most 4, and an enforcing rule past the fourth refuses the call: ${c.refs.join(', ')}`)
    if (node_fs.existsSync(disabledFile())) log.warn('Decide is disabled on this machine (`intutic decide enable` turns it back on).')
  }
  if (problems.length > 0) process.exitCode = 1
}

// ===========================================================================
// doctor
// ===========================================================================

export interface DecideDoctorCheck {
  name: string
  passed: boolean
  detail: string
  remediation?: string
}

/** Calls of the canary's size `doctor` times for the p95. */
const P95_CALLS = 20

/** The decide records the local policy snapshot carries (`snapshotText`, or the file the gates read) that decode. */
function localDecideRecords(snapshotText: string | null | undefined): DecideRecord[] {
  let text = snapshotText
  if (text === undefined) {
    try {
      text = node_fs.readFileSync(resolveSnapshotRulesPath(), 'utf8')
    } catch {
      text = null
    }
  }
  return (text ?? '')
    .split('\n')
    .filter((l) => l.startsWith(`${DECIDE_RECORD_TAG}\t`))
    .map((l) => decodeDecideRecord(l, checkRule))
    .filter((r): r is DecideRecord => r !== null)
}

/** Runs the known-answer canary and stores its result in canary.json, where the gates read it. */
async function canaryCheck(engine: DecideEngine, url: string, modelDigest: string, timeoutMs: number): Promise<DecideDoctorCheck> {
  try {
    const r = await runDecideCanary(engine.ask, Date.now() + timeoutMs * 3)
    createDecideCanaryFileStore(canaryFile(), nodeFs).write({ url, modelDigest, ok: r.ok, atMs: Date.now(), pViolation: r.pViolation, pClean: r.pClean, choiceTop: r.choiceTop })
    return r.ok
      ? { name: 'Decide Canary', passed: true, detail: `passed (p(violation) ${r.pViolation.toFixed(3)}, p(clean) ${r.pClean.toFixed(3)}, choice ${r.choiceTop})` }
      : {
          name: 'Decide Canary',
          passed: false,
          detail: `failed (p(violation) ${r.pViolation.toFixed(3)}, p(clean) ${r.pClean.toFixed(3)}, choice ${r.choiceTop}): enforcing decide rules refuse until it passes`,
          remediation: 'The model answers the fixed known-answer questions wrongly: check the model and adapter.',
        }
  } catch (err) {
    return { name: 'Decide Canary', passed: false, detail: `could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** How long Ollama keeps the model loaded after `intutic start` warms it: a working day. */
export const DECIDE_WARM_KEEP_ALIVE = '8h'
/** Loading a model from disk can take tens of seconds. */
const DECIDE_WARM_TIMEOUT_MS = 60_000

/**
 * Loads the engine's model and keeps it loaded for {@link DECIDE_WARM_KEEP_ALIVE},
 * with Ollama's native `POST /api/generate {model, keep_alive}`: with no
 * prompt it only loads. Whether Ollama's OpenAI-compatible route honours
 * `keep_alive` is unknown, so the warm-up goes through its own route. False
 * for a server that is not Ollama, which has no such route and is not
 * warmed. Throws when the request fails. `cfg` is a configuration
 * `createDecideEngine` accepted, so its host passed the self-hosted guard.
 */
export async function warmDecideEngine(cfg: DecideEngineConfig, timeoutMs: number = DECIDE_WARM_TIMEOUT_MS): Promise<boolean> {
  if (!cfg.ollama || cfg.adapter !== 'logprobs') return false
  let end = cfg.url.length
  while (end > 0 && cfg.url.charCodeAt(end - 1) === 0x2f) end--
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
  const res = await fetch(`${cfg.url.slice(0, end)}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, keep_alive: DECIDE_WARM_KEEP_ALIVE }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  await res.text()
  if (!res.ok) throw new Error(`/api/generate returned status ${res.status}`)
  return true
}

/**
 * What `intutic start` does for decide when this machine has decide rules
 * and an engine is configured (engine.json, or `INTUTIC_DECIDE_MODEL`): warm
 * the model, then run the known-answer canary and store its result in
 * canary.json, as `doctor` does, so the first gated call finds a fresh pass.
 * Nothing (an empty list) otherwise. Never throws: start reports each line
 * and goes on whatever they say.
 */
export async function decideStartChecks(opts: { snapshotText?: string | null } = {}): Promise<DecideDoctorCheck[]> {
  try {
    if (localDecideRecords(opts.snapshotText).length === 0) return []
    let file: Record<string, unknown> | null
    try {
      file = readEngineFile()
    } catch {
      file = { broken: true }
    }
    if (file === null && !process.env.INTUTIC_DECIDE_MODEL?.trim()) return []

    const loaded = loadEngine()
    if (loaded.engine instanceof DecideEngineError) {
      return [{ name: 'Decide Engine', passed: false, detail: `${loaded.engine.code}: ${loaded.engine.message}`, remediation: 'Check it with `intutic doctor`.' }]
    }
    const engine = loaded.engine
    const cfg = loaded.cfg!
    const out: DecideDoctorCheck[] = []
    try {
      if (await warmDecideEngine(cfg)) {
        out.push({ name: 'Decide Warm-up', passed: true, detail: `${cfg.model} loaded on ${engineHost(cfg.url)}, kept for ${DECIDE_WARM_KEEP_ALIVE}` })
      }
    } catch (err) {
      out.push({ name: 'Decide Warm-up', passed: false, detail: `could not load ${cfg.model}: ${err instanceof Error ? err.message : String(err)}` })
    }
    let identity
    try {
      identity = await engine.describe(Date.now() + cfg.timeoutMs)
    } catch (err) {
      out.push({
        name: 'Decide Engine',
        passed: false,
        detail: `unreachable or the model is missing: ${err instanceof Error ? err.message : String(err)}; enforcing decide rules refuse until it answers`,
        remediation: 'Start the engine, or pull the model it names.',
      })
      return out
    }
    out.push(await canaryCheck(engine, cfg.url, identity.modelDigest, cfg.timeoutMs))
    return out
  } catch (err) {
    return [{ name: 'Decide', passed: false, detail: `could not check the engine: ${err instanceof Error ? err.message : String(err)}` }]
  }
}

/**
 * The decide rules the policy snapshot was compiled from, as its JSON keeps
 * them (`decideRules`, every `on` and the local SOPs' or the control plane's
 * alike), that read. `snapshotJson` is the JSON's text, or the file beside
 * the rules file the gates read.
 */
function snapshotDecideRules(snapshotJson: string | null | undefined): Array<{ ref: string; rule: DecideRule }> {
  let text = snapshotJson
  if (text === undefined) {
    try {
      text = node_fs.readFileSync(join(dirname(resolveSnapshotRulesPath()), 'policy-snapshot.json'), 'utf8')
    } catch {
      text = null
    }
  }
  let served: unknown
  try {
    served = (JSON.parse(text ?? 'null') as { decideRules?: unknown } | null)?.decideRules
  } catch {
    return []
  }
  if (!Array.isArray(served)) return []
  const out: Array<{ ref: string; rule: DecideRule }> = []
  for (const r of served) {
    if (typeof r !== 'object' || r === null) continue
    const { sopId, ir } = r as { sopId?: unknown; ir?: unknown }
    const decl = parseDecideLine(typeof ir === 'string' ? ir : JSON.stringify(ir ?? null))
    if (decl.kind === 'rule') out.push({ ref: decideRuleRef(typeof sopId === 'string' ? sopId : '', decl.rule.id), rule: decl.rule })
  }
  return out
}

/**
 * What 3.0 does not do with the snapshot's decide rules as written, as doctor
 * lines: every rule declaring the reserved `context: ["last_user_turn"]` is
 * asked without it. (An `on: response` rule is the gateway's, which judges
 * each complete response by it.)
 */
function decideLimitChecks(rules: ReadonlyArray<{ ref: string; rule: DecideRule }>): DecideDoctorCheck[] {
  const out: DecideDoctorCheck[] = []
  const context = rules.filter((r) => (r.rule.context ?? []).includes('last_user_turn')).map((r) => r.ref)
  if (context.length > 0) {
    out.push({
      name: 'Decide Context',
      passed: true,
      detail: `${context.join(', ')} declare(s) context: ["last_user_turn"], which is reserved and not supplied in 3.0: they are asked without the user's last turn`,
      remediation: 'No gate passes the last turn yet; `decide test` and `decide eval` ask without it too, so the eval measures what a gate asks.',
    })
  }
  return out
}

/**
 * `intutic doctor`'s decide checks: what 3.0 does not do with the snapshot's
 * rules as written, then the engine and its model, the canary, the per-call
 * p95 (stored in engine.json), and every harness and rule pair the budget
 * cannot fit. Skipped (one passing line) when this machine has no decide
 * rule and no engine configured.
 */
export async function decideDoctorChecks(opts: { snapshotText?: string | null; snapshotJson?: string | null } = {}): Promise<DecideDoctorCheck[]> {
  const limits = decideLimitChecks(snapshotDecideRules(opts.snapshotJson))
  const engine = await decideEngineDoctorChecks(opts)
  return limits.length > 0 && engine.length === 1 && engine[0]!.name === 'Decide' && engine[0]!.passed ? limits : [...limits, ...engine]
}

async function decideEngineDoctorChecks(opts: { snapshotText?: string | null }): Promise<DecideDoctorCheck[]> {
  const records = localDecideRecords(opts.snapshotText)
  let file: Record<string, unknown> | null
  try {
    file = readEngineFile()
  } catch {
    file = { broken: true }
  }
  if (records.length === 0 && file === null) return [{ name: 'Decide', passed: true, detail: 'no decide rules and no engine configured' }]

  const out: DecideDoctorCheck[] = []
  const loaded = loadEngine()
  if (loaded.engine instanceof DecideEngineError) {
    out.push({
      name: 'Decide Engine',
      passed: false,
      detail: `${loaded.engine.code}: ${loaded.engine.message}`,
      remediation: 'Configure a self-hosted engine with `intutic decide configure --url <url> --model <model>`; `intutic decide models` lists what was validated.',
    })
    if (records.some((r) => r.rollout === 'enforce')) out.push({ name: 'Decide Rules', passed: false, detail: `${records.length} rule(s); enforcing ones refuse their tools (GOVERNANCE_UNAVAILABLE) until the engine answers` })
    return out
  }
  const engine = loaded.engine
  const timeout = loaded.cfg!.timeoutMs
  let identity
  try {
    identity = await engine.describe(Date.now() + timeout)
    out.push({ name: 'Decide Engine', passed: true, detail: `${engineHost(loaded.cfg!.url)} (${loaded.cfg!.adapter}), model ${identity.model}, ${identity.digestStrength} digest ${identity.modelDigest}` })
    if (identity.digestStrength === 'weak') {
      out.push({ name: 'Decide Model Digest', passed: true, detail: 'weak: the server cannot report a weights digest, so a model swapped under the same name is not detected', remediation: 'Set INTUTIC_DECIDE_MODEL_DIGEST to the weights digest.' })
    }
  } catch (err) {
    out.push({ name: 'Decide Engine', passed: false, detail: `unreachable or the model is missing: ${err instanceof Error ? err.message : String(err)}`, remediation: 'Start the engine, or pull the model it names.' })
    return out
  }

  const canary = await canaryCheck(engine, loaded.cfg!.url, identity.modelDigest, timeout)
  out.push(canary)
  if (!canary.passed) return out

  // p95 of warm calls the size of the canary's yes/no question.
  const times: number[] = []
  const state = buildDecideToolCallState({ ruleId: 'p95', sopTitle: 'Latency probe', ruleText: 'Measure only.', tool: 'Bash', cwd: '/', toolInput: { command: 'ls -la' } })
  for (let i = 0; i < P95_CALLS; i++) {
    const t = performance.now()
    try {
      await engine.ask(state, [{ name: 'probe', type: 'yes_no', ask: 'Does this command delete files recursively from the root of the filesystem?' }], Date.now() + timeout)
    } catch {
      break
    }
    times.push(performance.now() - t)
  }
  if (times.length === P95_CALLS) {
    const q95 = Math.round(quantile(times, 0.95))
    try {
      writeEngineFile({ ...(readEngineFile() ?? {}), q95Ms: q95, q95MeasuredAt: new Date().toISOString() })
    } catch {
      // the measurement is still reported
    }
    out.push({ name: 'Decide Latency', passed: true, detail: `per-call p95 ${q95} ms over ${P95_CALLS} warm calls (stored in ${engineFile()})` })
    const tight: string[] = []
    for (const r of records) {
      const v = validateDecideRule(r.ir)
      if (!v.ok) continue
      const est = decideRuleEstimateMs(v.rule, q95, loaded.cfg!.parallel)
      for (const b of decideBudgets()) {
        if (est > b.budgetMs) tight.push(`${r.ir.id} cannot be evaluated within ${b.harness}'s ${b.budgetMs.toLocaleString('en-US')} ms (estimated ${est.toLocaleString('en-US')} ms)`)
      }
    }
    out.push(
      tight.length === 0
        ? { name: 'Decide Budget', passed: true, detail: `every rule fits every harness's budget (${records.length} rule(s))` }
        : {
            name: 'Decide Budget',
            passed: false,
            detail: `${tight.length} harness and rule pair(s) escalate instead of asking: ${tight.join('; ')}`,
            remediation: 'Ask fewer questions, raise --parallel on an engine that serves requests concurrently, or use a faster model.',
          },
    )
  } else {
    out.push({ name: 'Decide Latency', passed: false, detail: 'the engine stopped answering while its p95 was measured' })
  }

  const disabled = node_fs.existsSync(disabledFile())
  const enforcing = records.filter((r) => r.rollout === 'enforce' && !decideEffectiveRollout(r, identity.modelDigest).why)
  out.push({
    name: 'Decide Rules',
    passed: true,
    detail: `${records.length} rule(s), ${enforcing.length} enforcing on this model${disabled ? '; disabled on this machine (`intutic decide enable`)' : ''}`,
  })
  return out
}

export type { DecideRecord }
