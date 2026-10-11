/**
 * The control plane's TOON list encoding, decoded.
 *
 * A list endpoint answering with 20 rows or more (`GET /api/v1/traces`) may
 * send them as one pipe-separated string under `data`, with `format: 'toon'`
 * and `listProperty` naming the key the rows belong under. This is a copy of
 * `toonDecode` in `@intutic/shared-types` (this package has no dependencies),
 * applied to every control-plane response the way the CLI applies it.
 *
 * Cells longer than the encoder's limit arrive cut, ending in `…`: TOON trades
 * that for size, and nothing here can restore them.
 *
 * @module
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

/** Rows from a TOON string, or null when it is not one. */
export function toonDecode(toon: string): Record<string, unknown>[] | null {
  const lines = toon.trimEnd().split('\n')
  const header = lines[0] ?? ''
  if (!header.startsWith('TOON|')) return null
  const colsStr = header.slice('TOON|'.length)
  if (colsStr === '(empty)') return []
  const cols = colsStr.split(',')
  const rows: Record<string, unknown>[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = splitCells(line)
    const row: Record<string, unknown> = {}
    cols.forEach((key, i) => {
      row[key] = decodeCell(cells[i] ?? '-')
    })
    rows.push(row)
  }
  return rows
}

function decodeCell(raw: string): unknown {
  if (raw === '-') return null
  if (raw === 't') return true
  if (raw === 'f') return false
  const num = Number(raw)
  if (!isNaN(num) && raw !== '') return num
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      // Not JSON after all: the text itself.
    }
  }
  return raw
}

/**
 * Moves a TOON-encoded list out of its envelope onto `listProperty`, so the
 * body has the shape a shorter list arrives in; any other body passes through.
 */
export function unwrapToonEnvelope(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const body = data as Record<string, unknown>
  if (body['format'] !== 'toon' || typeof body['data'] !== 'string' || typeof body['listProperty'] !== 'string') return data
  const unwrapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'format' && key !== 'data') unwrapped[key] = value
  }
  unwrapped[body['listProperty']] = toonDecode(body['data']) ?? []
  return unwrapped
}
