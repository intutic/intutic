export interface ClawdeClientOptions {
  apiKey: string                    // Virtual key (vk_xxx)
  baseUrl?: string                  // Default: http://localhost:4000
  provider?: 'openai' | 'anthropic' | 'google'  // Schema enforcement
  autoContext?: boolean             // Default: true — auto-detect Jira/git/PD
  timeout?: number                  // Default: 30000ms
  retries?: number                  // Default: 2
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
