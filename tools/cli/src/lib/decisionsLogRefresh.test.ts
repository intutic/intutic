/**
 * `refreshDecisionsLog` — the CLI-side, one-shot trigger the optional
 * post-merge hook invokes. The property this file exists to prove: opt-in
 * gating. `WorkspaceSettings.decisionsLogEnabled = false` (or absent —
 * indistinguishable once `resolveWorkspaceSettings` fills in the default) →
 * neither `.intutic/DECISIONS.md` nor the bounded CLAUDE.md section is
 * written or touched. Never throws either way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({
    apiKey: 'vk_test_key',
    workspaceId: 'ws_test',
    controlPlaneUrl: 'https://api.test.invalid',
    email: 'dev@example.com',
    storedAt: '2026-08-17T00:00:00.000Z',
  })),
}))

const refreshDecisionsDigestMock = vi.fn()
vi.mock('@intutic/sync-daemon', () => ({
  refreshDecisionsDigest: (...args: unknown[]) => refreshDecisionsDigestMock(...args),
}))

import { refreshDecisionsLog } from './decisionsLogRefresh.js'
import { loadCredentials } from '../config/store.js'

describe('refreshDecisionsLog', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    refreshDecisionsDigestMock.mockReset()
    vi.mocked(loadCredentials).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('not authenticated → no-op, no network call, no write attempt', async () => {
    vi.mocked(loadCredentials).mockResolvedValueOnce(null)
    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result).toEqual({ refreshed: false, reason: 'not authenticated' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(refreshDecisionsDigestMock).not.toHaveBeenCalled()
  })

  it('decisionsLogEnabled: false → no-op, no write attempt (opt-in gating)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { decisionsLogEnabled: false } }),
    })
    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result).toEqual({ refreshed: false, reason: 'decisionsLogEnabled is off' })
    expect(refreshDecisionsDigestMock).not.toHaveBeenCalled()
  })

  it('decisionsLogEnabled absent from settings (default) → no-op, no write attempt', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: {} }),
    })
    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result).toEqual({ refreshed: false, reason: 'decisionsLogEnabled is off' })
    expect(refreshDecisionsDigestMock).not.toHaveBeenCalled()
  })

  it('decisionsLogEnabled: true → delegates to refreshDecisionsDigest', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { decisionsLogEnabled: true } }),
    })
    refreshDecisionsDigestMock.mockResolvedValueOnce({ entriesWritten: 3 })

    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result).toEqual({ refreshed: true })
    expect(refreshDecisionsDigestMock).toHaveBeenCalledTimes(1)
    const call = refreshDecisionsDigestMock.mock.calls[0][0]
    expect(call.workspaceId).toBe('ws_test')
    expect(call.workspaceRoot).toBe('/tmp/some-workspace')
  })

  it('a settings-fetch failure is caught, not thrown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result.refreshed).toBe(false)
    expect(result.reason).toContain('ECONNREFUSED')
    expect(refreshDecisionsDigestMock).not.toHaveBeenCalled()
  })
})
