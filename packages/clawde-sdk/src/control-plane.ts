import { createHash } from 'crypto'
import { ClawdeConnectionError } from './errors'
import { unwrapToonEnvelope } from './toon'
import type {
  ControlPlaneClientOptions,
  WhoamiResult,
  OrgSignupParams,
  OrgSignupResult,
  StartDomainVerificationResult,
  CheckDomainVerificationResult,
  CreateOrgParams,
  CreateOrgResult,
  Team,
  Workspace,
  GatewayRegisterParams,
  GatewayRegisterResult,
  Gateway,
  GatewayRotateResult,
  GatewayStatus,
  GatewayConfigUpdate,
  GatewayConfigResult,
  GatewayResolution,
  ProviderCredentialStatus,
  ProviderModelList,
  WorkspaceSettings,
  WorkspaceSettingsUpdateResult,
  McpServerList,
  McpServerDecision,
  NotificationRule,
  NotificationRuleInput,
  NotificationRuleUpdate,
  NotificationSecretRotation,
  SiemDestination,
  SiemDestinationList,
  SiemSources,
  SiemDestinationInput,
  SiemDestinationUpdate,
  SiemSecretRotation,
  UsageOptions,
  MemberUsageResponse,
  TeamUsageResponse,
  BranchUsageResponse,
  CommitUsageResponse,
  PullRequestUsageResponse,
  PullRequestRefreshResult,
  InventorySummary,
  InventoryDevice,
  InventoryHarness,
  InventoryMcpServer,
  InventorySkill,
  DeviceDisconnect,
  InventoryFilters,
  InventorySkillFilters,
  CoverageFormat,
  FrameworkCoverage,
  EvidenceCollectOptions,
  EvidenceCollectResult,
  SigningJwks,
  GateLiveness,
  GitHubWebhookInfo,
  GitHubWebhookSecret,
  PolicySource,
  PolicySourceInput,
  PolicySourceSyncResult,
  PolicyDocumentSummary,
  PolicyDocumentDetail,
  ExtractDocumentResult,
  ExtractOptions,
  TokenCoverage,
  PassageSearchResult,
  GuardrailImpactSeed,
  LedgerImpact,
  DuplicatesOptions,
  LedgerDuplicates,
  GuardrailFilters,
  GuardrailSummary,
  GuardrailDetail,
  GuardrailReadiness,
  GuardrailTransitionResult,
  PromoteOptions,
  AuthoredGuardrailInput,
  AuthoredGuardrailUpdate,
  AuthoredGuardrailWriteResult,
  GuardrailDeleteResult,
  GuardrailReplay,
  GuardrailConflict,
  ReviewOptions,
  DecisionReviewResult,
  LoopRun,
  StartLoopRunOptions,
  CompleteLoopRunOptions,
  LoopRunReviewOptions,
  LoopRunActionResult,
  Finding,
  FindingFilters,
  FindingOutcome,
  AdjudicateOptions,
  FindingAdjudication,
  FindingStats,
  ResponseEchoReportOptions,
  ResponseEchoReport,
  TraceFilters,
  TraceList,
  IncidentFilters,
  Incident,
  IncidentList,
  TraceDetail,
  IntegrityRootList,
  IntegrityRootDetail,
  IntegrityRecompute,
  IntegrityChain,
  ConfigChain,
  CompliancePolicy,
  PolicyChangeResult,
  RuleCandidateSource,
  BundleUploadOptions,
  BundleUploadResult,
  WasmReplayOptions,
  WasmReplayResult,
  SopSummary,
  SopDetail,
  SopInput,
  SopCreateResult,
  OrgSop,
  OrgSopInput,
  AttenuateOptions,
  AttenuationResult,
  AttenuationChainLink,
  PredictCostParams,
  CostPrediction,
  MirrorAdoptionReport,
} from './types'

/** The connector providers `intutic guardrails sources` lists: the ones that are policy sources. */
const POLICY_SOURCE_PROVIDERS = new Set(['notion', 'confluence', 'github', 'gdrive'])

/** The coverage report's format names on the route, by the CLI's names. */
const COVERAGE_FORMATS: Record<CoverageFormat, string> = { json: 'json', md: 'markdown', csv: 'csv', pdf: 'pdf' }

/**
 * Control-plane management client (LLD #69): the operator APIs the CLI
 * exposes, as distinct from `ClawdeClient`'s data-plane chat calls.
 *
 * Deliberately a separate class, not new methods on `ClawdeClient`:
 * `ClawdeClient.baseUrl` targets the *proxy* (default `http://localhost:4000`);
 * the control plane is a different origin entirely (default
 * `https://app.intutic.ai`, or a self-hosted `CONTROL_PLANE_URL`). Bolting
 * management calls onto `ClawdeClient` would silently need a second base URL
 * on a class whose whole contract today is "one client, one proxy."
 *
 * Every endpoint here comes from the control-plane calls in
 * `tools/cli/src/commands/*` — the CLI's own already-tested contracts, not
 * re-derived — and the Python SDK's `control_plane.py` has the same methods
 * in snake_case. `packages/shared-types/fixtures/control-plane-operations.json`
 * lists every method with the request it makes and the answer it returns, and
 * both SDKs' tests run against it, so neither can grow a method the other
 * lacks. Method names follow one pattern for whatever is added next: a verb
 * (`list`, `get`, `create`, `update`, `delete`, `rotate…Secret`, `download`,
 * or the CLI subcommand's own verb, such as `approve` or `promote`), then the
 * resource.
 *
 * Not included: session establishment (`login`/`logout`; an SDK caller
 * supplies `apiKey` directly, and `ClawdeClient` registers its own session),
 * the CLI's workspace budget (`ClawdeClient.checkBudget()`), and commands
 * that act on the machine they run on: `init`, `setup`, `doctor`,
 * `install-daemon`, `connect`, `disconnect`, `exec`, `start`, `syncContext`,
 * `rollback`, `enforce`, `rules`, `judge`, `skill` (its loop commands are
 * here), `sops status`, `guardrails pull`, and `policy
 * compile|install|snapshot|list-local`.
 *
 * Works unmodified against a self-hosted control plane — there is no
 * SaaS-vs-self-hosted branch anywhere in this file. An open-core user who
 * runs the proxy standalone with no control plane configured simply never
 * constructs this class (or does, points it at nothing, and gets a
 * `ClawdeConnectionError` on the first call) — the same framing
 * `whoami.ts` already uses: "This command needs an Intutic control plane,
 * which open core does not include."
 *
 * Auth: the same `apiKey` type `ClawdeClient` accepts — a `vk_` token or a
 * JWT both satisfy `services/control-plane/src/middleware/auth.ts`, which
 * resolves either to an `AuthContext` with a role. A call the role may not
 * make throws `ClawdeConnectionError` with the control plane's answer; for a
 * 403 that names the roles allowed (`detail`), the message is that sentence,
 * as the CLI prints it.
 */
export class ControlPlaneClient {
  private apiKey: string
  private baseUrl: string

  constructor(options: ControlPlaneClientOptions) {
    if (!options.apiKey) {
      throw new Error('API key is required to initialize ControlPlaneClient.')
    }
    this.apiKey = options.apiKey
    this.baseUrl =
      options.baseUrl || process.env.INTUTIC_CONTROL_PLANE_URL || 'https://app.intutic.ai'
  }

  private async send(
    method: string,
    path: string,
    init: { body?: unknown; form?: FormData; auth?: boolean } = {},
  ): Promise<Response> {
    // A form body sets its own multipart content type, boundary included.
    const headers: Record<string, string> = init.form ? {} : { 'Content-Type': 'application/json' }
    if (init.auth !== false) headers['Authorization'] = `Bearer ${this.apiKey}`
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      })
    } catch (err: any) {
      throw new ClawdeConnectionError(`Could not reach control plane at ${this.baseUrl}: ${err.message}`)
    }
  }

  /**
   * A JSON call. `answers` lists the error statuses whose body is the answer
   * rather than a failure: the integrity chain walk answers a break with 409.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    answers: number[] = [],
    form?: FormData,
  ): Promise<T> {
    const res = await this.send(method, path, { body, form, auth })
    const text = await res.text().catch(() => 'Unknown error')
    if (!res.ok && !answers.includes(res.status)) throw controlPlaneFailure(method, path, res.status, text)
    return (text ? unwrapToonEnvelope(JSON.parse(text)) : undefined) as T
  }

  /** A file download: the body as bytes. Its errors are JSON, as every other call's. */
  private async download(path: string): Promise<Uint8Array> {
    const res = await this.send('GET', path)
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      throw controlPlaneFailure('GET', path, res.status, text)
    }
    return new Uint8Array(await res.arrayBuffer())
  }


  /** GET /api/v1/auth/me */
  public async whoami(): Promise<WhoamiResult> {
    return this.request('GET', '/api/v1/auth/me')
  }

  /**
   * POST /api/v1/auth/signup/org — unauthenticated, creates the calling user.
   *
   * Closed by default in production (`INTUTIC_PUBLIC_ORG_SIGNUP`, off unless
   * a deployment has built its own anonymous domain-verification story):
   * creating a real org auto-provisions a real managed gateway cell (LLD
   * #71), so org creation now requires DNS domain-ownership proof, and an
   * anonymous caller has no session to own a verification attempt against.
   * Prefer `startDomainVerification` + `checkDomainVerification` +
   * `createOrg` with an already-authenticated `apiKey` — the same flow the
   * CLI's `intutic org create` and the dashboard's "Create Organization"
   * modal use.
   */
  public async signupOrg(params: OrgSignupParams): Promise<OrgSignupResult> {
    return this.request('POST', '/api/v1/auth/signup/org', params, false)
  }

  /**
   * POST /api/v1/domain-verification/start — mints a DNS TXT-record
   * verification token for `domain`. Publish a TXT record at
   * `txtRecordName` with value `txtRecordValue`, then poll
   * `checkDomainVerification` until `status` is `'verified'`.
   */
  public async startDomainVerification(domain: string): Promise<StartDomainVerificationResult> {
    return this.request('POST', '/api/v1/domain-verification/start', { domain })
  }

  /**
   * GET /api/v1/domain-verification/:id — re-checks DNS for the TXT record.
   * Safe to call repeatedly; performs a fresh lookup every call.
   */
  public async checkDomainVerification(verificationId: string): Promise<CheckDomainVerificationResult> {
    return this.request('GET', `/api/v1/domain-verification/${encodeURIComponent(verificationId)}`)
  }

  /**
   * POST /api/v1/orgs — creates a real org from an already-authenticated
   * caller. Requires a `verified`, unconsumed domain verification (see
   * `startDomainVerification`); the verification is consumed atomically
   * inside the org-insert transaction, so it backs exactly this one org.
   */
  public async createOrg(params: CreateOrgParams): Promise<CreateOrgResult> {
    return this.request('POST', '/api/v1/orgs', params)
  }

  /** GET /api/v1/orgs/:orgId/teams */
  public async listTeams(orgId: string): Promise<Team[]> {
    const res = await this.request<{ data: Team[] }>('GET', `/api/v1/orgs/${encodeURIComponent(orgId)}/teams`)
    return res.data ?? []
  }

  /** POST /api/v1/orgs/:orgId/teams */
  public async createTeam(orgId: string, name: string): Promise<Team> {
    return this.request('POST', `/api/v1/orgs/${encodeURIComponent(orgId)}/teams`, { name })
  }

  /** GET /api/v1/teams/:teamId/workspaces */
  public async listTeamWorkspaces(teamId: string): Promise<Workspace[]> {
    const res = await this.request<{ data: Workspace[] }>(
      'GET',
      `/api/v1/teams/${encodeURIComponent(teamId)}/workspaces`,
    )
    return res.data ?? []
  }

  /** POST /api/v1/teams/:teamId/workspaces */
  public async createWorkspace(teamId: string, name: string): Promise<Workspace> {
    return this.request('POST', `/api/v1/teams/${encodeURIComponent(teamId)}/workspaces`, { name })
  }

  /** POST /api/v1/gateways */
  public async registerGateway(params: GatewayRegisterParams): Promise<GatewayRegisterResult> {
    return this.request('POST', '/api/v1/gateways', params)
  }

  /** GET /api/v1/gateways */
  public async listGateways(): Promise<Gateway[]> {
    const res = await this.request<{ data: Gateway[] }>('GET', '/api/v1/gateways')
    return res.data ?? []
  }

  /** GET /api/v1/gateways/:id/status */
  public async getGatewayStatus(gatewayId: string): Promise<GatewayStatus> {
    return this.request('GET', `/api/v1/gateways/${encodeURIComponent(gatewayId)}/status`)
  }

  /** POST /api/v1/gateways/:id/rotate */
  public async rotateGatewayToken(gatewayId: string): Promise<GatewayRotateResult> {
    return this.request('POST', `/api/v1/gateways/${encodeURIComponent(gatewayId)}/rotate`, {})
  }

  /** DELETE /api/v1/gateways/:id */
  public async revokeGateway(gatewayId: string, reason?: string): Promise<void> {
    await this.request('DELETE', `/api/v1/gateways/${encodeURIComponent(gatewayId)}`, { reason })
  }

  /** GET /api/v1/gateways/:id/config — the flags set on the gateway and their version, as the gateway pulls them. */
  public async getGatewayConfig(gatewayId: string): Promise<GatewayConfigResult> {
    return this.request('GET', `/api/v1/gateways/${encodeURIComponent(gatewayId)}/config`)
  }

  /** PATCH /api/v1/gateways/:id/config */
  public async setGatewayConfig(gatewayId: string, config: GatewayConfigUpdate): Promise<GatewayConfigResult> {
    return this.request('PATCH', `/api/v1/gateways/${encodeURIComponent(gatewayId)}/config`, config)
  }

  /** PATCH /api/v1/workspace/gateway — pass null to clear the override. */
  public async assignWorkspaceGateway(gatewayId: string | null): Promise<{ gatewayId: string | null }> {
    return this.request('PATCH', '/api/v1/workspace/gateway', { gatewayId })
  }

  /** PATCH /api/v1/orgs/:orgId/gateway — pass null to clear the org default. */
  public async assignOrgGateway(orgId: string, gatewayId: string | null): Promise<{ gatewayId: string | null }> {
    return this.request('PATCH', `/api/v1/orgs/${encodeURIComponent(orgId)}/gateway`, { gatewayId })
  }

  /** GET /api/v1/workspace/gateway-resolution */
  public async resolveGateway(): Promise<GatewayResolution> {
    return this.request('GET', '/api/v1/workspace/gateway-resolution')
  }

  /** GET /api/v1/workspace/settings — every setting, resolved with its default. */
  public async getWorkspaceSettings(): Promise<WorkspaceSettings> {
    return this.request('GET', '/api/v1/workspace/settings')
  }

  /**
   * PUT /api/v1/workspace/settings — the route `intutic settings set` calls.
   *
   * Only the keys given change; the rest are kept (`featureFlags` merges one
   * level deeper, so one flag does not switch the others off). The control
   * plane is the authority on which keys exist and what each accepts: an
   * unknown key or a bad value is refused with a 400 naming it, a setting the
   * workspace's plan does not include (the group policy below Biz Org) with a
   * 403 "Upgrade required", and a member below OWNER or ADMIN with a 403. Each
   * refusal throws `ClawdeConnectionError` carrying the server's answer.
   */
  public async updateWorkspaceSettings(settings: Record<string, unknown>): Promise<WorkspaceSettingsUpdateResult> {
    return this.request('PUT', '/api/v1/workspace/settings', settings)
  }

  /** GET /api/v1/workspace/provider-credentials */
  public async listProviderCredentials(): Promise<ProviderCredentialStatus[]> {
    const res = await this.request<{ data: ProviderCredentialStatus[] }>(
      'GET',
      '/api/v1/workspace/provider-credentials',
    )
    return res.data ?? []
  }

  /** PUT /api/v1/workspace/provider-credentials/:provider */
  public async setProviderCredential(
    provider: string,
    fields: Record<string, string>,
  ): Promise<ProviderCredentialStatus> {
    return this.request('PUT', `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}`, fields)
  }

  /** DELETE /api/v1/workspace/provider-credentials/:provider */
  public async unsetProviderCredential(provider: string): Promise<void> {
    await this.request('DELETE', `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}`)
  }

  /** GET /api/v1/workspace/provider-credentials/:provider/models */
  public async listProviderModels(provider: string): Promise<ProviderModelList> {
    return this.request('GET', `/api/v1/workspace/provider-credentials/${encodeURIComponent(provider)}/models`)
  }

  // ─── MCP server registry (`intutic mcp`) ───

  /** GET /api/v1/mcp/servers — every server the workspace's MCP proxies have reported, and the registry-wide policy. */
  public async listMcpServers(): Promise<McpServerList> {
    return this.request('GET', '/api/v1/mcp/servers')
  }

  /** POST /api/v1/mcp/servers/:serverId/status — approve a server (OWNER, ADMIN). */
  public async approveMcpServer(serverId: string): Promise<McpServerDecision> {
    return this.setMcpServerStatus(serverId, 'approved')
  }

  /** POST /api/v1/mcp/servers/:serverId/status — block a server (OWNER, ADMIN). */
  public async blockMcpServer(serverId: string): Promise<McpServerDecision> {
    return this.setMcpServerStatus(serverId, 'blocked')
  }

  /** POST /api/v1/mcp/servers/:serverId/status — return a server to the approval queue (OWNER, ADMIN). */
  public async resetMcpServer(serverId: string): Promise<McpServerDecision> {
    return this.setMcpServerStatus(serverId, 'candidate')
  }

  /** POST /api/v1/mcp/servers/:serverId/tools — switch one tool on (OWNER, ADMIN). */
  public async enableMcpTool(serverId: string, tool: string): Promise<McpServerDecision> {
    return this.request('POST', `/api/v1/mcp/servers/${seg(serverId)}/tools`, { tool, enabled: true })
  }

  /** POST /api/v1/mcp/servers/:serverId/tools — switch one tool off (OWNER, ADMIN). */
  public async disableMcpTool(serverId: string, tool: string): Promise<McpServerDecision> {
    return this.request('POST', `/api/v1/mcp/servers/${seg(serverId)}/tools`, { tool, enabled: false })
  }

  private async setMcpServerStatus(serverId: string, status: 'approved' | 'blocked' | 'candidate'): Promise<McpServerDecision> {
    return this.request('POST', `/api/v1/mcp/servers/${seg(serverId)}/status`, { status })
  }

  // ─── Notification rules (`intutic notifications`) ───

  /** GET /api/v1/notifications/rules */
  public async listNotificationRules(): Promise<NotificationRule[]> {
    const res = await this.request<{ rules: NotificationRule[] }>('GET', '/api/v1/notifications/rules')
    return res.rules ?? []
  }

  /**
   * POST /api/v1/notifications/rules. A webhook rule comes back with its
   * `signingSecret`, which is not shown again.
   */
  public async createNotificationRule(rule: NotificationRuleInput): Promise<NotificationRule> {
    return this.request('POST', '/api/v1/notifications/rules', rule)
  }

  /**
   * PUT /api/v1/notifications/rules/:ruleId — only the fields given change.
   * A switch to the webhook channel comes back with the new `signingSecret`.
   */
  public async updateNotificationRule(ruleId: string, changes: NotificationRuleUpdate): Promise<NotificationRule> {
    return this.request('PUT', `/api/v1/notifications/rules/${seg(ruleId)}`, changes)
  }

  /** DELETE /api/v1/notifications/rules/:ruleId */
  public async deleteNotificationRule(ruleId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/notifications/rules/${seg(ruleId)}`)
  }

  /** POST /api/v1/notifications/rules/:ruleId/signing-secret — deliveries are signed with the new secret from now on. */
  public async rotateNotificationRuleSecret(ruleId: string): Promise<NotificationSecretRotation> {
    return this.request('POST', `/api/v1/notifications/rules/${seg(ruleId)}/signing-secret`)
  }

  // ─── SIEM export (`intutic siem`) ───

  /** GET /api/v1/siem/destinations — the destinations and the event sources they can receive. */
  public async listSiemDestinations(): Promise<SiemDestinationList> {
    return this.request('GET', '/api/v1/siem/destinations')
  }

  /** GET /api/v1/siem/destinations/:destinationId */
  public async getSiemDestination(destinationId: string): Promise<SiemDestination> {
    return this.request('GET', `/api/v1/siem/destinations/${seg(destinationId)}`)
  }

  /** The event sources a destination can receive; `defaults` are the ones an empty `sourceTables` means. */
  public async listSiemSources(): Promise<SiemSources> {
    return (await this.listSiemDestinations()).sources
  }

  /**
   * POST /api/v1/siem/destinations (OWNER, ADMIN). The control plane refuses
   * a destination that points at an internal address. A webhook destination
   * comes back with its `signingSecret`, which is not shown again.
   */
  public async createSiemDestination(destination: SiemDestinationInput): Promise<SiemDestination> {
    return this.request('POST', '/api/v1/siem/destinations', destination)
  }

  /** PUT /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) — only the fields given change. */
  public async updateSiemDestination(destinationId: string, changes: SiemDestinationUpdate): Promise<SiemDestination> {
    return this.request('PUT', `/api/v1/siem/destinations/${seg(destinationId)}`, changes)
  }

  /** DELETE /api/v1/siem/destinations/:destinationId (OWNER, ADMIN) — deactivates it; `updateSiemDestination(id, { isActive: true })` turns it back on. */
  public async deleteSiemDestination(destinationId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/siem/destinations/${seg(destinationId)}`)
  }

  /** POST /api/v1/siem/destinations/:destinationId/signing-secret (OWNER, ADMIN) */
  public async rotateSiemDestinationSecret(destinationId: string): Promise<SiemSecretRotation> {
    return this.request('POST', `/api/v1/siem/destinations/${seg(destinationId)}/signing-secret`)
  }

  // ─── Usage (`intutic usage`) ───
  //
  // OWNER, ADMIN and EM see the whole workspace; anyone else their own calls
  // (`scope: 'self'`). `getTeamUsage` is refused below EM.

  /** GET /api/v1/usage/members */
  public async getMemberUsage(options: UsageOptions = {}): Promise<MemberUsageResponse> {
    return this.request('GET', `/api/v1/usage/members${usagePeriod(options)}`)
  }

  /** GET /api/v1/usage/teams — per SCIM group. */
  public async getTeamUsage(options: UsageOptions = {}): Promise<TeamUsageResponse> {
    return this.request('GET', `/api/v1/usage/teams${usagePeriod(options)}`)
  }

  /** GET /api/v1/usage/branches */
  public async getBranchUsage(options: UsageOptions = {}): Promise<BranchUsageResponse> {
    return this.request('GET', `/api/v1/usage/branches${usagePeriod(options)}`)
  }

  /** GET /api/v1/usage/commits */
  public async getCommitUsage(options: UsageOptions = {}): Promise<CommitUsageResponse> {
    return this.request('GET', `/api/v1/usage/commits${usagePeriod(options)}`)
  }

  /** GET /api/v1/usage/pull-requests */
  public async getPullRequestUsage(options: UsageOptions = {}): Promise<PullRequestUsageResponse> {
    return this.request('GET', `/api/v1/usage/pull-requests${usagePeriod(options)}`)
  }

  /** POST /api/v1/usage/pull-requests/refresh — look the branches up on GitHub now (OWNER, ADMIN, EM). */
  public async refreshPullRequestUsage(): Promise<PullRequestRefreshResult> {
    return this.request('POST', '/api/v1/usage/pull-requests/refresh')
  }

  // ─── AI inventory (`intutic inventory`) ───
  //
  // OWNER, ADMIN and EM see every machine; a DEVELOPER only their own.

  /** GET /api/v1/inventory/summary */
  public async getInventorySummary(): Promise<InventorySummary> {
    return (await this.request<{ data: InventorySummary }>('GET', '/api/v1/inventory/summary')).data
  }

  /** GET /api/v1/inventory/devices — one row per machine. */
  public async listInventoryDevices(): Promise<InventoryDevice[]> {
    return this.listData('/api/v1/inventory/devices')
  }

  /** GET /api/v1/inventory/harnesses */
  public async listInventoryHarnesses(filters: InventoryFilters = {}): Promise<InventoryHarness[]> {
    return this.listData(`/api/v1/inventory/harnesses${inventoryQuery(filters)}`)
  }

  /** GET /api/v1/inventory/mcp-servers */
  public async listInventoryMcpServers(filters: InventoryFilters = {}): Promise<InventoryMcpServer[]> {
    return this.listData(`/api/v1/inventory/mcp-servers${inventoryQuery(filters)}`)
  }

  /** GET /api/v1/inventory/skills */
  public async listInventorySkills(filters: InventorySkillFilters = {}): Promise<InventorySkill[]> {
    return this.listData(`/api/v1/inventory/skills${inventoryQuery(filters)}`)
  }

  /** GET /api/v1/inventory/disconnects — machines that ran `intutic disconnect`, newest first (default 100, at most 500). */
  public async listInventoryDisconnects(options: { limit?: number } = {}): Promise<DeviceDisconnect[]> {
    return this.listData(`/api/v1/inventory/disconnects${query({ limit: options.limit })}`)
  }

  /** GET /api/v1/inventory/harnesses?format=csv — the CSV the dashboard downloads. */
  public async downloadInventoryHarnessesCsv(filters: InventoryFilters = {}): Promise<Uint8Array> {
    return this.download(`/api/v1/inventory/harnesses${inventoryQuery(filters, true)}`)
  }

  /** GET /api/v1/inventory/mcp-servers?format=csv */
  public async downloadInventoryMcpServersCsv(filters: InventoryFilters = {}): Promise<Uint8Array> {
    return this.download(`/api/v1/inventory/mcp-servers${inventoryQuery(filters, true)}`)
  }

  private async listData<T>(path: string): Promise<T[]> {
    return (await this.request<{ data?: T[] }>('GET', path)).data ?? []
  }

  // ─── Compliance (`intutic compliance`) ───

  /** GET /api/v1/compliance/frameworks/:frameworkId/coverage — `eu_ai_act`, `iso_42001`, `nist_ai_rmf` or `mitre_atlas`. */
  public async getFrameworkCoverage(frameworkId: string): Promise<FrameworkCoverage> {
    return this.request('GET', `/api/v1/compliance/frameworks/${seg(frameworkId)}/coverage`)
  }

  /**
   * GET /api/v1/compliance/frameworks/:frameworkId/coverage?format= — the
   * report as a file. Unsigned: the signed copies are the ones sealed in the
   * evidence archive.
   */
  public async downloadFrameworkCoverage(frameworkId: string, format: CoverageFormat): Promise<Uint8Array> {
    const routeFormat = COVERAGE_FORMATS[format]
    if (!routeFormat) throw new Error(`format must be one of ${Object.keys(COVERAGE_FORMATS).join(', ')}, got "${format}"`)
    return this.download(`/api/v1/compliance/frameworks/${seg(frameworkId)}/coverage${query({ format: routeFormat })}`)
  }

  /** POST /api/v1/compliance/soc2-collect (OWNER, ADMIN) — run a fresh evidence collection and seal it. */
  public async collectEvidence(options: EvidenceCollectOptions = {}): Promise<EvidenceCollectResult> {
    return this.request('POST', '/api/v1/compliance/soc2-collect', defined({ periodStart: options.periodStart, periodEnd: options.periodEnd }))
  }

  /** GET /api/v1/compliance/soc2-export/:runId (OWNER, ADMIN) — a stored archive, as the file. Check it with `verifyEvidenceArchive`. */
  public async downloadEvidence(runId: string): Promise<Uint8Array> {
    return this.download(`/api/v1/compliance/soc2-export/${seg(runId)}`)
  }

  /**
   * GET /.well-known/intutic-trace-signing.json — the published signing keys,
   * fetched without credentials. `verifyEvidenceArchive` takes them.
   */
  public async getSigningKeys(): Promise<SigningJwks> {
    return this.request('GET', '/.well-known/intutic-trace-signing.json', undefined, false)
  }

  // ─── Gate liveness and the GitHub webhook ───

  /** GET /api/v1/governance/gate-liveness (OWNER, ADMIN, EM) — whether each installed harness's gate is reporting. */
  public async getGateLiveness(): Promise<GateLiveness> {
    return this.request('GET', '/api/v1/governance/gate-liveness')
  }

  /** GET /api/v1/integrations/github/webhook (OWNER, ADMIN) — the payload URL; never the secret. */
  public async getGithubWebhook(): Promise<GitHubWebhookInfo> {
    return this.request('GET', '/api/v1/integrations/github/webhook')
  }

  /**
   * POST /api/v1/integrations/github/webhook/secret (OWNER, ADMIN) — make the
   * webhook, or replace its secret. Deliveries signed with an earlier secret
   * are refused from then on.
   */
  public async rotateGithubWebhookSecret(): Promise<GitHubWebhookSecret> {
    return this.request('POST', '/api/v1/integrations/github/webhook/secret')
  }

  // ─── Policy guardrails (`intutic guardrails`) ───

  /** GET /api/v1/connectors — the workspace's policy sources (Notion, Confluence, GitHub, Google Drive). */
  public async listPolicySources(): Promise<PolicySource[]> {
    const res = await this.request<{ items?: PolicySource[] }>('GET', '/api/v1/connectors')
    return (res.items ?? []).filter((c) => POLICY_SOURCE_PROVIDERS.has(c.provider))
  }

  /** POST /api/v1/connectors */
  public async addPolicySource(source: PolicySourceInput): Promise<PolicySource> {
    return this.request('POST', '/api/v1/connectors', { config: {}, ...source })
  }

  /** POST /api/v1/connectors/:connectorId/sync */
  public async syncPolicySource(connectorId: string): Promise<PolicySourceSyncResult> {
    return this.request('POST', `/api/v1/connectors/${seg(connectorId)}/sync`, {})
  }

  /** GET /api/v1/policy-guardrails/documents */
  public async listPolicyDocuments(): Promise<PolicyDocumentSummary[]> {
    return (await this.request<{ documents?: PolicyDocumentSummary[] }>('GET', `${GUARDRAILS}/documents`)).documents ?? []
  }

  /** GET /api/v1/policy-guardrails/documents/:docId — passages, clauses and extraction runs. */
  public async getPolicyDocument(docId: string): Promise<PolicyDocumentDetail> {
    return (await this.request<{ document: PolicyDocumentDetail }>('GET', `${GUARDRAILS}/documents/${seg(docId)}`)).document
  }

  /** POST /api/v1/policy-guardrails/documents/:docId/extract — propose guardrails from the document's clauses. */
  public async extractPolicyDocument(docId: string, options: ExtractOptions = {}): Promise<ExtractDocumentResult> {
    const res = await this.request<{ result: ExtractDocumentResult }>('POST', `${GUARDRAILS}/documents/${seg(docId)}/extract`, {
      llm: options.llm ?? true,
    })
    return res.result
  }

  /** GET /api/v1/policy-guardrails/coverage?token= — the passages that mention a tool or action, and the guardrails on them. */
  public async getGuardrailCoverage(token: string): Promise<TokenCoverage> {
    return (await this.request<{ coverage: TokenCoverage }>('GET', `${GUARDRAILS}/coverage${query({ token })}`)).coverage
  }

  /** GET /api/v1/policy-guardrails/search?q= — full-text search over live passages, best match first. */
  public async searchPolicyPassages(text: string): Promise<PassageSearchResult> {
    return (await this.request<{ search: PassageSearchResult }>('GET', `${GUARDRAILS}/search${query({ q: text })}`)).search
  }

  /** GET /api/v1/policy-guardrails/impact — what a change to a document or a passage reaches. Name one of them. */
  public async getGuardrailImpact(seed: GuardrailImpactSeed): Promise<LedgerImpact> {
    const path = `${GUARDRAILS}/impact${query({ docId: seed.docId, passageId: seed.passageId })}`
    return (await this.request<{ impact: LedgerImpact }>('GET', path)).impact
  }

  /** GET /api/v1/policy-guardrails/duplicates — overlapping passages and rules cited more than once. */
  public async listGuardrailDuplicates(options: DuplicatesOptions = {}): Promise<LedgerDuplicates> {
    const path = `${GUARDRAILS}/duplicates${query({ minJaccard: options.minJaccard })}`
    return (await this.request<{ duplicates: LedgerDuplicates }>('GET', path)).duplicates
  }

  /** GET /api/v1/policy-guardrails/guardrails */
  public async listGuardrails(filters: GuardrailFilters = {}): Promise<GuardrailSummary[]> {
    const path = `${GUARDRAILS}/guardrails${query({
      status: filters.status,
      target: filters.target,
      provenance: filters.provenance,
      docId: filters.docId,
      limit: filters.limit,
    })}`
    return (await this.request<{ guardrails?: GuardrailSummary[] }>('GET', path)).guardrails ?? []
  }

  /** GET /api/v1/policy-guardrails/guardrails/:guardrailId */
  public async getGuardrail(guardrailId: string): Promise<GuardrailDetail> {
    return (await this.request<{ guardrail: GuardrailDetail }>('GET', `${GUARDRAILS}/guardrails/${seg(guardrailId)}`)).guardrail
  }

  /** GET /api/v1/policy-guardrails/guardrails/:guardrailId/readiness — whether a SHADOW guardrail's evidence clears promotion. */
  public async getGuardrailReadiness(guardrailId: string): Promise<GuardrailReadiness> {
    const res = await this.request<{ readiness: GuardrailReadiness }>('GET', `${GUARDRAILS}/guardrails/${seg(guardrailId)}/readiness`)
    return res.readiness
  }

  /** POST …/guardrails/:guardrailId/approve-shadow — into SHADOW: distributed as warn, measuring, enforcing nothing. */
  public async approveGuardrailShadow(guardrailId: string): Promise<GuardrailTransitionResult> {
    return this.transitionGuardrail(guardrailId, 'approve-shadow', {})
  }

  /**
   * POST …/guardrails/:guardrailId/promote — into ENFORCING. Refused with a
   * 409 until the shadow evidence clears the thresholds; a guardrail that
   * never fired needs `acknowledgeNoTraffic`.
   */
  public async promoteGuardrail(guardrailId: string, options: PromoteOptions = {}): Promise<GuardrailTransitionResult> {
    return this.transitionGuardrail(guardrailId, 'promote', { acknowledgeNoTraffic: options.acknowledgeNoTraffic === true })
  }

  /** POST …/guardrails/:guardrailId/reject — recorded with the reason. */
  public async rejectGuardrail(guardrailId: string, reason: string): Promise<GuardrailTransitionResult> {
    return this.transitionGuardrail(guardrailId, 'reject', { reason })
  }

  /** POST …/guardrails/:guardrailId/retire — gone from every rule endpoint on the next poll. */
  public async retireGuardrail(guardrailId: string): Promise<GuardrailTransitionResult> {
    return this.transitionGuardrail(guardrailId, 'retire', {})
  }

  /** POST …/guardrails/:guardrailId/reconfirm — re-confirm a stale citation against a live passage. */
  public async reconfirmGuardrail(guardrailId: string): Promise<GuardrailTransitionResult> {
    return this.transitionGuardrail(guardrailId, 'reconfirm', {})
  }

  /**
   * POST /api/v1/policy-guardrails/guardrails (OWNER, ADMIN) — an authored
   * guardrail, created PROPOSED. An IR a check refuses is a 400 naming the
   * check.
   */
  public async createGuardrail(guardrail: AuthoredGuardrailInput): Promise<AuthoredGuardrailWriteResult> {
    return this.request('POST', `${GUARDRAILS}/guardrails`, guardrail)
  }

  /**
   * PUT /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER, ADMIN). A
   * changed IR creates the next version (`forked`), PROPOSED with no
   * evidence; a name or description edit keeps the evidence.
   */
  public async updateGuardrail(guardrailId: string, changes: AuthoredGuardrailUpdate): Promise<AuthoredGuardrailWriteResult> {
    return this.request('PUT', `${GUARDRAILS}/guardrails/${seg(guardrailId)}`, changes)
  }

  /** DELETE /api/v1/policy-guardrails/guardrails/:guardrailId (OWNER, ADMIN) — retires it; its history is kept. */
  public async deleteGuardrail(guardrailId: string): Promise<GuardrailDeleteResult> {
    return this.request('DELETE', `${GUARDRAILS}/guardrails/${seg(guardrailId)}`)
  }

  /** POST …/guardrails/:guardrailId/replay — what the guardrail would have done on captured traffic. */
  public async replayGuardrail(guardrailId: string): Promise<GuardrailReplay> {
    return (await this.request<{ replay: GuardrailReplay }>('POST', `${GUARDRAILS}/guardrails/${seg(guardrailId)}/replay`, {})).replay
  }

  /** GET /api/v1/policy-guardrails/conflicts — live guardrails and front-matter rules that contradict each other. */
  public async listGuardrailConflicts(): Promise<GuardrailConflict[]> {
    return (await this.request<{ conflicts?: GuardrailConflict[] }>('GET', `${GUARDRAILS}/conflicts`)).conflicts ?? []
  }

  private async transitionGuardrail(guardrailId: string, action: string, body: Record<string, unknown>): Promise<GuardrailTransitionResult> {
    return this.request('POST', `${GUARDRAILS}/guardrails/${seg(guardrailId)}/${action}`, body)
  }

  // ─── Held decisions and loop runs (`intutic decision`, `intutic loop`) ───

  /** POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) — approve a held call. */
  public async approveDecision(holdId: string, options: ReviewOptions = {}): Promise<DecisionReviewResult> {
    return this.request('POST', `/api/v1/decisions/${seg(holdId)}/review`, defined({ action: 'approve', reason: options.reason }))
  }

  /** POST /api/v1/decisions/:holdId/review (OWNER, ADMIN, EM) — reject a held call. */
  public async rejectDecision(holdId: string, options: ReviewOptions = {}): Promise<DecisionReviewResult> {
    return this.request('POST', `/api/v1/decisions/${seg(holdId)}/review`, defined({ action: 'reject', reason: options.reason }))
  }

  /**
   * POST /api/v1/loops/start — register a loop run. Send its id with the run's
   * requests (`INTUTIC_LOOP_RUN_ID`, as `intutic loop exec` sets it) so the
   * proxy files them under it.
   */
  public async startLoopRun(name: string, options: StartLoopRunOptions = {}): Promise<LoopRun> {
    const body = defined({ name, budgetLimitUsd: options.budgetLimitUsd, sops: options.sops, autoJudge: options.autoJudge })
    return (await this.request<{ loop: LoopRun }>('POST', '/api/v1/loops/start', body)).loop
  }

  /** GET /api/v1/loops/:loopRunId */
  public async getLoopRun(loopRunId: string): Promise<LoopRun> {
    return (await this.request<{ loop: LoopRun }>('GET', `/api/v1/loops/${seg(loopRunId)}`)).loop
  }

  /** GET /api/v1/loops */
  public async listLoopRuns(): Promise<LoopRun[]> {
    return (await this.request<{ loops?: LoopRun[] }>('GET', '/api/v1/loops')).loops ?? []
  }

  /** POST /api/v1/loops/:loopRunId/complete — `outcome` records how the run ended. */
  public async completeLoopRun(loopRunId: string, options: CompleteLoopRunOptions = {}): Promise<LoopRunActionResult> {
    const body = options.outcome === undefined ? undefined : { outcome: options.outcome }
    return this.request('POST', `/api/v1/loops/${seg(loopRunId)}/complete`, body)
  }

  /** POST /api/v1/loops/:loopRunId/kill */
  public async killLoopRun(loopRunId: string): Promise<LoopRunActionResult> {
    return this.request('POST', `/api/v1/loops/${seg(loopRunId)}/kill`)
  }

  /** POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) — approve a run held for review; it is ACTIVE again. */
  public async approveLoopRun(loopRunId: string, options: LoopRunReviewOptions = {}): Promise<LoopRunActionResult> {
    return this.request('POST', `/api/v1/loops/${seg(loopRunId)}/review`, defined({ action: 'approve', note: options.note }))
  }

  /** POST /api/v1/loops/:loopRunId/review (OWNER, ADMIN, EM) — reject a run held for review; it is KILLED. */
  public async rejectLoopRun(loopRunId: string, options: LoopRunReviewOptions = {}): Promise<LoopRunActionResult> {
    return this.request('POST', `/api/v1/loops/${seg(loopRunId)}/review`, defined({ action: 'reject', note: options.note }))
  }

  // ─── Findings (`intutic findings`) ───

  /** GET /api/v1/findings — detector findings, newest first. */
  public async listFindings(filters: FindingFilters = {}): Promise<Finding[]> {
    const path = `/api/v1/findings${query({
      unadjudicated: filters.unadjudicated ? 'true' : undefined,
      detector_id: filters.detectorId,
      limit: filters.limit,
    })}`
    return (await this.request<{ findings?: Finding[] }>('GET', path)).findings ?? []
  }

  /** POST /api/v1/findings/:findingId/adjudicate — the ruling is recorded under the key's member. */
  public async adjudicateFinding(findingId: string, outcome: FindingOutcome, options: AdjudicateOptions = {}): Promise<FindingAdjudication> {
    return this.request('POST', `/api/v1/findings/${seg(findingId)}/adjudicate`, defined({ outcome, note: options.note }))
  }

  /** GET /api/v1/findings/stats — false-positive rate per detector, over adjudicated findings. */
  public async getFindingStats(): Promise<FindingStats> {
    return this.request('GET', '/api/v1/findings/stats')
  }

  /** GET /api/v1/findings/response-echo/report */
  public async getResponseEchoReport(options: ResponseEchoReportOptions = {}): Promise<ResponseEchoReport> {
    return this.request('GET', `/api/v1/findings/response-echo/report${query({ since: options.since, until: options.until })}`)
  }

  // ─── Governance incidents (`intutic incidents`) ───
  //
  // OWNER, ADMIN and EM only: incidents carry tool arguments and DLP reasons.

  /** GET /api/v1/incidents — ranked by review priority; filter by status, severity and type. */
  public async listIncidents(filters: IncidentFilters = {}): Promise<IncidentList> {
    const path = `/api/v1/incidents${query({
      status: filters.status,
      severity: filters.severity,
      type: filters.type,
      page: filters.page,
      limit: filters.limit,
    })}`
    return this.request('GET', path)
  }

  /** GET /api/v1/incidents/:incidentId */
  public async getIncident(incidentId: string): Promise<Incident> {
    return (await this.request<{ data: Incident }>('GET', `/api/v1/incidents/${seg(incidentId)}`)).data
  }

  // ─── Traces (`intutic traces`) ───

  /** GET /api/v1/traces — newest first. */
  public async listTraces(filters: TraceFilters = {}): Promise<TraceList> {
    const path = `/api/v1/traces${query({
      limit: filters.limit,
      offset: filters.offset,
      since: filters.since,
      enforcement: filters.enforcement,
      model: filters.model,
    })}`
    return this.request('GET', path)
  }

  /** GET /api/v1/traces/:traceId */
  public async getTrace(traceId: string): Promise<TraceDetail> {
    return this.request('GET', `/api/v1/traces/${seg(traceId)}`)
  }

  // ─── Trace integrity (`intutic integrity`) ───

  /** GET /api/v1/integrity/roots — the sealed trace roots. */
  public async listIntegrityRoots(options: { loopRunId?: string } = {}): Promise<IntegrityRootList> {
    return this.request('GET', `/api/v1/integrity/roots${query({ loopRunId: options.loopRunId })}`)
  }

  /** GET /api/v1/integrity/roots/:rootId — the root, its signature and its leaves. */
  public async getIntegrityRoot(rootId: string): Promise<IntegrityRootDetail> {
    return this.request('GET', `/api/v1/integrity/roots/${seg(rootId)}`)
  }

  /** POST /api/v1/integrity/roots/:rootId/recompute — re-derive the root from the stored traces. */
  public async recomputeIntegrityRoot(rootId: string): Promise<IntegrityRecompute> {
    return this.request('POST', `/api/v1/integrity/roots/${seg(rootId)}/recompute`, {})
  }

  /** GET /api/v1/integrity/chain — the root chain walk; `intact: false` lists the breaks. */
  public async getIntegrityChain(): Promise<IntegrityChain> {
    return this.request('GET', '/api/v1/integrity/chain', undefined, true, [409])
  }

  /** GET /api/v1/integrity/config-chain — the harness config snapshot chain walk. */
  public async getIntegrityConfigChain(): Promise<ConfigChain> {
    return this.request('GET', '/api/v1/integrity/config-chain', undefined, true, [409])
  }

  // ─── Compliance policies and WASM rules (`intutic policy`) ───

  /** GET /api/v1/policies */
  public async listPolicies(): Promise<CompliancePolicy[]> {
    return (await this.request<{ policies?: CompliancePolicy[] }>('GET', '/api/v1/policies')).policies ?? []
  }

  /** POST /api/v1/policies/:policyId/enable */
  public async enablePolicy(policyId: string): Promise<PolicyChangeResult> {
    return this.request('POST', `/api/v1/policies/${seg(policyId)}/enable`)
  }

  /** POST /api/v1/policies/:policyId/disable */
  public async disablePolicy(policyId: string): Promise<PolicyChangeResult> {
    return this.request('POST', `/api/v1/policies/${seg(policyId)}/disable`)
  }

  /** POST /api/v1/policies/:policyId/rollback */
  public async rollbackPolicy(policyId: string, version: number): Promise<PolicyChangeResult> {
    return this.request('POST', `/api/v1/policies/${seg(policyId)}/rollback`, { version })
  }

  /**
   * GET /api/v1/rule-candidates/:candidateId/source — the source of record a
   * candidate's bundle must be compiled from. A source that does not hash to
   * the `sourceSha256` served with it is refused (`ClawdeConnectionError`):
   * something between the control plane and this process changed it.
   */
  public async getRuleCandidateSource(candidateId: string): Promise<RuleCandidateSource> {
    const res = await this.request<RuleCandidateSource>('GET', `/api/v1/rule-candidates/${seg(candidateId)}/source`)
    const local = createHash('sha256').update(res.source, 'utf8').digest('hex')
    const stated = res.sourceSha256.toLowerCase()
    if (local !== stated) {
      throw new ClawdeConnectionError(`The served source hashes to ${local}, not the ${stated} the control plane states.`)
    }
    return { ...res, sourceSha256: stated }
  }

  /**
   * POST /api/v1/rule-candidates/:candidateId/bundle (OWNER, ADMIN) — upload
   * a compiled rule with the hash of the source it was compiled from. The
   * control plane runs its gates; `accepted` says whether the rule went into
   * shadow, and `gates` why.
   */
  public async uploadRuleCandidateBundle(
    candidateId: string,
    wasm: Uint8Array,
    sourceSha256: string,
    options: BundleUploadOptions = {},
  ): Promise<BundleUploadResult> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wasm)], { type: 'application/wasm' }), options.fileName ?? 'rule.wasm')
    form.append('source_sha256', sourceSha256)
    return this.request('POST', `/api/v1/rule-candidates/${seg(candidateId)}/bundle`, undefined, true, [], form)
  }

  /** POST /api/v1/wasm-rules/:ruleId/replay — what a rule would have done on sampled traffic, without enforcing. */
  public async replayWasmRule(ruleId: string, options: WasmReplayOptions = {}): Promise<WasmReplayResult> {
    return this.request('POST', `/api/v1/wasm-rules/${seg(ruleId)}/replay`, defined({ limit: options.limit, since: options.since }))
  }

  // ─── SOPs (`intutic sops`) ───

  /** GET /api/v1/sops */
  public async listSops(options: { limit?: number } = {}): Promise<SopSummary[]> {
    return (await this.request<{ items?: SopSummary[] }>('GET', `/api/v1/sops${query({ limit: options.limit })}`)).items ?? []
  }

  /** GET /api/v1/sops/:sopId */
  public async getSop(sopId: string): Promise<SopDetail> {
    return this.request('GET', `/api/v1/sops/${seg(sopId)}`)
  }

  /** POST /api/v1/sops — one workspace SOP; `markdown_content` without front matter. */
  public async createSop(sop: SopInput): Promise<SopCreateResult> {
    return this.request('POST', '/api/v1/sops', sop)
  }

  /** GET /api/v1/workspace/org-sops — the org-wide SOP floors of the key's org. */
  public async listOrgSops(): Promise<OrgSop[]> {
    return this.listData('/api/v1/workspace/org-sops')
  }

  /** POST /api/v1/workspace/org-sops — a mandatory org-wide floor (OWNER, ADMIN of a workspace in the org). */
  public async createOrgSop(sop: OrgSopInput): Promise<OrgSop> {
    return this.request('POST', '/api/v1/workspace/org-sops', sop)
  }

  /** DELETE /api/v1/workspace/org-sops/:orgSopId — answers 404 both for no such SOP and for a member without admin access. */
  public async deleteOrgSop(orgSopId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/workspace/org-sops/${seg(orgSopId)}`)
  }

  // ─── Key attenuation, cost prediction, routing ───

  /**
   * POST /api/v1/attenuate — a child key narrowed to a subset of the parent
   * key's capabilities. The child key is in the response once and never
   * stored.
   */
  public async attenuateKey(parentKeyId: string, requestedCaps: string[], options: AttenuateOptions = {}): Promise<AttenuationResult> {
    return this.request('POST', '/api/v1/attenuate', defined({ parentKeyId, requestedCaps, ttlSeconds: options.ttlSeconds }))
  }

  /** GET /api/v1/attenuate/chain/:chainId (OWNER, ADMIN) — the delegation lineage. */
  public async getAttenuationChain(chainId: string): Promise<AttenuationChainLink[]> {
    return (await this.request<{ chain?: AttenuationChainLink[] }>('GET', `/api/v1/attenuate/chain/${seg(chainId)}`)).chain ?? []
  }

  /** POST /api/v1/predict-cost — estimate a call's cost before it runs. Size the input with a token count or the text. */
  public async predictCost(params: PredictCostParams): Promise<CostPrediction> {
    return this.request('POST', '/api/v1/predict-cost', params)
  }

  /** GET /api/v1/routing/mirror-adoption-report — how a mirror-tested candidate model compared. Reported only; changes nothing. */
  public async getMirrorAdoptionReport(candidateModel: string): Promise<MirrorAdoptionReport> {
    return this.request('GET', `/api/v1/routing/mirror-adoption-report${query({ candidateModel })}`)
  }
}

const GUARDRAILS = '/api/v1/policy-guardrails'

const seg = encodeURIComponent

/** A query string of the parameters that are set, with its `?`; empty when none is. */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, String(value))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

function usagePeriod(options: UsageOptions): string {
  return query({ period: options.period ?? 'monthly' })
}

function inventoryQuery(filters: InventoryFilters, csv = false): string {
  return query({
    status: filters.status,
    harness: filters.harness,
    device: filters.device,
    q: filters.search,
    format: csv ? 'csv' : undefined,
  })
}

/** The object without its undefined members, which is also what JSON sends. */
function defined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}

/**
 * The error a failed call throws. A 403 carries the control plane's `detail`
 * when it gives one (a role guard names the roles that may make the call), so
 * the message says which role can, as the CLI's does.
 */
function controlPlaneFailure(method: string, path: string, status: number, text: string): ClawdeConnectionError {
  if (status === 403) {
    try {
      const body = JSON.parse(text) as { detail?: unknown }
      if (typeof body.detail === 'string') {
        return new ClawdeConnectionError(`Control plane ${method} ${path} refused (403): ${body.detail}`)
      }
    } catch {
      // Not JSON: the raw answer below.
    }
  }
  return new ClawdeConnectionError(`Control plane ${method} ${path} failed (${status}): ${text}`)
}
