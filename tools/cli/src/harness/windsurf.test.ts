/**
 * The Windsurf gate points Windsurf's HTTP proxy at the port the proxy runs
 * on, which `connect` and `start` take from INTUTIC_PROXY_URL. The shell's
 * `PORT` usually belongs to some other server and is not read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { writeWindsurfHooksMock } = vi.hoisted(() => ({ writeWindsurfHooksMock: vi.fn(async () => undefined) }))
vi.mock('@intutic/sync-daemon/harness/windsurfHooks', () => ({ writeWindsurfHooks: writeWindsurfHooksMock }))
vi.mock('../config/store.js', () => ({ loadCredentials: vi.fn(async () => ({ workspaceId: 'ws_test' })) }))

import { windsurfAdapter } from './windsurf.js'

describe('windsurfAdapter.installGate', () => {
  const saved = { proxy: process.env.INTUTIC_PROXY_URL, port: process.env.PORT }

  beforeEach(() => writeWindsurfHooksMock.mockClear())

  afterEach(() => {
    for (const [key, value] of [['INTUTIC_PROXY_URL', saved.proxy], ['PORT', saved.port]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('uses the port of INTUTIC_PROXY_URL, not PORT', async () => {
    process.env.INTUTIC_PROXY_URL = 'http://127.0.0.1:4123'
    process.env.PORT = '3000'
    await windsurfAdapter.installGate!('/tmp/ws', 'http://127.0.0.1:4123')
    expect(writeWindsurfHooksMock).toHaveBeenCalledWith('/tmp/ws', 'http://127.0.0.1:4123', 4123, 'ws_test')
  })

  it('defaults to 4000 with INTUTIC_PROXY_URL unset, whatever PORT says', async () => {
    delete process.env.INTUTIC_PROXY_URL
    process.env.PORT = '3000'
    await windsurfAdapter.installGate!('/tmp/ws', 'http://localhost:4000')
    expect(writeWindsurfHooksMock).toHaveBeenCalledWith('/tmp/ws', 'http://localhost:4000', 4000, 'ws_test')
  })
})
