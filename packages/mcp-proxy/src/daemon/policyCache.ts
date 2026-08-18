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

/**
 * Renders a connection error as one line. Not just `err.message`: Node's
 * dual-stack connect reports a refused Valkey as an AggregateError holding one
 * child error per address family, and an AggregateError's own `.message` is the
 * empty string — so the most common outage there is logged `"err":""` and told
 * an operator nothing. Message text only, so a credentialed VALKEY_URL cannot
 * reach the log through an error property bag.
 */
function describeConnectionError(err: Error): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('; ')
  }
  return err.message || err.name
}

valkey.on('error', (err: Error) => {
  logger.warn({ err: describeConnectionError(err) }, 'policyCache Valkey connection error')
})

export interface ResolvedPolicy {
  workspaceId:   string
  sopRules:      Record<string, unknown>[]
  dlpPatterns:   string[]
  interventionMode: string
  /**
   * Additive MCP tool allowlist; empty means unrestricted. Was silently
   * absent from `GET /api/v1/policy/resolve` (the daemon-mode source of this
   * type) until `lib/mcpCuration.ts` on the control plane started serving it
   * from the same place `GET /api/v1/sop/rules` (non-daemon mode) always
   * has. Always normalized to `[]` rather than left `undefined` here — a
   * stale Valkey/LRU entry or snapshot written before this field existed
   * must not read as "curation absent" one layer up.
   */
  allowedTools: string[]
  /** Operator-curated tool descriptions, applied to tools/list responses. */
  toolDescriptionOverrides: Record<string, string>
  /** Additive MCP server allowlist; empty means unrestricted. Same source
   *  and same backward-compat treatment as `allowedTools` above. */
  allowedServers: string[]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The policy fields the control plane sends, once they have been checked. */
type PolicyResponseBody = Pick<
  ResolvedPolicy,
  'sopRules' | 'dlpPatterns' | 'interventionMode' | 'allowedTools' | 'toolDescriptionOverrides' | 'allowedServers'
>

/**
 * Validates a `GET /api/v1/policy/resolve` body. The response is `unknown` at
 * this boundary — it crosses the network — so every field is checked rather
 * than asserted. Returns null when the body is not JSON or not an object;
 * individual fields fall back to their empty value.
 *
 * `allowedTools`/`toolDescriptionOverrides`/`allowedServers` default to
 * `[]`/`{}`/`[]` when absent — both because an older control plane may not
 * send them yet, and because absent is this policy's existing convention for
 * "unrestricted" (see `packages/mcp-proxy/src/policy.ts`'s `absorbCuration`).
 */
function parsePolicyResponse(raw: string): PolicyResponseBody | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const sopRules                  = parsed['sopRules']
  const dlpPatterns               = parsed['dlpPatterns']
  const interventionMode          = parsed['interventionMode']
  const allowedTools              = parsed['allowedTools']
  const toolDescriptionOverrides  = parsed['toolDescriptionOverrides']
  const allowedServers            = parsed['allowedServers']

  return {
    sopRules:    Array.isArray(sopRules) ? sopRules.filter(isRecord) : [],
    dlpPatterns: Array.isArray(dlpPatterns)
      ? dlpPatterns.filter((p): p is string => typeof p === 'string')
      : [],
    interventionMode: typeof interventionMode === 'string' ? interventionMode : 'BYPASS',
    allowedTools: Array.isArray(allowedTools)
      ? allowedTools.filter((t): t is string => typeof t === 'string')
      : [],
    toolDescriptionOverrides: isRecord(toolDescriptionOverrides)
      ? Object.fromEntries(
          Object.entries(toolDescriptionOverrides).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {},
    allowedServers: Array.isArray(allowedServers)
      ? allowedServers.filter((s): s is string => typeof s === 'string')
      : [],
  }
}

async function fetchFromControlPlane(workspaceId: string): Promise<ResolvedPolicy | null> {
  return new Promise((resolve) => {
    const path = `/api/v1/policy/resolve?workspaceId=${encodeURIComponent(workspaceId)}`
    const url  = new URL(path, getCpUrl())
    const lib  = url.protocol === 'https:' ? https : http
    const req  = lib.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET',
        headers: { 'Authorization': `Bearer ${getDaemonApiKey()}`, 'Accept': 'application/json' } },
      (res: http.IncomingMessage) => {
        // Without an encoding the stream yields Buffers, and `data += chunk`
        // then stringifies each one in isolation — a multi-byte UTF-8 character
        // split across a chunk boundary becomes U+FFFD and the JSON.parse below
        // fails. setEncoding makes the decoder span chunks, which is also what
        // makes the `chunk: string` annotation true rather than wishful.
        res.setEncoding('utf8')
        const statusCode = res.statusCode ?? 0
        let data = ''
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => {
          // An error body parses as JSON too. `{"error":"unauthorized"}` used to
          // become a policy with no sopRules and interventionMode BYPASS, which
          // resolvePolicy then cached for the full TTL and socketServer read as
          // `allowed: true` — an expired daemon key silently turned enforcement
          // off. A non-2xx is a failure to resolve, so it returns null, the same
          // as the transport failures below.
          if (statusCode < 200 || statusCode >= 300) {
            logger.warn({ workspaceId, statusCode }, 'policy_cache.fetch_http_error')
            resolve(null)
            return
          }
          const parsed = parsePolicyResponse(data)
          if (!parsed) {
            logger.warn({ workspaceId }, 'policy_cache.fetch_unparseable_body')
            resolve(null)
            return
          }
          resolve({
            workspaceId,
            sopRules:         parsed.sopRules,
            dlpPatterns:      parsed.dlpPatterns,
            interventionMode: parsed.interventionMode,
            allowedTools:     parsed.allowedTools,
            toolDescriptionOverrides: parsed.toolDescriptionOverrides,
            allowedServers:   parsed.allowedServers,
            cachedAt:         Date.now(),
          })
        })
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(5000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/**
 * Seeds the LRU from the policy snapshot the sync daemon writes locally.
 *
 * # What this removes
 *
 * `resolvePolicy`'s cold path is a blocking HTTP GET with a 5s socket timeout,
 * taken on the daemon's first request for a workspace after every restart. The
 * sync daemon already writes the same policy to
 * `~/.intutic/hooks/policy-snapshot.json` every cycle, so on the machine's own
 * workspace that round trip is avoidable.
 *
 * # Two things that make the obvious version wrong
 *
 * **It reads `sopRules`, not `rules`.** The snapshot carries both. `rules` is the
 * *gate* projection — patterns rewritten as space-padded EREs, `{source,
 * severity, subject}`, `warn` rules already dropped. Those pass this module's
 * `parsePolicyResponse` (it only checks that entries are objects) and are then
 * rejected wholesale by `isSopRule` in `../policy.ts`, which requires
 * `toolPattern` and `action`. The result would be a cache that reports entries,
 * logs nothing above `debug`, and enforces **nothing** — strictly worse than the
 * blocking fetch, and invisible.
 *
 * **`cachedAt` comes from the snapshot, not from now.** Stamping `Date.now()` on
 * a file written days ago (the sync daemon may be stopped — the snapshot writer
 * anticipates exactly that) would present stale policy as fresh and suppress the
 * refresh for a full TTL. Carrying the real write time means a stale snapshot
 * seeds the cache *and* is immediately recognised as stale, so the first request
 * returns instantly and triggers a background refresh — which is the actual goal.
 *
 * Never throws. This runs inside the daemon's `main()`, whose rejections become
 * `process.exit(1)`, and the daemon is a KeepAlive LaunchAgent — so a throw here
 * would be a restart loop rather than an error.
 *
 * @returns the workspaceId seeded, or null if nothing usable was found.
 */
export async function seedFromSnapshot(snapshotPath?: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const file =
      snapshotPath ??
      process.env['INTUTIC_POLICY_SNAPSHOT'] ??
      path.join(os.homedir(), '.intutic', 'hooks', 'policy-snapshot.json')

    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'))
    if (!isRecord(parsed)) return null

    const workspaceId = parsed['workspaceId']
    if (typeof workspaceId !== 'string' || !workspaceId) return null

    // Absent `sopRules` means an older snapshot that carries only the gate
    // projection. Seed nothing rather than seed an empty policy: an empty
    // policy is indistinguishable from "no rules configured" downstream, and
    // this path exists to avoid a slow answer, never to invent a wrong one.
    const raw = parsed['sopRules']
    if (!Array.isArray(raw)) {
      logger.debug({ file }, 'policy_cache.seed_skipped_no_sop_rules')
      return null
    }

    const generatedAt = parsed['generatedAt']
    const cachedAt =
      typeof generatedAt === 'string' && !Number.isNaN(Date.parse(generatedAt))
        ? Date.parse(generatedAt)
        : 0 // unknown age reads as maximally stale, never as fresh

    const entry: ResolvedPolicy = {
      workspaceId,
      sopRules: raw.filter(isRecord),
      dlpPatterns: [],
      interventionMode:
        typeof parsed['interventionMode'] === 'string' ? parsed['interventionMode'] : 'TRANSPARENT',
      // The sync daemon's snapshot (services/sync-daemon/src/lib/policySnapshot.ts)
      // does not carry MCP curation today — it predates this field and is a
      // separate `.rules`-gate mechanism, not this module's HTTP/Valkey path.
      // Default to unrestricted rather than invent a value; the background
      // HTTP refresh this seed exists to avoid delaying will fill these in on
      // the next cycle.
      allowedTools: [],
      toolDescriptionOverrides: {},
      allowedServers: [],
      cachedAt,
    }

    evictIfFull()
    lru.set(workspaceId, entry)
    logger.info(
      { workspaceId, ruleCount: entry.sopRules.length, ageMs: cachedAt ? Date.now() - cachedAt : null },
      'policy_cache.seeded_from_snapshot',
    )
    return workspaceId
  } catch {
    // No snapshot, unreadable, or malformed. The cold HTTP path still works;
    // this is an optimisation, and an optimisation must never be load-bearing.
    return null
  }
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
        } catch {
          // Valkey unreachable. This write only shares the refreshed policy
          // with sibling daemons; the in-process LRU above already holds it,
          // so resolution stays correct and the peers simply take an HTTP miss.
          // Deliberately not logged — this runs on a background refresh every
          // TTL per workspace and would flood the log while Valkey is down.
          // The connection-level 'error' handler above reports the outage once.
        }
      }
    })
    return cached
  }

  // Cache miss in LRU — check Valkey
  try {
    const valkeyCached = await valkey.get(`mcp_daemon:policy:${workspaceId}`)
    if (valkeyCached) {
      // Cast, not validated — this is our own prior write, not a network
      // boundary. But an entry written before this field existed is still a
      // valid prior write of an older shape, so the three curation fields
      // are normalized rather than trusted blindly off the cast.
      const raw = JSON.parse(valkeyCached) as Partial<ResolvedPolicy> &
        Pick<ResolvedPolicy, 'workspaceId' | 'sopRules' | 'dlpPatterns' | 'interventionMode' | 'cachedAt'>
      const parsed: ResolvedPolicy = {
        ...raw,
        allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
        toolDescriptionOverrides: isRecord(raw.toolDescriptionOverrides) ? raw.toolDescriptionOverrides : {},
        allowedServers: Array.isArray(raw.allowedServers) ? raw.allowedServers : [],
      }
      evictIfFull()
      lru.set(workspaceId, parsed)
      return parsed
    }
  } catch {
    // Valkey unreachable, or the cached value is not parseable JSON (written
    // by an older ResolvedPolicy shape). Either way this is only a cache tier:
    // falling through to the control-plane fetch below yields the same answer,
    // just slower. Swallowing here is what keeps the daemon serving policy
    // during a Valkey outage.
  }

  // Cache miss in Valkey too — fetch synchronously
  logger.debug({ workspaceId }, 'policy_cache.miss')
  const fresh = await fetchFromControlPlane(workspaceId)
  if (fresh) {
    evictIfFull()
    lru.set(workspaceId, fresh)
    try {
      await valkey.set(`mcp_daemon:policy:${workspaceId}`, JSON.stringify(fresh), 'PX', getPolicyTtlMs())
    } catch {
      // Valkey unreachable. Write-through to the shared tier is an
      // optimisation, not a correctness step: `fresh` is already in the LRU
      // and is returned below. Failing the caller's policy resolution because
      // a cache write failed would take the daemon down with Valkey.
    }
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
