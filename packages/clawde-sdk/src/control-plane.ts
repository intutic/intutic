import { ClawdeConnectionError } from './errors'
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
} from './types'

/**
 * Control-plane management client (LLD #69) — org/team/gateway/credentials
 * administration, as distinct from `ClawdeClient`'s data-plane chat calls.
 *
 * Deliberately a separate class, not new methods on `ClawdeClient`:
 * `ClawdeClient.baseUrl` targets the *proxy* (default `http://localhost:4000`);
 * the control plane is a different origin entirely (default
 * `https://app.intutic.ai`, or a self-hosted `CONTROL_PLANE_URL`). Bolting
 * management calls onto `ClawdeClient` would silently need a second base URL
 * on a class whose whole contract today is "one client, one proxy."
 *
 * Every endpoint here is mirrored 1:1 from `tools/cli/src/commands/{org,
 * team,gateway,credentials,whoami}.ts` — the CLI's own already-tested
 * contracts, not re-derived. Endpoints deliberately NOT included: session
 * establishment (`login`/`logout` — an SDK caller supplies `apiKey`
 * directly), and local-environment/terminal concerns (`init`, `doctor`,
 * `install-daemon`, `integrity`, `rollback`, `connect`, `exec`, `start`,
 * `syncContext`, `skill`) that have no meaning for a library embedded in
 * someone else's process.
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
 * resolves either to an `AuthContext` with a role; endpoints gated
 * `requireRole('OWNER','ADMIN')` server-side reject an under-privileged
 * token exactly as they would for the CLI using the same token.
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

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth) headers['Authorization'] = `Bearer ${this.apiKey}`

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err: any) {
      throw new ClawdeConnectionError(`Could not reach control plane at ${this.baseUrl}: ${err.message}`)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      throw new ClawdeConnectionError(`Control plane ${method} ${path} failed (${res.status}): ${text}`)
    }

    return (await res.json()) as T
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
}
