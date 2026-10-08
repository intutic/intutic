/**
 * dlpPii.ts — checksum-validated PII detectors.
 *
 * The TypeScript twin of the Rust proxy's `packages/proxy/src/dlp/pii.rs`.
 * Both read the same definition (`PII_DEFINITION` from
 * `@intutic/shared-types`, a byte-identical copy of the proxy's
 * `pii_detectors.json`) and implement its validators and boundary rule the
 * same way; `packages/shared-types/fixtures/pii-detector-vectors.json` runs
 * through both (`__tests__/dlpPii.test.ts`, `tests/pii_conformance_test.rs`).
 * A change to a rule here needs the same change there, or the vectors fail on
 * one side.
 *
 * The regex finds a candidate; the validator decides. Luhn plus the IIN table
 * for cards, the country length table plus mod-97 for IBANs, the never-issued
 * ranges for SSNs, structure for email, digit count for phone numbers.
 *
 * The boundary rule replaces `\b`, which means different things in the two
 * engines. Neighbouring characters must not be ASCII letters, digits or `_`,
 * except that a match right after a JSON escape (`\n`, `\r`, `\t`) counts as
 * bounded — both scanners read JSON as sent. A match starting right after a
 * backslash starts inside an escape and is rejected. `numeric` detectors
 * also reject a match glued to more digits by `.` or `-` (a decimal fraction,
 * a five-group serial). A rejected candidate resumes the search one character
 * after its start, so a card number right after `12 ` is still found.
 *
 * @module
 */

import { PII_DEFINITION } from '@intutic/shared-types'
import type { PiiAction, PiiDetectorDefinition } from '@intutic/shared-types'

export interface PiiDetector {
  id: string
  category: string
  description: string
  defaultAction: PiiAction
  /** Global flag: matched from `lastIndex`, which `findPii` sets. */
  regex: RegExp
  numeric: boolean
  /** The accepted length of the span (a prefix of it), or null. */
  validate: (span: string) => number | null
}

const CARD_BRANDS = PII_DEFINITION.card_brands
const IBAN_LENGTHS = PII_DEFINITION.iban_lengths

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isWord = (c: number): boolean =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const BACKSLASH = 92
const DOT = 46
const DASH = 45

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function card(span: string): boolean {
  const digits = span.replace(/[^0-9]/g, '')
  const n = digits.length
  const known = CARD_BRANDS.some(
    (b) =>
      b.lengths.includes(n) &&
      b.prefixes.some(([lo, hi]) => {
        const head = digits.slice(0, lo.length)
        return head >= lo && head <= hi
      }),
  )
  return known && luhn(digits)
}

/** Truncates to the country's length: the regex is greedy and runs on into `EUR`. */
function iban(span: string): number | null {
  const want = IBAN_LENGTHS[span.slice(0, 2)]
  if (want === undefined) return null
  let chars = ''
  let end = span.length
  for (let i = 0; i < span.length; i++) {
    const c = span[i]!
    if (c === ' ') continue
    if (chars.length === want) {
      // A further character glued on (no space) makes it longer than any
      // IBAN of this country.
      if (span[i - 1] !== ' ') return null
      break
    }
    chars += c
    end = i + 1
  }
  if (chars.length !== want) return null
  const rotated = chars.slice(4) + chars.slice(0, 4)
  let rem = 0
  for (const c of rotated) {
    const code = c.charCodeAt(0)
    const v = isDigit(code) ? code - 48 : code - 65 + 10
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97
  }
  return rem === 1 ? end : null
}

/** Never issued: area 000, 666 or 9xx; group 00; serial 0000. */
function ssn(span: string): boolean {
  const area = span.slice(0, 3)
  const group = span.slice(4, 6)
  const serial = span.slice(7, 11)
  return area !== '000' && area !== '666' && area[0] !== '9' && group !== '00' && serial !== '0000'
}

function email(span: string): boolean {
  const at = span.indexOf('@')
  if (at < 0) return false
  const local = span.slice(0, at)
  const domain = span.slice(at + 1)
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  const labels = domain.split('.')
  if (labels.some((l) => l === '' || l.startsWith('-') || l.endsWith('-'))) return false
  const tld = labels[labels.length - 1]!
  if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) return false
  // `icon@2x.png`: an asset scale suffix, not an address.
  const first = labels[0]!
  return !/^[0-9]+x$/.test(first)
}

function phone(span: string): boolean {
  const n = span.replace(/[^0-9]/g, '').length
  return n >= 10 && n <= 15
}

const whole =
  (check: (span: string) => boolean) =>
  (span: string): number | null =>
    check(span) ? span.length : null

const VALIDATORS: Record<PiiDetectorDefinition['validator'], (span: string) => number | null> = {
  card_luhn: whole(card),
  iban_mod97: iban,
  ssn_ranges: whole(ssn),
  email_shape: whole(email),
  phone_digits: whole(phone),
}

/** Every PII detector, in definition order, whatever its configured action. */
export const PII_DETECTORS: readonly PiiDetector[] = PII_DEFINITION.detectors.map((d) => {
  const validate = VALIDATORS[d.validator]
  if (!validate) throw new Error(`pii detector ${d.id} names unknown validator ${d.validator}`)
  return {
    id: d.id,
    category: d.category,
    description: d.description,
    defaultAction: d.default_action,
    regex: new RegExp(d.regex, 'g'),
    numeric: d.boundary === 'numeric',
    validate,
  }
})

function bounded(text: string, start: number, end: number, numeric: boolean): boolean {
  if (start > 0) {
    const p = text.charCodeAt(start - 1)
    if (p === BACKSLASH) return false
    const escaped =
      (p === 110 || p === 114 || p === 116) && start >= 2 && text.charCodeAt(start - 2) === BACKSLASH
    if (isWord(p) && !escaped) return false
    if (numeric && (p === DOT || p === DASH) && start >= 2 && isDigit(text.charCodeAt(start - 2))) return false
  }
  if (end < text.length) {
    const q = text.charCodeAt(end)
    if (isWord(q)) return false
    if (numeric && (q === DOT || q === DASH) && end + 1 < text.length && isDigit(text.charCodeAt(end + 1))) {
      return false
    }
  }
  return true
}

/** Validated matches of one detector, as `[start, end)` UTF-16 ranges, in text order. */
export function findPii(det: PiiDetector, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = det.regex
  let pos = 0
  while (pos < text.length) {
    re.lastIndex = pos
    const m = re.exec(text)
    if (!m) break
    const start = m.index
    const len = det.validate(m[0])
    const end = len === null ? null : start + len
    if (end !== null && bounded(text, start, end, det.numeric)) {
      out.push([start, end])
      pos = end
    } else {
      pos = start + 1
    }
  }
  return out
}

/**
 * Every detector over `text`, actions ignored, in definition order then text
 * order — what the conformance vectors measure.
 */
export function detectPii(text: string): Array<{ id: string; start: number; end: number }> {
  const out: Array<{ id: string; start: number; end: number }> = []
  for (const det of PII_DETECTORS) {
    for (const [start, end] of findPii(det, text)) out.push({ id: det.id, start, end })
  }
  return out
}

/**
 * Resolve each detector's action from an `INTUTIC_MCP_DLP_DETECTORS` value —
 * a JSON object of detector id → `off` | `redact` | `block` — over the
 * defaults. Never throws, like the other `INTUTIC_MCP_*` JSON settings: an
 * unparseable value, an unknown id or an unknown action is reported in
 * `problems` and that entry keeps its default, which for card, IBAN and SSN
 * is on.
 */
export function resolvePiiActions(raw: string | undefined): {
  actions: Map<string, PiiAction>
  problems: string[]
} {
  const actions = new Map<string, PiiAction>(PII_DETECTORS.map((d) => [d.id, d.defaultAction]))
  const problems: string[] = []
  if (!raw) return { actions, problems }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { actions, problems: ['INTUTIC_MCP_DLP_DETECTORS is not valid JSON; using the defaults'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { actions, problems: ['INTUTIC_MCP_DLP_DETECTORS is not a JSON object; using the defaults'] }
  }
  for (const [id, action] of Object.entries(parsed as Record<string, unknown>)) {
    if (!actions.has(id)) {
      problems.push(`INTUTIC_MCP_DLP_DETECTORS names unknown detector ${id}; known: ${[...actions.keys()].join(', ')}`)
    } else if (action !== 'off' && action !== 'redact' && action !== 'block') {
      problems.push(`INTUTIC_MCP_DLP_DETECTORS sets ${id} to ${String(action)}; only off, redact and block exist`)
    } else {
      actions.set(id, action)
    }
  }
  return { actions, problems }
}
