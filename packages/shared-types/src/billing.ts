/**
 * Monetization & Financial Ledger types — LLD #20
 *
 * Stripe Metered Billing,
 * and usage-based overage enforcement.
 *
 * HLD §3.23 (PLG/Billing)
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
