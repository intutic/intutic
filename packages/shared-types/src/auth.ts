/**
 * Auth + RBAC Types — Shared across control plane services.
 *
 * LLD #7 — Auth, RBAC, Dashboard API
 * HLD §5.1 — Zero-Trust Perimeter
 *
 * @module
 */

import { z } from 'zod'
import type { WorkspaceRole } from './enums.js'

// ─── Auth Context ────────────────────────────────────────────────────

/**
 * Auth context injected by middleware on every authenticated request.
 * Available via `c.get('auth')` in Hono handlers.
 */
export interface AuthContext {
  /** The workspace member ID (PK of workspace_members). */
  memberId: string
  /** The workspace this member belongs to. */
  workspaceId: string
  /** Display-facing email of the authenticated member. */
  email: string
  /** RBAC role within the workspace. */
  role: WorkspaceRole
  /** Cross-workspace user ID (LLD #11). Optional for pre-migration members. */
  userId?: string
  /**
   * The org the workspace belongs to (denormalized `workspaces.orgId`,
   * LLD #71). Optional: cached auth entries written before this field
   * existed lack it, and readers must treat absence as "unknown", never as
   * "no org" — the proxy's cell org-pinning revalidates via the control
   * plane in that case rather than guessing.
   */
  orgId?: string
}

// ─── JWT ─────────────────────────────────────────────────────────────

/** JWT access token payload (compact claims). */
export interface JwtPayload {
  /** Subject — member_id */
  sub: string
  /** Workspace ID */
  wid: string
  /** RBAC role */
  role: WorkspaceRole
  /** Issued at (epoch seconds) */
  iat: number
  /** Expiry (epoch seconds) */
  exp: number
}

// ─── Login ───────────────────────────────────────────────────────────

/** Login request schema (Zod validated). */
export const LoginInputSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(8).max(128),
})

/** Login request input. */
export type LoginInput = z.infer<typeof LoginInputSchema>

/** Login response payload. */
export interface LoginResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  member: WorkspaceMemberInfo
}

// ─── Register ────────────────────────────────────────────────────────

/** Registration request schema (Zod validated). */
export const RegisterInputSchema = z.object({
  email: z.string().email().max(256),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128),
  workspaceName: z.string().min(1).max(128),
  workspaceSlug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  signupSource: z.string().max(32).optional(),
  marketingAttribution: z.record(z.any()).optional(),
})

/** Registration request input. */
export type RegisterInput = z.infer<typeof RegisterInputSchema>

/** Registration response payload. */
export interface RegisterResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  member: WorkspaceMemberInfo
  workspaceId: string
}

// ─── Refresh ─────────────────────────────────────────────────────────

/** Token refresh request schema. */
export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1),
})

/** Token refresh response. */
export interface RefreshResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

// ─── Change Password ─────────────────────────────────────────────────

/** Change password request schema. */
export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
})

// ─── Member Info ─────────────────────────────────────────────────────

/** Safe projection of a workspace member (no password hash). */
export interface WorkspaceMemberInfo {
  memberId: string
  workspaceId: string
  email: string
  displayName: string
  role: WorkspaceRole
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  /**
   * The workspace's org (tenancy phase 1, migration 130) -- optional because
   * most `WorkspaceMemberInfo` construction sites (signup responses) return
   * org info separately in their own `org: {...}` field already, so this
   * would be redundant there. Only `GET /api/v1/auth/me` populates it, for
   * the dashboard to resolve which org's teams/gateway-defaults apply
   * without a second round-trip.
   */
  orgId?: string
}

// ─── Member Invite ───────────────────────────────────────────────────

/** Invite member request schema. */
export const InviteMemberInputSchema = z.object({
  email: z.string().email().max(256),
  displayName: z.string().min(1).max(128),
  role: z.enum(['ADMIN', 'EM', 'DEVELOPER', 'VIEWER']),
  tempPassword: z.string().min(8).max(128),
})

/** Invite member input. */
export type InviteMemberInput = z.infer<typeof InviteMemberInputSchema>

// ─── Role Update ─────────────────────────────────────────────────────

/** Update role request schema. */
export const UpdateRoleInputSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'EM', 'DEVELOPER', 'VIEWER']),
})

// ─── PLG Self-Serve Signup (LLD #9) ───────────────────────────────────

/** PLG signup input schema. */
export const SignupInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(128),
  workspaceName: z.string().min(1).max(64).optional(),
  signupSource: z.string().max(32).optional(),
  marketingAttribution: z.record(z.any()).optional(),
})

/** PLG signup params type. */
export type SignupParams = z.infer<typeof SignupInputSchema>

/** PLG signup result. */
export interface SignupResult {
  user: {
    id: string
    email: string
    name: string
    emailVerified: boolean
  }
  workspace: {
    id: string
    name: string
    planTier: string
    trialExpiresAt: string
  }
  accessToken: string
  refreshToken: string
  cliInstall: string
  isNewUser: boolean
}

// ─── Org Signup (Tenancy phase 4) ─────────────────────────────────────

/**
 * Org signup input schema. Distinct from `SignupInputSchema`: `orgName` is
 * required (no "N's workspace" auto-name fallback — an org identity is the
 * point of this path), and there is no `workspaceName` — the org's default
 * workspace is named from the org itself.
 */
export const OrgSignupInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(128),
  orgName: z.string().min(1).max(128),
  /**
   * The company's own domain (e.g. "acme.com") — informational, stored in
   * `orgs.settings.domain` (LLD #71). Deliberately NOT the cell hostname:
   * the org's slug is the subdomain under gateway.intutic.ai, so no domain
   * verification is needed here.
   */
  orgDomain: z
    .string()
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, 'must be a bare domain like acme.com')
    .optional(),
  signupSource: z.string().max(32).optional(),
  marketingAttribution: z.record(z.any()).optional(),
})

/** Org signup params type. */
export type OrgSignupParams = z.infer<typeof OrgSignupInputSchema>

/** Org signup result — same shape as SignupResult, plus the org identity. */
export interface OrgSignupResult {
  user: {
    id: string
    email: string
    name: string
    emailVerified: boolean
  }
  org: {
    id: string
    name: string
    planTier: string
    trialExpiresAt: string
  }
  workspace: {
    id: string
    name: string
    planTier: string
    trialExpiresAt: string
  }
  accessToken: string
  refreshToken: string
  cliInstall: string
  isNewUser: boolean
}

/** Verify email input schema. */
export const VerifyEmailInputSchema = z.object({
  token: z.string().length(64),
})

/** Resend verification email input schema. */
export const ResendVerificationInputSchema = z.object({
  email: z.string().email(),
})

/** Magic link request schema (Zod validated). */
export const MagicLinkRequestInputSchema = z.object({
  email: z.string().email().max(256),
})

/** Magic link request input. */
export type MagicLinkRequestInput = z.infer<typeof MagicLinkRequestInputSchema>

/** Magic link login schema (Zod validated). */
export const MagicLinkLoginInputSchema = z.object({
  token: z.string().min(1),
})

/** Magic link login input. */
export type MagicLinkLoginInput = z.infer<typeof MagicLinkLoginInputSchema>



// ─── API Key ─────────────────────────────────────────────────────────

/** API key creation request schema. */
export const CreateApiKeyInputSchema = z.object({
  label: z.string().min(1).max(128),
  scopes: z.array(z.string()).default(['*']),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /**
   * Automation key: exempt from the `ssoKeyMaxIdleDays` recency gate, because its
   * owner may never log in interactively. Still bound to the member's active flag
   * and still revocable, so offboarding applies (TD-218).
   */
  isServiceAccount: z.boolean().default(false),
})

/** API key creation input. */
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>

/** API key creation result (plaintext key returned ONCE). */
export interface CreateApiKeyResult {
  keyId: string
  /** Plaintext vk_* token — returned ONCE, never stored. */
  key: string
  keyPrefix: string
  label: string
  scopes: string[]
  expiresAt: string | null
  createdAt: string
}

/** Safe projection of an API key (no key_hash, no plaintext). */
export interface ApiKeyInfo {
  keyId: string
  keyPrefix: string
  label: string
  scopes: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

// ─── Dashboard Summary ──────────────────────────────────────────────

/**
 * Workspace dashboard summary — aggregated metrics for EM Dashboard.
 * Phase 1 provides JSON API; the EM Dashboard UI is Phase 2 (TD-032).
 * HLD §8b.1
 */
export interface DashboardSummary {
  /** Total active sessions in the workspace. */
  activeSessions: number
  /**
   * Sessions opened with `executionMode: 'SANDBOX'` in the last 30 days —
   * `intutic exec --sandbox` runs (LLD #63 §6). A 30-day window rather than
   * "active" because a sandbox run is typically short-lived.
   */
  sandboxSessions30d: number
  /** Budget utilization (current month spend vs. budget). */
  budgetUtilization: {
    spentUsd: number
    budgetUsd: number
    percentUsed: number
  }
  /** Anomaly count in the last 24 hours by category. */
  anomalyCount24h: number
  /** SOP health summary. */
  sopHealth: {
    /** Enforced — `VALIDATED` only. Every runtime gate filters on that state. */
    totalActive: number
    /**
     * Synced into agent context and read by the model, but enforced by nothing:
     * `HYPOTHESIZED` and `REFINED`.
     *
     * Separate from `totalActive` because folding them in overstates what is
     * enforced, and dropping them understates what is deployed — this field
     * exists because the count previously did both at once.
     */
    totalAdvisory: number
    totalStale: number
    totalInvalidated: number
  }
  /** Recent governance incidents (last 5). */
  recentIncidents: Array<{
    incidentId: string
    sessionId: string
    category: string
    severity: string
    createdAt: string
  }>

  // ── Optional UI Chart Metrics (Phase 2) ──
  agentSuccessRate?: Array<{
    date: string
    rate: number
  }>
  tokenEfficiency?: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    wastedTokens: number
  }>
  recurringFailures?: Array<{
    pattern: string
    count: number
    severity: 'critical' | 'high' | 'medium' | 'low'
  }>
  sopAdherence?: Array<{
    date: string
    adherenceRate: number
    threshold: number
  }>
  wastedTokenBreakdown?: Array<{
    category: string
    tokens: number
    percentOfTotal: number
  }>
  /**
   * Bytes the SnipCompactor removed from response bodies in the window.
   *
   * Bytes, not tokens, and deliberately outside `wastedTokenBreakdown` — the
   * two cannot share a pie. Compaction is response-side, so its benefit lands
   * in the next turn's prompt rather than reducing this window's input count.
   */
  toolOutputTrimmedBytes?: number
  costSavings?: {
    rawCostUsd: number
    actualCostUsd: number
    savedUsd: number
    savingsPercent: number
  }
}

