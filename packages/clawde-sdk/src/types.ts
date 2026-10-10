export interface ClawdeClientOptions {
  apiKey: string                    // Virtual key (vk_xxx)
  baseUrl?: string                  // Proxy base URL. Default: http://localhost:4000
  /**
   * Control-plane base URL used by checkBudget() (a different origin from
   * `baseUrl` — see control-plane.ts's doc comment). Default:
   * INTUTIC_CONTROL_PLANE_URL env or https://app.intutic.ai.
   */
  controlPlaneUrl?: string
  provider?: 'openai' | 'anthropic' | 'google'  // Schema enforcement
  autoContext?: boolean             // Default: true — resolveContext() reads the sync daemon's config
  timeout?: number                  // Default: 30000ms
  retries?: number                  // Default: 2
  /**
   * This client's position in the agent graph. Omit and it is inherited from the
   * environment, so a spawned agent is automatically a child of its spawner.
   * Supply it when one process drives several logical agents and the environment
   * cannot describe the shape.
   */
  graphIdentity?: Partial<import('./graph-identity').GraphIdentity>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | any[]
  name?: string
  tool_calls?: any[]
  tool_call_id?: string
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
  tools?: any[]
  tool_choice?: any
  response_format?: any
  [key: string]: any
}

/** The proxy's `x-intutic-upstream-attempts` / `x-intutic-upstream-fallback-from` headers, read. */
export interface UpstreamCalls {
  attempts: number
  fallbackFrom?: string
}

export interface ChatResponse {
  id: string
  object: string
  created: number
  model: string
  choices: {
    index: number
    message: ChatMessage
    finish_reason: string
  }[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  /** Always `allow`: a response only comes back when the proxy let the request through. */
  verdict?: Verdict | LegacyVerdict
  /**
   * What the proxy's retry layer did, when it did anything: how many upstream
   * calls this answer took, and — when a fallback answered after the model's
   * retries ran out — which model failed (`model` names the one that
   * answered). Absent for the ordinary single-call request.
   */
  upstream?: UpstreamCalls
  /** @deprecated Never set: the proxy does not report budget on responses. Use `checkBudget()`. */
  budgetRemainingUsd?: number
  /** @deprecated Never set: the proxy does not report budget on responses. Use `checkBudget()`. */
  budgetPctUsed?: number
}

/**
 * A governance refusal the proxy answered with: `kill` blocks the request, `reask`
 * refuses this attempt and tells the agent to revise it (it escalates to `kill`
 * after repeated attempts), and `hold` pauses a loop run until a human reviews it.
 */
export type RefusalVerdict = 'kill' | 'reask' | 'hold'

/** What `chat()` can know about a request: it was let through, or refused. */
export type Verdict = 'allow' | RefusalVerdict

/**
 * @deprecated Never reported. The proxy applies these inside the response and
 * does not tell the client, so no response carries them and no event fires for
 * them. Still accepted so code written against 2.0 compiles; they will be
 * removed in the next major version.
 */
export type LegacyVerdict = 'hijack' | 'enhance' | 'bypass'

/** Events `on()` accepts. */
export type VerdictEvent = RefusalVerdict | LegacyVerdict

export interface CircuitBreakerOptions {
  /**
   * Run `checkBudget()` first and refuse to run the function when the workspace
   * has no budget left. Default: false.
   */
  requireBudget?: boolean
  /**
   * @deprecated Use `requireBudget: true`. Any value turns the workspace budget
   * check on; the amount is not compared with anything, because nothing reports
   * a call's cost before it is made.
   */
  maxCostUsd?: number
  /** @deprecated Ignored: neither the SDK nor the proxy reads a sensitivity tier. */
  sensitivityTier?: 'low' | 'medium' | 'high' | 'critical'
  failOpen?: boolean                // Default: false (fail-closed)
}

export interface ResolvedContext {
  workspaceId?: string              // From ~/.intutic/config.json or INTUTIC_WORKSPACE_ID env
  sessionId?: string                // From ~/.intutic/config.json or INTUTIC_SESSION_ID env
  gitBranch?: string
  jiraTicket?: string               // From sync-daemon config
  pagerdutyIncident?: string        // From sync-daemon config or PD_INCIDENT_ID env
  ciPipeline?: string               // From CI env vars (GITHUB_RUN_ID, etc.)
  workingDirectory?: string
}

export interface BudgetCheckResult {
  allowed: boolean
  remaining_usd: number
  reason?: string
}

/** Called with the refusal before `chat()` throws it as a `ClawdeBlockedError`. */
export type EventCallback = (data: {
  /** One of the `RefusalVerdict` values; typed wider so listeners written against 2.0 compile. */
  verdict: Verdict | LegacyVerdict
  /** The proxy's refusal code, e.g. `policy_denied`, `OVERAGE_HARD_CAP_EXCEEDED` or `TOOL_DENIED`. */
  code: string
  status: number
  message: string
  /** The rule that decided, when the proxy names one. */
  ruleId?: string
  /** @deprecated Never set. */
  budgetRemainingUsd?: number
  /** @deprecated Never set. */
  budgetPctUsed?: number
}) => void | Promise<void>

// ─── Control-plane management types (LLD #69) ───

export interface ControlPlaneClientOptions {
  apiKey: string                    // vk_xxx or a JWT — see control-plane.ts's doc comment
  baseUrl?: string                  // Default: INTUTIC_CONTROL_PLANE_URL env or https://app.intutic.ai
}

export interface WhoamiResult {
  email: string
  memberId: string
  workspaceId: string
  role: string
}

export interface OrgSignupParams {
  email: string
  password: string
  name: string
  orgName: string
}

export interface OrgSignupResult {
  user: { id: string; email: string; name: string; emailVerified: boolean }
  org: { id: string; name: string; planTier: string; trialExpiresAt: string }
  workspace: { id: string; name: string; planTier: string; trialExpiresAt: string }
  accessToken: string
  refreshToken: string
  cliInstall: string
  isNewUser: boolean
}

export interface StartDomainVerificationResult {
  verificationId: string
  domain: string
  txtRecordName: string
  txtRecordValue: string
  expiresAt: string
}

export interface CheckDomainVerificationResult {
  verificationId: string
  domain: string
  status: 'pending' | 'verified' | 'consumed' | 'expired'
  txtRecordName: string
  txtRecordValue: string
  verifiedAt: string | null
}

export interface CreateOrgParams {
  orgName: string
  domain: string
  verificationId: string
  /** Gateway cell region ('us' | 'eu' | ...). Omit for the deployment's home region; server-validated. */
  region?: string
}

export interface CreateOrgResult {
  orgId: string
  teamId: string
  workspaceId: string
  name: string
  planTier: string
  region?: string
}

export interface Team {
  teamId: string
  orgId: string
  name: string
  slug: string
  createdAt: string
}

export interface Workspace {
  workspaceId: string
  name: string
  slug: string
  planTier: string
  createdAt: string
}

export interface GatewayRegisterParams {
  name: string
  deploymentTarget: 'docker' | 'kubernetes' | 'bare_metal'
}

export interface GatewayRegisterResult {
  gatewayId: string
  name: string
  deploymentTarget: string
  status: string
  /** Shown once — not retrievable again after this response. */
  token: string
  instructions: string
}

export interface Gateway {
  gatewayId: string
  name: string
  deploymentTarget: string
  status: string
  keyPrefix: string
  lastHeartbeatAt: string | null
  proxyVersion: string | null
  createdAt: string
  revokedAt: string | null
}

export interface GatewayRotateResult {
  gatewayId: string
  /** Shown once — not retrievable again after this response. */
  token: string
  previousTokenValidUntil: string
  instructions: string
}

export interface GatewayStatus {
  status: 'online' | 'degraded' | 'unreachable' | 'pending'
  proxyVersion: string | null
  uptimeSeconds: number | null
  activeWorkspaces: number | null
  litellmReachable: boolean | null
  lastError: string | null
  reportedAt: string | null
  /** The config version the gateway reported running in its last heartbeat; null when unreachable or not reported. */
  appliedConfigVersion: number | null
  /** The version the latest config change produced; 0 before any. The gateway pulls it on its next heartbeat. */
  desiredConfigVersion: number
}

export interface GatewayConfigUpdate {
  requireVk?: boolean
  requireProvisionedKey?: boolean
}

export interface GatewayConfigResult {
  /** The flags set on the gateway (`requireVk`, `requireProvisionedKey`). One never set is absent: the gateway runs its deployment's own value. */
  config: Record<string, unknown>
  configVersion: number
}

export interface WorkspaceSettings {
  workspaceId: string
  /** Every setting, resolved with its default. */
  settings: Record<string, unknown>
}

export interface WorkspaceSettingsUpdateResult extends WorkspaceSettings {
  updated: true
}

export interface GatewayResolution {
  source: 'workspace' | 'org' | 'default'
  gateway: { gatewayId: string; name: string; deploymentTarget: string; status: string } | null
  staleAssignment?: string
}

export interface ProviderCredentialStatus {
  provider: string
  routingLive: boolean
  provisioned: boolean
  lastFour: string | null
  updatedAt: string | null
}

// ─── Operator API types: the rest of the CLI's control-plane surface ───
//
// Wire shapes, as the control plane sends them: camelCase except where the
// route itself answers in snake_case (findings, integrity roots, SOP writes,
// policy sources). Optional parameters of a method are its last argument.

/** `listProperty` and `rowCase`, which every control-plane list response carries beside its rows. */
export interface ListEnvelope {
  listProperty?: string
  rowCase?: 'snake' | 'camel' | 'mixed'
}

// MCP server registry

export interface McpServer {
  serverId: string
  serverName: string
  status: 'candidate' | 'approved' | 'blocked'
  tools: string[]
  disabledTools: string[]
  lastSeenAt: string
  /** A high-risk tool change is waiting for a decision. */
  heldForReview: boolean
}

export interface McpServerList extends ListEnvelope {
  servers: McpServer[]
  defaultPolicy: 'allow' | 'deny'
  highRiskToolChange: 'notify' | 'hold'
  pendingCount: number
}

export interface McpServerDecision {
  ok: boolean
  server: McpServer
}

// Notifications

export type NotificationChannel = 'slack' | 'email' | 'webhook' | 'pagerduty'

export interface NotificationChannelConfig {
  slackChannelId?: string
  slackChannelName?: string
  emailRecipients?: string[]
  webhookUrl?: string
  pagerdutyRoutingKey?: string
}

export interface NotificationFilters {
  severity?: string[]
  harnessType?: string[]
  userId?: string[]
}

export interface NotificationRule {
  ruleId: string
  eventType: string
  channel: NotificationChannel
  channelConfig: NotificationChannelConfig
  filters: NotificationFilters
  cooldownMinutes: number
  enabled: boolean
  /** A webhook rule's signing secret, only in the response that made it. Not retrievable again. */
  signingSecret?: string
}

/** The body of a create. Channel config and filters are each stored whole. */
export interface NotificationRuleInput {
  eventType: string
  channel: NotificationChannel
  channelConfig: NotificationChannelConfig
  filters?: NotificationFilters
  cooldownMinutes?: number
  enabled?: boolean
}

/** An update sends only the fields that change; `channelConfig` and `filters` replace the stored ones whole. */
export type NotificationRuleUpdate = Partial<NotificationRuleInput>

export interface SigningSecretRotation {
  /** Shown once: not retrievable again after this response. */
  signingSecret: string
}

export interface NotificationSecretRotation extends SigningSecretRotation {
  ruleId: string
}

// SIEM export

export type SiemAdapterType = 'syslog_cef' | 'webhook_https' | 'gcs' | 's3' | 'splunk_hec' | 'datadog_logs'

export interface SiemDestination {
  destinationId: string
  name: string
  adapterType: SiemAdapterType
  isActive: boolean
  /** Empty means the default set: every source except the opt-in ones. */
  sourceTables: string[]
  batchSize: number
  flushIntervalMs: number
  lastHeartbeatAt: string | null
  lastError: string | null
  /** The adapter settings, with credentials masked. */
  config?: Record<string, unknown>
  /** A webhook destination's signing secret, only in the response that made it. */
  signingSecret?: string
}

export interface SiemSources {
  all: string[]
  defaults: string[]
}

export interface SiemDestinationList {
  items: SiemDestination[]
  sources: SiemSources
}

export interface SiemDestinationInput {
  name: string
  adapterType: SiemAdapterType
  /** Adapter settings, credentials included; the control plane encrypts them and masks them on every read. */
  config: Record<string, unknown>
  sourceTables?: string[]
  batchSize?: number
  flushIntervalMs?: number
}

export interface SiemDestinationUpdate {
  name?: string
  config?: Record<string, unknown>
  sourceTables?: string[]
  batchSize?: number
  flushIntervalMs?: number
  /** `true` turns a deleted (deactivated) destination back on. */
  isActive?: boolean
}

export interface SiemSecretRotation extends SigningSecretRotation {
  destinationId: string
}

// Usage

export type UsagePeriod = 'daily' | 'monthly'

export interface UsageOptions {
  /** Default `monthly`. */
  period?: UsagePeriod
}

export interface UsageTotals {
  totalCostUsd: number
  totalRawCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

/** `self` when the caller may see only their own calls (below OWNER, ADMIN and EM). */
export type UsageScope = 'workspace' | 'self'

export interface MemberUsage extends UsageTotals {
  /** Null for calls no single member owns. */
  memberId: string | null
  displayName: string | null
  email: string | null
  models: string[]
  activeDays: number
}

export interface MemberUsageResponse {
  scope: UsageScope
  members: MemberUsage[]
}

export interface TeamUsage extends UsageTotals {
  groupId: string
  displayName: string
  memberCount: number
  activeMembers: number
}

export interface TeamUsageResponse {
  /** False when the workspace has no SCIM groups, so there are no teams. */
  scimGroups: boolean
  teams: TeamUsage[]
}

export interface BranchUsage extends UsageTotals {
  /** Null on the row for calls made with no git context. */
  repo: string | null
  branch: string | null
  commitCount: number
  lastCallAt: string
}

export interface BranchUsageResponse {
  scope: UsageScope
  branches: BranchUsage[]
}

export interface CommitUsage extends UsageTotals {
  repo: string | null
  branch: string | null
  commit: string | null
  firstCallAt: string
  lastCallAt: string
}

export interface CommitUsageResponse {
  scope: UsageScope
  commits: CommitUsage[]
}

export interface PullRequestUsage extends UsageTotals {
  repo: string
  number: number
  title: string
  author: string | null
  state: 'open' | 'closed' | 'merged'
  headBranch: string
  baseBranch: string | null
  url: string
  openedAt: string
  mergedAt: string | null
  closedAt: string | null
  memberCount: number
  firstCallAt: string
  lastCallAt: string
}

export interface PullRequestSources {
  connector: boolean
  webhook: boolean
  apiHost: string
  noAccessRepos: string[]
  mappedPullRequests: number
  lastCheckedAt: string | null
}

export interface PullRequestUsageResponse {
  scope: UsageScope
  github: PullRequestSources
  pullRequests: PullRequestUsage[]
}

export interface PullRequestRefreshResult {
  checked: number
  notModified: number
  pullRequests: number
  noAccess: number
  rateLimited: boolean
}

// AI inventory

export interface InventorySummary {
  devices: number
  staleDevices: number
  harnesses: number
  governedHarnesses: number
  governedPercent: number | null
  ungovernedHarnesses: number
  staleGates: number
  unverifiedHarnesses: number
  mcpServers: number
  ungovernedMcpServers: number
  skills: number
}

export interface InventoryDevice {
  deviceId: string
  hostname: string
  platform: string
  cliVersion: string | null
  reportedBy: string | null
  workspace: string | null
  guardProbes: { total: number; failed: number; ranAt: number } | null
  firstSeenAt: string
  lastSeenAt: string
  stale: boolean
  disconnectedAt: string | null
  harnesses: number
  ungovernedHarnesses: number
  staleGates: number
  mcpServers: number
  ungovernedMcpServers: number
  skills: number
}

interface InventoryItem {
  itemId: string
  deviceId: string
  hostname: string
  deviceStale: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export interface InventoryHarness extends InventoryItem {
  harness: string
  version: string | null
  configured: boolean
  gateKind: string
  gateInstalled: boolean | null
  gateFile: string | null
  lastHookEventAt: string | null
  status: string
  reason: string | null
  reasonText: string | null
}

export interface InventoryMcpServer extends InventoryItem {
  server: string
  harness: string
  transport: string
  endpoint: string | null
  status: string
  reason: string | null
}

export interface InventorySkill extends InventoryItem {
  name: string
  source: string
  sha256: string | null
  scanned: boolean
  clean: boolean
  findingsCount: number
  scriptCount: number
}

export interface DeviceDisconnect {
  disconnectId: string
  hostname: string
  fingerprint: string
  scope: 'machine' | 'harness'
  harnesses: string[]
  memberId: string | null
  reportedBy: string | null
  createdAt: string
}

export interface InventoryFilters {
  status?: string
  harness?: string
  /** A device id. */
  device?: string
  /** Text matched against the item's name and the machine's hostname. */
  search?: string
}

export interface InventorySkillFilters {
  device?: string
  search?: string
}

// Compliance

/** The coverage report formats: `md` is markdown. */
export type CoverageFormat = 'json' | 'md' | 'csv' | 'pdf'

export interface FrameworkCoverage {
  frameworkId: string
  name: string
  mappingVersion: string
  generatedAt: string
  summary: {
    controls: number
    mapped: number
    full: number
    partial: number
    states: Record<string, number>
  }
  [key: string]: unknown
}

export interface EvidenceCollectOptions {
  /** ISO 8601. */
  periodStart?: string
  periodEnd?: string
}

export interface EvidenceDetachedSignature {
  algorithm: string
  keyId: string
  preimageDomain: string
  value: string
}

/** An evidence archive: the parts verification reads. Everything else is covered by the archive hash. */
export interface EvidenceArchive {
  formatVersion?: number
  runId?: string
  collectedAt?: string
  periodStart?: string
  periodEnd?: string
  overallScore?: number | null
  categories?: Array<{ category: string; [key: string]: unknown }>
  frameworks?: Array<{ coverage: { frameworkId: string; [key: string]: unknown }; csv?: string; pdf?: string; [key: string]: unknown }>
  manifest?: { algorithm?: string; sections?: Record<string, string>; archiveSha256?: string; unsignedReason?: string; [key: string]: unknown }
  signature?: EvidenceDetachedSignature | null
  [key: string]: unknown
}

export interface EvidenceCollectResult {
  runId: string
  archive: EvidenceArchive
  artifactUrl: string | null
  signed: boolean
  signingKeyId?: string
  unsignedReason?: string
}

/** The control plane's published signing keys, one per `kid`. */
export interface SigningJwks {
  keys: Array<Record<string, unknown>>
}

export type EvidenceSignatureState = 'valid' | 'invalid' | 'unsigned' | 'unverifiable' | 'keys_unavailable'

export interface EvidenceVerification {
  /** The recomputed whole-archive hash, and whether it equals `manifest.archiveSha256`. */
  archiveSha256: string
  archiveHashMatches: boolean
  /** Manifest entries whose content does not hash to the recorded value, or that name nothing in the archive. */
  sectionMismatches: string[]
  sectionsChecked: number
  signature: EvidenceSignatureState
  signingKeyId: string | null
  unsignedReason: string | null
  /** True only when the hashes match and a published key accepts the signature. */
  verified: boolean
}

// Gate liveness

export interface GateLiveness {
  windowHours: number
  gates: Array<{
    harnessType: string
    status: 'reporting' | 'silent' | 'new'
    lastSeen: string | null
    agentLastSeen: string | null
    alertOpen: boolean
  }>
}

// GitHub pull-request webhook

export interface GitHubWebhookInfo {
  configured: boolean
  url: string | null
  createdAt: string | null
  secretRotatedAt: string | null
  lastDeliveryAt: string | null
}

export interface GitHubWebhookSecret {
  url: string
  /** Shown once: not retrievable again after this response. */
  secret: string
}

// Policy guardrails (the Policy Clause Ledger)

/** The connector providers that are policy sources. */
export type PolicySourceProvider = 'notion' | 'confluence' | 'github' | 'gdrive'

export interface PolicySource {
  connector_id: string
  provider: PolicySourceProvider
  name: string
  config: Record<string, unknown> | null
  last_synced_at: string | null
  last_sync_error?: string | null
  last_attempt_at?: string | null
  created_at?: string
}

export interface PolicySourceInput {
  provider: PolicySourceProvider
  name: string
  /** The provider credential (a Google service-account key is the key file's JSON). */
  token: string
  config?: Record<string, unknown>
}

export interface PolicySourceSyncResult {
  success: boolean
  processed_docs: number
  updated_sops: string[]
  successor_sops: string[]
}

export type GuardrailStatus = 'PROPOSED' | 'SHADOW' | 'ENFORCING' | 'REJECTED' | 'RETIRED'
export type GuardrailTarget = 'hook_rule' | 'sop_front_matter' | 'wasm_rule' | 'workspace_setting'
export type GuardrailProvenance = 'extracted' | 'authored'

export interface PolicyDocumentSummary {
  docId: string
  title: string
  provider: string
  sourceUrl: string | null
  status: string
  injectionFlagged: boolean
  sopId: string | null
  fetchedAt: string
  passageCount: number
  clauseCount: number
  guardrailCount: number
  lastRun: { runId: string; extractor: string; startedAt: string; finishedAt: string | null; error: string | null } | null
}

export interface PolicyDocumentDetail extends PolicyDocumentSummary {
  contentHash: string
  upstreamVersion: string | null
  passages: Array<Record<string, unknown>>
  clauses: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
}

export interface ExtractDocumentResult {
  docId: string
  runId: string | null
  extractor: string
  skipped: 'no_passages' | 'daily_cap' | 'cap_unavailable' | 'llm_disabled' | null
  cap: { count: number; cap: number } | null
  llmUnavailable: boolean
  chunks: number
  proposals: number
  verbatimQuotes: number
  valid: number
  rejected: number
  malformed: number
  guardrails: { proposed: number; rejectedForInjection: number; existing: number }
  lifted: { clauses: number; valid: number; errors: string[] }
  error: string | null
}

export interface ExtractOptions {
  /** Default true. False runs only the front-matter lift, with no model call. */
  llm?: boolean
}

export interface TokenCoverage {
  token: string
  passages: Array<{ passageId: string; docId: string; title: string; sourceUrl: string | null; headingPath: string[]; excerpt: string }>
  guardrails: Array<{ guardrailId: string; clauseId: string; passageId: string | null; status: string; target: string; quote: string }>
}

export interface PassageSearchResult {
  query: string
  passages: Array<{ passageId: string; docId: string; title: string; sourceUrl: string | null; headingPath: string[]; excerpt: string; rank: number }>
}

/** Name exactly one: the document or the passage whose change to follow. */
export interface GuardrailImpactSeed {
  docId?: string
  passageId?: string
}

export interface LedgerImpact {
  seed: { docId: string | null; passageId: string | null }
  maxDepth: number
  passages: Array<Record<string, unknown>>
  clauses: Array<Record<string, unknown>>
  guardrails: Array<{ guardrailId: string; clauseId: string; status: string; target: string; sourceStale: boolean; ruleCandidateId: string | null; depth: number }>
  truncated: boolean
}

export interface DuplicatesOptions {
  /** 0 to 1. */
  minJaccard?: number
}

export interface LedgerDuplicates {
  minJaccard: number
  passagePairs: Array<Record<string, unknown>>
  sameRule: Array<Record<string, unknown>>
}

export interface GuardrailFilters {
  status?: GuardrailStatus
  target?: GuardrailTarget
  provenance?: GuardrailProvenance
  docId?: string
  limit?: number
}

export interface GuardrailSummary {
  guardrailId: string
  provenance: GuardrailProvenance
  name: string | null
  description: string | null
  version: number
  supersedes: string | null
  target: GuardrailTarget
  status: GuardrailStatus
  /** The guardrail IR: `kind` and the keys that kind takes. */
  ir: Record<string, unknown>
  rendered: unknown
  roles: string[]
  scope: string
  shadowEvaluations: number
  shadowWouldAct: number
  enforcingFires: number
  sourceStale: boolean
  ruleCandidateId: string | null
  proposedAt: string
  shadowAt: string | null
  promotedAt: string | null
  rejectedReason: string | null
  clause: Record<string, unknown> | null
  document: { docId: string; title: string; provider: string; sourceUrl: string | null } | null
}

export interface GuardrailDetail extends GuardrailSummary {
  validation: unknown
  passage: Record<string, unknown> | null
  events: Array<{ eventId: string; event: string; actorId: string | null; detail: unknown; createdAt: string }>
  supersededBy: string | null
}

export interface GuardrailReadiness {
  ready: boolean
  reasons: string[]
  neverFired: boolean
  evaluations: number
  wouldAct: number
  wouldActRate: number | null
  adjudicated: number
  adjudicatedRequired: number
  falsePositives: number
  falsePositiveRate: number | null
  thresholds: {
    minShadowEvaluations: number
    maxWouldActRate: number
    minAdjudicatedFires: number
    maxAdjudicatedFalsePositiveRate: number
  }
}

export interface GuardrailTransitionResult {
  ok: boolean
  guardrail: GuardrailDetail
  readiness?: GuardrailReadiness
}

export interface PromoteOptions {
  /** Promote a guardrail that never fired in shadow. Default false. */
  acknowledgeNoTraffic?: boolean
}

export interface AuthoredGuardrailInput {
  /** One line. */
  name: string
  description?: string | null
  ir: Record<string, unknown>
}

/** Any of the three. A changed IR creates the next version; `description: null` clears it. */
export interface AuthoredGuardrailUpdate {
  name?: string
  description?: string | null
  ir?: Record<string, unknown>
}

export interface AuthoredGuardrailWriteResult {
  ok: true
  guardrail: GuardrailDetail
  /** The IR changed: a new version, PROPOSED with no evidence, replaced the old one, which is now RETIRED. */
  forked: boolean
  supersedes: string | null
}

export interface GuardrailDeleteResult {
  ok: boolean
  guardrail: GuardrailDetail
}

export interface GuardrailReplay {
  source: 'enforcement_log' | 'context_snapshots' | 'execution_traces' | 'none'
  windowDays: number
  captured: number
  fires: number
  sample: Array<{ toolName: string; at: string; excerpt: string }>
  truncated: boolean
  unsupported: string[]
}

export interface GuardrailConflict {
  kind: string
  token: string | null
  a: { id: string; quote: string }
  b: { id: string; quote: string }
  detail: string
}

// Held decisions and loop runs

export interface ReviewOptions {
  /** Recorded with the decision. */
  reason?: string
}

export interface DecisionReviewResult {
  ok: boolean
  status: string
  /** A short-lived bypass was written for the exact retried call. */
  bypassWritten?: boolean
}

export type LoopRunStatus = 'ACTIVE' | 'PENDING_REVIEW' | 'COMPLETED' | 'FAILED' | 'KILLED'

export interface LoopRun {
  loopRunId: string
  name: string
  status: LoopRunStatus
  totalTokenCostUsd: string
  budgetLimitUsd: string
  [key: string]: unknown
}

export interface StartLoopRunOptions {
  budgetLimitUsd?: number | string
  /** SOP names active for the run. */
  sops?: string[]
  autoJudge?: boolean
}

export interface CompleteLoopRunOptions {
  outcome?: 'SUCCEEDED' | 'FAILED'
}

export interface LoopRunReviewOptions {
  note?: string
}

export interface LoopRunActionResult {
  ok: boolean
  status?: string
  outcome?: string
}

// Findings

export type FindingOutcome = 'TRUE_POSITIVE' | 'FALSE_POSITIVE'

export interface Finding {
  finding_id: string
  trace_id: string | null
  session_id: string | null
  loop_run_id: string | null
  detector_id: string
  anomaly_kind: string | null
  severity: string | null
  disposition: string | null
  confidence: number
  reason: string | null
  harness: string | null
  shadowed: boolean
  outcome: FindingOutcome | null
  outcome_by: string | null
  outcome_at: string | null
  outcome_note: string | null
  created_at: string
}

export interface FindingFilters {
  /** Only findings nobody has ruled on. */
  unadjudicated?: boolean
  detectorId?: string
  limit?: number
}

export interface AdjudicateOptions {
  note?: string
}

export interface FindingAdjudication {
  finding_id: string
  outcome: FindingOutcome
}

export interface FindingStats {
  detectors: Array<{
    detector_id: string
    anomaly_kind: string | null
    shadowed: boolean
    total_findings: number
    adjudicated: number
    false_positives: number
    /** Null when nothing has been ruled on. */
    false_positive_rate: number | null
  }>
  caveats: string[]
}

export interface ResponseEchoReportOptions {
  /** ISO 8601. */
  since?: string
  until?: string
}

export interface ResponseEchoReport {
  window: { since: string; until: string }
  tracesIngested: number
  refusal: string | null
  patterns: Array<{
    pattern: string
    findings: number
    adjudicated: number
    truePositives: number
    falsePositives: number
    falsePositiveRate: number | null
    refusal: string | null
  }>
}

// Traces

export interface TraceFilters {
  /** 1 to 100; default 20. */
  limit?: number
  offset?: number
  /** ISO 8601, or a relative duration such as `24h` or `7d`. */
  since?: string
  enforcement?: 'BYPASS' | 'ENHANCE' | 'HIJACK' | 'KILL'
  model?: string
}

export interface TraceSummary {
  traceId: string
  timestamp: string
  requestedModel: string
  actualModelRouted: string
  enforcementAction: string
  complianceScore: number
  actualCostUsd: number
  anomalyDetected: string | null
  breakGlass?: boolean
  breakGlassRequestId?: string | null
}

export interface TraceList extends ListEnvelope {
  traces: TraceSummary[]
  total: number
  limit?: number
  offset?: number
}

export interface TraceDetail {
  traceId: string
  sessionId: string
  requestId: string
  timestamp: string
  requestedModel: string
  actualModelRouted: string
  enforcementAction: string
  actualCostUsd: number
  [key: string]: unknown
}

// Trace integrity

export interface SealedRoot {
  root_id: string
  loop_run_id: string | null
  leaf_schema_version: number
  merkle_root: string
  leaf_count: number
  first_trace_at: string
  last_trace_at: string
  signature_alg: string | null
  signing_key_id: string | null
  sealed_at: string
}

export interface IntegrityRootList extends ListEnvelope {
  ok: boolean
  data: SealedRoot[]
  leafSchemaVersion: number
}

/**
 * The fields of a sealed root its signature covers, as
 * `GET /api/v1/integrity/roots/:rootId` serves them: what
 * `verifyIntegrityRoot` reads.
 */
export interface SignedIntegrityRoot {
  workspace_id: string
  loop_run_id: string | null
  leaf_schema_version: number
  merkle_root: string
  signature_alg: string | null
  signature: string | null
  signing_key_id: string | null
  /** The chain link; in the signed bytes from preimage version 2 on. */
  previous_root?: string | null
  /** The preimage the signature covers; absent from a control plane older than the column, which means 1. */
  signing_preimage_version?: number
}

/**
 * What `verifyIntegrityRoot` established: `valid` a published key accepted
 * the signature, `invalid` the key the root names rejected it, `unsigned` no
 * key was configured when it was sealed, `unverifiable` the key is not
 * published or the root names an algorithm or preimage version this build
 * cannot check, `keys_unavailable` no key set was given. Only `invalid` says
 * the root changed.
 */
export type IntegrityRootSignatureState = 'valid' | 'invalid' | 'unsigned' | 'unverifiable' | 'keys_unavailable'

export interface IntegrityRootDetail {
  ok: boolean
  root: SealedRoot & SignedIntegrityRoot & {
    workspace_id: string
    signature: string | null
    previous_root: string | null
    signing_preimage_version?: number
    [key: string]: unknown
  }
  leaves: Array<{ trace_id: string; leaf_index: number; leaf_hash: string }>
}

export interface IntegrityRecompute {
  ok: boolean
  verdict: 'match' | 'mismatch' | 'missing_traces'
  storedRoot: string
  recomputedRoot: string | null
  changedTraceIds: string[]
  missingTraceIds: string[]
  retentionExpired?: boolean
}

/** The walk is the answer whether or not it found a break (the control plane answers a break with a 409). */
export interface IntegrityChain {
  ok: boolean
  workspaceId: string
  rootsWalked: number
  rootsNotWalked: number
  unchainedRootIds: string[]
  breaks: Array<{ rootId: string; namedPrevious: string; precedingRootId: string; precedingMerkleRoot: string }>
  intact: boolean
}

export interface ConfigChain {
  ok: boolean
  workspaceId: string
  harnessType: string | null
  snapshotsWalked: number
  /** Saturates at 1: read it as "more snapshots than the walk covered". */
  snapshotsNotWalked: number
  unchainedSnapshotIds: string[]
  breaks: Array<{ snapshotId: string; harnessType: string; filePath: string; namedPrevious: string; precedingSnapshotId: string; precedingContentHash: string }>
  contentMismatches: Array<{ snapshotId: string; harnessType: string; filePath: string; storedHash: string; recomputedHash: string }>
  snapshotsWithoutContent?: number
  intact: boolean
}

// Compliance policies and WASM rules

export interface CompliancePolicy {
  policyId: string
  workspaceId: string
  name: string
  description: string | null
  riskCategory: string | null
  targetToolPattern: string
  enforcementAction: string
  interventionMode: string | null
  priority: number | null
  conditions: unknown
  isActive: boolean | null
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface PolicyChangeResult {
  ok: boolean
  currentVersion?: number
}

export interface RuleCandidateSource {
  candidateId: string
  guardrailId: string | null
  status: string
  source: string
  /** Lower-case hex; checked against `source` before it is returned. */
  sourceSha256: string
}

export interface BundleUploadOptions {
  /** The upload's file name. Default `rule.wasm`. */
  fileName?: string
}

export interface BundleUploadResult {
  accepted?: boolean
  gates?: Array<{ gate: string; passed: boolean; detail: string }>
  ruleId?: string
  mode?: string
  error?: string
  detail?: string
}

export interface WasmReplayOptions {
  limit?: number
  /** ISO 8601. */
  since?: string
}

export interface WasmReplayResult {
  ruleId: string
  since: string | null
  contextCount: number
  wouldActCount: number
  wouldActRate: number
  verdictCounts: Record<string, number>
  sampleMatches: Array<Record<string, unknown>>
}

// SOPs

export interface SopSummary {
  sopId: string
  title: string
  contentHash?: string
  [key: string]: unknown
}

export interface SopDetail {
  sopId: string
  title: string
  riskTier: string
  version: string
  markdownContent: string
  [key: string]: unknown
}

/** The body `intutic sops push` sends, in the route's snake_case. */
export interface SopInput {
  title: string
  markdown_content: string
  risk_tier?: string
  complexity_tier?: string
  version?: string
}

export interface SopCreateResult {
  ok: boolean
  sopId?: string
}

export interface OrgSopInput {
  title: string
  markdown_content: string
  risk_tier?: string
}

export interface OrgSop {
  orgSopId: string
  orgId?: string
  title: string
  riskTier: string
  createdAt: string
  [key: string]: unknown
}

// Key attenuation, cost prediction, routing

export interface AttenuateOptions {
  /** 60 to 86400 seconds. */
  ttlSeconds?: number
}

export interface AttenuationResult {
  /** The child `vk_` key: shown once, never stored. */
  childKey: string
  childKeyId: string
  attenuationChainId: string
  grantedCaps: string[]
  expiresAt: string
}

export interface AttenuationChainLink {
  chainId: string
  parentKeyId: string
  childKeyId: string
  workspaceId: string
  grantedCaps: string[]
  expiresAt: string
  createdAt: string
}

export interface PredictCostParams {
  /** Must be the key's own workspace. */
  workspaceId: string
  model: string
  inputTokenCount?: number
  inputText?: string
}

export interface CostPrediction {
  inputTokens: number
  estimatedOutputTokens: number
  estimatedReasoningTokens: number | null
  estimatedCostUsd: number
  confidence: 'high' | 'medium' | 'low'
  basedOnSamples: number
}

export type MirrorAdoptionReport =
  | {
      candidateModel: string
      sufficientData: true
      sampleCount: number
      candidateBetter: number
      originalBetter: number
      tie: number
      unjudged: number
      faultRateDelta: number | null
      averageCostDeltaUsd: number | null
      averageLatencyDeltaMs: number | null
    }
  | {
      candidateModel: string
      sufficientData: false
      sampleCount: number
      minimumRequired: number
      reason: string
    }
