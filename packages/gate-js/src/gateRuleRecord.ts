/**
 * Rule records in the policy snapshot: the `@rule` record, its
 * fallback line, and how a gate that reads it decides a call (Tier R).
 *
 * A gate that cannot evaluate a rule must refuse what the rule covers, never
 * skip it. So for each rule a gate is to enforce, the snapshot writer emits
 * two lines inside the digest, as the decide records do:
 *
 * - an `@rule` record of five tab-separated columns: the tag, the fallback
 *   line's id or `-`, the kind, the rollout (`shadow` or `enforce`), and
 *   base64 of the canonical JSON of its payload, `{v, ref, sopTitle, …kind
 *   fields}`. Every reader up to v22 needs six
 *   columns for a rule, so it skips the record;
 * - for an enforcing record, a fallback line: an ordinary `block` rule whose
 *   id is `<kind>-fallback:<n>@<sha256(sopId)[:12]>`
 *   ({@link gateRuleFallbackId}), on what the rule covers
 *   ({@link gateRuleFallback}). A gate that reads `@rule` records skips a
 *   fallback line only when a record that decodes names it.
 *
 * A snapshot with any `@rule` record is written in format 3
 * ({@link RULE_SNAPSHOT_FORMAT}). Kinds in this batch:
 *
 * | Kind | From | Gate decision |
 * |---|---|---|
 * | `requires_outcome` | `requires_before: action:run_tests[ok] -> X` | X refused `PREREQUISITE_UNMET` unless the latest test run in the session passed |
 * | `scope_paths` | `scope_paths:` with `scope_paths_mode: enforce` | a file change outside the scope refused `OUT_OF_SCOPE` |
 * | `plan_approval` | `plan_approval: required\|strict` | refused `PLAN_NOT_APPROVED` until the session's plan is approved; under `strict`, a tool not in the plan refused `OFF_PLAN` |
 *
 * Only SOPs with no `roles:` compile: a gate knows no agent role.
 *
 * Self-contained but for `./testOutcome.ts`, `./scopeMatch.ts`, `./lanes.ts`
 * and `./phrases.ts` (all carried by `@intutic/gate` as byte-identical
 * copies), so `@intutic/gate` keeps a byte-identical copy of this file too.
 * The Python port is `intutic_clawde/gate/rule_record.py`; both run
 * `fixtures/rule-record-vectors.json`.
 *
 * @module
 */

import { LANE_PHRASES } from './lanes.js'
import { changeTargets, isPlanExemptTool, isWithinScope, scopeRelativePath, SCOPE_DELETE_TOOLS, SCOPE_EDIT_TOOLS, SCOPE_EDITOR_TOOLS, SCOPE_MOVE_TOOLS, SCOPE_SHELL_TOOLS, SCOPE_WRITE_TOOLS } from './scopeMatch.js'
import { prerequisiteCase, prerequisiteUnmetReason, type OutcomeState, type PrerequisiteCase } from './testOutcome.js'
import type { RefusalScope } from './refusalDetail.js'

/** First column of a rule record. */
export const RULE_RECORD_TAG = '@rule'
/** The snapshot format a snapshot carrying any rule record is written in. */
export const RULE_SNAPSHOT_FORMAT = 3
/** The longest SOP title a record carries, in code points. */
export const RULE_SOP_TITLE_MAX_CHARS = 80
/** The most scope paths one record carries, and the longest of them in code points. */
export const RULE_SCOPE_PATHS_MAX = 64
export const RULE_SCOPE_PATH_MAX_CHARS = 512

export type GateRuleKind = 'requires_outcome' | 'scope_paths' | 'plan_approval'
export const GATE_RULE_KINDS: readonly GateRuleKind[] = ['requires_outcome', 'scope_paths', 'plan_approval']

/** The four action tokens a v22 hook gate's classifier knows: a fallback on one of them can use the `action` subject. */
export const V22_ACTION_TOKENS: readonly string[] = ['action:deploy', 'action:publish', 'action:release', 'action:db_write']

interface GateRuleRecordBase {
  v: 1
  /** `<sopId>#<kind>:<n>`. */
  ref: string
  sopTitle: string
  /** The paired fallback line's id; null when the record is shadow and has none. */
  fallbackId: string | null
  rollout: 'shadow' | 'enforce'
}

export interface RequiresOutcomeRecord extends GateRuleRecordBase {
  kind: 'requires_outcome'
  first: 'action:run_tests'
  qualifier: 'ok'
  /** The gated token or tool. */
  then: string
  /** `~>`: the run must be the call right before. */
  adjacent: boolean
}

export interface ScopePathsRecord extends GateRuleRecordBase {
  kind: 'scope_paths'
  scopePaths: string[]
}

export interface PlanApprovalRecord extends GateRuleRecordBase {
  kind: 'plan_approval'
  mode: 'required' | 'strict'
}

export type GateRuleRecord = RequiresOutcomeRecord | ScopePathsRecord | PlanApprovalRecord

/**
 * The fields of each kind's payload, sorted: `{v, ref, sopTitle, …kind
 * fields}`. The kind, the fallback id and the rollout are columns 3, 2 and 4,
 * not payload fields. Any other field refuses the record.
 */
const RULE_RECORD_FIELDS: Record<GateRuleKind, readonly string[]> = {
  requires_outcome: ['adjacent', 'first', 'qualifier', 'ref', 'sopTitle', 'then', 'v'],
  scope_paths: ['ref', 'scopePaths', 'sopTitle', 'v'],
  plan_approval: ['mode', 'ref', 'sopTitle', 'v'],
}

/** `ref`: `<sopId>#<kind>:<n>`. */
export function gateRuleRef(sopId: string, kind: GateRuleKind, n: number): string {
  return sopId + '#' + kind + ':' + n
}

/** `fallbackId`: `<kind>-fallback:<n>@<first 12 hex of sha256(sopId)>`. */
export function gateRuleFallbackId(kind: GateRuleKind, n: number, sopId: string, sha256Hex: (text: string) => string): string {
  return kind + '-fallback:' + n + '@' + sha256Hex(sopId).slice(0, 12)
}

/** What an older gate says when a rule's fallback line refuses. The writer scrubs and bounds it like any reason. */
export function gateRuleFallbackReason(kind: GateRuleKind, sopTitle: string): string {
  if (kind === 'requires_outcome') return 'Qualified requires_before (' + sopTitle + '): this gate cannot read test results, so the call it gates is refused; upgrade the Intutic gate'
  if (kind === 'scope_paths') return 'scope_paths_mode: enforce (' + sopTitle + '): this gate cannot check a change against the scope, so every file change is refused; upgrade the Intutic gate'
  return 'plan_approval (' + sopTitle + '): this gate cannot check plan approval, so every call is refused; upgrade the Intutic gate'
}

function ruleIsObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** JSON with keys sorted at every level and no whitespace, so a record is byte-stable. */
function ruleCanonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(ruleCanonicalJson).join(',') + ']'
  if (ruleIsObject(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + ruleCanonicalJson(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

function ruleToBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Standard base64 back to UTF-8 text. Throws on anything but the canonical encoding of valid UTF-8. */
function ruleFromBase64(b64: string): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  if (ruleToBase64(text) !== b64) throw new Error('not canonical base64')
  return text
}

/** A short text a record may carry: a string with no tab, CR or LF, at most `max` code points (and, with `min`, at least that many). */
function ruleText(v: unknown, max: number, min: number): boolean {
  if (typeof v !== 'string' || /[\t\r\n]/.test(v)) return false
  const n = Array.from(v).length
  return n >= min && n <= max
}

/** The record's payload: everything but the kind, the fallback id and the rollout, which are columns. */
export function gateRulePayload(record: GateRuleRecord): { v: 1; ref: string; sopTitle: string } & Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const k of Object.keys(record)) if (k !== 'kind' && k !== 'fallbackId' && k !== 'rollout') payload[k] = (record as unknown as Record<string, unknown>)[k]
  return payload as { v: 1; ref: string; sopTitle: string } & Record<string, unknown>
}

/** The record as one `.rules` line. */
export function encodeGateRuleRecord(record: GateRuleRecord): string {
  return [RULE_RECORD_TAG, record.fallbackId ?? '-', record.kind, record.rollout, ruleToBase64(ruleCanonicalJson(gateRulePayload(record)))].join('\t')
}

/**
 * Reads an `@rule` line back, its kind, fallback id and rollout from the
 * columns and the rest from the payload. Null, and so the fallback line stays
 * in force, for any other line or when: it does not have five columns; the
 * base64 or JSON is damaged; the kind (column 3) is unknown; the payload has
 * a field its kind does not have or lacks one; the rollout (column 4) is not
 * `shadow` or `enforce`; a field is out of its bounds; the ref does not end
 * `#<kind>:<n>`; an enforcing record's fallback id (column 2) is not
 * `<kind>-fallback:<n>@<12 hex>` for the same n, or a shadow record's is
 * not `-`.
 */
export function decodeGateRuleRecord(line: string): GateRuleRecord | null {
  const f = line.split('\t')
  if (f.length !== 5 || f[0] !== '@rule' || !f[4]) return null
  const kind = f[2] as GateRuleKind
  if (kind !== 'requires_outcome' && kind !== 'scope_paths' && kind !== 'plan_approval') return null
  let r: unknown
  try {
    r = JSON.parse(ruleFromBase64(f[4]))
  } catch {
    return null
  }
  if (!ruleIsObject(r)) return null
  const fields = RULE_RECORD_FIELDS[kind]
  const keys = Object.keys(r).sort()
  if (keys.length !== fields.length || keys.some((k, i) => k !== fields[i])) return null
  if (f[3] !== 'shadow' && f[3] !== 'enforce') return null
  r = { ...r, kind, fallbackId: f[1] === '-' ? null : f[1], rollout: f[3] }
  if (!ruleIsObject(r)) return null
  if (r.v !== 1) return null
  if (!ruleText(r.sopTitle, 80, 0)) return null
  if (typeof r.ref !== 'string') return null
  const m = /^.+#([a-z_]+):([1-9][0-9]{0,5})$/.exec(r.ref)
  if (!m || m[1] !== kind) return null
  if (r.rollout === 'enforce') {
    if (typeof r.fallbackId !== 'string' || !new RegExp('^' + kind + '-fallback:' + m[2] + '@[0-9a-f]{12}$').test(r.fallbackId)) return null
  } else if (r.fallbackId !== null) {
    return null
  }
  if (kind === 'requires_outcome') {
    if (r.first !== 'action:run_tests' || r.qualifier !== 'ok' || typeof r.adjacent !== 'boolean') return null
    if (typeof r.then !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(r.then) || r.then === 'action:run_tests') return null
  } else if (kind === 'scope_paths') {
    const paths = r.scopePaths
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 64 || paths.some((p) => !ruleText(p, 512, 1))) return null
  } else if (r.mode !== 'required' && r.mode !== 'strict') {
    return null
  }
  return r as unknown as GateRuleRecord
}

/**
 * A record as the control plane serves it from policy resolve
 * (`ResolvedPolicy.gateRecords`): which SOP it came from, its kind, rollout
 * and fallback id, and the payload the `@rule` line carries.
 */
export interface ServedGateRecord {
  sopId: string
  kind: GateRuleKind
  rollout: 'shadow' | 'enforce'
  fallbackId: string | null
  payload: { v: 1; ref: string; sopTitle: string } & Record<string, unknown>
}

/** A record in the served shape. */
export function toServedGateRecord(record: GateRuleRecord, sopId: string): ServedGateRecord {
  return { sopId, kind: record.kind, rollout: record.rollout, fallbackId: record.fallbackId, payload: gateRulePayload(record) }
}

/**
 * A served record as a gate record, or null when it does not hold together:
 * checked by encoding it and reading the line back, so a writer never emits
 * a record no gate can decode (its fallback line would refuse instead).
 */
export function fromServedGateRecord(served: ServedGateRecord): GateRuleRecord | null {
  if (!ruleIsObject(served) || !ruleIsObject(served.payload)) return null
  const fields = Object.keys(served.payload).filter((k) => k !== 'kind' && k !== 'fallbackId' && k !== 'rollout')
  if (fields.length !== Object.keys(served.payload).length) return null
  const line = [RULE_RECORD_TAG, served.fallbackId ?? '-', served.kind, served.rollout, ruleToBase64(ruleCanonicalJson(served.payload))].join('\t')
  return decodeGateRuleRecord(line)
}

// ---------------------------------------------------------------------------
// The writer's half
// ---------------------------------------------------------------------------

/** The parts of a parsed SOP (`ParsedFrontMatter`, guardrailRender.ts) the records are compiled from. */
export interface GateRuleFrontMatter {
  roles: readonly string[]
  mode: 'shadow' | 'enforce'
  requiresBefore: ReadonlyArray<readonly [string, string, boolean]>
  scopePaths: readonly string[]
  scopePathsMode: 'advise' | 'enforce'
  planApproval: 'required' | 'strict' | null
}

/** One fallback line, in the shape the snapshot writer's `GuardPattern` takes (it adds the rationale). */
export interface GateRuleFallback {
  id: string
  severity: 'block'
  subject: 'tool' | 'action' | 'phrase'
  source: string
  ignoreCase: boolean
  reason: string
}

/** A title as a record carries it: tabs and newlines collapsed, at most 80 code points. */
function ruleSopTitle(title: string): string {
  return Array.from(title.replace(/[\t\r\n]+/g, ' ').trim()).slice(0, 80).join('')
}

/** A regex literal for a tool name in a portable-ERE tool rule. */
function ruleEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The fallback line for an enforcing record: what an older gate refuses in
 * its place. `requires_outcome`: the gated call (by the action subject for
 * the four tokens a v22 classifier knows, by the token's phrases for a newer
 * token, by the shell tools for a token with no phrases, by the tool subject
 * for a tool); `scope_paths`: every mutation tool; `plan_approval`: every call.
 */
export function gateRuleFallback(record: GateRuleRecord): GateRuleFallback | null {
  if (record.fallbackId === null) return null
  const base = { id: record.fallbackId, severity: 'block' as const, reason: gateRuleFallbackReason(record.kind, record.sopTitle) }
  if (record.kind === 'plan_approval') return { ...base, subject: 'tool', source: ' [^ ]+ ', ignoreCase: false }
  if (record.kind === 'scope_paths') {
    const tools = [...SCOPE_WRITE_TOOLS, ...SCOPE_EDIT_TOOLS, ...SCOPE_DELETE_TOOLS, ...SCOPE_MOVE_TOOLS, ...SCOPE_EDITOR_TOOLS]
    return { ...base, subject: 'tool', source: ' [^ ]*(' + tools.map(ruleEscape).join('|') + ') ', ignoreCase: true }
  }
  const then = record.then
  if (V22_ACTION_TOKENS.indexOf(then) !== -1) return { ...base, subject: 'action', source: ' (' + ruleEscape(then) + ') ', ignoreCase: true }
  if (then.slice(0, 7) === 'action:') {
    const phrases = Object.prototype.hasOwnProperty.call(LANE_PHRASES, then) ? LANE_PHRASES[then]! : []
    if (phrases.length > 0) return { ...base, subject: 'phrase', source: phrases.join('|'), ignoreCase: true }
    return { ...base, subject: 'tool', source: ' [^ ]*(' + SCOPE_SHELL_TOOLS.map(ruleEscape).join('|') + ') ', ignoreCase: true }
  }
  return { ...base, subject: 'tool', source: ' (' + ruleEscape(then) + ') ', ignoreCase: false }
}

/**
 * The records (and, for each enforcing one, its fallback line) one SOP
 * compiles to: each qualified `requires_before`, then its `scope_paths` when
 * `scope_paths_mode: enforce`, then its `plan_approval:`. Nothing for a SOP
 * with `roles:` (a gate knows no role). A shadow SOP (`mode: shadow`, or
 * `entry.shadow`, which the writer sets for SILENT_LOG) gets shadow records
 * and no fallback lines.
 */
export function compileSopGateRecords(
  entry: { sopId: string; sopTitle: string; shadow?: boolean },
  fm: GateRuleFrontMatter,
  sha256Hex: (text: string) => string,
): { records: GateRuleRecord[]; fallbacks: GateRuleFallback[] } {
  const out: { records: GateRuleRecord[]; fallbacks: GateRuleFallback[] } = { records: [], fallbacks: [] }
  if (fm.roles.length > 0) return out
  const rollout: 'shadow' | 'enforce' = fm.mode === 'shadow' || entry.shadow === true ? 'shadow' : 'enforce'
  const sopTitle = ruleSopTitle(entry.sopTitle)
  const add = (record: GateRuleRecord) => {
    out.records.push(record)
    const fallback = gateRuleFallback(record)
    if (fallback) out.fallbacks.push(fallback)
  }
  const base = (kind: GateRuleKind, n: number) => ({
    v: 1 as const,
    ref: gateRuleRef(entry.sopId, kind, n),
    sopTitle,
    fallbackId: rollout === 'enforce' ? gateRuleFallbackId(kind, n, entry.sopId, sha256Hex) : null,
    rollout,
  })
  let n = 0
  for (const [first, then, adjacent] of fm.requiresBefore) {
    if (first !== 'action:run_tests[ok]' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(then) || then === 'action:run_tests') continue
    n += 1
    add({ ...base('requires_outcome', n), kind: 'requires_outcome', first: 'action:run_tests', qualifier: 'ok', then, adjacent })
  }
  if (fm.scopePathsMode === 'enforce') {
    const paths = fm.scopePaths.filter((p) => ruleText(p, 512, 1)).slice(0, 64)
    if (paths.length > 0) add({ ...base('scope_paths', 1), kind: 'scope_paths', scopePaths: paths })
  }
  if (fm.planApproval !== null) add({ ...base('plan_approval', 1), kind: 'plan_approval', mode: fm.planApproval })
  return out
}

// ---------------------------------------------------------------------------
// The gate's half: Tier R
// ---------------------------------------------------------------------------

/** The refusal codes Tier R gives. */
export type GateRuleCode = 'PREREQUISITE_UNMET' | 'OUT_OF_SCOPE' | 'OFF_PLAN' | 'PLAN_NOT_APPROVED'

/** The session's plan as a gate reads it: approved (APPROVED or EXECUTING) with its tools, none, or not readable. */
export type GateRulePlan = { status: 'approved'; tools: readonly string[] } | { status: 'none' } | { status: 'unavailable' }

/**
 * The session's plan from `GET /api/v1/plans/session/:sessionId`: `status`
 * is the HTTP status, or null when the control plane could not be reached.
 * 200 with `lifecycleState` APPROVED or EXECUTING is approved, its tools the
 * steps' `tool` (or `toolName`) names; 200 in any other state, and 404, are
 * none; anything else is unavailable, which refuses as none does.
 */
export function gateRulePlanFromResponse(status: number | null, body: unknown): GateRulePlan {
  if (status === 404) return { status: 'none' }
  if (status !== 200 || !ruleIsObject(body)) return { status: 'unavailable' }
  if (body.lifecycleState !== 'APPROVED' && body.lifecycleState !== 'EXECUTING') return { status: 'none' }
  const tools: string[] = []
  for (const step of Array.isArray(body.steps) ? body.steps : []) {
    if (!ruleIsObject(step)) continue
    const tool = typeof step.tool === 'string' ? step.tool : step.toolName
    if (typeof tool === 'string' && tool.trim() !== '' && tools.indexOf(tool.trim()) === -1) tools.push(tool.trim())
  }
  return { status: 'approved', tools }
}

/** One call, and what the gate knows of its session, for {@link evaluateGateRuleRecords}. */
export interface GateRuleCall {
  tool: string
  input: unknown
  /** The action tokens the call classifies to. */
  actions: readonly string[]
  /** The gate's working directory and the workspace root (the nearest `.git` above it, else the directory itself). */
  cwd: string
  root: string
  /** The session id; empty when the harness sent none. */
  sessionId: string
  /** The harness's name, for the reasons. */
  harness: string
  /** The session's outcome state, or null when there is none or it does not read. */
  outcomes: OutcomeState | null
  /** The harness reports tool results the gate can read (its post event is confirmed). */
  observable: boolean
  /** The session's plan; only read when a `plan_approval` record applies. */
  plan: GateRulePlan
  nowMs: number
}

export interface GateRuleFinding {
  code: GateRuleCode
  /** The rule id the refusal and its events name. */
  ruleId: string
  reason: string
  scope: RefusalScope
  /** The record's ref, or the first record's when several decided together. */
  ref: string
}

export interface GateRuleEvaluation {
  /** The first enforcing record that refuses, or null to let the call on. */
  refusal: GateRuleFinding | null
  /** What the shadow records would have refused, recorded and not acted on. */
  shadow: GateRuleFinding[]
}

function ruleLower(s: string): string {
  return s.toLowerCase()
}

/** The plan rule of `records` (strict beats required), or null. */
function rulePlanFinding(records: readonly PlanApprovalRecord[], call: GateRuleCall): GateRuleFinding | null {
  if (records.length === 0 || isPlanExemptTool(call.tool)) return null
  const strict = records.find((r) => r.mode === 'strict')
  const rec = strict ?? records[0]!
  const ruleId = 'plan_approval.' + rec.sopTitle
  const scope = { tools: [call.tool] }
  if (call.sessionId === '') {
    return { code: 'PLAN_NOT_APPROVED', ruleId, scope, ref: rec.ref, reason: 'plan_approval: ' + rec.mode + ' (' + rec.sopTitle + '): ' + call.harness + ' sent no session id, so no approved plan can be found for this session' }
  }
  if (call.plan.status !== 'approved') {
    const why = call.plan.status === 'none' ? 'this session has no approved plan' : 'the approved plans could not be read'
    return { code: 'PLAN_NOT_APPROVED', ruleId, scope, ref: rec.ref, reason: 'plan_approval: ' + rec.mode + ' (' + rec.sopTitle + '): ' + why + '; get the plan approved, then retry' }
  }
  if (rec.mode === 'strict') {
    const tool = ruleLower(call.tool)
    if (!call.plan.tools.some((t) => ruleLower(t) === tool)) {
      return { code: 'OFF_PLAN', ruleId, scope, ref: rec.ref, reason: call.tool + ' is not a step of this session\'s approved plan (plan_approval: strict, ' + rec.sopTitle + ')' }
    }
  }
  return null
}

/** The first requires_outcome record the call is gated by and does not meet, or null. */
function ruleRequiresFinding(records: readonly RequiresOutcomeRecord[], call: GateRuleCall): GateRuleFinding | null {
  const tool = ruleLower(call.tool)
  for (const rec of records) {
    if (call.actions.indexOf(rec.then) === -1 && ruleLower(rec.then) !== tool) continue
    let c: PrerequisiteCase
    let why: string | null = null
    if (!call.observable) c = 'not_observable'
    else if (call.sessionId === '') c = 'no_session'
    else {
      const got = prerequisiteCase(call.outcomes, rec.first, rec.adjacent, call.nowMs)
      c = got.case
      why = got.why
    }
    if (c === 'met') continue
    return {
      code: 'PREREQUISITE_UNMET',
      ruleId: 'requires_before.' + rec.first + '[ok]' + (rec.adjacent ? '~>' : '->') + rec.then,
      reason: prerequisiteUnmetReason(rec.first, rec.then, c, why, call.harness),
      scope: { tools: [rec.then], step: rec.first },
      ref: rec.ref,
    }
  }
  return null
}

/** A change outside the union of the records' scopes, or null. */
function ruleScopeFinding(records: readonly ScopePathsRecord[], call: GateRuleCall): GateRuleFinding | null {
  if (records.length === 0) return null
  const targets = changeTargets(call.tool, call.input)
  if (targets.length === 0) return null
  const scopes: string[] = []
  for (const r of records) for (const p of r.scopePaths) if (scopes.indexOf(p) === -1) scopes.push(p)
  const outside: string[] = []
  for (const t of targets) {
    const rel = scopeRelativePath(t.target, call.cwd, call.root)
    if ((rel === null || !isWithinScope(rel, scopes)) && outside.indexOf(t.target) === -1) outside.push(t.target)
  }
  if (outside.length === 0) return null
  const rec = records[0]!
  return {
    code: 'OUT_OF_SCOPE',
    ruleId: 'scope_paths.' + rec.sopTitle,
    reason: 'Changes outside the declared file scope: ' + outside.join(', ') + ' (scope: ' + scopes.join(', ') + ')',
    scope: { paths: outside },
    ref: rec.ref,
  }
}

/** The findings of one rollout's records, in order: plan approval, then qualified prerequisites, then scope. */
function ruleFindings(records: readonly GateRuleRecord[], call: GateRuleCall): GateRuleFinding[] {
  const out: GateRuleFinding[] = []
  const plan = rulePlanFinding(records.filter((r): r is PlanApprovalRecord => r.kind === 'plan_approval'), call)
  if (plan) out.push(plan)
  const requires = ruleRequiresFinding(records.filter((r): r is RequiresOutcomeRecord => r.kind === 'requires_outcome'), call)
  if (requires) out.push(requires)
  const scope = ruleScopeFinding(records.filter((r): r is ScopePathsRecord => r.kind === 'scope_paths'), call)
  if (scope) out.push(scope)
  return out
}

/**
 * Tier R: the snapshot's rule records against one call. The enforcing
 * records' first finding refuses; the shadow records' findings are reported
 * and change nothing. A rule failure (an unreadable plan feed, an unreadable
 * outcome state) is a finding, so it refuses whatever the client's
 * `failClosed` says.
 */
export function evaluateGateRuleRecords(records: readonly GateRuleRecord[], call: GateRuleCall): GateRuleEvaluation {
  const enforce = ruleFindings(records.filter((r) => r.rollout === 'enforce'), call)
  return { refusal: enforce.length > 0 ? enforce[0]! : null, shadow: ruleFindings(records.filter((r) => r.rollout === 'shadow'), call) }
}

/**
 * The decoder and Tier R as JavaScript source, for the hook gates to embed
 * after `PHRASES_JS_SOURCE`, `TEST_OUTCOME_JS_SOURCE` and
 * `SCOPE_MATCH_JS_SOURCE`, whose functions these call. The constants the
 * functions read are written into the source.
 */
export const RULE_RECORD_JS_SOURCE = [
  `const RULE_RECORD_FIELDS = ${JSON.stringify(RULE_RECORD_FIELDS)};`,
  `const LANE_PHRASES = ${JSON.stringify(LANE_PHRASES)};`,
  `const V22_ACTION_TOKENS = ${JSON.stringify(V22_ACTION_TOKENS)};`,
  `const SCOPE_WRITE_TOOLS = ${JSON.stringify(SCOPE_WRITE_TOOLS)};`,
  `const SCOPE_EDIT_TOOLS = ${JSON.stringify(SCOPE_EDIT_TOOLS)};`,
  `const SCOPE_DELETE_TOOLS = ${JSON.stringify(SCOPE_DELETE_TOOLS)};`,
  `const SCOPE_MOVE_TOOLS = ${JSON.stringify(SCOPE_MOVE_TOOLS)};`,
  `const SCOPE_EDITOR_TOOLS = ${JSON.stringify(SCOPE_EDITOR_TOOLS)};`,
  `const SCOPE_SHELL_TOOLS = ${JSON.stringify(SCOPE_SHELL_TOOLS)};`,
  ...[
    ruleIsObject,
    ruleFromBase64,
    ruleToBase64,
    ruleText,
    decodeGateRuleRecord,
    gateRuleFallbackReason,
    ruleEscape,
    gateRuleFallback,
    ruleLower,
    rulePlanFinding,
    ruleRequiresFinding,
    ruleScopeFinding,
    ruleFindings,
    evaluateGateRuleRecords,
    gateRulePlanFromResponse,
  ].map((fn) =>
    fn
      .toString()
      .replace(/\(0,\s*(?:[\w$]+_js_\d+|__vite_ssr_import_\d+__)\.([\w$]+)\)/g, '$1')
      .replace(/\b(?:[\w$]+_js_\d+|__vite_ssr_import_\d+__)\.([\w$]+)/g, '$1')
      .replace(/\bexports\./g, ''),
  ),
].join('\n')
