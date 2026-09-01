import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchGuardProbes } from '../src/agentReporter.js'

afterEach(() => vi.restoreAllMocks())

describe('fetchGuardProbes — plumbing guard-liveness probe results off the proxy', () => {
  it('returns the summary, capping failing probe ids at 10', async () => {
    const probes = Array.from({ length: 12 }, (_, i) => ({
      probe_id: `probe-${i}`,
      passed: i < 3, // 9 failing
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ probes, total: 12, failed: 9, ran_at: 1700000000 }),
    })) as unknown as typeof fetch)
    const result = await fetchGuardProbes()
    expect(result).toEqual({
      total: 12,
      failed: 9,
      ranAt: 1700000000,
      failing: Array.from({ length: 9 }, (_, i) => `probe-${i + 3}`),
    })
  })

  it('caps failing at 10 even when more than 10 probes failed', async () => {
    const probes = Array.from({ length: 20 }, (_, i) => ({ probe_id: `probe-${i}`, passed: false }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ probes, total: 20, failed: 20, ran_at: 1700000000 }),
    })) as unknown as typeof fetch)
    const result = await fetchGuardProbes()
    expect(result?.failing).toHaveLength(10)
  })

  it('returns null (facet omitted) when the proxy is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    expect(await fetchGuardProbes()).toBeNull()
  })

  it('returns null on a non-OK response (e.g. 503 — suite has not run yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch)
    expect(await fetchGuardProbes()).toBeNull()
  })

  it('returns null on an unparseable body missing the required numeric fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ probes: [] }),
    })) as unknown as typeof fetch)
    expect(await fetchGuardProbes()).toBeNull()
  })
})
