/**
 * Policy Cache — LRU in-memory + Valkey write-through
 *
 * Resolves PCAS permissions + active SOP rules for MCP daemon.
 * Cache hit: < 0.1ms (LRU). Valkey hit: < 2ms. Miss: HTTP to control-plane.
 *
 * @module
 */
import https from 'node:https'
import http from 'node:http'
import { Redis } from 'ioredis'
import { describeConnectionError } from '../valkeyErrors.js'
import { createLogger } from '@intutic/logger'
import {
  UNRESTRICTED_REGISTRY,
  parsePrincipal,
  parseRegistry,
  parseSsoGroupPolicy,
  type McpPrincipal,
  type McpRegistryPolicy,
  type SsoGroupPolicy,
} from '../policy.js'
import { parseMcpBudgetPolicy, type McpBudgetPolicy } from '@intutic/shared-types'

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
  /**
   * Prompt-injection disposition override (`packages/mcp-proxy/src/injection.ts`).
   * `undefined` when the control plane has not sent this field yet — read the
   * same way as every other optional curation field here: absent must mean
   * "no override, use the package's own env-derived default"
   * (`PolicyClient.getInjectionAction`, `../policy.ts`), never "warn" by
   * silent default at this layer, so an old snapshot/cache entry from before
   * this field existed reads correctly as absent rather than as an explicit
   * value.
   */
  mcpInjectionAction?: 'warn' | 'block'
  /** Workspace injection-pattern sources; normalized to `[]` like `allowedTools`. */
  mcpInjectionPatterns: string[]
  /**
   * Anomaly-detection mode override (Phase 2, `packages/mcp-proxy/src/anomaly/`).
   * `undefined` means absent — same convention as `mcpInjectionAction` above.
   */
  mcpAnomalyMode?: 'enforce' | 'warn' | 'off'
  /**
   * Per-detector disposition overrides. Always an object, never `undefined`
   * — an absent field normalizes to `{}` (no overrides) the same way
   * `toolDescriptionOverrides` above does, since "absent" and "explicitly
   * empty" mean the same thing for an override map.
   */
  mcpAnomalyOverrides: Record<string, 'steer' | 'reask' | 'kill' | 'off'>
  /**
   * MCP server registry decisions. `undefined` only on an entry that did not
   * come from the control plane — the snapshot seed, or a Valkey entry
   * written before this field existed — and such an entry is treated as
   * stale (see `isStale`), so the first request refreshes it. A control plane
   * that sends no registry yields {@link UNRESTRICTED_REGISTRY}, never
   * `undefined`: it has no registry, which is not the same as not knowing.
   */
  mcpRegistry?: McpRegistryPolicy
  /** The member the daemon's API key resolves to (see `McpPrincipal`). */
  principal?: McpPrincipal
  /** The workspace's SSO group policy, when it has one. */
  ssoGroupPolicy?: SsoGroupPolicy
  /** The workspace's `mcpProxyFailBehavior`, when it has chosen one. */
  mcpProxyFailBehavior?: 'open' | 'closed'
  /** The workspace's MCP call budgets; absent on an entry from before they existed, which reads as none. */
  mcpBudgets?: McpBudgetPolicy
  /**
   * The control plane's `piiDetectors` field, carried as it was sent: absent
   * from an older control plane and from the snapshot seed, `null` when the
   * control plane could not read the setting. `PolicyClient` reads it with
   * `parseWorkspacePiiDetectors`, the reader the per-session mode uses too,
   * so the two modes cannot read one value differently.
   */
  piiDetectors?: unknown
  /**
   * True on the entry `seedFromSnapshot` built from the sync daemon's local
   * snapshot, which carries only part of the policy. A proxy that already
   * loaded a full policy takes only the rules from such an entry (see
   * `PolicyClient.refresh`), so a daemon restart cannot lift its curation.
   */
  fromSnapshot?: boolean
  cachedAt:      number
  /**
   * The workspace's `v2:sync:config_version` at fetch time.
   * A guardrail promote/retire bumps it; a fresh LRU hit whose version no
   * longer matches refetches instead of waiting out the TTL. Absent when
   * Valkey could not be read — then the TTL is the floor, as before.
   */
  configVersion?: number
}

/** Same key `packages/db`'s `configVersionKey` builds; this package does not depend on it. */
const configVersionKey = (workspaceId: string) => `v2:sync:config_version:${workspaceId}`

async function readConfigVersion(workspaceId: string): Promise<number | undefined> {
  // Only a connected client is asked. With Valkey down, ioredis queues the GET
  // and rejects it after `maxRetriesPerRequest` reconnect attempts — hundreds
  // of milliseconds on every cache hit, on the tool-call path. Unknown version
  // means "serve the cached entry", which is what the cache did before the
  // version existed. The miss path below starts the connection, so a reachable
  // Valkey is ready from the next call on.
  if (valkey.status !== 'ready') return undefined
  try {
    const raw = await valkey.get(configVersionKey(workspaceId))
    if (raw === null) return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether Valkey can answer a command now, starting the connection on first
 * use. With Valkey down, ioredis queues a command and rejects it only after
 * `maxRetriesPerRequest` reconnect attempts, whose delays grow with the outage
 * to two seconds each: a policy miss waited out a GET and then a SET before it
 * returned, seconds on the tool-call path for every miss for as long as
 * Valkey was down. A Valkey that is not ready is skipped, as an empty one
 * would be, and the control plane answers.
 */
function valkeyReady(): boolean {
  if (valkey.status === 'wait') valkey.connect().catch(() => {})
  return valkey.status === 'ready'
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
  // An entry with no registry did not come from the control plane (see the
  // field); serve it, but refresh it as if it had expired.
  return entry.mcpRegistry === undefined || Date.now() - entry.cachedAt > getPolicyTtlMs()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The policy fields the control plane sends, once they have been checked. */
type PolicyResponseBody = Pick<
  ResolvedPolicy,
  | 'sopRules'
  | 'dlpPatterns'
  | 'interventionMode'
  | 'allowedTools'
  | 'toolDescriptionOverrides'
  | 'allowedServers'
  | 'mcpInjectionAction'
  | 'mcpInjectionPatterns'
  | 'mcpAnomalyMode'
  | 'mcpAnomalyOverrides'
  | 'mcpRegistry'
  | 'principal'
  | 'ssoGroupPolicy'
  | 'mcpProxyFailBehavior'
  | 'mcpBudgets'
  | 'piiDetectors'
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
  const mcpInjectionAction        = parsed['mcpInjectionAction']
  const mcpInjectionPatterns      = parsed['mcpInjectionPatterns']
  const mcpAnomalyMode            = parsed['mcpAnomalyMode']
  const mcpAnomalyOverridesRaw    = parsed['mcpAnomalyOverrides']

  return {
    sopRules:    Array.isArray(sopRules) ? sopRules.filter(isRecord) : [],
    dlpPatterns: Array.isArray(dlpPatterns)
      ? dlpPatterns.filter((p): p is string => typeof p === 'string')
      : [],
    // 'TRANSPARENT', matching every other default in this pipeline: the
    // resolve route's own fallback (services/control-plane/src/routes/
    // evaluate.ts), the schema default on pcas_policies.intervention_mode,
    // and this module's snapshot-seed path below. The old default here was
    // 'BYPASS', which is not an intervention_mode_type value at all — a
    // fabricated mode no other component recognises.
    interventionMode: typeof interventionMode === 'string' ? interventionMode : 'TRANSPARENT',
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
    mcpInjectionAction:
      mcpInjectionAction === 'warn' || mcpInjectionAction === 'block' ? mcpInjectionAction : undefined,
    mcpInjectionPatterns: Array.isArray(mcpInjectionPatterns)
      ? mcpInjectionPatterns.filter((p): p is string => typeof p === 'string')
      : [],
    mcpAnomalyMode:
      mcpAnomalyMode === 'enforce' || mcpAnomalyMode === 'warn' || mcpAnomalyMode === 'off'
        ? mcpAnomalyMode
        : undefined,
    mcpAnomalyOverrides: isRecord(mcpAnomalyOverridesRaw)
      ? Object.fromEntries(
          Object.entries(mcpAnomalyOverridesRaw).filter(
            (entry): entry is [string, 'steer' | 'reask' | 'kill' | 'off'] =>
              entry[1] === 'steer' || entry[1] === 'reask' || entry[1] === 'kill' || entry[1] === 'off',
          ),
        )
      : {},
    mcpRegistry: parseRegistry(parsed['mcpRegistry']) ?? UNRESTRICTED_REGISTRY,
    principal: parsePrincipal(parsed['principal']),
    ssoGroupPolicy: parseSsoGroupPolicy(parsed['ssoGroupPolicy']),
    mcpProxyFailBehavior:
      parsed['mcpProxyFailBehavior'] === 'open' || parsed['mcpProxyFailBehavior'] === 'closed'
        ? parsed['mcpProxyFailBehavior']
        : undefined,
    mcpBudgets: parseMcpBudgetPolicy(parsed['mcpBudgets']),
    piiDetectors: parsed['piiDetectors'],
  }
}

async function fetchFromControlPlane(workspaceId: string): Promise<ResolvedPolicy | null> {
  // Read BEFORE the fetch: a bump that lands during the request is then seen
  // as "changed" on the next hit and refetched, never missed.
  const versionAtFetch = await readConfigVersion(workspaceId)
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
          // become a policy with no sopRules and the parser's fallback
          // interventionMode (historically the fabricated 'BYPASS', now
          // 'TRANSPARENT'), which resolvePolicy then cached for the full TTL
          // and socketServer read as `allowed: true` — an expired daemon key
          // silently turned enforcement off. A non-2xx is a failure to
          // resolve, so it returns null, the same as the transport failures
          // below.
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
            mcpInjectionAction: parsed.mcpInjectionAction,
            mcpInjectionPatterns: parsed.mcpInjectionPatterns,
            mcpAnomalyMode:   parsed.mcpAnomalyMode,
            mcpAnomalyOverrides: parsed.mcpAnomalyOverrides,
            mcpRegistry:      parsed.mcpRegistry,
            principal:        parsed.principal,
            ssoGroupPolicy:   parsed.ssoGroupPolicy,
            mcpProxyFailBehavior: parsed.mcpProxyFailBehavior,
            mcpBudgets:       parsed.mcpBudgets,
            piiDetectors:     parsed.piiDetectors,
            cachedAt:         Date.now(),
            configVersion:    versionAtFetch,
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
 * `~/.intutic/hooks/policy-snapshot.json` every cycle, and a verified copy under
 * `~/.intutic/hooks/verified/`, which this reads; so on the machine's own
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
    // The sync daemon's verified copy (VERIFIED_SNAPSHOT_DIR in
    // services/sync-daemon/src/lib/policySnapshot.ts), not the live file next
    // to it: the live JSON carries the server allowlist with no digest over
    // it, so an edit to it would otherwise seed this cache until the refresh.
    const file =
      snapshotPath ??
      process.env['INTUTIC_POLICY_SNAPSHOT'] ??
      path.join(os.homedir(), '.intutic', 'hooks', 'verified', 'policy-snapshot.json')

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
      // carries the server allowlist but no other MCP curation. The rest
      // defaults to unrestricted for a proxy with nothing loaded yet; a proxy
      // that has loaded a policy keeps its own (`fromSnapshot` below). The
      // background refresh this seed triggers fills them in.
      mcpInjectionPatterns: [],
      allowedTools: [],
      toolDescriptionOverrides: {},
      // The one curation field the snapshot does carry: the gates enforce the
      // same server allowlist from it.
      allowedServers: Array.isArray(parsed['mcpAllowedServers'])
        ? parsed['mcpAllowedServers'].filter((s): s is string => typeof s === 'string')
        : [],
      mcpAnomalyOverrides: {},
      // No registry: the snapshot does not carry one, and guessing "allow"
      // here would let a deny workspace's unapproved servers through after
      // every daemon restart. Left unknown, the entry is refreshed on first
      // use (see `isStale`) and the proxy applies its fail setting meanwhile.
      fromSnapshot: true,
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
    // A fresh entry is still refetched when the workspace's config version
    // moved since it was fetched (a guardrail promote/retire bumps it) — one
    // Valkey GET per hit, the same class of read as the Valkey-backed miss
    // path below. A failed refetch keeps serving the cached entry.
    if (cached.configVersion !== undefined) {
      const current = await readConfigVersion(workspaceId)
      if (current !== undefined && current !== cached.configVersion) {
        const fresh = await fetchFromControlPlane(workspaceId)
        if (fresh) {
          lru.delete(workspaceId)
          evictIfFull()
          lru.set(workspaceId, fresh)
          try {
            await valkey.set(`mcp_daemon:policy:${workspaceId}`, JSON.stringify(fresh), 'PX', getPolicyTtlMs())
          } catch {
            // Same reasoning as the stale-refresh branch below.
          }
          return fresh
        }
      }
    }
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

  // Cache miss in LRU — check Valkey, when it can answer now
  try {
    const valkeyCached = valkeyReady() ? await valkey.get(`mcp_daemon:policy:${workspaceId}`) : null
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
        mcpInjectionPatterns: Array.isArray(raw.mcpInjectionPatterns) ? raw.mcpInjectionPatterns : [],
        mcpAnomalyOverrides: isRecord(raw.mcpAnomalyOverrides) ? raw.mcpAnomalyOverrides : {},
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
    // Write-through to the shared tier is an optimisation, not a correctness
    // step: `fresh` is already in the LRU and is returned now, without waiting
    // on the write. A failed write is dropped; failing or holding the caller's
    // policy resolution on it would take the daemon down with Valkey.
    if (valkey.status === 'ready') {
      valkey.set(`mcp_daemon:policy:${workspaceId}`, JSON.stringify(fresh), 'PX', getPolicyTtlMs()).catch(() => {})
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
