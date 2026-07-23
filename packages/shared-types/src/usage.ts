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
