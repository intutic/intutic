/**
 * `fetchLocalProxyInstanceId` — the daemon's read of the local proxy's
 * process-lifetime id (`GET /intutic/instance`, TD-231 Wave 5.6). The id is
 * what lets the daemon register the proxy's OWN session row with git/task
 * context; every refusal below is a case where doing so would be wrong, so
 * each must come back `null` (→ the `ses_` fallback), never a value.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchLocalProxyInstanceId } from '../src/agentReporter.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.INTUTIC_PROXY_URL
})

function answer(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch)
}

describe('fetchLocalProxyInstanceId', () => {
  it('returns the id of a local per-developer proxy', async () => {
    answer({ proxy_instance_id: 'proxy_0b6a2c9e-1d4f-4a6b-9c1e-7f2d3a4b5c6d', shared_gateway: false })
    expect(await fetchLocalProxyInstanceId()).toBe('proxy_0b6a2c9e-1d4f-4a6b-9c1e-7f2d3a4b5c6d')
  })

  it('reads the proxy at INTUTIC_PROXY_URL, trailing slash tolerated, on the instance path', async () => {
    process.env.INTUTIC_PROXY_URL = 'http://127.0.0.1:4123/'
    answer({ proxy_instance_id: 'proxy_x', shared_gateway: false })
    await fetchLocalProxyInstanceId()
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('http://127.0.0.1:4123/intutic/instance')
  })

  it('refuses a shared gateway by its gw_ prefix — its row aggregates every developer behind it', async () => {
    answer({ proxy_instance_id: 'gw_0b6a2c9e-1d4f-4a6b-9c1e-7f2d3a4b5c6d', shared_gateway: true })
    expect(await fetchLocalProxyInstanceId()).toBeNull()
  })

  it('refuses when the flag says gateway even if the prefix does not (either field alone must be enough)', async () => {
    answer({ proxy_instance_id: 'proxy_looks-local', shared_gateway: true })
    expect(await fetchLocalProxyInstanceId()).toBeNull()
  })

  it('refuses an id with neither prefix, and a malformed body', async () => {
    answer({ proxy_instance_id: 'something_else', shared_gateway: false })
    expect(await fetchLocalProxyInstanceId()).toBeNull()
    answer({ shared_gateway: false })
    expect(await fetchLocalProxyInstanceId()).toBeNull()
    answer({ proxy_instance_id: 42 })
    expect(await fetchLocalProxyInstanceId()).toBeNull()
  })

  it('returns null on a non-OK answer (403 from a non-loopback bind) and when the proxy is unreachable', async () => {
    answer({ error: 'loopback only' }, false)
    expect(await fetchLocalProxyInstanceId()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await fetchLocalProxyInstanceId()).toBeNull()
  })
})
