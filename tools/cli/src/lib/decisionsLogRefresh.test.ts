/**
 * `refreshDecisionsLog` — the CLI-side, one-shot trigger the optional
 * post-merge hook invokes. The property this file exists to prove: opt-in
 * gating. `WorkspaceSettings.decisionsLogEnabled = false` (or absent —
 * indistinguishable once `resolveWorkspaceSettings` fills in the default) →
 * neither `.intutic/DECISIONS.md` nor any harness's decisions section or
 * file is written or touched. Never throws either way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({
    apiKey: 'vk_test_key',
    workspaceId: 'ws_test',
    controlPlaneUrl: 'https://api.test.invalid',
    email: 'dev@example.com',
    storedAt: '2026-08-17T00:00:00.000Z',
  })),
  loadConfig: vi.fn(() => ({ harnesses: ['codex', 'cursor'] })),
}))

const refreshDecisionsDigestMock = vi.fn()
const retireClaudeMdDigestMock = vi.fn(async (_root: string) => undefined)
vi.mock('@intutic/sync-daemon', () => ({
  refreshDecisionsDigest: (...args: unknown[]) => refreshDecisionsDigestMock(...args),
  retireClaudeMdDigest: (root: string) => retireClaudeMdDigestMock(root),
}))

import { refreshDecisionsLog } from './decisionsLogRefresh.js'
import { loadCredentials } from '../config/store.js'

describe('refreshDecisionsLog', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const saved = { HOME: process.env.HOME, url: process.env.INTUTIC_CONTROL_PLANE_URL, dev: process.env.INTUTIC_DEV }
  let home: string

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    refreshDecisionsDigestMock.mockReset()
    vi.mocked(loadCredentials).mockClear()
    // The control plane resolves from the environment and ~/.intutic, so
    // neither the developer's own may leak in.
    home = mkdtempSync(join(tmpdir(), 'intutic-decisions-'))
    process.env.HOME = home
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://api.test.invalid'
    delete process.env.INTUTIC_DEV
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
    for (const [key, value] of [['HOME', saved.HOME], ['INTUTIC_CONTROL_PLANE_URL', saved.url], ['INTUTIC_DEV', saved.dev]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('uses INTUTIC_CONTROL_PLANE_URL over the URL saved with the login', async () => {
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.env.example'
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ settings: { decisionsLogEnabled: true } }) })
    refreshDecisionsDigestMock.mockResolvedValueOnce({ entriesWritten: 1 })

    await refreshDecisionsLog('/tmp/some-workspace')

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cp.env.example/api/v1/workspace/settings')
    expect(refreshDecisionsDigestMock.mock.calls[0][0].controlPlaneUrl).toBe('https://cp.env.example')
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
    // Every harness this machine governs, not Claude Code alone.
    expect(call.harnesses).toEqual(['codex', 'cursor'])
    expect(retireClaudeMdDigestMock).toHaveBeenCalledWith('/tmp/some-workspace')
  })

  it('a settings-fetch failure is caught, not thrown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await refreshDecisionsLog('/tmp/some-workspace')
    expect(result.refreshed).toBe(false)
    expect(result.reason).toContain('ECONNREFUSED')
    expect(refreshDecisionsDigestMock).not.toHaveBeenCalled()
  })
})
