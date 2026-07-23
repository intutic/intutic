import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'

describe('policyCache Unit Tests', () => {
  let mockServer: http.Server
  let port: number
  let requestCount = 0
  let latestWorkspaceId: string | null = null

  let resolvePolicy: any
  let invalidatePolicy: any
  let getCacheStats: any

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      requestCount++
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      latestWorkspaceId = url.searchParams.get('workspaceId')

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          workspaceId: latestWorkspaceId,
          sopRules: [
            {
              id: 'rule_1',
              toolPattern: 'Bash',
              action: 'block',
              reason: 'No destructive commands allowed',
            },
          ],
          dlpPatterns: [],
          interventionMode: 'BLOCK',
        })
      )
    })

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as net.AddressInfo | null
        port = addr?.port ?? 3001
        process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${port}`
        resolve()
      })
    })

    // Import after process.env is set to ensure it uses the mock URL
    const mod = await import('../../daemon/policyCache.js')
    resolvePolicy = mod.resolvePolicy
    invalidatePolicy = mod.invalidatePolicy
    getCacheStats = mod.getCacheStats

    // Clean up any stale cache from prior runs in Valkey
    invalidatePolicy('ws_test_cache_miss')
    requestCount = 0
    latestWorkspaceId = null
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  it('fetches policy from control plane on cache miss', async () => {
    const wsId = 'ws_test_cache_miss'
    const policy = await resolvePolicy(wsId)
    expect(policy).not.toBeNull()
    expect(policy!.workspaceId).toBe(wsId)
    expect(policy!.sopRules).toHaveLength(1)
    expect(policy!.sopRules[0]!.id).toBe('rule_1')
    expect(requestCount).toBe(1)
    expect(latestWorkspaceId).toBe(wsId)
  })

  it('serves policy from memory on cache hit', async () => {
    const wsId = 'ws_test_cache_miss' // reuse the same wsId
    const policy = await resolvePolicy(wsId)
    expect(policy).not.toBeNull()
    expect(requestCount).toBe(1) // Request count remains 1 due to cache hit
  })

  it('invalidates policy correctly', async () => {
    const wsId = 'ws_test_cache_miss'
    invalidatePolicy(wsId)

    const policy = await resolvePolicy(wsId)
    expect(policy).not.toBeNull()
    expect(requestCount).toBe(2) // Request count increments to 2 on new fetch
  })

  it('tracks cache entries stats correctly', () => {
    const stats = getCacheStats()
    expect(stats.entries).toBeGreaterThanOrEqual(1)
  })
})
