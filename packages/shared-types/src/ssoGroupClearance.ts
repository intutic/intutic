/**
 * SSO-group tool clearance — the one evaluator.
 *
 * A workspace's `sso_group_policy` names high-risk tools, the IdP groups that
 * clear them, and tools that only an on-behalf-of token may call. These places
 * decide a tool call against it: the control plane's hook gate
 * (`resolveSsoGroupPrivilege`), the MCP proxy, the Rust proxy's response gate,
 * and — through the policy snapshot the sync daemon compiles with this
 * function — every harness gate. `@intutic/gate`, `intutic-clawde` and the Rust
 * proxy (`packages/proxy/src/sso_groups.rs`) cannot depend on this package, so
 * they carry ports; `fixtures/sso-group-clearance-vectors.json` holds all of
 * them to the same answers.
 *
 * The algorithm, in order:
 *   1. no policy                       → GRANTED
 *   2. tool on `requireOboFor`         → REQUIRES_OBO (a gate has no OBO token,
 *                                        so every gate refuses it)
 *   3. tool not on `highRiskTools`     → GRANTED
 *   4. member's groups unknown         → DENIED (fail closed; never "granted")
 *   5. member holds a `requiredGroups` → GRANTED
 *   6. otherwise                       → DENIED
 *
 * Names and groups match exactly — no case folding, no patterns — because
 * that is what the server has always done and a gate that matched more loosely
 * would refuse calls the server allows. The one widening is MCP's two names
 * for one tool ({@link ssoGroupToolMatches}): an entry naming the tool as its
 * server declares it (`run_query`) also matches the name a harness hook sees
 * (`mcp__postgres__run_query`), at every gate.
 *
 * @module
 */

import { z } from 'zod'

import type { SsoGroupClearance, SsoGroupPolicy } from './attenuation.js'

export interface SsoGroupDecision {
  clearance: SsoGroupClearance
  /** `sso_group.<require_obo|high_risk>.<tool>` when the call is refused, else null. */
  ruleId: string | null
  /** Why the call is refused; empty when it is granted. */
  reason: string
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** One tool or group name: matched exactly, so no trimming happens anywhere. */
const SsoGroupNameSchema = z.string().min(1).max(256)
const SsoGroupNameListSchema = z.array(SsoGroupNameSchema).max(500).default([])

/**
 * The shape of `sso_group_policy` — the one definition. The settings PUT
 * validates a write against it (and refuses anything else with a 400 naming
 * the field), and {@link parseSsoGroupPolicy} reads a stored value through it.
 * Each list is optional on write and defaults to empty.
 */
export const SsoGroupPolicySchema = z
  .object({
    highRiskTools: SsoGroupNameListSchema,
    requiredGroups: SsoGroupNameListSchema,
    requireOboFor: SsoGroupNameListSchema,
  })
  .strict()

/**
 * Reads a stored `sso_group_policy`. A value the settings route wrote passes
 * {@link SsoGroupPolicySchema} as it is. One that reached the row some other
 * way is still read rather than dropped: null only when there is no policy
 * object at all; a wrong-typed list reads as empty and non-string entries are
 * dropped, so a malformed `requiredGroups` leaves every high-risk tool denied
 * rather than the whole policy silently gone.
 */
export function parseSsoGroupPolicy(value: unknown): SsoGroupPolicy | null {
  const valid = SsoGroupPolicySchema.safeParse(value)
  if (valid.success) return valid.data
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  const policy = {} as SsoGroupPolicy
  for (const key of Object.keys(SsoGroupPolicySchema.shape) as Array<keyof SsoGroupPolicy>) {
    policy[key] = stringList(p[key])
  }
  return policy
}

/** A rule id that survives `ruleIdFromReason` (`[A-Za-z0-9_.:-]`). */
export function ssoGroupRuleId(kind: 'require_obo' | 'high_risk', toolName: string): string {
  return `sso_group.${kind}.${toolName.replace(/[^A-Za-z0-9_.:-]/g, '_')}`
}

/**
 * Whether a call that goes by `name` is the tool a policy entry names.
 *
 * Exactly, or — for an entry that is an MCP tool's own name, not starting
 * with `mcp__` — as the name a harness hook gives that tool on any server:
 * `mcp__<server>__<entry>`, the server part non-empty. The MCP proxy sees
 * `run_query` where Claude Code's hook sees `mcp__postgres__run_query`, so
 * without this an entry written one way held at one gate and not the other.
 * An entry that already names the harness form (`mcp__postgres__run_query`)
 * matches only that server's tool.
 */
export function ssoGroupToolMatches(entry: string, name: string): boolean {
  if (name === entry) return true
  if (entry.startsWith('mcp__') || !name.startsWith('mcp__')) return false
  const suffix = `__${entry}`
  return name.length > 'mcp__'.length + suffix.length && name.endsWith(suffix)
}

/**
 * The first entry of `list` a call matches: an exact match on any of its
 * names first, then an MCP tool's own name matching a harness name.
 */
function matchingEntry(list: readonly string[], names: readonly string[]): string | undefined {
  const exact = names.find((n) => list.includes(n))
  if (exact !== undefined) return exact
  for (const n of names) {
    const entry = list.find((e) => ssoGroupToolMatches(e, n))
    if (entry !== undefined) return entry
  }
  return undefined
}

/**
 * Decides one tool call. `toolNames` is every name the call goes by — the MCP
 * proxy sees `create_issue` where a harness hook sees
 * `mcp__github__create_issue` — and a policy entry naming any of them applies
 * ({@link ssoGroupToolMatches}). The rule id and reason name the entry.
 * `memberGroups` null means the caller does not know the member's groups.
 */
export function evaluateSsoGroupClearance(
  policy: SsoGroupPolicy | null,
  toolNames: string | readonly string[],
  memberGroups: readonly string[] | null,
): SsoGroupDecision {
  if (!policy) return { clearance: 'GRANTED', ruleId: null, reason: '' }
  const names = typeof toolNames === 'string' ? [toolNames] : toolNames

  const obo = matchingEntry(policy.requireOboFor, names)
  if (obo !== undefined) {
    return {
      clearance: 'REQUIRES_OBO',
      ruleId: ssoGroupRuleId('require_obo', obo),
      reason: `SSO group policy: ${obo} is on-behalf-of only, and a tool-call gate has no OBO token to present`,
    }
  }

  const risky = matchingEntry(policy.highRiskTools, names)
  if (risky === undefined) return { clearance: 'GRANTED', ruleId: null, reason: '' }
  if (memberGroups && policy.requiredGroups.some((g) => memberGroups.includes(g))) {
    return { clearance: 'GRANTED', ruleId: null, reason: '' }
  }

  const groups = policy.requiredGroups.length > 0 ? policy.requiredGroups.join(', ') : '(none configured)'
  return {
    clearance: 'DENIED',
    ruleId: ssoGroupRuleId('high_risk', risky),
    reason: memberGroups
      ? `SSO group policy: ${risky} requires one of the SSO groups ${groups}, and this member holds none of them`
      : `SSO group policy: ${risky} requires one of the SSO groups ${groups}, and this gate does not know the member's groups`,
  }
}

// ─── The policy-snapshot record ──────────────────────────────────────

/**
 * What a policy snapshot carries about SSO groups: the workspace's policy and
 * the member the snapshot was issued to, with their groups as the control
 * plane resolved them at `issuedAt`. `member` is null when the control plane
 * named no member for the key, and every gate then treats the groups as
 * unknown.
 */
export interface SsoGroupRecord {
  policy: SsoGroupPolicy
  member: { memberId: string; ssoGroups: string[] } | null
  issuedAt: string
}

/**
 * First column of the record's line in `policy-snapshot.rules`.
 *
 * The record is a data line, not a `#` header, on purpose: every gate's digest
 * covers exactly the non-`#` lines, so the member's groups are inside the
 * integrity check every deployed gate already performs, and an edited group
 * list fails it. Two columns, so every rule parser (which needs six) skips it.
 */
export const SSO_GROUP_RECORD_TAG = '@sso_groups'

function toBase64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(b64: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

/** The record as one `.rules` line: the tag, a tab, base64 of its JSON. */
export function encodeSsoGroupRecord(record: SsoGroupRecord): string {
  return `${SSO_GROUP_RECORD_TAG}\t${toBase64(JSON.stringify(record))}`
}

/** Reads a record line back; null for any other line or a damaged one. */
export function decodeSsoGroupRecord(line: string): SsoGroupRecord | null {
  const [tag, b64, ...rest] = line.split('\t')
  if (tag !== SSO_GROUP_RECORD_TAG || !b64 || rest.length > 0) return null
  try {
    const raw = JSON.parse(fromBase64(b64)) as Record<string, unknown>
    const policy = parseSsoGroupPolicy(raw['policy'])
    if (!policy || typeof raw['issuedAt'] !== 'string') return null
    const m = raw['member'] as Record<string, unknown> | null
    const member =
      m && typeof m === 'object' && typeof m['memberId'] === 'string'
        ? { memberId: m['memberId'], ssoGroups: stringList(m['ssoGroups']) }
        : null
    return { policy, member, issuedAt: raw['issuedAt'] }
  } catch {
    return null
  }
}
