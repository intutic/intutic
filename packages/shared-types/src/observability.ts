import { z } from 'zod'

// ─── Zod Schemas ─────────────────────────────────────────────────────

export const PromptEstimateInputSchema = z.object({
  prompt: z.string().min(1),
  modelName: z.string().min(1),
})

export type PromptEstimateInput = z.infer<typeof PromptEstimateInputSchema>

// ─── Interfaces ──────────────────────────────────────────────────────

export interface PromptEstimateResult {
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsd: number
  recommendations: string[]
}

export interface CostHistoryEntry {
  date: string
  estimatedCostUsd: number
  actualCostUsd: number
}

export interface CostHistoryResult {
  history: CostHistoryEntry[]
}

export interface DriftReportResult {
  driftPct: number
  totalEstimates: number
  totalActuals: number
}

export interface TraceDagNode {
  sessionId: string
  harnessType: string
  parentSessionId: string | null
  totalCostUsd: number
  stepCount: number
  errorCount: number
}

export interface TraceDagResult {
  traceId: string
  rootSessionId: string
  nodes: TraceDagNode[]
}


