/**
 * SSO-group tool clearance, read from the policy snapshot.
 *
 * Port of `evaluateSsoGroupClearance` and the `@sso_groups` record in
 * `packages/shared-types/src/ssoGroupClearance.ts` — the evaluator the control
 * plane's hook gate, the MCP proxy and the sync daemon's snapshot compiler
 * share. This package has no workspace dependencies, so it carries a copy, and
 * `src/__tests__/ssoGroups.test.ts` runs the shared vectors
 * (`packages/shared-types/fixtures/sso-group-clearance-vectors.json`) through
 * it so the copy cannot drift. `intutic_clawde/gate/sso_groups.py` is the
 * Python port of the same thing.
 *
 * The snapshot's record carries the workspace's policy and the member the
 * snapshot was issued to, with their groups as the control plane resolved
 * them. It sits inside the snapshot's digest; when the digest fails, the gate
 * still applies the policy but treats the member's groups as unknown, so an
 * edited group list clears nothing.
 */

export type SsoGroupClearance = 'GRANTED' | 'DENIED' | 'REQUIRES_OBO'

export interface SsoGroupPolicy {
  highRiskTools: string[]
  requiredGroups: string[]
  requireOboFor: string[]
}

export interface SsoGroupRecord {
  policy: SsoGroupPolicy
  member: { memberId: string; ssoGroups: string[] } | null
  issuedAt: string
}

export interface SsoGroupDecision {
  clearance: SsoGroupClearance
  ruleId: string | null
  reason: string
}

export const SSO_GROUP_RECORD_TAG = '@sso_groups'

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function parseSsoGroupPolicy(value: unknown): SsoGroupPolicy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  return {
    highRiskTools: stringList(p['highRiskTools']),
    requiredGroups: stringList(p['requiredGroups']),
    requireOboFor: stringList(p['requireOboFor']),
  }
}

function ruleId(kind: 'require_obo' | 'high_risk', toolName: string): string {
  return `sso_group.${kind}.${toolName.replace(/[^A-Za-z0-9_.:-]/g, '_')}`
}

/**
 * Whether a call named `name` is the tool a policy entry names: exactly, or,
 * for an entry that is an MCP tool's own name (not starting with `mcp__`), as
 * the name a harness gives it on any server, `mcp__<server>__<entry>`.
 */
export function ssoGroupToolMatches(entry: string, name: string): boolean {
  if (name === entry) return true
  if (entry.startsWith('mcp__') || !name.startsWith('mcp__')) return false
  const suffix = `__${entry}`
  return name.length > 'mcp__'.length + suffix.length && name.endsWith(suffix)
}

function matchingEntry(list: readonly string[], toolName: string): string | undefined {
  if (list.includes(toolName)) return toolName
  return list.find((e) => ssoGroupToolMatches(e, toolName))
}

/** `memberGroups` null means the groups are unknown — a high-risk tool is then refused. */
export function evaluateSsoGroupClearance(
  policy: SsoGroupPolicy | null,
  toolName: string,
  memberGroups: readonly string[] | null,
): SsoGroupDecision {
  if (!policy) return { clearance: 'GRANTED', ruleId: null, reason: '' }
  const obo = matchingEntry(policy.requireOboFor, toolName)
  if (obo !== undefined) {
    return {
      clearance: 'REQUIRES_OBO',
      ruleId: ruleId('require_obo', obo),
      reason: `SSO group policy: ${obo} is on-behalf-of only, and a tool-call gate has no OBO token to present`,
    }
  }
  const risky = matchingEntry(policy.highRiskTools, toolName)
  if (risky === undefined) return { clearance: 'GRANTED', ruleId: null, reason: '' }
  if (memberGroups && policy.requiredGroups.some((g) => memberGroups.includes(g))) {
    return { clearance: 'GRANTED', ruleId: null, reason: '' }
  }
  const groups = policy.requiredGroups.length > 0 ? policy.requiredGroups.join(', ') : '(none configured)'
  return {
    clearance: 'DENIED',
    ruleId: ruleId('high_risk', risky),
    reason: memberGroups
      ? `SSO group policy: ${risky} requires one of the SSO groups ${groups}, and this member holds none of them`
      : `SSO group policy: ${risky} requires one of the SSO groups ${groups}, and this gate does not know the member's groups`,
  }
}

/** Reads the snapshot's record line; null for any other line or a damaged one. */
export function decodeSsoGroupRecord(line: string): SsoGroupRecord | null {
  const [tag, b64, ...rest] = line.split('\t')
  if (tag !== SSO_GROUP_RECORD_TAG || !b64 || rest.length > 0) return null
  try {
    const raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
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
