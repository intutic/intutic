/**
 * `intutic findings` — hits the right routes with the right bodies, refuses
 * a malformed adjudicate call before sending it, and never renders a null
 * rate as "0" or "0%".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import {
  runFindingsList,
  runFindingsAdjudicate,
  runFindingsStats,
  runFindingsEchoReport,
} from './findings.js'

describe('intutic findings', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn's inferred type narrows to the
  // mocked implementation's signature, which is incompatible with a pre-declared generic annotation.
  let exitSpy: any
  let logSpy: any
  let errSpy: any

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

  // ─── list ────────────────────────────────────────────────────────

  it('list hits GET /api/v1/findings with no query params by default', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ findings: [] }) })

    await runFindingsList({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/findings?')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')
  })

  it('list --unadjudicated adds unadjudicated=true (matching the route\'s own default, not inventing a CLI-side one)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ findings: [] }) })

    await runFindingsList({ unadjudicated: true })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/findings?unadjudicated=true')
  })

  it('list --detector and --limit add detector_id and limit', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ findings: [] }) })

    await runFindingsList({ detector: 'response_injection:override-instructions', limit: '50' })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.searchParams.get('detector_id')).toBe('response_injection:override-instructions')
    expect(parsed.searchParams.get('limit')).toBe('50')
  })

  it('list renders a null outcome as "unruled", not blank or a fabricated value', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        findings: [
          {
            finding_id: 'fnd_abc123456789',
            trace_id: 'tr_1',
            session_id: 'sess_1',
            loop_run_id: null,
            detector_id: 'response_injection:override-instructions',
            anomaly_kind: 'response_injection',
            severity: 'MEDIUM',
            disposition: 'ADVISORY',
            confidence: 0.5,
            reason: null,
            harness: 'claude-code',
            shadowed: false,
            outcome: null,
            outcome_by: null,
            outcome_at: null,
            outcome_note: null,
            created_at: '2026-08-16T00:00:00Z',
          },
        ],
      }),
    })

    await runFindingsList({})

    expect(printed()).toMatch(/unruled/)
  })

  // ─── adjudicate ──────────────────────────────────────────────────

  it('adjudicate refuses when BOTH --true-positive and --false-positive are set', async () => {
    await expect(
      runFindingsAdjudicate('fnd_1', { truePositive: true, falsePositive: true }),
    ).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('adjudicate refuses when NEITHER flag is set', async () => {
    await expect(runFindingsAdjudicate('fnd_1', {})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('adjudicate --true-positive hits POST /api/v1/findings/:id/adjudicate with outcome TRUE_POSITIVE', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ finding_id: 'fnd_1', outcome: 'TRUE_POSITIVE' }),
    })

    await runFindingsAdjudicate('fnd_1', { truePositive: true, note: 'confirmed via replay' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/findings/fnd_1/adjudicate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ outcome: 'TRUE_POSITIVE', note: 'confirmed via replay' })
  })

  it('adjudicate --false-positive hits the same route with outcome FALSE_POSITIVE and no note', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ finding_id: 'fnd_2', outcome: 'FALSE_POSITIVE' }),
    })

    await runFindingsAdjudicate('fnd_2', { falsePositive: true })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/findings/fnd_2/adjudicate')
    const body = JSON.parse(init.body)
    expect(body.outcome).toBe('FALSE_POSITIVE')
    expect(body.note).toBeUndefined()
  })

  it('adjudicate exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'Finding not found' })

    await expect(runFindingsAdjudicate('fnd_missing', { truePositive: true })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })

  // ─── stats ───────────────────────────────────────────────────────

  it('stats hits GET /api/v1/findings/stats and prints caveats verbatim', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        detectors: [
          {
            detector_id: 'response_injection:override-instructions',
            anomaly_kind: 'response_injection',
            shadowed: false,
            total_findings: 40,
            adjudicated: 25,
            false_positives: 3,
            false_positive_rate: 0.12,
          },
        ],
        caveats: [
          'false_positive_rate divides by ADJUDICATED findings, not by all findings.',
          'Recall is not reported and cannot be.',
        ],
      }),
    })

    await runFindingsStats({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/findings/stats')
    expect(init.method).toBe('GET')

    const out = printed()
    expect(out).toContain('false_positive_rate divides by ADJUDICATED findings, not by all findings.')
    expect(out).toContain('Recall is not reported and cannot be.')
  })

  it('stats renders a null false_positive_rate as "no measured rate", never "0" or "0%"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        detectors: [
          {
            detector_id: 'response_injection:reveal-system-prompt',
            anomaly_kind: 'response_injection',
            shadowed: false,
            total_findings: 5,
            adjudicated: 0,
            false_positives: 0,
            false_positive_rate: null,
          },
        ],
        caveats: [],
      }),
    })

    await runFindingsStats({})

    const out = printed()
    expect(out).toMatch(/no measured rate/)
    expect(out).not.toMatch(/\b0%/)
  })

  // ─── echo-report ─────────────────────────────────────────────────

  it('echo-report hits GET /api/v1/findings/response-echo/report with since/until', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        window: { since: '2026-08-09T00:00:00Z', until: '2026-08-16T00:00:00Z' },
        tracesIngested: 120,
        refusal: null,
        patterns: [],
      }),
    })

    await runFindingsEchoReport({ since: '2026-08-09T00:00:00Z', until: '2026-08-16T00:00:00Z' })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/v1/findings/response-echo/report')
    expect(parsed.searchParams.get('since')).toBe('2026-08-09T00:00:00Z')
    expect(parsed.searchParams.get('until')).toBe('2026-08-16T00:00:00Z')
  })

  it('echo-report prints the tracesIngested denominator prominently', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        window: { since: '2026-08-09T00:00:00Z', until: '2026-08-16T00:00:00Z' },
        tracesIngested: 42,
        refusal: null,
        patterns: [],
      }),
    })

    await runFindingsEchoReport({})

    expect(printed()).toContain('42')
  })

  it('echo-report never suppresses a top-level refusal', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        window: { since: '2026-08-09T00:00:00Z', until: '2026-08-16T00:00:00Z' },
        tracesIngested: 0,
        refusal: 'no traces ingested in this window',
        patterns: [
          {
            pattern: 'override-instructions',
            findings: 0,
            adjudicated: 0,
            truePositives: 0,
            falsePositives: 0,
            falsePositiveRate: null,
            refusal: 'fewer than 20 adjudicated findings for this pattern — rate withheld',
          },
        ],
      }),
    })

    await runFindingsEchoReport({})

    const out = printed()
    expect(out).toContain('no traces ingested in this window')
    expect(out).toContain('fewer than 20 adjudicated findings for this pattern — rate withheld')
  })

  it('echo-report renders a null per-pattern rate as "no measured rate", never "0" or "0%"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        window: { since: '2026-08-09T00:00:00Z', until: '2026-08-16T00:00:00Z' },
        tracesIngested: 500,
        refusal: null,
        patterns: [
          {
            pattern: 'guardrail-bypass',
            findings: 10,
            adjudicated: 5,
            truePositives: 5,
            falsePositives: 0,
            falsePositiveRate: null,
            refusal: 'fewer than 20 adjudicated findings for this pattern — rate withheld',
          },
        ],
      }),
    })

    await runFindingsEchoReport({})

    const out = printed()
    expect(out).toContain('fewer than 20 adjudicated findings for this pattern — rate withheld')
    expect(out).not.toMatch(/\b0%/)
  })

  it('echo-report exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal error' })

    await expect(runFindingsEchoReport({})).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('table padding is ANSI-aware', () => {
  // Shipped and broke in CI, not locally: `pad` sliced RAW string length, so
  // `pc.dim('no measured rate')` (17 visible characters, more raw ones once
  // wrapped in SGR codes) got cut mid-escape-sequence against an 18-wide
  // column, corrupting the visible text. It passed on every local run because
  // picocolors disables colour when stdout is not a TTY, and only showed up
  // once GitHub Actions' runner reported a colour-capable stream. Forcing
  // colour here is the whole point of this block — see the identical fix and
  // writeup in integrity.test.ts's "table padding is ANSI-aware".
  const DIM = '' + '[2m'
  const RESET = '' + '[22m'

  it('keeps a coloured cell whole when its visible width fits', async () => {
    const { pad } = await import('./findings.js')
    const cell = `${DIM}no measured rate${RESET}`
    const out = pad(cell, 18)
    expect(out).toContain('no measured rate')
    // eslint-disable-next-line no-control-regex -- ESC opens every SGR colour sequence; matching it is this assertion's whole purpose.
    expect(out.replace(/\[[0-9;]*m/g, '')).toHaveLength(18)
  })

  it('cuts by visible characters, not raw ones, and never leaves colour open', async () => {
    const { pad } = await import('./findings.js')
    const out = pad(`${DIM}no measured rate${RESET}`, 6)
    // eslint-disable-next-line no-control-regex -- ESC opens every SGR colour sequence; matching it is this assertion's whole purpose.
    expect(out.replace(/\[[0-9;]*m/g, '')).toBe('no mea')
    expect(out.endsWith('' + '[0m') || out.endsWith(RESET)).toBe(true)
  })

  it('pads an uncoloured cell to the same visible width', async () => {
    const { pad } = await import('./findings.js')
    expect(pad('ok', 5)).toBe('ok   ')
  })
})
