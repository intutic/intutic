/**
 * `reportDeviceState` — never throws, sends only the legs present in local
 * state, and reports why it didn't send when it can't.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

vi.mock('./enforcementState.js', () => ({
  readEnforcementState: vi.fn(),
}))

import { reportDeviceState } from './deviceReport.js'
import { loadCredentials } from '../config/store.js'
import { readEnforcementState } from './enforcementState.js'

const readEnforcementStateMock = vi.mocked(readEnforcementState)

describe('reportDeviceState', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    readEnforcementStateMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('not authenticated → reported: false, no network call', async () => {
    vi.mocked(loadCredentials).mockResolvedValueOnce(null)
    const result = await reportDeviceState()
    expect(result).toEqual({ reported: false, reason: 'not authenticated' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no local state yet → reported: false, no network call', async () => {
    readEnforcementStateMock.mockResolvedValueOnce(null)
    const result = await reportDeviceState()
    expect(result.reported).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only the legs present in local state', async () => {
    readEnforcementStateMock.mockResolvedValueOnce({
      fingerprint: 'fp1',
      hostname: 'laptop',
      platform: 'darwin',
      cliVersion: '1.7.0',
      firewall: { active: true, backend: 'pf', reportedAt: '2026-08-15T00:00:00.000Z' },
      // caTrust and systemHooks deliberately absent
    })
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ deviceId: 'dev_1', status: 'enforcing' }) })

    const result = await reportDeviceState()
    expect(result).toEqual({ reported: true })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test.invalid/api/v1/devices/report')
    const body = JSON.parse(init.body)
    expect(body.fingerprint).toBe('fp1')
    expect(body.firewall).toEqual({ active: true, backend: 'pf', detail: undefined })
    expect(body.caTrust).toBeUndefined()
    expect(body.systemHooks).toBeUndefined()
  })

  it('a network/API failure is caught, not thrown', async () => {
    readEnforcementStateMock.mockResolvedValueOnce({
      fingerprint: 'fp1',
      hostname: 'laptop',
      platform: 'darwin',
      cliVersion: '1.7.0',
    })
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await reportDeviceState()
    expect(result.reported).toBe(false)
    expect(result.reason).toContain('ECONNREFUSED')
  })
})
