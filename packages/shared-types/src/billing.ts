/**
 * Monetization & Financial Ledger types — LLD #20
 *
 * Stripe Metered Billing, FinOps Chargeback GL Export,
 * and usage-based overage enforcement.
 *
 * HLD §3.19 (4D Attribution, Showback/Chargeback), §3.23 (PLG/Billing)
 *
 * @module
 */

import { z } from 'zod'

// ─── Metered Usage Events ────────────────────────────────────────────

/**
 * Status of a Stripe metered usage event report.
 * - PENDING: inserted, Stripe call not yet made
 * - REPORTED: Stripe accepted the event (stripe_meter_id populated)
 * - FAILED: Stripe call failed (retried by reconciliation cron)
 */
export type MeteredEventStatus = 'PENDING' | 'REPORTED' | 'FAILED'

/**
 * A metered usage event row in the billing retry buffer.
 * One row per proxied LLM API call for metered workspaces.
 */
export interface MeteredUsageEvent {
  /** Unique event ID — `newId('mue')` */
  eventId: string
  /** Workspace scope */
  workspaceId: string
  /** FK to execution_traces (nullable — set null on trace deletion) */
  traceId: string | null
  /** Stripe meterEvent.id on successful report */
  stripeMeterId: string | null
  /** Total tokens consumed in this call */
  tokensUsed: number
  /** Calculated cost for this call (USD) */
  costUsd: number
  /** When the event was inserted */
  reportedAt: string
  /** Current processing status */
  status: MeteredEventStatus
  /** Retry attempt count (max 5) */
  retryCount: number
  /** Last error message (only set on FAILED) */
  lastError: string | null
}

/**
 * Result from reconcileFailedEvents cron.
 */
export interface ReconcileResult {
  /** Total FAILED rows attempted */
  retried: number
  /** Rows successfully reported to Stripe this run */
  succeeded: number
  /** Rows still FAILED after this run */
  stillFailed: number
}

// ─── Chargeback GL Mapping ───────────────────────────────────────────

/**
 * Department → GL cost center code mapping.
 * Enterprise tier — maps FinOps attribution dimensions to ERP/SAP GL codes.
 * HLD §3.19 — Chargeback mode.
 */
export interface ChargebackGlMapping {
  /** Unique mapping ID — `newId('cgl')` */
  mappingId: string
  /** Workspace scope */
  workspaceId: string
  /** FK to departments.department_id */
  departmentId: string
  /** GL cost center code (e.g., 'CC-4200', 'ENG-PLATFORM') */
  glCode: string
  /** Human-readable cost center label */
  costCenter: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Chargeback GL mapping with joined department name (for API responses).
 */
export interface ChargebackGlMappingRow extends ChargebackGlMapping {
  /** Department name (joined from departments table) */
  departmentName: string
}

/**
 * A single row in a chargeback export report.
 * Matched = has a GL code mapping; unmatched = no mapping defined.
 */
export interface ChargebackExportRow {
  departmentId: string
  departmentName: string
  /** Null if unmatched (no GL mapping defined for this department) */
  glCode: string | null
  costCenter: string | null
  /** Total AI spend for this department in the period (USD) */
  totalCostUsd: number
  /** Per-model cost breakdown: { 'claude-4': 12.40, 'gpt-4o': 3.20 } */
  modelBreakdown: Record<string, number>
  /** Ratio of wasted tokens (0.0–1.0) */
  wasteRatio: number
  /** true = GL code found; false = flagged for Finance review */
  matched: boolean
}

/**
 * Full chargeback report (JSON format response).
 * HLD §3.19 — GL Code Mapping Data Model.
 */
export interface ChargebackReport {
  period: { from: string; to: string }
  generatedAt: string
  rows: ChargebackExportRow[]
  summary: {
    totalCostUsd: number
    matchedCostUsd: number
    unmatchedCostUsd: number
    departments: number
  }
}

/** Zod schema for GL mapping upsert input. */
export const UpsertGlMappingInputSchema = z.object({
  departmentId: z.string().min(1),
  glCode: z.string().min(1).max(64),
  costCenter: z.string().max(128).optional(),
})
export type UpsertGlMappingInput = z.infer<typeof UpsertGlMappingInputSchema>

// ─── Billing Usage Summary ───────────────────────────────────────────

/**
 * Current period metered usage summary for a workspace.
 * Returned by GET /api/v1/billing/usage/current.
 */
export interface BillingUsageSummary {
  workspaceId: string
  /** Period start (ISO-8601) */
  periodStart: string
  /** Period end (ISO-8601) */
  periodEnd: string
  /** Total tokens consumed in the period */
  tokensUsed: number
  /** Plan-included token volume */
  tokensIncluded: number
  /** Tokens exceeding the included volume (max(0, used - included)) */
  overageTokens: number
  /** Estimated overage charge (USD) */
  estimatedOverageUsd: number
  /** True when budget:hard_block:{wid} Valkey key is set */
  hardCapActive: boolean
}

/** Chargeback export query params schema. */
export const ChargebackExportQuerySchema = z.object({
  period: z.enum(['month', 'quarter', 'custom']).default('month'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
})
export type ChargebackExportQuery = z.infer<typeof ChargebackExportQuerySchema>
