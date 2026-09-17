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
