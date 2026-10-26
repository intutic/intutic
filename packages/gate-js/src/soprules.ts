/**
 * SOP rules authored in the product, enforced before execution.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/soprules.py`.
 *
 * `SopRule` has carried an optional `argPattern` since mcp-proxy shipped, and
 * `packages/mcp-proxy/src/policy.ts` matches it against the serialised tool
 * input. The control plane's SOP-title grammar gained a ` WHERE ` clause to the SOP
 * title grammar, so a rule can finally say "kubectl apply without a digest"
 * instead of only "any shell call":
 *
 *     BLOCK:^shell$ WHERE kubectl\s+apply(?!.*@sha256:):deploy must be pinned
 *
 * Now the *policy* lives in the SOP register — versioned, lifecycle-gated,
 * visible on the dashboard, editable without touching agent code — and this
 * module is only the part that applies it.
 *
 * Matching mirrors `matchSopRule` in
 * `services/control-plane/src/lib/sopRuleTitle.ts` (itself a deliberate
 * line-for-line mirror of `PolicyClient.matchRule` in
 * `packages/mcp-proxy/src/policy.ts`), deliberately:
 *
 *   * rules are tried in the order the control plane returned them
 *   * the most severe matching rule decides (block, then require_approval,
 *     then warn); among rules of that severity, the first in list order. A
 *     warn rule listed before a block rule (a shadow guardrail, or the
 *     control plane's catch-all reminder) must not let the call through
 *     with a flag when a later rule refuses it
 *   * `toolPattern` is tested against the tool name, `argPattern` against the
 *     serialised tool input
 *   * the serialisation is the `JSON.stringify(tool_input ?? {})` shape every
 *     mirror matches against — compact separators, insertion order, non-ASCII
 *     left intact
 *   * a rule whose regex does not compile is SKIPPED, not fatal
 *
 * Fetch failure is non-fatal for the same reason it is in `policy.ts`: the
 * gate's image-integrity tier independently covers the deploy case and fails
 * CLOSED. This tier changes where the policy is *authored*, not whether the
 * run is safe.
 */

import { isOpaqueInterventionMode } from './opaqueRefusal.js'

export const FETCH_TIMEOUT_MS = 3_000

// Actions the control plane can return. Anything else is ignored rather than
// guessed at — an unrecognised action must not silently become "allow".
export const ACTION_BLOCK = 'block'
export const ACTION_WARN = 'warn'
export const ACTION_APPROVAL = 'require_approval'
const KNOWN_ACTIONS = new Set([ACTION_BLOCK, ACTION_WARN, ACTION_APPROVAL])

export interface SopRule {
  id: string
  toolPattern: string
  action: string
  reason: string
  argPattern: string | null
}

/** Mirror of `matchSopRule`, including its silent-skip on bad regex. */
export function ruleMatches(rule: SopRule, toolName: string, toolInputJson: string): boolean {
  try {
    if (!new RegExp(rule.toolPattern).test(toolName)) return false
    if (rule.argPattern !== null) {
      return new RegExp(rule.argPattern).test(toolInputJson)
    }
    return true
  } catch {
    // Malformed regex in rule — skip silently, exactly as the control plane
    // and mcp-proxy mirrors do.
    return false
  }
}

/**
 * The `JSON.stringify(tool_input ?? {})` shape every mirror matches against.
 *
 * `JSON.stringify` already produces compact separators and preserves
 * insertion order and non-ASCII by default — this function exists mainly so
 * every call site names the contract explicitly rather than calling
 * `JSON.stringify` inline and drifting on a future edit.
 */
export function serialiseToolInput(toolInput: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(toolInput ?? {})
}

/**
 * Accept the rule list in whichever envelope the control plane used.
 *
 * `/api/v1/sop/rules` returns `{rules:[...]}`, while sibling list endpoints
 * variously return `{items:[...]}` and `{data:[...]}`. Reading the wrong key
 * yields zero rules and a tier that enforces nothing while looking healthy —
 * the worst failure a gate can have — so all three are accepted rather than
 * assumed.
 */
export function parseRules(payload: unknown): SopRule[] {
  let rows: unknown[]
  if (Array.isArray(payload)) {
    rows = payload
  } else if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const candidate = obj.rules ?? obj.items ?? obj.data ?? []
    rows = Array.isArray(candidate) ? candidate : []
  } else {
    return []
  }

  const out: SopRule[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const toolPattern = r.toolPattern ?? r.tool_pattern
    const action = String(r.action ?? '').toLowerCase()
    if (typeof toolPattern !== 'string' || !toolPattern) continue
    if (!KNOWN_ACTIONS.has(action)) continue
    const arg = r.argPattern ?? r.arg_pattern
    out.push({
      id: String(r.id ?? r.sopId ?? 'sop'),
      toolPattern,
      action,
      reason: String(r.reason ?? `SOP rule ${toolPattern}`),
      argPattern: typeof arg === 'string' && arg ? arg : null,
    })
  }
  return out
}

/**
 * The register as `GET /api/v1/sop/rules` answers it: the rules, and whether
 * the workspace's intervention mode is OPAQUE (`interventionMode`, absent from
 * a control plane that predates it, which reads as not OPAQUE). The gate uses
 * the mode when there is no policy snapshot to read it from.
 */
export interface SopRegister {
  rules: SopRule[]
  opaque: boolean
}

/** {@link parseRules}, and the `interventionMode` beside them. */
export function parseRegister(payload: unknown): SopRegister {
  const mode =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).interventionMode
      : undefined
  return { rules: parseRules(payload), opaque: isOpaqueInterventionMode(mode) }
}

/**
 * Fetch active VALIDATED rules, or `null` if they could not be fetched.
 *
 * `null` and `[]` mean different things and the caller must not conflate
 * them: `null` is "the register did not answer", `[]` is "the register
 * answered and this workspace has no rules". Only the second is a statement
 * about policy.
 */
export async function fetchRules(
  baseUrl: string,
  apiKey: string,
  workspaceId: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<SopRule[] | null> {
  const register = await fetchRegister(baseUrl, apiKey, workspaceId, timeoutMs)
  return register === null ? null : register.rules
}

/** {@link fetchRules} with the workspace's mode: `null` if the register did not answer. */
export async function fetchRegister(
  baseUrl: string,
  apiKey: string,
  workspaceId: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<SopRegister | null> {
  const qs = new URLSearchParams({ workspaceId, active: 'true' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/sop/rules?${qs.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Workspace-Id': workspaceId,
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const raw = await res.text()
    return parseRegister(raw ? JSON.parse(raw) : {})
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * True when the control plane emitted at least one usable `argPattern`.
 *
 * A control plane that predates the ` WHERE ` clause cannot produce one, so
 * this doubles as a deployment probe — surface it rather than letting the
 * tier be silently inert.
 */
export function supportsArgPatterns(rules: readonly SopRule[]): boolean {
  return rules.some((r) => r.argPattern !== null && compiles(r.argPattern))
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

// Higher decides: a refusal wins over a hold, a hold over a flag.
const SEVERITY: Readonly<Record<string, number>> = { [ACTION_BLOCK]: 3, [ACTION_APPROVAL]: 2, [ACTION_WARN]: 1 }

/**
 * The rule that decides this call: the most severe one matching it (block,
 * then require_approval, then warn), the first of that severity in
 * control-plane order. `null` when none matches.
 */
export function firstMatch(
  rules: readonly SopRule[],
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined,
): SopRule | null {
  const payload = serialiseToolInput(toolInput)
  let decided: SopRule | null = null
  for (const rule of rules) {
    if (decided !== null && (SEVERITY[rule.action] ?? 0) <= (SEVERITY[decided.action] ?? 0)) continue
    if (!ruleMatches(rule, toolName, payload)) continue
    decided = rule
    if (rule.action === ACTION_BLOCK) break
  }
  return decided
}
