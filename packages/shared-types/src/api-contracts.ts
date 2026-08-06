/**
 * Zod schemas for API request/response validation.
 *
 * Each schema is exported alongside its inferred TypeScript type.
 * Services use these schemas in route handlers to validate incoming
 * payloads; the inferred types are used in service function signatures.
 *
 * HLD §3.1 (Proxy Gateway), §3.6 (FinOps), §3.3 (PCAS)
 *
 * @module
 */

import { z } from 'zod'
import {
  BudgetTier,
  EnforcementAction,
  ExecutionMode,
  HarnessType,
  RoutingTier,
  TokenUtility,
} from './enums.js'

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extract the values array from a const object for use in `z.enum()`. */
function constValues<T extends Record<string, string>>(obj: T) {
  return Object.values(obj) as [T[keyof T], ...T[keyof T][]]
}

// ─── CreateSession ───────────────────────────────────────────────────

/**
 * Zod schema for the `POST /api/v1/sessions` request body.
 *
 * Creates a new agent session in the control plane.
 */
export const CreateSessionSchema = z.object({
  /** Workspace to create the session in. */
  workspaceId: z.string().min(1),

  /** User initiating the session. */
  userId: z.string().min(1),

  /** Optional project to scope the session. */
  projectId: z.string().min(1).optional(),

  /** Optional SOP to govern the session. */
  activeSopId: z.string().min(1).optional(),

  /** Agent harness type. */
  harnessType: z.enum(constValues(HarnessType)),

  /** Budget tier — defaults to JUNIOR on the server. */
  budgetTier: z.enum(constValues(BudgetTier)).optional(),

  /** Execution mode — defaults to STANDARD on the server. */
  executionMode: z.enum(constValues(ExecutionMode)).optional(),
})

/** Inferred type for a create-session request payload. */
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>

// ─── CreateTrace ─────────────────────────────────────────────────────

/**
 * Zod schema for the `POST /api/v1/traces` request body.
 *
 * Appends a new row to the `execution_traces` ledger.
 * Fields with server-side defaults (e.g., `timestamp`) are optional.
 */
export const CreateTraceSchema = z.object({
  /** Session that produced this trace. */
  sessionId: z.string().min(1),

  /** Idempotency key — must be unique across all traces. */
  requestId: z.string().min(1),

  /** Effective date of the governing SOP (ISO 8601). */
  sopEffectiveDate: z.string().datetime(),

  // ── Model routing ──
  requestedModel: z.string().min(1),
  actualModelRouted: z.string().min(1),
  routingTier: z.enum(constValues(RoutingTier)),
  complexityScore: z.number().min(0).max(1),

  // ── Token accounting ──
  rawInputTokens: z.number().int().nonnegative(),
  compressedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),

  // ── Cost accounting ──
  rawCostUsd: z.number().nonnegative(),
  actualCostUsd: z.number().nonnegative(),

  // ── Token utility ──
  tokenUtility: z.enum(constValues(TokenUtility)).optional(),
  tokenUtilityScore: z.number().min(0).max(1).optional(),

  // ── Enforcement ──
  complianceScore: z.number().min(0).max(1),
  enforcementAction: z.enum(constValues(EnforcementAction)),

  // ── Anomaly ──
  anomalyDetected: z.string().nullable().optional(),
  anomalyConfidenceScore: z.number().min(0).max(1).nullable().optional(),
  taxonomyMetadata: z.record(z.unknown()).nullable().optional(),

  // ── Forensics ──
  rawPayloadJson: z.record(z.unknown()).nullable().optional(),

  // ── 4D Attribution ──
  appId: z.string().nullable().optional(),
  agentChainId: z.string().nullable().optional(),
  agentChain: z.record(z.unknown()).nullable().optional(),

  // ── Cache ──
  cacheHit: z.boolean().optional(),
  cacheSavingsUsd: z.number().nonnegative().optional(),

  // ── Root cause ──
  rootCauseAttribution: z.record(z.unknown()).nullable().optional(),
  correctivePromptCard: z.record(z.unknown()).nullable().optional(),
})

/** Inferred type for a create-trace request payload. */
export type CreateTraceInput = z.infer<typeof CreateTraceSchema>

// ─── PolicyVerdict ───────────────────────────────────────────────────

/**
 * Zod schema for a policy verdict (used in Circuit Breaker responses
 * and inter-service communication).
 *
 * HLD §3.3 — PCAS enforcement
 */
export const PolicyVerdictSchema = z.object({
  /** Enforcement action to apply. */
  action: z.enum(constValues(EnforcementAction)),

  /** Confidence score (0.0–1.0). */
  confidence: z.number().min(0).max(1),

  /** Human-readable reason. */
  reason: z.string().min(1),

  /** Optional policy rule ID. */
  policyId: z.string().optional(),
})

/** Inferred type for a policy verdict. */
export type PolicyVerdictInput = z.infer<typeof PolicyVerdictSchema>

// ─── Triage queue responses ──────────────────────────────────────────

/**
 * The three triage-inbox response shapes, shared between the control plane and
 * the dashboard.
 *
 * These were declared locally in `apps/dashboard/src/hooks/useIncidents.ts` — a
 * second, hand-maintained copy of shapes the server already defines. That is the
 * drift this repo has been bitten by twice, and it bit here too: the server has
 * always returned `audit` on `/api/v1/trajectory/alerts`, the local copy omitted
 * it, and the drift-alerts tab silently dropped its review-budget disclosure.
 *
 * `snake_case` where the API is snake_case and camelCase where it is camelCase,
 * deliberately: these describe the wire, not an idealised model, and quietly
 * renaming fields here would move the divergence rather than remove it.
 */

/** A bounded review queue stating its own coverage. */
export interface ReviewBudget {
  budget: number
  matched: number
  withheld: number
  /** True when the queue held rows back; the UI discloses only then. */
  overBudget: boolean
}

/** Pagination plus the review budget, on list endpoints that rank and bound. */
export interface ListMeta {
  total: number
  page: number
  limit: number
  /** Absent from older control planes; the UI degrades to no banner. */
  audit?: ReviewBudget
}

/** `GET /api/v1/incidents` row. */
export interface IncidentRow {
  incident_id: string
  workspace_id: string
  trace_id: string | null
  session_id: string | null
  severity: string
  anomaly_type: string
  description: string | null
  resolution_status: string | null
  resolved_by: string | null
  resolved_at: string | null
  escalation_chain: Record<string, unknown> | null
  created_at: string
}

/** `GET /api/v1/trajectory/alerts` row. */
export interface TrajectoryAlertRow {
  alertId: string
  sessionId: string
  workspaceId: string
  alertType: string
  severity: string
  state: string
  verdict: string
  confidence: string
  summary: string
  heuristicTriggers: Array<{ rule?: string; message?: string } | string>
  llmReasoning: string | null
  interventionAction: string | null
  monitorMode: string
  trajectoryWindow: Record<string, unknown>
  createdAt: string
}

/** `GET /api/v1/anomalies` row. */
export interface AnomalyRow {
  trace_id: string
  session_id: string
  timestamp: string
  anomaly_type: string
  confidence: number
  model: string | null
  enforcement_action: string | null
  compliance_score: number
}
