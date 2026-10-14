/**
 * API key scopes — what a `vk_` key may do, on top of its owner's role.
 *
 * One small, fixed vocabulary, in the shape GitHub fine-grained tokens, Stripe
 * restricted keys, OpenAI project keys and Cloudflare API tokens share: a
 * resource area with a `read` or `write` level, `write` covering `read`, and
 * everything not granted refused. Three kinds of scope:
 *
 * - `*` — everything the owner's role allows. The default, and what every key
 *   minted before scopes were enforced holds.
 * - `gateway:use` — agent traffic: what the proxy, the hook gates, the SDKs,
 *   the MCP proxy and the sync daemon send with a key (LLM calls through the
 *   proxy, gate checks, hook events, trace sync-back, holds). The scope for a
 *   key that only runs agents.
 * - `<area>:read` / `<area>:write` — the REST API by area.
 *
 * A request made with a key needs BOTH: the owner's role must allow the route
 * and the key's scopes must cover it. A dashboard session has no scopes; only
 * its role applies. The control plane maps every route to the scopes that
 * cover it (`services/control-plane/src/lib/routeScopes.ts`) and refuses an
 * uncovered request with 403 `INSUFFICIENT_SCOPE`.
 *
 * Mirrored by the Terraform provider's `validKeyScopes` (checked by
 * `__tests__/apiKeyScopes.test.ts`) and published in `apps/docs/reference/api.md`
 * (generated from this file).
 *
 * @module
 */

/** Every REST area a scope can name, with what it covers. Order is the display order. */
export const API_KEY_SCOPE_AREAS = {
  traces: 'traces, agent sessions, plans, loop runs, trajectories, agents and the tamper-evident trace chain',
  usage: 'usage, cost and routing analytics, cost prediction and provider incidents',
  findings: 'findings, incidents, anomalies, holds and decisions, judge reviews, governance cards, trust scores and break-glass',
  sops: 'SOPs and their lifecycle, skills, the dream cycle, MetaClaw and optimisation suggestions',
  policies: 'policies, guardrails and policy documents, WASM rules, rule candidates and the evaluator sandbox',
  compliance: 'compliance coverage, probes and evidence exports, and the audit timeline',
  inventory: 'developer machines, harnesses, MCP servers, self-hosted gateways and governance coverage',
  settings: 'workspace settings, provider credentials, region, orgs and teams, domains, SSO providers and the license',
  members: 'members, invitations, roles, profiles and SCIM tokens',
  keys: 'API keys, attenuated child keys and on-behalf-of tokens',
  billing: 'billing, invoices, budgets and trials',
  siem: 'SIEM destinations and their dead-letter queue, and notification rules',
  integrations: 'connectors and the GitHub, Slack and task-tracker integrations',
} as const

/** A REST area a scope can name. */
export type ApiKeyScopeArea = keyof typeof API_KEY_SCOPE_AREAS

/** The scope that covers agent traffic. */
export const GATEWAY_USE_SCOPE = 'gateway:use' as const

/** The scope that covers everything the owner's role allows. */
export const ALL_SCOPES = '*' as const

/** One scope a key can hold. */
export type ApiKeyScope = typeof ALL_SCOPES | typeof GATEWAY_USE_SCOPE | `${ApiKeyScopeArea}:${'read' | 'write'}`

/** A scope with what it grants, as the dashboard, the CLI and the docs show it. */
export interface ApiKeyScopeEntry {
  scope: ApiKeyScope
  description: string
}

/** The registry: every valid scope, in display order. */
export const API_KEY_SCOPES: readonly ApiKeyScopeEntry[] = [
  { scope: ALL_SCOPES, description: "Everything the key owner's role allows (the default)" },
  {
    scope: GATEWAY_USE_SCOPE,
    description:
      'Agent traffic: LLM calls through the proxy, hook-gate checks, hook events, trace sync-back, sessions, holds, SOP rules, the policy snapshot and the workspace settings agents read',
  },
  ...(Object.entries(API_KEY_SCOPE_AREAS) as Array<[ApiKeyScopeArea, string]>).flatMap(([area, covers]) => [
    { scope: `${area}:read` as ApiKeyScope, description: `Read ${covers}` },
    { scope: `${area}:write` as ApiKeyScope, description: `Read and change ${covers}` },
  ]),
]

/** Every valid scope string. */
export const API_SCOPE_NAMES: readonly ApiKeyScope[] = API_KEY_SCOPES.map((s) => s.scope)

const SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPE_NAMES)

/** The least-privilege preset for a key that only runs agents, CI jobs or a proxy. */
export const AUTOMATION_KEY_SCOPES: readonly ApiKeyScope[] = [GATEWAY_USE_SCOPE]

/** Whether `scope` is in the registry. */
export function isApiKeyScope(scope: string): scope is ApiKeyScope {
  return SCOPE_SET.has(scope)
}

/** The scopes in `scopes` that are not in the registry. */
export function unknownApiKeyScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !SCOPE_SET.has(s))
}

/**
 * Whether a key holding `granted` may act with `required`: `*` grants every
 * scope, and `<area>:write` grants `<area>:read`.
 */
export function scopeGrants(granted: readonly string[], required: string): boolean {
  if (granted.includes(ALL_SCOPES)) return true
  if (granted.includes(required)) return true
  if (required.endsWith(':read')) return granted.includes(`${required.slice(0, -':read'.length)}:write`)
  return false
}

/** Whether a key holding `granted` may act with at least one of `anyOf`. */
export function scopesGrantAny(granted: readonly string[], anyOf: readonly string[]): boolean {
  return anyOf.some((r) => scopeGrants(granted, r))
}

/**
 * What a key's stored scopes mean today.
 *
 * - All known: those scopes.
 * - None known (a key written with free-form scope strings before scopes were
 *   enforced, such as `["read"]`): `*`, flagged `legacy`, for one release —
 *   until 2.6.0, when such a key is refused. The control plane logs a
 *   deprecation warning on each use and the dashboard marks the key.
 * - Some known: the known ones; the unknown ones grant nothing.
 * - Missing (a NULL column): `*`, the column's default.
 */
export function effectiveApiKeyScopes(stored: unknown): { scopes: ApiKeyScope[]; legacy: boolean; ignored: string[] } {
  if (!Array.isArray(stored)) return { scopes: [ALL_SCOPES], legacy: false, ignored: [] }
  const strings = stored.filter((s): s is string => typeof s === 'string')
  const known = strings.filter(isApiKeyScope)
  const ignored = strings.filter((s) => !SCOPE_SET.has(s))
  if (known.length === 0) return { scopes: [ALL_SCOPES], legacy: true, ignored }
  return { scopes: compactScopes(known), legacy: false, ignored }
}

/**
 * The smallest list granting the same as `scopes`: `*` alone when present,
 * and an area's `read` dropped when its `write` is there. Registry order.
 */
export function compactScopes(scopes: readonly string[]): ApiKeyScope[] {
  if (scopes.includes(ALL_SCOPES)) return [ALL_SCOPES]
  return API_SCOPE_NAMES.filter(
    (s) => s !== ALL_SCOPES && scopes.includes(s) && !(s.endsWith(':read') && scopes.includes(`${s.slice(0, -':read'.length)}:write`)),
  )
}

/** What both `a` and `b` grant, compacted — a child key's reach under its parent. */
export function intersectScopes(a: readonly string[], b: readonly string[]): ApiKeyScope[] {
  if (a.includes(ALL_SCOPES) && b.includes(ALL_SCOPES)) return [ALL_SCOPES]
  return compactScopes(API_SCOPE_NAMES.filter((s) => s !== ALL_SCOPES && scopeGrants(a, s) && scopeGrants(b, s)))
}

/** The message naming the valid scopes, for a request that sent an unknown one. */
export function unknownScopesMessage(unknown: readonly string[]): string {
  return `Unknown scope${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => `"${s}"`).join(', ')}. Valid scopes: ${API_SCOPE_NAMES.join(', ')}`
}
