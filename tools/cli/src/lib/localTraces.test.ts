import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLocalTraces, findLocalTraceById, LOCAL_VERDICTS } from './localTraces.js'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A minimal, valid ExecutionTrace-shaped JSONL line (snake_case, matching the proxy's wire format). */
function traceLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    trace_id: 'tr_default',
    created_at: '2026-08-30T12:00:00.000Z',
    requested_model: 'claude-3-5-sonnet',
    actual_model_routed: 'claude-3-5-sonnet',
    verdict: 'allowed',
    raw_cost_usd: 0.01,
    actual_cost_usd: 0.01,
    harness_type: 'claude-code',
    latency_ms: 500,
    cache_hit: false,
    break_glass: false,
    ...overrides,
  })
}

function writeDayFile(logsDir: string, date: string, lines: string[]): void {
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(join(logsDir, `traces-${date}.jsonl`), lines.join('\n') + '\n', 'utf-8')
}

describe('readLocalTraces', () => {
  it('maps every ExecutionTrace field the reader uses, from a fixture JSONL line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-30', [
      traceLine({
        trace_id: 'tr_abc123',
        requested_model: 'gpt-4o',
        actual_model_routed: 'claude-3-5-sonnet',
        verdict: 'hijacked',
        raw_cost_usd: 0.05,
        actual_cost_usd: 0.02,
        harness_type: 'cursor',
        latency_ms: 1234,
        cache_hit: true,
        break_glass: true,
      }),
    ])

    const result = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 20 })

    expect(result.traces).toHaveLength(1)
    expect(result.traces[0]).toEqual({
      traceId: 'tr_abc123',
      timestamp: '2026-08-30T12:00:00.000Z',
      requestedModel: 'gpt-4o',
      actualModelRouted: 'claude-3-5-sonnet',
      verdict: 'hijacked',
      rawCostUsd: 0.05,
      actualCostUsd: 0.02,
      harnessType: 'cursor',
      latencyMs: 1234,
      cacheHit: true,
      breakGlass: true,
    })
    expect(result.total).toBe(1)
    expect(result.malformedLines).toBe(0)
  })

  it('walks day-files backwards for --since, spanning two files newest-first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-29', [
      traceLine({ trace_id: 'tr_yesterday', created_at: '2026-08-29T10:00:00.000Z' }),
    ])
    writeDayFile(dir, '2026-08-30', [
      traceLine({ trace_id: 'tr_today', created_at: '2026-08-30T10:00:00.000Z' }),
    ])

    const result = await readLocalTraces({
      logsDir: dir,
      since: new Date('2026-08-28T00:00:00.000Z'),
      limit: 20,
    })

    expect(result.traces.map((t) => t.traceId)).toEqual(['tr_today', 'tr_yesterday'])
  })

  it('stops before a trace older than --since, and does not read earlier files at all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-01', [
      // If this file were ever opened, this line would be counted — it must not be.
      traceLine({ trace_id: 'tr_way_too_old' }),
    ])
    writeDayFile(dir, '2026-08-30', [
      traceLine({ trace_id: 'tr_old', created_at: '2026-08-30T01:00:00.000Z' }),
      traceLine({ trace_id: 'tr_new', created_at: '2026-08-30T23:00:00.000Z' }),
    ])

    const result = await readLocalTraces({
      logsDir: dir,
      since: new Date('2026-08-30T12:00:00.000Z'),
      limit: 20,
    })

    expect(result.traces.map((t) => t.traceId)).toEqual(['tr_new'])
  })

  it('counts malformed lines rather than silencing or crashing on them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-30', [
      'not json at all',
      JSON.stringify({ trace_id: 'tr_missing_fields' }), // missing required fields
      traceLine({ trace_id: 'tr_good' }),
    ])

    const result = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 20 })

    expect(result.traces.map((t) => t.traceId)).toEqual(['tr_good'])
    expect(result.malformedLines).toBe(2)
  })

  it('respects limit while total counts everything in the window', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(
      dir,
      '2026-08-30',
      Array.from({ length: 5 }, (_, i) => traceLine({ trace_id: `tr_${i}`, created_at: `2026-08-30T0${i}:00:00.000Z` })),
    )

    const result = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 2 })

    expect(result.traces).toHaveLength(2)
    expect(result.total).toBe(5)
  })

  it('filters by verdict and model before the limit is applied', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-30', [
      traceLine({ trace_id: 'tr_a', verdict: 'allowed', requested_model: 'gpt-4o' }),
      traceLine({ trace_id: 'tr_b', verdict: 'killed', requested_model: 'gpt-4o' }),
      traceLine({ trace_id: 'tr_c', verdict: 'allowed', requested_model: 'claude-3-5-sonnet' }),
    ])

    const byVerdict = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 20, verdict: 'killed' })
    expect(byVerdict.traces.map((t) => t.traceId)).toEqual(['tr_b'])

    const byModel = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 20, model: 'claude-3-5-sonnet' })
    expect(byModel.traces.map((t) => t.traceId)).toEqual(['tr_c'])
  })

  it('discloses when a day-file has reached the 64MB write cap', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'traces-2026-08-30.jsonl')
    // Cheaper than actually writing 64MB: truncate to the cap size directly,
    // then append one real, parseable line so the reader still finds a trace.
    writeFileSync(path, Buffer.alloc(64 * 1024 * 1024))
    writeFileSync(path, traceLine({ trace_id: 'tr_capped' }) + '\n', { flag: 'a' })

    const result = await readLocalTraces({ logsDir: dir, since: new Date('2026-01-01'), limit: 20 })

    expect(result.cappedFiles).toEqual(['traces-2026-08-30.jsonl'])
  })

  it('returns an empty result for a logs directory that does not exist', async () => {
    const result = await readLocalTraces({
      logsDir: join(tmpdir(), 'intutic-traces-does-not-exist'),
      since: new Date('2026-01-01'),
      limit: 20,
    })
    expect(result).toEqual({ traces: [], total: 0, malformedLines: 0, cappedFiles: [] })
  })
})

describe('findLocalTraceById', () => {
  it('finds a trace by id and returns the raw record', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-30', [traceLine({ trace_id: 'tr_findme', requested_model: 'gpt-4o' })])

    const found = await findLocalTraceById(dir, 'tr_findme')

    expect(found?.trace_id).toBe('tr_findme')
    expect(found?.requested_model).toBe('gpt-4o')
  })

  it('returns null when no day-file has a matching trace_id', async () => {
    dir = mkdtempSync(join(tmpdir(), 'intutic-traces-'))
    writeDayFile(dir, '2026-08-30', [traceLine({ trace_id: 'tr_other' })])

    expect(await findLocalTraceById(dir, 'tr_missing')).toBeNull()
  })
})

describe('LOCAL_VERDICTS', () => {
  it('is the complete, real local verdict vocabulary', () => {
    // Pinned here rather than only in the field-parity test so a change to
    // this list is visible in this file's own diff, not just the parity
    // test's.
    expect([...LOCAL_VERDICTS].sort()).toEqual(
      ['allowed', 'hijacked', 'killed', 'reasked', 'upstream_error'].sort(),
    )
  })
})
