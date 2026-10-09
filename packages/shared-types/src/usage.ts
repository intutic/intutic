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

export type PullRequestState = 'open' | 'closed' | 'merged'

/**
 * One pull request's usage for a period (`GET /api/v1/usage/pull-requests`):
 * the calls made on its head branch, in its repository, between the end of
 * the previous pull request from that branch (or the branch's first call) and
 * this one's merge or close. A call belongs to one pull request at most.
 */
export interface PullRequestUsage {
  /** Normalised host/owner/name, lower-cased. */
  repo: string
  number: number
  title: string
  /** GitHub login of whoever opened it. */
  author: string | null
  state: PullRequestState
  headBranch: string
  baseBranch: string | null
  /** The pull request on GitHub. */
  url: string
  /** ISO 8601. */
  openedAt: string
  mergedAt: string | null
  closedAt: string | null
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
  /** Members with an attributed call on it in the period. */
  memberCount: number
  /** First and latest call in the period, ISO 8601. */
  firstCallAt: string
  lastCallAt: string
}

/** Where pull requests come from, and whether that is working, for the empty states. */
export interface PullRequestSources {
  /** The workspace has a GitHub source connector whose token lists pull requests. */
  connector: boolean
  /** The pull-request webhook is set up. */
  webhook: boolean
  /** The GitHub host the connector's token is used against, e.g. `github.com`. */
  apiHost: string
  /** Repositories whose pull requests the connector's token was refused (missing scope or access). */
  noAccessRepos: string[]
  /** Pull requests mapped in the workspace, any period. */
  mappedPullRequests: number
  /** Last time a branch was looked up through the connector, ISO 8601. */
  lastCheckedAt: string | null
}

/** `scope` as on {@link MemberUsageResponse}: `'self'` counts only the caller's own calls. */
export interface PullRequestUsageResponse {
  scope: 'workspace' | 'self'
  github: PullRequestSources
  pullRequests: PullRequestUsage[]
}

/** `POST /api/v1/usage/pull-requests/refresh`. */
export interface PullRequestRefreshResult {
  /** Branches looked up. */
  checked: number
  /** Answered 304: the ETag matched and nothing changed. */
  notModified: number
  /** Pull requests written or updated. */
  pullRequests: number
  /** Branches the token could not list. */
  noAccess: number
  /** True when GitHub's rate limit stopped the run early. */
  rateLimited: boolean
}

/** `GET /api/v1/integrations/github/webhook`. The secret is never returned here. */
export interface GitHubWebhookInfo {
  configured: boolean
  /** Payload URL to paste into GitHub. Null until a secret has been made. */
  url: string | null
  createdAt: string | null
  secretRotatedAt: string | null
  lastDeliveryAt: string | null
}

/** `POST /api/v1/integrations/github/webhook/secret`: the new secret, shown once. */
export interface GitHubWebhookSecret {
  url: string
  secret: string
}
