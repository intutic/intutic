/**
 * `intutic loop review` must not report success it did not get: a response
 * with `ok: false` used to print nothing and exit 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import { runLoopReview } from './skill.js'

describe('runLoopReview', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the action and note to the loop review route', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 'ACTIVE' }) })

    await runLoopReview('lr_1', { approve: true, note: 'checked' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/loops/lr_1/review')
    expect(JSON.parse(init.body)).toEqual({ action: 'approve', note: 'checked' })
  })

  it('exits 1 when the control plane answers ok: false', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, status: 'ACTIVE' }) })

    await expect(runLoopReview('lr_1', { reject: true })).rejects.toThrow('process.exit(1)')
  })
})
