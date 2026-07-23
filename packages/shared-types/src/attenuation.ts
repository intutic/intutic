/**
 * Attenuation & GDPR types — LLD #19 (Enterprise Identity & Compliance)
 *
 * DCT Token Attenuation (Patent Family A), OBO Ephemeral Tokens,
 * PointerMemory GDPR erasure, and SSO Group Privilege Scoping.
 *
 * HLD §5.1, §5.6 — Zero-Trust Identity Broker
 *
 * @module
 */

import { z } from 'zod'

// ─── OBO Ephemeral Token ─────────────────────────────────────────────

/**
 * OBO (On-Behalf-Of) token grant — short-lived, employee-scoped
 * JWT issued per harness session.
 *
 * HLD §5.6 — per-employee ephemeral scoping.
 */
export interface OboTokenGrant {
  /** Unique grant identifier — `newId('obo')` */
  grantId: string
  /** Issuing workspace member ID */
  memberId: string
  /** Workspace scope */
  workspaceId: string
  /** Optional agent session binding */
  sessionId: string | null
  /** Allow-list of tool names this token grants access to */
  scopedTools: string[]
  /** Plaintext short-lived JWT — returned ONCE on issuance */
  oboToken: string
  /** Grant expiry (ISO-8601, 15 min from issuance) */
  expiresAt: string
}

/** Request schema for OBO token issuance. */
export const IssueOboTokenInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  scopedTools: z.array(z.string().min(1)).min(1, 'At least one tool must be specified'),
})
export type IssueOboTokenInput = z.infer<typeof IssueOboTokenInputSchema>

// ─── Token Attenuation (DCT — Patent Family A) ───────────────────────

/**
 * Result returned from a successful token attenuation handshake.
 * The plaintext child key is returned ONCE and never stored.
 */
export interface AttenuationResult {
  /** Plaintext `vk_*` child key — returned ONCE */
  childKey: string
  /** child api_keys.key_id */
  childKeyId: string
  /** attenuation_chains.chain_id */
  attenuationChainId: string
  /** Verified subset of parent capabilities granted to child */
  grantedCaps: string[]
  /** Child key expiry (ISO-8601) */
  expiresAt: string
}

/**
 * A single link in the attenuation delegation lineage chain.
 */
export interface AttenuationChainLink {
  /** attenuation_chains.chain_id */
  chainId: string
  /** Parent api_keys.key_id */
  parentKeyId: string
  /** Child api_keys.key_id */
  childKeyId: string
  /** Workspace scope */
  workspaceId: string
  /** Capabilities granted to the child key */
  grantedCaps: string[]
  /** Chain expiry (ISO-8601) */
  expiresAt: string
  /** Creation timestamp (ISO-8601) */
  createdAt: string
}

/** Request schema for token attenuation. */
export const AttenuateTokenInputSchema = z.object({
  parentKeyId: z.string().min(1),
  requestedCaps: z.array(z.string().min(1)).min(1, 'At least one capability must be requested'),
  ttlSeconds: z.number().int().min(60).max(86400).optional(),
})
export type AttenuateTokenInput = z.infer<typeof AttenuateTokenInputSchema>


// ─── SSO Group Privilege Scoping ─────────────────────────────────────

/**
 * Result of SSO group → tool clearance resolution.
 * - GRANTED: member has required SSO group; tool execution allowed
 * - DENIED: member lacks required SSO group; tool blocked
 * - REQUIRES_OBO: tool requires an active OBO token with this tool in scopedTools
 */
export type SsoGroupClearance = 'GRANTED' | 'DENIED' | 'REQUIRES_OBO'

/**
 * Workspace SSO group policy configuration.
 * Stored in workspaces.settings->>'sso_group_policy' as JSONB.
 */
export interface SsoGroupPolicy {
  /** Tools gated by SSO group membership (e.g. ['bash', 'file_write', 'database_write']) */
  highRiskTools: string[]
  /** IdP group names that grant clearance for high-risk tools */
  requiredGroups: string[]
  /** Tools that always require an OBO token regardless of group membership */
  requireOboFor: string[]
}
