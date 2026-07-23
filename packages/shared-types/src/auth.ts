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
    totalActive: number
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
    sopId?: string
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
  costSavings?: {
    rawCostUsd: number
    actualCostUsd: number
    savedUsd: number
    savingsPercent: number
  }
}

