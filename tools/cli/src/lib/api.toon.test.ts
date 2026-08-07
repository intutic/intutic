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
import { toonDecode, unwrapToonEnvelope } from './api.js'
import { toonEncode } from '@intutic/shared-types'

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

describe('the fixtures above are still what the encoder emits', () => {
  it('round-trips a real incidents row through the shared encoder', () => {
    // The rows above are hand-written wire bytes. That is the right way to pin a
    // DECODER — it fails if the decoder regresses, independently of the encoder.
    // But it also means an ENCODER change leaves these fixtures pinning bytes
    // nothing produces any more, and this file would keep passing against a
    // format that no longer exists.
    //
    // Verified: breaking `escapeCell` in @intutic/shared-types fails the control
    // plane's round-trip tests and leaves every test in this file green.
    //
    // So this one asserts the two agree. It is the only test here that will
    // notice the encoder moving.
    const row = {
      anomaly_type: 'HOOK_GATE_BLOCK',
      created_at: '2026-08-05T00:00:00.000Z',
      description: '[Hook Gate] Tool "Bash" blocked. Reason: exfil \\',
      escalation_chain: 'oncall',
      incident_id: 'inc_1',
      resolution_status: 'OPEN',
      resolved_at: null,
      resolved_by: null,
      review_priority: 91,
      session_id: 'sess_1',
      severity: 'CRITICAL',
      trace_id: 'tr_1',
      workspace_id: 'ws_victim',
    }
    expect(
      toonEncode([row]),
      'the encoder no longer produces the bytes these fixtures assume',
    ).toBe(encodedIncident('exfil \\\\'))

    // And the decoder gets the original value back out.
    expect(toonDecode(toonEncode([row]))[0]).toEqual(row)
  })
})

/**
 * The envelope unwrap, which is a separate failure from the cell decoding above.
 *
 * `listProperty` names where the decoded rows should LAND. For
 * `/api/v1/incidents` that name is `data` — the same key the encoded string
 * arrived in — so the original order (assign, then delete `data`) wrote the rows
 * and deleted them on the next line. Every incidents response over the 20-row
 * TOON threshold reached the CLI and the dashboard as `{meta:{total:N}}`: no
 * rows, no error, and a correct total sitting next to the empty list.
 *
 * `/api/v1/traces` was never affected, because its listProperty is `traces`.
 * That is the whole reason this went unnoticed — the endpoint people tested
 * with worked.
 */
describe('unwrapToonEnvelope', () => {
  const encoded = toonEncode([
    { incident_id: 'gi_1', severity: 'HIGH' },
    { incident_id: 'gi_2', severity: 'LOW' },
  ])!

  it('keeps the rows when listProperty is "data" (the incidents case)', () => {
    const out = unwrapToonEnvelope({
      format: 'toon', listProperty: 'data', data: encoded, meta: { total: 2 },
    }) as Record<string, unknown>
    expect(Array.isArray(out['data'])).toBe(true)
    expect(out['data']).toHaveLength(2)
    expect((out['data'] as Record<string, unknown>[])[0]!['incident_id']).toBe('gi_1')
  })

  it('keeps the rows when listProperty is a different key (the traces case)', () => {
    const out = unwrapToonEnvelope({
      format: 'toon', listProperty: 'traces', data: encoded, total: 2,
    }) as Record<string, unknown>
    expect(out['traces']).toHaveLength(2)
    expect(out['data']).toBeUndefined()
  })

  it('strips the envelope keys', () => {
    const out = unwrapToonEnvelope({
      format: 'toon', listProperty: 'traces', data: encoded,
    }) as Record<string, unknown>
    expect(out['format']).toBeUndefined()
    expect(out['listProperty']).toBeUndefined()
  })

  it('leaves sibling keys alone', () => {
    const out = unwrapToonEnvelope({
      format: 'toon', listProperty: 'data', data: encoded, meta: { total: 2, page: 1 },
    }) as Record<string, unknown>
    expect(out['meta']).toEqual({ total: 2, page: 1 })
  })

  it.each([
    ['a plain list body', { data: [{ a: 1 }], meta: {} }],
    ['a non-toon format', { format: 'json', data: 'x', listProperty: 'data' }],
    ['a toon body with no listProperty', { format: 'toon', data: 'x' }],
    ['a toon body whose data is not a string', { format: 'toon', data: [], listProperty: 'data' }],
    ['null', null],
    ['a string', 'nope'],
  ])('passes %s through untouched', (_label, input) => {
    expect(unwrapToonEnvelope(input)).toEqual(input)
  })
})
