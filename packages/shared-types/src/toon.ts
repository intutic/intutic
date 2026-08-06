/**
 * The TOON wire format — one encoder, one decoder, one place.
 *
 * TOON is a compact tabular encoding for large row arrays:
 *
 * ```
 * TOON|col1,col2,...,colN
 * val1|val2|...|valN
 * val1|val2|...|valN
 * ```
 *
 * It is produced by the control plane (`routes/incidents.ts`, `routes/traces.ts`)
 * and consumed by the dashboard and the CLI. Pipe-delimited rather than CSV so
 * commas in values need no escaping, with column headers up front so an LLM
 * reading a tool result gets type context, and a `TOON` sentinel so a decoder
 * can tell the format apart from JSON.
 *
 * # Why this module exists at all
 *
 * It used to live in `services/control-plane/src/lib/toon.ts`, with the decoder
 * hand-copied into `tools/cli/src/lib/api.ts` and `apps/dashboard/src/lib/api.ts`
 * — three implementations of one wire format, bound together by a comment saying
 * they must not diverge.
 *
 * That is not a hypothetical risk; it already cost a live bug. `escapeCell`
 * escaped `|` and newlines without escaping the backslash first, so a cell ending
 * in `\` escaped the delimiter the encoder appended after it and merged with the
 * next cell. On a governance incident from `GET /api/v1/incidents` that reads:
 *
 *     severity     "CRITICAL"  ->  "tr_…"   (the trace id)
 *     workspace_id  "ws_…"     ->  null
 *
 * so the row stopped rendering and filtering as CRITICAL in the dashboard and
 * printing as CRITICAL in the CLI, for any holder of a workspace API key. It also
 * corrupted ordinary data with no attacker present: a Windows path `C:\new` had
 * its `\n` turned into a real newline.
 *
 * The repair was applied to the encoder and to the control plane's own decoder —
 * and **nothing in the control plane decodes TOON**. The two decoders on the read
 * path kept their private copies, so the exploit still reproduced end to end
 * afterwards, and the half-fix additionally made a benign mid-string backslash
 * render doubled. Consolidating here is what stops the next fix landing in one
 * copy of three.
 *
 * # What is deliberately NOT here
 *
 * `toonEncodeWithMetrics` stays in the control plane. It calls
 * `Buffer.byteLength`, and this module is imported by the dashboard's browser
 * bundle — a Node built-in in here would work only for as long as tree-shaking
 * happened to drop it, which is the kind of guarantee that fails silently. The
 * wire format is universal; the byte accounting is a server concern.
 *
 * @module
 */

// ── Configuration ───────────────────────────────────────────────────────────

/** Minimum number of rows before TOON encoding activates. */
export const TOON_THRESHOLD_ROWS = 20

/** Max characters per cell value before truncation. */
export const TOON_MAX_CELL_CHARS = 120

/** Sentinel prefix for detecting TOON-encoded strings. */
export const TOON_MAGIC = 'TOON'

// ── Encoder ─────────────────────────────────────────────────────────────────

/**
 * A consistent ordered column set: the union of all keys, most common first.
 */
export function extractColumns(rows: Record<string, unknown>[]): string[] {
  const freq = new Map<string, number>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k)
}

/**
 * Escapes a cell body so nothing in it can be mistaken for structure.
 *
 * **The backslash is escaped first, and that ordering is the whole point.**
 * Escaping `|` and `\n` while passing the backslash through means a value ending
 * in one escapes the delimiter the encoder appends after it: `x\` + `|` + `y`
 * decodes as the single cell `x|y`, every later column shifts one place left, and
 * the last decodes as null. Repeating the trailing backslash shifts further.
 *
 * The value is reachable without an attacker: `routes/incidents.ts` builds
 * `description` from a hook event's `reason`, which any holder of a workspace API
 * key sets on `POST /api/v1/hook-events`.
 */
function escapeCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n')
}

/**
 * Truncates an already-escaped cell without severing an escape pair.
 *
 * `slice()` counts characters, not escape sequences, so a naive cut can land
 * between a backslash and the character it escapes and leave a dangling backslash
 * at the end of the cell — reintroducing the delimiter-swallowing bug through the
 * back door. A trailing run of backslashes is even by construction (each came
 * from `\\`), so an odd count means the cut split a pair.
 */
function truncateEscaped(escaped: string): string {
  if (escaped.length <= TOON_MAX_CELL_CHARS) return escaped
  let cut = escaped.slice(0, TOON_MAX_CELL_CHARS)
  let trailing = 0
  while (trailing < cut.length && cut[cut.length - 1 - trailing] === '\\') trailing++
  if (trailing % 2 === 1) cut = cut.slice(0, -1)
  return cut + '\u2026'
}

/** Serialises one cell value to a compact, pipe-safe string. */
export function serializeCell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'boolean') return value ? 't' : 'f'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return truncateEscaped(escapeCell(value))
  // `JSON.stringify` escapes backslashes and newlines *within* the JSON string
  // literals it emits, but the result is still a plain string that can end in a
  // backslash (`{"p":"C:\\"}`), so it goes through the same escaper.
  return truncateEscaped(escapeCell(JSON.stringify(value)))
}

/** Encodes an array of objects to TOON wire format. */
export function toonEncode(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return `${TOON_MAGIC}|(empty)\n`
  const cols = columns ?? extractColumns(rows)
  const lines: string[] = [`${TOON_MAGIC}|${cols.join(',')}`]
  for (const row of rows) {
    lines.push(cols.map((col) => serializeCell(row[col])).join('|'))
  }
  return lines.join('\n') + '\n'
}

// ── Decoder ─────────────────────────────────────────────────────────────────

/**
 * Splits one encoded row into cells, unescaping as it goes.
 *
 * A single left-to-right pass, not a chain of `.replace()` calls. The decoder
 * this replaces swapped `\|` for a NUL placeholder before splitting, which cannot
 * express the `\\` that {@link escapeCell} emits: given `x\\|y` the regex pairs
 * the *second* backslash with the delimiter and swallows it, merging two cells —
 * the exact bug the encoder change closes. Scanning is the only way the two
 * escapes stay distinguishable.
 *
 * A lone backslash before anything other than `\`, `|` or `n` is kept literal
 * rather than dropped. That is deliberate: it is what a payload from a control
 * plane predating the encoder fix looks like, and a stale value is a better
 * failure than a discarded character.
 */
function splitCells(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      const next = line[i + 1]
      if (next === '\\') { cur += '\\'; i++; continue }
      if (next === '|') { cur += '|'; i++; continue }
      if (next === 'n') { cur += '\n'; i++; continue }
      cur += '\\'
      continue
    }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells
}

/**
 * Decodes a TOON string back to plain objects, or `null` if it is not TOON.
 */
export function toonDecode(toon: string): Record<string, unknown>[] | null {
  const lines = toon.trimEnd().split('\n')
  if (lines.length < 1) return null
  const header = lines[0] as string
  if (!header.startsWith(`${TOON_MAGIC}|`)) return null
  const colsStr = header.slice(TOON_MAGIC.length + 1)
  if (colsStr === '(empty)') return []
  const cols = colsStr.split(',')
  const rows: Record<string, unknown>[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = splitCells(line)
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) {
      const key = cols[i] as string
      const raw = cells[i] ?? '-'
      if (raw === '-') { obj[key] = null; continue }
      if (raw === 't') { obj[key] = true; continue }
      if (raw === 'f') { obj[key] = false; continue }
      const num = Number(raw)
      if (!isNaN(num) && raw !== '') { obj[key] = num; continue }
      if (raw.startsWith('{') || raw.startsWith('[')) {
        try { obj[key] = JSON.parse(raw); continue } catch { /* fall through */ }
      }
      obj[key] = raw
    }
    rows.push(obj)
  }
  return rows
}

// ── Threshold-gated encode ──────────────────────────────────────────────────

export function shouldToon(rows: unknown[]): boolean {
  return rows.length >= TOON_THRESHOLD_ROWS
}

/**
 * Encodes a tool-result payload for context-window efficiency: TOON at or above
 * {@link TOON_THRESHOLD_ROWS} rows, JSON below it.
 */
export function toonEncodeToolResult(
  toolName: string,
  rows: Record<string, unknown>[],
): string {
  if (!shouldToon(rows)) return JSON.stringify(rows)
  return `# ${toolName} [${rows.length} rows, TOON-compressed]\n` + toonEncode(rows)
}

export function toonDecodeToolResult(payload: string): Record<string, unknown>[] | null {
  const body = payload.replace(/^#[^\n]*\n/, '')
  if (body.startsWith(`${TOON_MAGIC}|`)) return toonDecode(body)
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}
