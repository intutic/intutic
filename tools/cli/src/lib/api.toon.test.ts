/**
 * The CLI's TOON decoder against what the control plane's encoder actually emits.
 *
 * These rows are byte-for-byte what `services/control-plane/src/lib/toon.ts`
 * produces (`escapeCell` escapes `\` -> `\\`, then `|` -> `\|`, then newline ->
 * `\n`). The decoder this file exercises previously replaced `\|` with a NUL
 * placeholder before splitting on `|`, which pairs the SECOND backslash of a
 * `\\` with the following delimiter: two columns merge, every later column
 * shifts one place left, and the last column decodes as null.
 *
 * The column order is the encoder's own (`extractColumns` sorts by frequency
 * then name), so `description` — the only attacker-controlled cell on a
 * governance incident — sits immediately before `escalation_chain` and the
 * shift lands on the tail of the row: `severity` reads back as the trace id.
 */
import { describe, it, expect } from 'vitest'
import { toonDecode } from './api.js'

/**
 * One incidents row exactly as `routes/incidents.ts` shapes it and
 * `toonEncode` serialises it, for a given hook-event `reason`.
 */
function encodedIncident(escapedDescriptionTail: string): string {
  const cols = [
    'anomaly_type', 'created_at', 'description', 'escalation_chain', 'incident_id',
    'resolution_status', 'resolved_at', 'resolved_by', 'review_priority',
    'session_id', 'severity', 'trace_id', 'workspace_id',
  ].join(',')
  const cells = [
    'HOOK_GATE_BLOCK',
    '2026-08-05T00:00:00.000Z',
    `[Hook Gate] Tool "Bash" blocked. Reason: ${escapedDescriptionTail}`,
    'oncall',
    'inc_1',
    'OPEN',
    '-',
    '-',
    '91',
    'sess_1',
    'CRITICAL',
    'tr_1',
    'ws_victim',
  ].join('|')
  return `TOON|${cols}\n${cells}\n`
}

describe('toonDecode — backslash handling', () => {
  it('keeps a governance incident on its own columns when the reason ends in a backslash', () => {
    // reason `exfil \` -> escapeCell -> `exfil \\`
    const row = toonDecode(encodedIncident('exfil \\\\'))[0]

    expect(row.severity).toBe('CRITICAL')
    expect(row.resolution_status).toBe('OPEN')
    expect(row.workspace_id).toBe('ws_victim')
    expect(row.trace_id).toBe('tr_1')
    expect(row.description).toBe('[Hook Gate] Tool "Bash" blocked. Reason: exfil \\')
  })

  it('does not shift columns for a repeated trailing backslash', () => {
    // reason `exfil \\` -> escapeCell -> `exfil \\\\`
    const row = toonDecode(encodedIncident('exfil \\\\\\\\'))[0]

    expect(row.severity).toBe('CRITICAL')
    expect(row.workspace_id).toBe('ws_victim')
    expect(row.description).toBe('[Hook Gate] Tool "Bash" blocked. Reason: exfil \\\\')
  })

  it('unescapes a literal backslash without consuming the delimiter after it', () => {
    const rows = toonDecode('TOON|a,b\nx\\\\|y\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].a).toBe('x\\')
    expect(rows[0].b).toBe('y')
  })

  it('still unescapes a genuinely escaped delimiter into one cell', () => {
    const rows = toonDecode('TOON|a,b\nx\\|y|z\n')
    expect(rows[0].a).toBe('x|y')
    expect(rows[0].b).toBe('z')
  })

  it('does not turn an escaped literal backslash-n into a newline', () => {
    // The Windows path `C:\new\test` encodes as `C:\\new\\test`.
    const rows = toonDecode('TOON|p,q\nC:\\\\new\\\\test|ok\n')
    expect(rows[0].p).toBe('C:\\new\\test')
    expect(rows[0].q).toBe('ok')
  })

  it('still decodes an escaped newline', () => {
    const rows = toonDecode('TOON|p,q\nline1\\nline2|ok\n')
    expect(rows[0].p).toBe('line1\nline2')
    expect(rows[0].q).toBe('ok')
  })

  it('leaves values without a backslash exactly as before', () => {
    const rows = toonDecode('TOON|a,b,c\nhello|-|t\n')
    expect(rows[0]).toEqual({ a: 'hello', b: null, c: true })
  })
})
