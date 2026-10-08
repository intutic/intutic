/**
 * Usage and Token Metrics Types — Token usage breakdown and event logs.
 */

export interface UsageSummary {
  workspaceId: string
  period: 'daily' | 'weekly' | 'monthly'
  startDate: string
  endDate: string
  totalCostUsd: number
  totalRawCostUsd: number
  totalSavingsUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

export interface UsageEvent {
  trace_id: string
  timestamp: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  enforcement_action: string
  token_utility: 'USEFUL' | 'WASTED' | null
}

export interface ModelBreakdown {
  requestedModel: string
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

/**
 * Per-virtual-key cost breakdown (`GET /api/v1/usage/virtual-keys`).
 *
 * "Desktop vs. app" and similar traffic-class splits work today by minting
 * one virtual key per class and pointing that traffic at it — this is the
 * meter that makes those separate keys actually read as separate cost
 * figures. Same shape as {@link ModelBreakdown}, grouped by key instead of
 * model. See migration 174.
 */
export interface VirtualKeyBreakdown {
  /**
   * The key's non-secret key_prefix — `null` groups every trace with no
   * virtual-key auth context (standalone/offline traces synced back, or any
   * trace older than migration 174), never invented as `'unknown'` inline
   * with a real prefix.
   */
  virtualKeyId: string | null
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

/**
 * One developer's usage for a period (`GET /api/v1/usage/members`).
 *
 * A call is attributed to the workspace member who owns the virtual key that
 * authenticated it. `memberId: null` is the unattributed bucket: calls with no
 * virtual-key auth context, and calls whose key prefix no single member owns.
 */
export interface MemberUsage {
  memberId: string | null
  /** Null for the unattributed bucket, and for a member since removed. */
  displayName: string | null
  email: string | null
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
  /** Distinct requested models, sorted. */
  models: string[]
  /** Distinct UTC calendar days with at least one call. */
  activeDays: number
}

/**
 * `GET /api/v1/usage/members`. `scope: 'self'` when the caller may only see
 * their own row (DEVELOPER and VIEWER); `'workspace'` for OWNER, ADMIN and EM.
 */
export interface MemberUsageResponse {
  scope: 'workspace' | 'self'
  members: MemberUsage[]
}

/**
 * One SCIM group's usage for a period (`GET /api/v1/usage/teams`): the sum over
 * every member in the group, directly or through nested groups. A member in
 * several groups counts in each, so team totals can add up to more than the
 * workspace total.
 */
export interface TeamUsage {
  groupId: string
  displayName: string
  /** Members in the group, transitively. */
  memberCount: number
  /** Members of the group with at least one attributed call in the period. */
  activeMembers: number
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

/**
 * `GET /api/v1/usage/teams`. `scimGroups: false` means the workspace has no
 * SCIM groups, so there are no teams to roll up to; per-member usage is the
 * finest grouping available.
 */
export interface TeamUsageResponse {
  scimGroups: boolean
  teams: TeamUsage[]
}

/**
 * Usage per repository and branch (`GET /api/v1/usage/branches`), from the git
 * context copied onto each trace when it was recorded. `repo` and `branch` are
 * both null on the row for calls made with no git context.
 */
export interface BranchUsage {
  /** Normalised `origin` remote, host/path. Null when the directory had no `origin`. */
  repo: string | null
  branch: string | null
  /** Distinct HEAD commits the calls were made at. */
  commitCount: number
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
  /** Latest call, ISO 8601. */
  lastCallAt: string
}

/**
 * Usage per HEAD commit (`GET /api/v1/usage/commits`): the calls made while
 * that commit was checked out, which is the work that led to the next commit,
 * not the work that produced this one.
 */
export interface CommitUsage {
  repo: string | null
  branch: string | null
  commit: string | null
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
  /** First and latest call at this commit, ISO 8601. */
  firstCallAt: string
  lastCallAt: string
}

/** `scope` as on {@link MemberUsageResponse}: `'self'` counts only the caller's own calls. */
export interface BranchUsageResponse {
  scope: 'workspace' | 'self'
  branches: BranchUsage[]
}

export interface CommitUsageResponse {
  scope: 'workspace' | 'self'
  commits: CommitUsage[]
}
