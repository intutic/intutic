import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'

/** Type-only view of the module under test; the value import is dynamic (see below). */
type PolicyCacheModule = typeof import('../../daemon/policyCache.js')

describe('policyCache Unit Tests', () => {
  let mockServer: http.Server
  let port: number
  let requestCount = 0
  let latestWorkspaceId: string | null = null

  let resolvePolicy: PolicyCacheModule['resolvePolicy']
  let invalidatePolicy: PolicyCacheModule['invalidatePolicy']
  let getCacheStats: PolicyCacheModule['getCacheStats']

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      requestCount++
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      latestWorkspaceId = url.searchParams.get('workspaceId')

      res.writeHead(200, { 'Content-Type': 'application/json' })

      // `ws_curation_test` gets a response WITH the three MCP curation
      // fields, to prove they parse through. Every other workspace gets the
      // exact shape `GET /api/v1/policy/resolve` served before the M1 fix —
      // the regression case: a workspace with no MCP curation configured (or
      // an older control plane that predates the field) must still get
      // well-typed empty defaults rather than `undefined` fields, so a
      // caller can compare against them without extra guards.
      const body: Record<string, unknown> = {
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
      }
      if (latestWorkspaceId === 'ws_curation_test') {
        body['allowedTools'] = ['read_file']
        body['toolDescriptionOverrides'] = { read_file: 'Reads a file' }
        body['allowedServers'] = ['filesystem']
      }
      res.end(JSON.stringify(body))
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
    const mod: PolicyCacheModule = await import('../../daemon/policyCache.js')
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
    expect(policy?.workspaceId).toBe(wsId)
    expect(policy?.sopRules).toHaveLength(1)
    // ResolvedPolicy.sopRules is Record<string, unknown>[], so rule fields are
    // reached by index and land as `unknown` — which toBe() compares fine.
    expect(policy?.sopRules[0]?.['id']).toBe('rule_1')
    expect(requestCount).toBe(1)
    expect(latestWorkspaceId).toBe(wsId)
    // M1 regression case: a response that omits the three MCP curation
    // fields must normalize to empty defaults, not `undefined` — a stale
    // control plane or cache entry must never read as "curation absent" one
    // layer up in packages/mcp-proxy/src/policy.ts's absorbCuration.
    expect(policy?.allowedTools).toEqual([])
    expect(policy?.toolDescriptionOverrides).toEqual({})
    expect(policy?.allowedServers).toEqual([])
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

  // Placed last, on its own workspaceId, so it does not perturb the exact
  // requestCount assertions the cache-hit/invalidation tests above depend on.
  it('parses MCP curation fields (allowedTools/toolDescriptionOverrides/allowedServers) when the control plane sends them', async () => {
    invalidatePolicy('ws_curation_test')
    const policy = await resolvePolicy('ws_curation_test')
    expect(policy).not.toBeNull()
    expect(policy?.allowedTools).toEqual(['read_file'])
    expect(policy?.toolDescriptionOverrides).toEqual({ read_file: 'Reads a file' })
    expect(policy?.allowedServers).toEqual(['filesystem'])
  })
})
