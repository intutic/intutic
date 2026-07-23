/**
 * Policy Cache — LRU in-memory + Valkey write-through
 *
 * Resolves PCAS permissions + active SOP rules for MCP daemon.
 * Cache hit: < 0.1ms (LRU). Valkey hit: < 2ms. Miss: HTTP to control-plane.
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 * @module
 */
import https from 'node:https'
import http from 'node:http'
import { Redis } from 'ioredis'
import { createLogger } from '@intutic/logger'

const logger = createLogger('mcp-proxy.policyCache')

const getPolicyTtlMs = () => parseInt(process.env['MCP_DAEMON_POLICY_TTL_MS'] ?? '300000', 10)
const getMaxEntries = () => parseInt(process.env['MCP_DAEMON_MAX_CACHE_ENTRIES'] ?? '500',    10)
const getCpUrl = () => process.env['CONTROL_PLANE_URL'] ?? 'http://localhost:3001'
const getDaemonApiKey = () => process.env['INTUTIC_API_KEY']   ?? ''

const VALKEY_URL = process.env['VALKEY_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const valkey = new Redis(VALKEY_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
})

valkey.on('error', (err: any) => {
  logger.warn({ err: err.message }, 'policyCache Valkey connection error')
})

export interface ResolvedPolicy {
  workspaceId:   string
  sopRules:      Record<string, unknown>[]
  dlpPatterns:   string[]
  interventionMode: string
  cachedAt:      number
}

// Simple LRU map (insertion-order eviction)
const lru = new Map<string, ResolvedPolicy>()

function evictIfFull(): void {
  if (lru.size >= getMaxEntries()) {
    const firstKey = lru.keys().next().value as string
    lru.delete(firstKey)
  }
}

function isStale(entry: ResolvedPolicy): boolean {
  return Date.now() - entry.cachedAt > getPolicyTtlMs()
}

async function fetchFromControlPlane(workspaceId: string): Promise<ResolvedPolicy | null> {
  return new Promise((resolve) => {
    const path = `/api/v1/policy/resolve?workspaceId=${encodeURIComponent(workspaceId)}`
    const url  = new URL(path, getCpUrl())
    const lib  = url.protocol === 'https:' ? https : http
    const req  = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET',
        headers: { 'Authorization': `Bearer ${getDaemonApiKey()}`, 'Accept': 'application/json' } },
      (res: any) => {
        let data = ''
        res.on('data', (c: string) => { data += c })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Partial<ResolvedPolicy>
            resolve({ workspaceId, sopRules: parsed.sopRules ?? [], dlpPatterns: parsed.dlpPatterns ?? [],
              interventionMode: parsed.interventionMode ?? 'BYPASS', cachedAt: Date.now() })
          } catch { resolve(null) }
        })
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(5000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/**
 * Resolves policy for a workspace.
 * Order: LRU (fresh) → LRU (stale, triggers async refresh) → Valkey → HTTP fetch
 */
export async function resolvePolicy(workspaceId: string): Promise<ResolvedPolicy | null> {
  const cached = lru.get(workspaceId)

  if (cached && !isStale(cached)) {
    // Touch for LRU recency
    lru.delete(workspaceId)
    lru.set(workspaceId, cached)
    return cached
  }

  if (cached && isStale(cached)) {
    // Return stale, trigger async refresh
    void fetchFromControlPlane(workspaceId).then(async (fresh) => {
      if (fresh) {
        lru.delete(workspaceId)
        evictIfFull()
        lru.set(workspaceId, fresh)
        try {
          await valkey.set(`mcp_daemon:policy:${workspaceId}`, JSON.stringify(fresh), 'PX', getPolicyTtlMs())
        } catch {}
      }
    })
    return cached
  }

  // Cache miss in LRU — check Valkey
  try {
    const valkeyCached = await valkey.get(`mcp_daemon:policy:${workspaceId}`)
    if (valkeyCached) {
      const parsed = JSON.parse(valkeyCached) as ResolvedPolicy
      evictIfFull()
      lru.set(workspaceId, parsed)
      return parsed
    }
  } catch {}

  // Cache miss in Valkey too — fetch synchronously
  logger.debug({ workspaceId }, 'policy_cache.miss')
  const fresh = await fetchFromControlPlane(workspaceId)
  if (fresh) {
    evictIfFull()
    lru.set(workspaceId, fresh)
    try {
      await valkey.set(`mcp_daemon:policy:${workspaceId}`, JSON.stringify(fresh), 'PX', getPolicyTtlMs())
    } catch {}
  }
  return fresh
}

/** Invalidates policy cache for a workspace (called on SOP update). */
export function invalidatePolicy(workspaceId: string): void {
  lru.delete(workspaceId)
  valkey.del(`mcp_daemon:policy:${workspaceId}`, `mcp_daemon:sop_rules:${workspaceId}`).catch(() => {})
  logger.info({ workspaceId }, 'policy_cache.invalidated')
}

/** Returns cache statistics. */
export function getCacheStats(): { entries: number; hitRate: number } {
  return { entries: lru.size, hitRate: 0 } // hit rate tracked by metrics in production
}
