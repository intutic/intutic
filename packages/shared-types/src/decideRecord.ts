/**
 * Decide rules in the policy snapshot: the `@format` record, the `@decide`
 * record, and the id and reason of a rule's fallback line.
 *
 * A gate that cannot evaluate a decide rule must refuse what the rule covers,
 * never skip it. So the snapshot writer emits, for each rule a gate is to
 * enforce, two lines inside the digest:
 *
 * - an `@decide` record of five tab-separated columns (the tag, the fallback
 *   line's id or `-`, the stamped rollout, the comma-joined tools, and base64
 *   of the record's canonical JSON). Every 2.x rule parser needs six columns,
 *   so it skips the record;
 * - a fallback line, an ordinary `block` rule on the rule's tools whose id
 *   starts `decide-fallback:`, which every gate since 2.0 enforces.
 *
 * A gate that reads decide rules skips a fallback line only when a record
 * with that `fallbackId` decodes ({@link decodeDecideRecord}): a damaged
 * record leaves its fallback line in force, which refuses. The `@format`
 * record names the snapshot format, 2 once any decide line is written; a
 * snapshot without one is byte-identical to a format 1 snapshot.
 *
 * Self-contained (no imports, no module state) so `@intutic/gate` can carry
 * a byte-identical copy (`packages/gate-js/src/decideRecord.ts`) and the
 * JavaScript hook gates can embed the decoder ({@link DECIDE_RECORD_JS_SOURCE}).
 * The rule itself is checked by the caller's {@link DecideRuleCheck}, which
 * runs `validateDecideRule` and `decideRuleHash` from `./decide.ts`. The
 * Python gate's port is `intutic_clawde/gate/decide_record.py`; both run the
 * `record` group of `fixtures/decide-vectors.json`.
 *
 * @module
 */

import type { DecideRule } from './decide.js'

/** First column of the snapshot format record: `@format<TAB><integer>`. */
export const SNAPSHOT_FORMAT_RECORD_TAG = '@format'
/**
 * The newest snapshot format a gate of this generation reads: 3, which adds
 * the `@rule` records of the loops, graphs and gates release (`./gateRuleRecord.ts`). A gate reading a
 * newer one reports `snapshot_format_newer` and enforces the fallback lines
 * of the records it does not know.
 */
export const SNAPSHOT_FORMAT = 3
/**
 * The format a snapshot carrying decide lines and no `@rule` record is
 * written in, so such a snapshot stays byte-identical to what 3.0 wrote. One
 * with any `@rule` record is format 3 (`RULE_SNAPSHOT_FORMAT`).
 */
export const DECIDE_SNAPSHOT_FORMAT = 2
/** First column of a decide rule's record. */
export const DECIDE_RECORD_TAG = '@decide'
/** The id prefix of a decide rule's fallback line. */
export const DECIDE_FALLBACK_PREFIX = 'decide-fallback:'
/** A record carries the first this many bytes of its SOP's body. */
export const DECIDE_RULE_TEXT_MAX_BYTES = 4096
/** The longest SOP title a record carries, in code points. */
export const DECIDE_SOP_TITLE_MAX_CHARS = 80

/** Why a rule's stamped rollout is what it is. Only `rule` can stamp `enforce`. */
export type DecideStamp = 'rule' | 'local-disable' | 'server-shadow' | 'silent-log' | 'no-pins'

/** A calibration a rule may enforce under: the model digest it was evaluated on, and what the evaluation fitted. */
export interface DecidePin {
  modelDigest: string
  temperature?: Record<string, number>
  band?: { yes_at: number; no_below: number }
  combiner?: { bias: number; weights: Record<string, number> }
  evalRunId: string
  source: 'local' | 'server'
}

/** One `@decide` record's payload. */
export interface DecideRecord {
  v: 1
  /** `<sopId>#<rule id>`. */
  ref: string
  ruleHash: string
  /** The paired fallback line's id; null when the rule is stamped shadow and has none. */
  fallbackId: string | null
  rollout: 'shadow' | 'enforce'
  stampedBy: DecideStamp
  /** The rule as its `decide:` line carries it. */
  ir: DecideRule
  sopTitle: string
  ruleText: string
  pins: DecidePin[]
}

/**
 * Checks a record's rule: the rule's `ruleHash` when it is a valid decide
 * rule, null when it is not. Callers pass `validateDecideRule` then
 * `decideRuleHash`, with their own SHA-256.
 */
export type DecideRuleCheck = (ir: unknown) => string | null

const DECIDE_STAMPS = ['rule', 'local-disable', 'server-shadow', 'silent-log', 'no-pins']
const DECIDE_RECORD_FIELDS = ['fallbackId', 'ir', 'pins', 'ref', 'rollout', 'ruleHash', 'ruleText', 'sopTitle', 'stampedBy', 'v']
const DECIDE_PIN_FIELDS = ['band', 'combiner', 'evalRunId', 'modelDigest', 'source', 'temperature']

/** `@format<TAB><format>`: 2 ({@link DECIDE_SNAPSHOT_FORMAT}) unless the writer passes 3 for a snapshot with `@rule` records. */
export function encodeSnapshotFormatRecord(format: number = DECIDE_SNAPSHOT_FORMAT): string {
  return `${SNAPSHOT_FORMAT_RECORD_TAG}\t${format}`
}

/** The format a `@format` line names: a positive integer, or null for any other line or a damaged one. */
export function decodeSnapshotFormatRecord(line: string): number | null {
  const f = line.split('\t')
  if (f.length !== 2 || f[0] !== SNAPSHOT_FORMAT_RECORD_TAG || !/^[1-9][0-9]{0,5}$/.test(f[1]!)) return null
  return Number(f[1])
}

/** `ruleRef`: `<sopId>#<rule id>`. */
export function decideRuleRef(sopId: string, ruleId: string): string {
  return `${sopId}#${ruleId}`
}

/** `fallbackId`: `decide-fallback:<rule id>@<first 12 hex of sha256(sopId)>`. `sha256Hex` hashes a string's UTF-8 bytes. */
export function decideFallbackId(ruleId: string, sopId: string, sha256Hex: (text: string) => string): string {
  return `${DECIDE_FALLBACK_PREFIX}${ruleId}@${sha256Hex(sopId).slice(0, 12)}`
}

/** What an older gate says when a fallback line refuses. The writer scrubs and bounds it like any reason. */
export function decideFallbackReason(ruleId: string, sopTitle: string): string {
  return `Decide rule ${ruleId} (${sopTitle}): upgrade to Intutic 3.0 to evaluate this rule`
}

/** A SOP body as a record carries it: its first {@link DECIDE_RULE_TEXT_MAX_BYTES} bytes of UTF-8, never splitting a character. */
export function decideRuleText(body: string): string {
  let bytes = 0
  let end = 0
  for (const ch of body) {
    const cp = ch.codePointAt(0)!
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + n > DECIDE_RULE_TEXT_MAX_BYTES) break
    bytes += n
    end += ch.length
  }
  return body.slice(0, end)
}

function decideIsObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function decideIsNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v)
}

/** Every own key is one of `allowed`. */
function decideOnlyFields(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.indexOf(k) !== -1)
}

function decideNumberMap(v: unknown): boolean {
  return decideIsObject(v) && Object.keys(v).every((k) => decideIsNumber(v[k]))
}

/** JSON with keys sorted at every level and no whitespace, so a record is byte-stable. */
function decideCanonicalRecordJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(decideCanonicalRecordJson).join(',') + ']'
  if (decideIsObject(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + decideCanonicalRecordJson(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function decideToBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Standard base64 back to UTF-8 text. Throws on anything but the canonical encoding of valid UTF-8. */
function decideFromBase64(b64: string): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  if (decideToBase64(text) !== b64) throw new Error('not canonical base64')
  return text
}

/** A pin as a record carries it, or null. Unknown fields refuse: a pin a reader cannot apply must not be read as a weaker one. */
export function parseDecidePin(value: unknown): DecidePin | null {
  if (!decideIsObject(value) || !decideOnlyFields(value, DECIDE_PIN_FIELDS)) return null
  const { modelDigest, evalRunId, source, temperature, band, combiner } = value
  if (typeof modelDigest !== 'string' || modelDigest === '' || typeof evalRunId !== 'string' || evalRunId === '') return null
  if (source !== 'local' && source !== 'server') return null
  if (temperature !== undefined && !decideNumberMap(temperature)) return null
  if (band !== undefined) {
    if (!decideIsObject(band) || !decideOnlyFields(band, ['yes_at', 'no_below'])) return null
    const { yes_at, no_below } = band
    if (!decideIsNumber(yes_at) || !decideIsNumber(no_below) || !(yes_at > 0.5 && yes_at < 1 && no_below > 0 && no_below < yes_at)) return null
  }
  if (combiner !== undefined) {
    if (!decideIsObject(combiner) || !decideOnlyFields(combiner, ['bias', 'weights'])) return null
    if (!decideIsNumber(combiner.bias) || !decideNumberMap(combiner.weights)) return null
  }
  return value as unknown as DecidePin
}

/** The record's tools column: the rule's tools, distinct and sorted, joined by commas. */
function decideToolsColumn(ir: { tools?: readonly string[] }): string {
  return (ir.tools ?? []).filter((t, i, all) => all.indexOf(t) === i).sort().join(',')
}

/** The record as one `.rules` line. */
export function encodeDecideRecord(record: DecideRecord): string {
  return [
    DECIDE_RECORD_TAG,
    record.fallbackId ?? '-',
    record.rollout,
    decideToolsColumn(record.ir),
    decideToBase64(decideCanonicalRecordJson(record)),
  ].join('\t')
}

/**
 * Reads an `@decide` line back. Null, and so the fallback line stays in
 * force, for any other line or when: it does not have five columns; the
 * base64 or JSON is damaged; the payload has a field this reader does not
 * know or lacks one; `check` finds the rule invalid or its hash differs from
 * `ruleHash`; the stamp is inconsistent (only a rule stamped `enforce` by
 * `rule` has a fallback line, and it is named for the rule); or columns 2 to
 * 4 disagree with the payload.
 */
export function decodeDecideRecord(line: string, check: DecideRuleCheck): DecideRecord | null {
  const f = line.split('\t')
  if (f.length !== 5 || f[0] !== DECIDE_RECORD_TAG || !f[4]) return null
  let r: unknown
  try {
    r = JSON.parse(decideFromBase64(f[4]))
  } catch {
    return null
  }
  if (!decideIsObject(r) || !decideOnlyFields(r, DECIDE_RECORD_FIELDS)) return null
  if (DECIDE_RECORD_FIELDS.some((k) => !Object.prototype.hasOwnProperty.call(r, k))) return null
  const ir = r.ir
  if (r.v !== 1 || !decideIsObject(ir) || typeof ir.id !== 'string') return null
  if (typeof r.ruleHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.ruleHash) || check(ir) !== r.ruleHash) return null
  if (typeof r.ref !== 'string' || r.ref.length <= ir.id.length + 1 || r.ref.slice(-(ir.id.length + 1)) !== '#' + ir.id) return null
  if (r.rollout !== 'shadow' && r.rollout !== 'enforce') return null
  if (typeof r.stampedBy !== 'string' || DECIDE_STAMPS.indexOf(r.stampedBy) === -1) return null
  if (r.rollout === 'enforce') {
    if (r.stampedBy !== 'rule' || typeof r.fallbackId !== 'string') return null
    const head = DECIDE_FALLBACK_PREFIX + ir.id + '@'
    if (r.fallbackId.slice(0, head.length) !== head || !/^[0-9a-f]{12}$/.test(r.fallbackId.slice(head.length))) return null
  } else if (r.fallbackId !== null) {
    return null
  }
  if (typeof r.sopTitle !== 'string' || /[\t\r\n]/.test(r.sopTitle) || Array.from(r.sopTitle).length > DECIDE_SOP_TITLE_MAX_CHARS) return null
  if (typeof r.ruleText !== 'string' || new TextEncoder().encode(r.ruleText).length > DECIDE_RULE_TEXT_MAX_BYTES) return null
  if (!Array.isArray(r.pins) || r.pins.some((p) => parseDecidePin(p) === null)) return null
  const record = r as unknown as DecideRecord
  if (f[1] !== (record.fallbackId ?? '-') || f[2] !== record.rollout || f[3] !== decideToolsColumn(record.ir)) return null
  return record
}

/**
 * The decoders above as JavaScript source, for the hook gates to embed. The
 * gate defines `check` with the embedded `./decide.ts` source and its own
 * SHA-256. A CommonJS build names an exported constant `exports.X` inside a
 * function; the source defines each as a plain `X`, so that prefix is dropped.
 */
export const DECIDE_RECORD_JS_SOURCE = [
  `const SNAPSHOT_FORMAT_RECORD_TAG = ${JSON.stringify(SNAPSHOT_FORMAT_RECORD_TAG)};`,
  `const DECIDE_RECORD_TAG = ${JSON.stringify(DECIDE_RECORD_TAG)};`,
  `const DECIDE_FALLBACK_PREFIX = ${JSON.stringify(DECIDE_FALLBACK_PREFIX)};`,
  `const DECIDE_RULE_TEXT_MAX_BYTES = ${DECIDE_RULE_TEXT_MAX_BYTES};`,
  `const DECIDE_SOP_TITLE_MAX_CHARS = ${DECIDE_SOP_TITLE_MAX_CHARS};`,
  `const DECIDE_STAMPS = ${JSON.stringify(DECIDE_STAMPS)};`,
  `const DECIDE_RECORD_FIELDS = ${JSON.stringify(DECIDE_RECORD_FIELDS)};`,
  `const DECIDE_PIN_FIELDS = ${JSON.stringify(DECIDE_PIN_FIELDS)};`,
  ...[
    decodeSnapshotFormatRecord,
    decideIsObject,
    decideIsNumber,
    decideOnlyFields,
    decideNumberMap,
    decideToBase64,
    decideFromBase64,
    parseDecidePin,
    decideToolsColumn,
    decodeDecideRecord,
  ].map((fn) => fn.toString().replace(/\bexports\./g, '')),
].join('\n')
