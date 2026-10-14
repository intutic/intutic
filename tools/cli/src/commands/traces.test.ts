/**
 * `intutic traces list` against a control plane sends the window the docs,
 * help and footer promise: 24h unless `--since` says otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
  getTracesLogDir: vi.fn(() => '/nonexistent'),
}))

import { runTracesList } from './traces.js'

describe('intutic traces list (connected)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ traces: [], total: 0 }) })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function sentSince(): number {
    const url = new URL(fetchMock.mock.calls[0][0] as string)
    const since = url.searchParams.get('since')
    expect(since).not.toBeNull()
    return Date.parse(since as string)
  }

  it('sends a 24h window when --since is not given', async () => {
    const before = Date.now()
    await runTracesList({})
    const since = sentSince()
    const day = 24 * 60 * 60 * 1000
    expect(since).toBeGreaterThanOrEqual(before - day - 1000)
    expect(since).toBeLessThanOrEqual(Date.now() - day + 1000)
  })

  it('sends the --since window when given', async () => {
    const before = Date.now()
    await runTracesList({ since: '7d' })
    const week = 7 * 24 * 60 * 60 * 1000
    expect(sentSince()).toBeGreaterThanOrEqual(before - week - 1000)
    expect(sentSince()).toBeLessThanOrEqual(Date.now() - week + 1000)
  })
})
