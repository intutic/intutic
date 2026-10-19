/**
 * What a refusal says about where to retry: its `scope` (the
 * paths, tools, step, detector or rule it concerns) and its `evidence` (what
 * the refuser saw), bounded the same way on every surface.
 *
 * - Each list holds at most {@link REFUSAL_DETAIL_MAX_ITEMS} items, and each
 *   string at most {@link REFUSAL_DETAIL_MAX_CHARS} characters (code points),
 *   with C0 control characters (U+0000 to U+001F) removed first. A string
 *   that is empty after that is dropped; an empty list is left out; a scope
 *   with nothing left is null.
 * - In an OPAQUE workspace both are dropped, and so is the stderr retry line:
 *   only the refusal code survives, as with the reason
 *   (`OPAQUE_REFUSAL_MESSAGE`). SILENT_LOG behaves as TRANSPARENT.
 *
 * Self-contained, so `@intutic/gate` keeps a byte-identical copy. The Python
 * port is `intutic_clawde/gate/refusal_detail.py`, the Rust one is in the
 * proxy's `refusal.rs`; all run `fixtures/refusal-detail-vectors.json`.
 *
 * @module
 */

/** Where a refusal applies, so a retry can stay out of it. */
export interface RefusalScope {
  paths?: string[]
  tools?: string[]
  step?: string
  detector?: string
  rule?: string
}

/** One thing the refuser saw. */
export interface RefusalEvidence {
  kind: string
  detail: string
}

export const REFUSAL_DETAIL_MAX_ITEMS = 8
export const REFUSAL_DETAIL_MAX_CHARS = 256
/** The stderr line an exit-code harness prints after the reason. */
export const RETRY_SCOPE_PREFIX = '[Intutic] Retry scope: '

/** `s` without C0 control characters, cut to 256 code points; null when nothing is left or it is not a string. */
function refusalDetailText(s: unknown): string | null {
  if (typeof s !== 'string') return null
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = Array.from(s.replace(/[\u0000-\u001f]/g, ''))
  if (clean.length === 0) return null
  return clean.slice(0, 256).join('')
}

/** A list of strings, bounded: the first 8 that survive {@link refusalDetailText}. */
function refusalDetailList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (out.length >= 8) break
    const t = refusalDetailText(item)
    if (t !== null) out.push(t)
  }
  return out.length > 0 ? out : null
}

/** A scope bounded as the module doc says, keys in a fixed order; null when nothing is left. */
export function boundRefusalScope(scope: unknown): RefusalScope | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  const s = scope as Record<string, unknown>
  const out: RefusalScope = {}
  const paths = refusalDetailList(s.paths)
  if (paths) out.paths = paths
  const tools = refusalDetailList(s.tools)
  if (tools) out.tools = tools
  const step = refusalDetailText(s.step)
  if (step !== null) out.step = step
  const detector = refusalDetailText(s.detector)
  if (detector !== null) out.detector = detector
  const rule = refusalDetailText(s.rule)
  if (rule !== null) out.rule = rule
  return Object.keys(out).length > 0 ? out : null
}

/** Evidence bounded: at most 8 items, each with a `kind` and a `detail` that survive bounding. */
export function boundRefusalEvidence(evidence: unknown): RefusalEvidence[] {
  const out: RefusalEvidence[] = []
  if (!Array.isArray(evidence)) return out
  for (const item of evidence) {
    if (out.length >= 8) break
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const kind = refusalDetailText((item as Record<string, unknown>).kind)
    const detail = refusalDetailText((item as Record<string, unknown>).detail)
    if (kind !== null && detail !== null) out.push({ kind, detail })
  }
  return out
}

/**
 * The detail a refusal carries in `mode` (an intervention mode): nothing in
 * OPAQUE; otherwise the bounded scope and evidence, each left out when empty.
 */
export function refusalDetailForMode(mode: string | null | undefined, scope: unknown, evidence: unknown): { scope?: RefusalScope; evidence?: RefusalEvidence[] } {
  if (mode === 'OPAQUE') return {}
  const out: { scope?: RefusalScope; evidence?: RefusalEvidence[] } = {}
  const s = boundRefusalScope(scope)
  if (s) out.scope = s
  const e = boundRefusalEvidence(evidence)
  if (e.length > 0) out.evidence = e
  return out
}

/**
 * The stderr line an exit-code harness gets after the reason:
 * `[Intutic] Retry scope: <paths, else tools, comma-separated>`, or null when
 * the scope names neither, or in OPAQUE.
 */
export function retryScopeLine(mode: string | null | undefined, scope: unknown): string | null {
  if (mode === 'OPAQUE') return null
  const s = boundRefusalScope(scope)
  const items = s?.paths ?? s?.tools
  return items ? '[Intutic] Retry scope: ' + items.join(', ') : null
}

/** The functions above as JavaScript source, for the hook gates to embed. */
export const REFUSAL_DETAIL_JS_SOURCE = [refusalDetailText, refusalDetailList, boundRefusalScope, boundRefusalEvidence, refusalDetailForMode, retryScopeLine]
  .map((fn) => fn.toString().replace(/\bexports\./g, ''))
  .join('\n')
