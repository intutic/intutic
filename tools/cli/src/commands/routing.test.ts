/**
 * `intutic routing adoption-report` — hits the right route with the right
 * query param, refuses a missing `--candidate-model` before sending
 * anything, and never renders a null delta as "0" or "$0.00".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runRoutingAdoptionReport } from './routing.js'

describe('intutic routing adoption-report', () => {
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

  it('refuses a missing --candidate-model before sending any request', async () => {
    await expect(runRoutingAdoptionReport({})).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('refuses a blank --candidate-model', async () => {
    await expect(runRoutingAdoptionReport({ candidateModel: '   ' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hits GET /api/v1/routing/mirror-adoption-report with the trimmed, url-encoded candidate model', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidateModel: 'gpt-4o-mini',
        sufficientData: false,
        sampleCount: 0,
        minimumRequired: 20,
        reason: '0 verdict(s) recorded; 20 required before a win/loss ratio means anything',
      }),
    })

    await runRoutingAdoptionReport({ candidateModel: '  gpt-4o-mini  ' })

    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/v1/routing/mirror-adoption-report')
    expect(parsed.searchParams.get('candidateModel')).toBe('gpt-4o-mini')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')
  })

  it('renders the insufficient-data state distinctly, never as a report with invented zeroes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidateModel: 'gpt-4o-mini',
        sufficientData: false,
        sampleCount: 3,
        minimumRequired: 20,
        reason: '3 verdict(s) recorded; 20 required before a win/loss ratio means anything',
      }),
    })

    await runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })

    const out = printed()
    expect(out).toMatch(/Insufficient data/)
    expect(out).toContain('3 of 20 required')
    expect(out).toContain('3 verdict(s) recorded; 20 required before a win/loss ratio means anything')
    // No win/loss/tie fields for an insufficient-data response.
    expect(out).not.toMatch(/Candidate better/i)
    expect(out).not.toMatch(/Fault-rate delta/i)
  })

  it('renders win/loss/tie/unjudged and a fault-rate delta for a sufficiently-sampled candidate', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidateModel: 'gpt-4o-mini',
        sufficientData: true,
        sampleCount: 25,
        candidateBetter: 15,
        originalBetter: 5,
        tie: 3,
        unjudged: 2,
        faultRateDelta: -0.1,
        averageCostDeltaUsd: null,
        averageLatencyDeltaMs: null,
      }),
    })

    await runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })

    const out = printed()
    expect(out).toContain('15')
    expect(out).toContain('5')
    expect(out).toContain('3')
    expect(out).toContain('2')
    expect(out).toMatch(/-10\.0 pts \(candidate faults less\)/)
  })

  it('renders a null fault-rate/cost/latency delta as an explicit "not measured" phrase, never "0" or "$0.00"', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidateModel: 'gpt-4o-mini',
        sufficientData: true,
        sampleCount: 25,
        candidateBetter: 10,
        originalBetter: 10,
        tie: 5,
        unjudged: 0,
        faultRateDelta: null,
        averageCostDeltaUsd: null,
        averageLatencyDeltaMs: null,
      }),
    })

    await runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })

    const out = printed()
    expect(out).toContain('not enough scored pairs')
    expect(out).toMatch(/not measured.*served-side cost/)
    expect(out).toMatch(/not measured.*served-side latency/)
    expect(out).not.toMatch(/\$0\.00/)
    expect(out).not.toMatch(/\+0\.0000 USD/)
  })

  it('renders a real, non-null cost and latency delta when both sides are populated', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidateModel: 'gpt-4o-mini',
        sufficientData: true,
        sampleCount: 25,
        candidateBetter: 10,
        originalBetter: 10,
        tie: 5,
        unjudged: 0,
        faultRateDelta: 0,
        averageCostDeltaUsd: -0.0025,
        averageLatencyDeltaMs: 120,
      }),
    })

    await runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })

    const out = printed()
    expect(out).toMatch(/-0\.0025 USD\/request/)
    expect(out).toMatch(/\+120 ms/)
  })

  it('--json prints the raw response verbatim instead of the formatted report', async () => {
    const body = {
      candidateModel: 'gpt-4o-mini',
      sufficientData: false,
      sampleCount: 0,
      minimumRequired: 20,
      reason: 'no data yet',
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => body })

    await runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini', json: true })

    expect(JSON.parse(printed())).toEqual(body)
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal error' })

    await expect(runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })

  it('reports not-authenticated and exits without making a request when no credentials are stored', async () => {
    const store = await import('../config/store.js')
    vi.mocked(store.loadCredentials).mockResolvedValueOnce(null as never)

    await expect(runRoutingAdoptionReport({ candidateModel: 'gpt-4o-mini' })).rejects.toThrow(
      'process.exit(1)',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('open core does not include'))
  })
})
