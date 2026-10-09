/**
 * policy.ts — PolicyClient: fetches and caches SOP governance rules from the Intutic control plane.
 *
 * Rules are refreshed every policyTtlMs (default: 60s). On fetch failure, the
 * last-known-good set is retained (fail-open behaviour).
 *
 * @module
 */

import { createStderrLogger as createLogger } from './stderrLog.js'
import { callDaemonSocket } from './daemonClient.js'
import { HttpStatusError, httpRequest } from './httpJson.js'
import type { ResolvedPolicy } from './daemon/policyCache.js'
import {
  parseMcpBudgetPolicy,
  parseWorkspacePiiDetectors,
  type McpBudgetPolicy,
  type WorkspacePiiDetectors,
} from '@intutic/shared-types'

const log = createLogger('mcp-proxy-policy')

export interface SopRule {
  id: string
  /** Regex pattern matched against tool name (e.g. "mcp__github__.*" or "Bash") */
  toolPattern: string
  /** Optional regex matched against JSON.stringify(tool_input) */
  argPattern?: string
  /** Action to take when the rule matches */
  action: 'block' | 'warn' | 'require_approval'
  /** Human-readable reason reported back to harness */
  reason: string
}

/**
 * Is this unvalidated object actually a policy rule?
 *
 * The daemon caches `sopRules` as `Record<string, unknown>[]` — it filters the
 * control plane's response to plain objects and validates nothing further. The
 * client then used `as SopRule[]`, behind a `Promise<any>` that hid the
 * mismatch entirely.
 *
 * That matters because these drive blocking decisions: a rule missing
 * `toolPattern` reaches `new RegExp(undefined)` and matches everything, and a
 * rule with an unrecognised `action` falls through every branch and enforces
 * nothing. Neither is a shape the control plane intends to send — which is the
 * argument for dropping the malformed ones loudly rather than trusting a cast.
 */
/**
 * Exported because it is the contract between this package and whatever
 * produces rules for it, not merely an internal helper. `policyCache`'s snapshot
 * seed has to satisfy it, and a test that asserted against a *copy* of this
 * predicate would prove nothing about the real one — which is precisely the
 * two-copies-of-one-rule failure the harness gates were just rebuilt to remove.
 */
export function isSopRule(value: unknown): value is SopRule {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['toolPattern'] === 'string' &&
    typeof r['reason'] === 'string' &&
    (r['argPattern'] === undefined || typeof r['argPattern'] === 'string') &&
    (r['action'] === 'block' || r['action'] === 'warn' || r['action'] === 'require_approval')
  )
}

interface SopRulesResponse {
  rules: SopRule[]
}

/**
 * The workspace's MCP server registry decisions, as the control plane sends
 * them (`mcpRegistry`). A blocked server is refused always; under a `deny`
 * default, so is every server not approved; a disabled tool is hidden from
 * tools/list and refused within any server.
 */
export interface McpRegistryPolicy {
  defaultPolicy: 'allow' | 'deny'
  approvedServers: string[]
  blockedServers: string[]
  /**
   * Servers a high-risk tool-set change sent back to the approval queue
   * (`mcpHighRiskToolChange: hold`). Refused under either default until an
   * owner or admin decides again.
   */
  heldServers: string[]
  disabledTools: Record<string, string[]>
}

/**
 * What an older control plane — one that sends no `mcpRegistry` at all —
 * means: no registry, so nothing is refused on its account. Distinct from an
 * UNKNOWN registry (no policy loaded yet), which the interceptor resolves
 * through the fail-open/fail-closed setting instead.
 */
export const UNRESTRICTED_REGISTRY: McpRegistryPolicy = Object.freeze({
  defaultPolicy: 'allow',
  approvedServers: [],
  blockedServers: [],
  heldServers: [],
  disabledTools: {},
}) as McpRegistryPolicy

/**
 * The workspace member this proxy's API key resolves to, as the control
 * plane resolved it. Never derived locally: the proxy can know the OS user it
 * runs as, but only the control plane can say which member a key belongs to.
 */
export interface McpPrincipal {
  memberId: string
  email: string
  role: string
  ssoGroups: string[]
}

/** The workspace's SSO group policy — the one the server-side hook gate applies. */
export interface SsoGroupPolicy {
  highRiskTools: string[]
  requiredGroups: string[]
  requireOboFor: string[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses `mcpRegistry`. Returns `undefined` for anything that is not a
 * registry object, so the caller decides what absence means for its source.
 */
export function parseRegistry(value: unknown): McpRegistryPolicy | undefined {
  if (!isPlainObject(value)) return undefined
  const disabledTools: Record<string, string[]> = {}
  if (isPlainObject(value['disabledTools'])) {
    for (const [server, tools] of Object.entries(value['disabledTools'])) {
      const list = stringList(tools)
      if (list.length > 0) disabledTools[server] = list
    }
  }
  return {
    defaultPolicy: value['defaultPolicy'] === 'deny' ? 'deny' : 'allow',
    approvedServers: stringList(value['approvedServers']),
    blockedServers: stringList(value['blockedServers']),
    heldServers: stringList(value['heldServers']),
    disabledTools,
  }
}

export function parsePrincipal(value: unknown): McpPrincipal | undefined {
  if (!isPlainObject(value) || typeof value['memberId'] !== 'string' || !value['memberId']) return undefined
  return {
    memberId: value['memberId'],
    email: typeof value['email'] === 'string' ? value['email'] : '',
    role: typeof value['role'] === 'string' ? value['role'] : '',
    ssoGroups: stringList(value['ssoGroups']),
  }
}

export function parseSsoGroupPolicy(value: unknown): SsoGroupPolicy | undefined {
  if (!isPlainObject(value)) return undefined
  return {
    highRiskTools: stringList(value['highRiskTools']),
    requiredGroups: stringList(value['requiredGroups']),
    requireOboFor: stringList(value['requireOboFor']),
  }
}

/** How long a proxy waits between on-demand refreshes while it has no registry. */
const UNKNOWN_REGISTRY_RETRY_MS = 5_000

export class PolicyClient {
  private rules: SopRule[] = []
  /**
   * Workspace DLP regex sources, delivered to the scanner on every refresh.
   * The daemon has cached these since the policy cache existed; this client
   * received and dropped them — a workspace's custom patterns were a setting
   * wired to nothing.
   */
  private dlpPatterns: string[] = []
  /** Workspace injection-pattern sources (`mcpInjectionPatterns`, TD-436); empty = floor only. */
  private injectionPatterns: string[] = []
  /**
   * Additive tool scoping: when non-empty, ONLY these tools may be called
   * through this proxy. Empty means unrestricted — the same convention as
   * `allow_harnesses` and the starter rules' allowlist inversion warnings:
   * an empty allowlist read as "permit nothing" would block every workspace
   * that never declared one.
   */
  private allowedTools: string[] = []
  /** Operator-curated tool descriptions, applied to tools/list responses. */
  private toolDescriptionOverrides: Record<string, string> = {}
  /**
   * Additive SERVER scoping: when non-empty, ONLY these MCP server names may
   * be proxied by this process. Empty means unrestricted — same convention
   * and same source as `allowedTools` above (mirrors `mcpAllowedTools` /
   * `mcpAllowedServers` in workspace settings, delivered via the same
   * `GET /api/v1/sop/rules` response this class already polls).
   */
  private allowedServers: string[] = []
  /**
   * Control-plane-delivered prompt-injection disposition override. `undefined`
   * (never `'warn'`/`'block'` by default) means "the control plane did not
   * send this field" — distinct from the field being explicitly set to
   * `'warn'` — so the caller (interceptor.ts) knows to fall back to
   * `config.ts`'s `mcpInjectionAction` env-derived default rather than
   * silently treating an unset policy as an explicit warn.
   */
  private injectionAction: 'warn' | 'block' | undefined
  /**
   * Control-plane-delivered anomaly-detection mode override (Phase 2).
   * `undefined` when absent — same "absent means no override, fall back to
   * config.ts's env-derived default" convention as `injectionAction` above.
   */
  private anomalyMode: 'enforce' | 'warn' | 'off' | undefined
  /**
   * Control-plane-delivered per-detector disposition overrides. Always an
   * object (never `undefined`) — an absent policy field reads as "no
   * overrides," which `resolveEffectiveDisposition` (anomaly/index.ts)
   * already treats as a no-op via `overrides[detectorId] === undefined`, the
   * same empty-object-means-unrestricted convention `toolDescriptionOverrides`
   * above uses.
   */
  private anomalyOverrides: Record<string, 'steer' | 'reask' | 'kill' | 'off'> = {}
  /**
   * Registry decisions from the last policy that carried them. `undefined`
   * until then — no policy has loaded in this process, or the only one so far
   * was the MCP daemon's snapshot seed, which carries none. The interceptor
   * resolves that state through the fail-open/fail-closed setting.
   */
  private registry: McpRegistryPolicy | undefined
  private principal: McpPrincipal | undefined
  /**
   * The workspace's `mcpProxyFailBehavior` as a fail-open flag, or
   * `undefined` when the control plane did not send it (the workspace never
   * chose, or no policy has loaded) — then `INTUTIC_MCP_FAIL_OPEN` decides.
   */
  private failOpen: boolean | undefined
  private ssoGroupPolicy: SsoGroupPolicy | undefined
  /** The workspace's MCP call budgets (`mcpBudgets`); no budgets until a policy says otherwise. */
  private mcpBudgets: McpBudgetPolicy = parseMcpBudgetPolicy(undefined)
  /**
   * The workspace's `piiDetectors` setting, read as the LLM proxy reads it
   * from key-context (`parseWorkspacePiiDetectors`). `none` until a policy
   * carries one. `unreadable` when the control plane says it could not read
   * the stored value; the interceptor applies the fail setting to that.
   */
  private piiDetectors: WorkspacePiiDetectors = { kind: 'none' }
  /** The first refresh `start()` kicks off, so the first tool call can wait for it. */
  private firstRefresh: Promise<void> | null = null
  private lastRefreshAttemptAt = 0
  /** Whether a policy that came from the control plane (directly or through the daemon's fetch) has loaded. */
  private loadedFromControlPlane = false
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly workspaceId: string,
    private readonly ttlMs: number = 60_000,
    private readonly mcpProxyMode: string = 'per-session'
  ) {}

  /**
   * Start background refresh timer.
   *
   * @param onTick - Optional callback invoked on the SAME interval as the
   *   policy refresh (including the initial kick below) — Phase 3's
   *   `~/.intutic/wasm/` rescan (`WasmRunner.rescan`, wired from proxy.ts)
   *   hooks this rather than starting a second timer, per the task's own
   *   "don't add a second timer" instruction. Errors are swallowed the same
   *   way `refresh()`'s own are — a rescan failure must not take down the
   *   policy refresh it rides alongside.
   */
  start(onTick?: () => void | Promise<void>): void {
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {
        // Errors already logged inside refresh()
      })
      if (onTick) void Promise.resolve(onTick()).catch(() => {})
    }, this.ttlMs)
    // Don't block Node.js exit on this timer
    this.refreshTimer.unref()

    // Kick off initial fetch (non-blocking — proxy starts immediately; the
    // first tool call waits for it through `ready()`).
    this.firstRefresh = this.refresh().catch(() => {})
    if (onTick) void Promise.resolve(onTick()).catch(() => {})
  }

  /** Stop the background refresh timer. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * Resolves once the policy is as loaded as it is going to get for this call.
   *
   * The first tool call of a process can arrive before `start()`'s first
   * fetch has answered; without this wait, a `deny` workspace's very first
   * call would be decided against no registry at all. After that, while the
   * registry is still unknown (control plane unreachable, or only the
   * daemon's snapshot seed so far), a call triggers one more refresh at most
   * every {@link UNKNOWN_REGISTRY_RETRY_MS} — so a proxy started offline
   * picks the registry up as soon as it can, not at the next 60-second tick.
   * Never rejects; every wait is bounded by the 5-second fetch timeout.
   */
  async ready(): Promise<void> {
    if (this.firstRefresh) await this.firstRefresh
    if (this.registry !== undefined) return
    if (Date.now() - this.lastRefreshAttemptAt < UNKNOWN_REGISTRY_RETRY_MS) return
    await this.refresh().catch(() => {})
  }

  /** Registry decisions, or `undefined` while none has loaded (see the field). */
  getRegistry(): McpRegistryPolicy | undefined {
    return this.registry
  }

  /** The member this proxy's key resolves to, when the control plane said. */
  getPrincipal(): McpPrincipal | undefined {
    return this.principal
  }

  /** The workspace's SSO group policy, when it has one. */
  getSsoGroupPolicy(): SsoGroupPolicy | undefined {
    return this.ssoGroupPolicy
  }

  /** The workspace's MCP call budgets; an empty list means no limits. */
  getMcpBudgets(): McpBudgetPolicy {
    return this.mcpBudgets
  }

  /** The workspace's PII detector actions (see the field). */
  getPiiDetectors(): WorkspacePiiDetectors {
    return this.piiDetectors
  }

  /** The workspace's fail-open choice, or `undefined` to fall back to the local setting (see the field). */
  getFailOpen(): boolean | undefined {
    return this.failOpen
  }

  /** Return the current cached rule set. */
  getRules(): readonly SopRule[] {
    return this.rules
  }

  /** Workspace DLP regex sources from the last successful refresh. */
  /** Workspace-supplied prompt-injection regex sources; empty means the hardcoded floor alone. */
  getInjectionPatterns(): readonly string[] {
    return this.injectionPatterns
  }

  getDlpPatterns(): readonly string[] {
    return this.dlpPatterns
  }

  /** The additive tool allowlist; empty means unrestricted. */
  getAllowedTools(): readonly string[] {
    return this.allowedTools
  }

  /** The additive MCP server allowlist; empty means unrestricted. */
  getAllowedServers(): readonly string[] {
    return this.allowedServers
  }

  /** Operator description overrides for tools/list curation. */
  getToolDescriptionOverrides(): Readonly<Record<string, string>> {
    return this.toolDescriptionOverrides
  }

  /**
   * The control-plane-delivered prompt-injection disposition, or `undefined`
   * when the policy source never sent `mcpInjectionAction` — absent means
   * "no override", not "warn". Callers (interceptor.ts) fall back to
   * `config.ts`'s env-derived default in that case, the same "absent means
   * default" convention every other optional policy field in this class
   * follows.
   */
  getInjectionAction(): 'warn' | 'block' | undefined {
    return this.injectionAction
  }

  /** The control-plane-delivered anomaly mode, or `undefined` if unset (see field doc). */
  getAnomalyMode(): 'enforce' | 'warn' | 'off' | undefined {
    return this.anomalyMode
  }

  /** Per-detector disposition overrides; always an object, empty means none. */
  getAnomalyOverrides(): Readonly<Record<string, 'steer' | 'reask' | 'kill' | 'off'>> {
    return this.anomalyOverrides
  }

  /** Parse the optional curation fields shared by both refresh paths. */
  private absorbCuration(source: Record<string, unknown>): void {
    const allowed = source['allowedTools'] ?? source['mcpAllowedTools']
    this.allowedTools = Array.isArray(allowed)
      ? allowed.filter((t): t is string => typeof t === 'string')
      : []
    const overrides = source['toolDescriptionOverrides'] ?? source['mcpToolDescriptionOverrides']
    this.toolDescriptionOverrides = {}
    if (typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)) {
      for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof v === 'string') this.toolDescriptionOverrides[k] = v
      }
    }
    const allowedServers = source['allowedServers'] ?? source['mcpAllowedServers']
    this.allowedServers = Array.isArray(allowedServers)
      ? allowedServers.filter((s): s is string => typeof s === 'string')
      : []
    const injectionPatterns = source['mcpInjectionPatterns']
    this.injectionPatterns = Array.isArray(injectionPatterns)
      ? injectionPatterns.filter((p): p is string => typeof p === 'string')
      : []
    const injectionAction = source['mcpInjectionAction']
    this.injectionAction =
      injectionAction === 'warn' || injectionAction === 'block' ? injectionAction : undefined
    const anomalyMode = source['mcpAnomalyMode']
    this.anomalyMode =
      anomalyMode === 'enforce' || anomalyMode === 'warn' || anomalyMode === 'off' ? anomalyMode : undefined
    const anomalyOverrides = source['mcpAnomalyOverrides']
    this.anomalyOverrides = {}
    if (typeof anomalyOverrides === 'object' && anomalyOverrides !== null && !Array.isArray(anomalyOverrides)) {
      for (const [k, v] of Object.entries(anomalyOverrides as Record<string, unknown>)) {
        if (v === 'steer' || v === 'reask' || v === 'kill' || v === 'off') this.anomalyOverrides[k] = v
      }
    }
    this.principal = parsePrincipal(source['principal'])
    this.ssoGroupPolicy = parseSsoGroupPolicy(source['ssoGroupPolicy'])
    this.mcpBudgets = parseMcpBudgetPolicy(source['mcpBudgets'])
    const failBehavior = source['mcpProxyFailBehavior']
    this.failOpen = failBehavior === 'open' ? true : failBehavior === 'closed' ? false : undefined
    this.piiDetectors = parseWorkspacePiiDetectors(source['piiDetectors'])
    if (this.piiDetectors.kind === 'unreadable') {
      log.warn({ action: 'pii_detectors_unreadable', reason: this.piiDetectors.reason }, 'Workspace PII detector actions unreadable')
    }
  }

  /** Find the first matching rule for a given tool name + serialized args. */
  matchRule(toolName: string, toolInputJson: string): SopRule | null {
    for (const rule of this.rules) {
      try {
        const toolRegex = new RegExp(rule.toolPattern)
        if (!toolRegex.test(toolName)) continue
        if (rule.argPattern) {
          const argRegex = new RegExp(rule.argPattern)
          if (!argRegex.test(toolInputJson)) continue
        }
        return rule
      } catch {
        // Malformed regex in rule — skip silently
      }
    }
    return null
  }

  /** Fetch fresh rules from the control plane. */
  async refresh(): Promise<void> {
    this.lastRefreshAttemptAt = Date.now()
    if (this.mcpProxyMode === 'daemon') {
      try {
        // The socket returns whatever the daemon serialised, so the caller
        // names the shape it expects. `policy.get` is answered by `resolvePolicy`
        // in the daemon's own policyCache, which is where this type comes from —
        // not an assertion, the actual producer's return type.
        const policy = await callDaemonSocket<ResolvedPolicy | null>('policy.get', {
          workspaceId: this.workspaceId,
        })
        if (policy) {
          const candidates = policy.sopRules ?? []
          // An explicit loop rather than `.filter(isSopRule)`: TypeScript will
          // not narrow `Record<string, unknown>[]` to `SopRule[]` through a type
          // predicate, because an interface has no implicit index signature.
          const accepted: SopRule[] = []
          for (const candidate of candidates) {
            if (isSopRule(candidate)) accepted.push(candidate)
          }
          this.rules = accepted
          const dropped = candidates.length - accepted.length
          if (dropped > 0) {
            log.warn(
              { action: 'policy_rules_malformed', dropped, kept: this.rules.length },
              'Dropped malformed SOP rules from the daemon — they cannot be enforced',
            )
          }
          // A restarted daemon answers from the sync daemon's snapshot until
          // its first fetch, and the snapshot carries the rules and the server
          // allowlist but no tool allowlist, description overrides, DLP or
          // injection patterns, registry or dispositions. Absorbing that over
          // a policy this process already loaded would lift every restriction
          // the snapshot lacks — a daemon restart as a way to disarm curation.
          // So once a control-plane policy has loaded, a snapshot answer
          // updates the rules and nothing else; before that, it is the best
          // policy there is.
          if (policy.fromSnapshot && this.loadedFromControlPlane) {
            log.info({ action: 'policy_snapshot_rules_only', ruleCount: this.rules.length }, 'Daemon answered from its snapshot; kept the loaded curation')
            return
          }
          this.dlpPatterns = (policy.dlpPatterns ?? []).filter(
            (p): p is string => typeof p === 'string',
          )
          this.absorbCuration(policy as unknown as Record<string, unknown>)
          // Re-parsed, not trusted: a daemon on an older version, or an entry it
          // cached before a field existed, can carry a registry without one.
          if (policy.mcpRegistry) this.registry = parseRegistry(policy.mcpRegistry) ?? this.registry
          if (!policy.fromSnapshot) this.loadedFromControlPlane = true
          log.info({ action: 'policy_refreshed_from_daemon', ruleCount: this.rules.length }, 'SOP rules refreshed from daemon')
          return
        }
      } catch (err) {
        log.warn(
          {
            action: 'policy_daemon_failed',
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to refresh policy from daemon socket — falling back to HTTP',
        )
      }
    }

    const url = `${this.controlPlaneUrl}/api/v1/sop/rules?workspaceId=${encodeURIComponent(this.workspaceId)}&active=true`
    log.debug({ action: 'policy_refresh', url }, 'Fetching SOP rules from control plane')

    let body: string
    try {
      body = await httpRequest('GET', url, this.apiKey)
    } catch (err) {
      // The control plane refused this proxy's key: revoked, or its member
      // deactivated or offboarded. Every other rule stays as loaded, but the
      // member's SSO groups were vouched for by that key, so the proxy stops
      // knowing them — a high-risk tool is refused until a key works again.
      if (err instanceof HttpStatusError && (err.status === 401 || err.status === 403)) this.principal = undefined
      throw err
    }
    const parsed = JSON.parse(body) as SopRulesResponse & Record<string, unknown>
    const rules = Array.isArray(parsed.rules) ? parsed.rules : []
    this.rules = rules
    const dlp = parsed['dlpPatterns']
    this.dlpPatterns = Array.isArray(dlp)
      ? dlp.filter((p): p is string => typeof p === 'string')
      : []
    this.absorbCuration(parsed)
    // A control plane that sends no registry has none: unrestricted, not unknown.
    this.registry = parseRegistry(parsed['mcpRegistry']) ?? UNRESTRICTED_REGISTRY
    this.loadedFromControlPlane = true
    log.info({ action: 'policy_refreshed', ruleCount: rules.length }, 'SOP rules refreshed')
  }
}
