/**
 * Responses of the control plane routes in auth.ts, domainVerification.ts, orgs.ts, teams.ts, members.ts, trial.ts, keys.ts, budget.ts, and the signing key set in app.ts.
 *
 * @module
 */
import { z } from 'zod'
import { IsoTimestamp, listEnvelope } from './common.js'

// ─── Shared pieces ───────────────────────────────────────────────────

/** A member's RBAC role in a workspace (`workspace_role_type`). */
const MemberRole = z.enum(['OWNER', 'ADMIN', 'EM', 'DEVELOPER', 'VIEWER'])

/** Whether a budget refuses requests (`hard`) or only alerts (`soft`). */
const Enforcement = z.enum(['hard', 'soft'])

/** One spend budget of a key or member (`spendBudgetService.ts` `toSpendBudget`). */
const SpendBudgetRow = z.object({
  period: z.enum(['day', 'month']),
  limitUsd: z.number(),
  enforcement: Enforcement,
})

/** A key's per-minute limits; `null` is no limit. */
const KeyRateLimitRow = z.object({
  rpm: z.number().int().nullable(),
  tpm: z.number().int().nullable(),
})

// ─── GET /.well-known/intutic-trace-signing.json (app.ts) ────────────

/** One published trace-signing key: the public half of an Ed25519 key as a JWK (`rootSigner.ts` `publicJwks`). */
const TraceSigningJwk = z.object({
  kty: z.string().describe('Key type; `OKP` for the Ed25519 keys the control plane signs with.'),
  crv: z.string().describe('Curve; `Ed25519`.'),
  x: z.string().describe('The public key, base64url.'),
  use: z.literal('sig'),
  alg: z.literal('EdDSA'),
  kid: z.string().describe('RFC 7638 thumbprint of the key; a sealed root names it as `signing_key_id`.'),
})

/** `GET /.well-known/intutic-trace-signing.json`: the active key and any retired ones still verifying old roots; empty when none is configured. */
export const TraceSigningJwksResponse = z.object({ keys: z.array(TraceSigningJwk) })
export type TraceSigningJwksResponse = z.infer<typeof TraceSigningJwksResponse>

// ─── Auth (auth.ts) ──────────────────────────────────────────────────

/** A workspace member without credentials (`toMemberInfo` in `authService.ts` / `memberService.ts`). */
export const MemberInfoResponse = z.object({
  memberId: z.string(),
  workspaceId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: MemberRole,
  isActive: z.boolean(),
  lastLoginAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
})
export type MemberInfoResponse = z.infer<typeof MemberInfoResponse>

/** `GET /api/v1/auth/me`: the caller's member row and its workspace's org. */
export const AuthMeResponse = MemberInfoResponse.extend({ orgId: z.string() })
export type AuthMeResponse = z.infer<typeof AuthMeResponse>

/**
 * A session as a client that reads tokens from the body receives it. A
 * cookie client (one sending `X-Intutic-CSRF`) gets the same body without
 * `refreshToken`, which travels in the HttpOnly refresh cookie instead.
 */
export const LoginTokensResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe('Seconds until `accessToken` expires.'),
  member: MemberInfoResponse,
})
export type LoginTokensResponse = z.infer<typeof LoginTokensResponse>

/** `POST /api/v1/auth/login`: `LoginTokensResponse`, without `refreshToken` for a cookie client. */
export const LoginResponse = z.union([LoginTokensResponse, LoginTokensResponse.omit({ refreshToken: true })])
export type LoginResponse = z.infer<typeof LoginResponse>

/** A rotated token pair, as a client that reads tokens from the body receives it. */
export const RefreshTokensResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe('Seconds until `accessToken` expires.'),
})
export type RefreshTokensResponse = z.infer<typeof RefreshTokensResponse>

/** `POST /api/v1/auth/refresh`: `RefreshTokensResponse`, without `refreshToken` for a cookie client. */
export const RefreshResponse = z.union([RefreshTokensResponse, RefreshTokensResponse.omit({ refreshToken: true })])
export type RefreshResponse = z.infer<typeof RefreshResponse>

/** The org, or workspace, a signup created. */
const SignupTenant = z.object({
  id: z.string(),
  name: z.string(),
  planTier: z.string(),
  trialExpiresAt: IsoTimestamp,
})

/** An org signup as a client that reads tokens from the body receives it (`signupService.ts` `signupOrg`). */
export const OrgSignupTokensResponse = z.object({
  user: z.object({
    id: z.string().describe('The new member id.'),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
  }),
  org: SignupTenant,
  workspace: SignupTenant.describe("The org's default workspace."),
  accessToken: z.string(),
  refreshToken: z.string(),
  cliInstall: z.string().describe('The command that installs the CLI.'),
  isNewUser: z.boolean(),
})
export type OrgSignupTokensResponse = z.infer<typeof OrgSignupTokensResponse>

/** `POST /api/v1/auth/signup/org`: `OrgSignupTokensResponse`, without `refreshToken` for a cookie client. */
export const OrgSignupResponse = z.union([OrgSignupTokensResponse, OrgSignupTokensResponse.omit({ refreshToken: true })])
export type OrgSignupResponse = z.infer<typeof OrgSignupResponse>

/** `GET /api/v1/auth/session`: who the session is, on which workspace. */
export const AuthSessionResponse = z.object({
  memberId: z.string(),
  workspaceId: z.string(),
  email: z.string(),
  role: MemberRole,
  refreshToken: z
    .string()
    .optional()
    .describe('Only on a workspace switch (`X-Workspace-Id`) by a client that reads tokens from the body: a refresh token for the new workspace.'),
})
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>

// ─── Domain verification (domainVerification.ts) ─────────────────────

/** `POST /api/v1/domain-verification/start`: the TXT record to publish (`domainVerificationService.ts`). */
export const DomainVerificationStartResponse = z.object({
  verificationId: z.string(),
  domain: z.string().describe('The domain, normalized (lowercase, no scheme or path).'),
  txtRecordName: z.string().describe('Where to publish the TXT record: `_intutic-verify.<domain>`.'),
  txtRecordValue: z.string().describe('The token the TXT record must hold.'),
  expiresAt: IsoTimestamp,
})
export type DomainVerificationStartResponse = z.infer<typeof DomainVerificationStartResponse>

/** `GET /api/v1/domain-verification/:id`: the verification after a fresh DNS check. */
export const DomainVerificationResponse = z.object({
  verificationId: z.string(),
  domain: z.string(),
  status: z
    .enum(['pending', 'verified', 'consumed', 'expired'])
    .describe('`verified` once the TXT record was seen; `consumed` once an org was created from it.'),
  txtRecordName: z.string(),
  txtRecordValue: z.string(),
  verifiedAt: IsoTimestamp.nullable(),
})
export type DomainVerificationResponse = z.infer<typeof DomainVerificationResponse>

// ─── Orgs and teams (orgs.ts, teams.ts) ──────────────────────────────

/** `POST /api/v1/orgs`: the org created, with its default team and workspace. */
export const OrgCreateResponse = z.object({
  orgId: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  planTier: z.string(),
  region: z.string().describe("The region the org's managed gateway cell is placed in."),
})
export type OrgCreateResponse = z.infer<typeof OrgCreateResponse>

/** `PATCH /api/v1/orgs/:orgId/gateway`: the org's default gateway; `null` when cleared. */
export const OrgGatewayResponse = z.object({ orgId: z.string(), gatewayId: z.string().nullable() })
export type OrgGatewayResponse = z.infer<typeof OrgGatewayResponse>

/** A team (`teams` row). */
const TeamRow = z.object({
  teamId: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})

/** `GET /api/v1/orgs/:orgId/teams`: the org's teams, oldest first. */
export const TeamListResponse = z.object({ data: z.array(TeamRow) })
export type TeamListResponse = z.infer<typeof TeamListResponse>

/** `POST /api/v1/orgs/:orgId/teams`: the team created. */
export const TeamCreateResponse = z.object({ teamId: z.string(), orgId: z.string(), name: z.string() })
export type TeamCreateResponse = z.infer<typeof TeamCreateResponse>

/** A workspace under a team. */
const TeamWorkspaceRow = z.object({
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  planTier: z.string(),
  createdAt: IsoTimestamp,
})

/** `GET /api/v1/teams/:teamId/workspaces`: the team's workspaces, oldest first. */
export const TeamWorkspaceListResponse = z.object({ data: z.array(TeamWorkspaceRow) })
export type TeamWorkspaceListResponse = z.infer<typeof TeamWorkspaceListResponse>

/** `POST /api/v1/teams/:teamId/workspaces`: the workspace created; the caller is its OWNER. */
export const TeamWorkspaceCreateResponse = z.object({
  workspaceId: z.string(),
  teamId: z.string(),
  orgId: z.string(),
  name: z.string(),
})
export type TeamWorkspaceCreateResponse = z.infer<typeof TeamWorkspaceCreateResponse>

// ─── Members (members.ts) ────────────────────────────────────────────

/** `GET /api/v1/members`: every member of the workspace, deactivated ones included. */
export const MemberListResponse = listEnvelope('data', 'camel').extend({ data: z.array(MemberInfoResponse) })
export type MemberListResponse = z.infer<typeof MemberListResponse>

// ─── Trial (trial.ts) ────────────────────────────────────────────────

/** `GET /api/v1/trial/status`: the workspace's plan, trial and billing term. */
export const TrialStatusResponse = z.object({
  tier: z.string().describe('The plan tier (`planSkuMap.ts`).'),
  planName: z.string(),
  trialExpiresAt: IsoTimestamp.nullable(),
  daysRemaining: z.number().int().describe('Days left in the trial; 0 with none.'),
  isTrialActive: z.boolean(),
  features: z.record(z.boolean()).describe('What the plan includes, by feature flag.'),
  limits: z
    .object({ maxTokensPerDay: z.number().int(), maxSessionsPerDay: z.number().int() })
    .describe('The limits `POST /api/v1/policy/check` enforces; -1 is unlimited.'),
  billing: z
    .object({
      interval: z.enum(['month', 'year']),
      termEndsAt: IsoTimestamp.nullable(),
      bookedChange: z
        .object({
          tier: z.string(),
          planName: z.string(),
          interval: z.enum(['month', 'year']),
          effectiveAt: z.string().describe('When the booked change takes effect (the term end).'),
        })
        .nullable()
        .describe('A plan change booked for the term end.'),
    })
    .nullable()
    .describe('How the plan is billed; null when nothing is billed through Stripe.'),
  checkoutOpen: z.boolean().describe('Whether this account may buy a plan through checkout.'),
})
export type TrialStatusResponse = z.infer<typeof TrialStatusResponse>

// ─── API keys (keys.ts) ──────────────────────────────────────────────

/** `POST /api/v1/keys`: the key created, with its plaintext — returned once, never again. */
export const ApiKeyCreateResponse = z.object({
  keyId: z.string(),
  key: z.string().describe('The plaintext `vk_` key. Shown only in this response.'),
  keyPrefix: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
  allowedModels: z.array(z.string()).nullable().describe('The key’s model allowlist; null inherits the workspace’s.'),
  expiresAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  budgets: z.array(SpendBudgetRow),
  rateLimit: KeyRateLimitRow,
})
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponse>

/** An API key without its secret (`apiKeyService.ts` `toApiKeyInfo`). */
export const ApiKeyResponse = z.object({
  keyId: z.string(),
  keyPrefix: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
  allowedModels: z.array(z.string()).nullable().describe('The key’s model allowlist; null inherits the workspace’s.'),
  expiresAt: IsoTimestamp.nullable(),
  lastUsedAt: IsoTimestamp.nullable(),
  revokedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  isServiceAccount: z.boolean(),
  budgets: z.array(SpendBudgetRow),
  rateLimit: KeyRateLimitRow,
})
export type ApiKeyResponse = z.infer<typeof ApiKeyResponse>

/** `GET /api/v1/keys`: the caller's own keys in the workspace, revoked ones included. */
export const ApiKeyListResponse = listEnvelope('data', 'camel').extend({ data: z.array(ApiKeyResponse) })
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponse>

/** `DELETE /api/v1/keys/:id`: always `{ revoked: true }`, also when the caller had no such live key. */
export const ApiKeyRevokeResponse = z.object({ revoked: z.literal(true) })
export type ApiKeyRevokeResponse = z.infer<typeof ApiKeyRevokeResponse>

// ─── Budgets (budget.ts) ─────────────────────────────────────────────

/** `GET /api/v1/budget`: the workspace's caps and its spend against them. */
export const BudgetStatusResponse = z.object({
  workspace_id: z.string(),
  monthly_budget_usd: z.number(),
  monthly_spend_usd: z.number(),
  daily_budget_usd: z.number(),
  daily_budget_is_default: z.boolean().describe('No daily cap was saved: the workspace is held to the default.'),
  daily_spend_usd: z.number(),
  pct_monthly_used: z.number(),
  pct_daily_used: z.number(),
  alert_threshold_pct: z.number(),
  daily_enforcement: Enforcement,
  monthly_enforcement: Enforcement,
  alert_triggered: z.boolean().describe('Either period’s spend is at or above the alert threshold.'),
  budget_remaining_usd: z.number().describe('Monthly cap minus monthly spend; negative when over.'),
})
export type BudgetStatusResponse = z.infer<typeof BudgetStatusResponse>

/** `PUT /api/v1/budget`. */
export const BudgetUpdateResponse = z.object({ updated: z.literal(true), workspace_id: z.string() })
export type BudgetUpdateResponse = z.infer<typeof BudgetUpdateResponse>

/** `GET /api/v1/budget/keys`: each live key's budgets, rate limit and spend. */
export const BudgetKeysResponse = listEnvelope('keys', 'camel').extend({
  keys: z.array(
    z.object({
      keyId: z.string(),
      keyPrefix: z.string(),
      label: z.string(),
      memberId: z.string(),
      memberEmail: z.string(),
      budgets: z.array(SpendBudgetRow),
      rateLimit: KeyRateLimitRow,
      spendTodayUsd: z.number(),
      spendThisMonthUsd: z.number(),
    }),
  ),
  dayResetsAt: IsoTimestamp.describe('When the UTC day’s spend resets.'),
  monthResetsAt: IsoTimestamp.describe('When the UTC month’s spend resets.'),
})
export type BudgetKeysResponse = z.infer<typeof BudgetKeysResponse>

/** `GET /api/v1/budget/members`: the default member budget and each active member's budgets and spend. */
export const BudgetMembersResponse = listEnvelope('members', 'camel').extend({
  defaultBudgets: z.array(SpendBudgetRow).describe('The budget each member without their own gets, per period.'),
  members: z.array(
    z.object({
      memberId: z.string(),
      email: z.string(),
      budgets: z.array(SpendBudgetRow).describe('The member’s own budgets.'),
      effectiveBudgets: z.array(SpendBudgetRow).describe('The budgets that apply: their own per period, else the default.'),
      spendTodayUsd: z.number(),
      spendThisMonthUsd: z.number(),
    }),
  ),
  dayResetsAt: IsoTimestamp,
  monthResetsAt: IsoTimestamp,
})
export type BudgetMembersResponse = z.infer<typeof BudgetMembersResponse>

/** `PUT` and `DELETE /api/v1/budget/members/:memberId`: the member's (or `default`'s) budgets now; empty after a delete. */
export const MemberBudgetsResponse = z.object({
  memberId: z.string().describe('The member id, or `default`.'),
  budgets: z.array(SpendBudgetRow),
})
export type MemberBudgetsResponse = z.infer<typeof MemberBudgetsResponse>
