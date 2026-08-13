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
  autoContext?: boolean             // Default: true — auto-detect Jira/git/PD
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
  // Intutic header additions exposed at top level on return payload
  verdict?: 'allow' | 'hijack' | 'enhance' | 'kill' | 'bypass'
  budgetRemainingUsd?: number
  budgetPctUsed?: number
}

export interface CircuitBreakerOptions {
  maxCostUsd?: number               // Per-invocation cost ceiling
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

export type EventCallback = (data: {
  verdict: 'allow' | 'hijack' | 'enhance' | 'kill' | 'bypass'
  budgetRemainingUsd?: number
  budgetPctUsed?: number
  [key: string]: any
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
}

export interface GatewayConfigUpdate {
  requireVk?: boolean
  requireProvisionedKey?: boolean
}

export interface GatewayConfigResult {
  config: Record<string, unknown>
  configVersion: number
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
