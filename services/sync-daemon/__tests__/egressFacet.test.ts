import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchEgressStatus } from '../src/agentReporter.js'

afterEach(() => vi.restoreAllMocks())

describe('fetchEgressStatus — plumbing egress counters off the proxy', () => {
  it('returns the proxy egress status when reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: 'enforce', denied: 3, would_deny: 0 }),
    })) as unknown as typeof fetch)
    expect(await fetchEgressStatus()).toEqual({ mode: 'enforce', denied: 3, would_deny: 0 })
  })

  it('coerces missing counters to 0 but keeps the mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ mode: 'monitor' }),
    })) as unknown as typeof fetch)
    expect(await fetchEgressStatus()).toEqual({ mode: 'monitor', denied: 0, would_deny: 0 })
  })

  it('returns null (facet omitted) when the proxy is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await fetchEgressStatus()).toBeNull()
  })

  it('returns null on a non-OK response or unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch)
    expect(await fetchEgressStatus()).toBeNull()
  })
})
