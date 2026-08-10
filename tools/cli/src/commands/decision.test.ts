/**
 * `intutic decision approve|reject` — the real front door for a
 * `review_before` hold, hitting `POST /api/v1/decisions/:id/review`.
 *
 * Before this command existed, the only printed remediation was
 * `intutic loop review <holdId> --approve`, which posts to
 * `/api/v1/loops/:loopRunId/review` — a completely different id space. These
 * tests assert this command hits the RIGHT route with the right body, and
 * surfaces the response (including whether a bypass was written) rather than
 * swallowing it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runDecisionApprove, runDecisionReject } from './decision.js'

describe('runDecisionApprove / runDecisionReject', () => {
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

  it('approve hits POST /api/v1/decisions/:id/review with action=approve, not the loop route', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 'APPROVED', bypassWritten: false }),
    })

    await runDecisionApprove('dm_abc123', { reason: 'looks fine' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/decisions/dm_abc123/review')
    // Specifically NOT the Loop Run id-space route this replaces.
    expect(url).not.toContain('/api/v1/loops/')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ action: 'approve', reason: 'looks fine' })
    expect(init.headers.Authorization).toBe('Bearer vk_test_key')
  })

  it('reject hits the same route with action=reject', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 'REJECTED' }),
    })

    await runDecisionReject('dm_xyz789', {})

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/decisions/dm_xyz789/review')
    expect(JSON.parse(init.body)).toEqual({ action: 'reject', reason: undefined })
  })

  it('reports when approving also wrote a bypass', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: 'APPROVED', bypassWritten: true }),
    })

    await runDecisionApprove('dm_abc123', {})

    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toMatch(/bypass/i)
  })

  it('exits non-zero and reports the failure on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Decision not found',
    })

    await expect(runDecisionApprove('dm_missing', {})).rejects.toThrow('process.exit(1)')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errSpy).toHaveBeenCalled()
  })
})
