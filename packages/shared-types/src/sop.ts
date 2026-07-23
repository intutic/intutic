/**
 * SOP (Standard Operating Procedure) registry types.
 *
 * These types correspond to the `sop_registry` table and the
 * SOP proof tree structures used by the SSL (Self-Supervised Learning)
 * synthesis pipeline.
 *
 * HLD §3.4 (SOP Registry), LLD 01-data-architecture §3.1, LLD #6
 *
 * @module
 */

import type {
  ChangeClassification,
  ComplexityTier,
  RiskLevel,
  SopLifecycleState,
} from './enums.js'

// ─── SOP ─────────────────────────────────────────────────────────────

/**
 * A Standard Operating Procedure in the registry.
 *
 * SOPs are the governance documents that define expected agent behavior.
 * They are versioned, classified by risk/complexity, and follow a
 * lifecycle from hypothesis through validation to deprecation.
 *
 * LLD §3.1 — sop_registry table
 */
export interface Sop {
  /** Unique SOP identifier — `newId('sp')`. */
  sopId: string

  /** Workspace this SOP belongs to — FK to `workspaces`. */
  workspaceId: string

  /** Human-readable title of the SOP. */
  title: string

  /** Semantic version string (e.g., '1.0.0'). */
  version: string

  /** Full markdown content of the SOP document. CONFIDENTIAL. */
  markdownContent: string

  /** Risk severity tier assigned to this SOP. */
  riskTier: RiskLevel

  /** Task complexity tier for routing. */
  complexityTier: ComplexityTier

  /** Whether this SOP version is currently active. */
  isActive: boolean

  /** Current lifecycle state. */
  lifecycleState: SopLifecycleState

  /** Optional when it was created. */
  createdAt?: string

  /** Optional when it was updated. */
  updatedAt?: string

  /** Optional SHA-256 hash of markdown content. */
  contentHash?: string

  /** Optional SOP IDs this SOP depends on. */
  dependencies?: string[]

  /** Optional author/creator who registered the SOP. */
  createdBy?: string

  /** Optional connector credentials ID. */
  connectorId?: string

  /** Optional external source identifier. */
  externalId?: string

  /** Version counter for optimistic locking. */
  versionCounter?: number
}

// ─── SOP Proof Tree ──────────────────────────────────────────────────

/**
 * A proof tree produced by the SSL bottom-up synthesis pipeline.
 *
 * Proof trees capture the formal verification structure of an SOP,
 * including the synthesis score (Family B metric) that measures
 * how well the SOP has been validated against real-world execution traces.
 *
 * HLD §3.4 — SSL Skill Graph, Family B synthesis metrics
 */
export interface SopProofTree {
  /** Unique tree identifier — `newId('pt')`. */
  treeId: string

  /** SOP this proof tree belongs to — FK to `sop_registry`. */
  sopId: string

  /** Monotonically increasing version number. */
  version: number

  /** The proof tree structure (JSON). */
  treeJson: Record<string, unknown>

  /** Bottom-up synthesis score (0.0–1.0). */
  synthesisScore: number
}

// ─── SOP Lifecycle Transition (LLD #6) ──────────────────────────────

/**
 * Audit record for a SOP lifecycle state transition.
 *
 * Every transition through the 7-state FSM is logged in the
 * `sop_lifecycle_transitions` table for governance auditability.
 *
 * @see HLD §3.4 — SOP Lifecycle FSM
 */
export interface SopLifecycleTransition {
  /** Unique transition identifier — `newId('lt')`. */
  transitionId: string

  /** SOP that transitioned — FK to `sop_registry`. */
  sopId: string

  /** Workspace scope — FK to `workspaces`. */
  workspaceId: string

  /** State before the transition. */
  fromState: SopLifecycleState

  /** State after the transition. */
  toState: SopLifecycleState

  /** How the change affects the prior version (anti-gaming gate). */
  changeClassification?: ChangeClassification

  /** User or system actor who triggered the transition. */
  actorId: string

  /** Explanation for the transition (required for WEAKEN). */
  rationale?: string

  /** Anti-gaming gate evaluation result. */
  antiGamingResult?: {
    gatePassed: boolean
    classificationConfidence: number
    reviewRequired: boolean
  }

  /** When the transition occurred. */
  createdAt: string
}

// ─── SOP Health Metrics (LLD #6) ────────────────────────────────────

/**
 * Aggregated health metrics snapshot for a SOP.
 *
 * Computed by `sopHealthService.computeHealthMetrics()` and cached
 * in Valkey at `v2:sop:health:{sop_id}` with a 5-minute TTL.
 *
 * @see HLD §3.4 — SOP Health Dashboard
 */
export interface SopHealthMetrics {
  /** SOP identifier. */
  sopId: string

  /** Workspace identifier. */
  workspaceId: string

  /** Last time this SOP was matched by an execution trace. */
  lastMatchAt: string | null

  /** Last time this SOP was edited. */
  lastEditAt: string | null

  /** Number of matches in the last 30 days. */
  matchCount30d: number

  /** Average compliance score across recent traces (0.0–1.0). */
  avgCompliance: number

  /** Number of behavioral drift events detected. */
  driftEventCount: number

  /** Total accumulated cost in USD attributed to this SOP. */
  totalCostUsd: number

  /** Whether this SOP is stale (no matches in SOP_STALENESS_DAYS). */
  isStale: boolean
}

// ─── Dream Cycle Queue (LLD #6) ─────────────────────────────────────

/**
 * A queued item in the Dream Cycle processing pipeline.
 *
 * Items originate from capability misses (LLD #5), decision mining
 * entries, or drift signals. Phase 1: queue management only.
 * Phase 3: LLM synthesis consumes the queue.
 *
 * @see HLD §3.4.6 — Dream Cycle
 */
export interface DreamCycleQueueItem {
  /** Unique queue item identifier — `newId('dq')`. */
  queueItemId: string

  /** Workspace scope — FK to `workspaces`. */
  workspaceId: string

  /** Origin of the queue item. */
  sourceType: 'CAPABILITY_MISS' | 'DECISION_MINING' | 'DRIFT_SIGNAL'

  /** Source entity ID (FK to originating table). */
  sourceId: string

  /** Priority (lower = higher priority). Default: 100. */
  priority: number

  /** Queue item status. */
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

  /** Resulting SOP ID (populated on COMPLETED). */
  resultSopId?: string

  /** Error message (populated on FAILED). */
  errorMessage?: string

  /** When the item was enqueued. */
  enqueuedAt: string

  /** When processing started. */
  startedAt?: string

  /** When processing completed or failed. */
  completedAt?: string
}

/**
 * Input for enqueuing a Dream Cycle item.
 *
 * @see HLD §3.4.6 — Dream Cycle
 */
export interface DreamCycleEnqueueInput {
  /** Workspace to enqueue in. */
  workspaceId: string

  /** Origin of the queue item. */
  sourceType: 'CAPABILITY_MISS' | 'DECISION_MINING' | 'DRIFT_SIGNAL'

  /** Source entity ID. */
  sourceId: string

  /** Priority override. Default: 100. */
  priority?: number
}

// ─── Gödel Probe (LLD #6) ───────────────────────────────────────────

/**
 * Result of a Gödel completeness probe evaluation.
 *
 * Evaluates a SOP against the 13-category quality rubric (HLD §3.7).
 * Distinct from the 12-category runtime anomaly taxonomy (LLD #5).
 *
 * @see HLD §3.7 — Gödel Completeness Probe
 */
export interface GodelProbeResult {
  /** Unique result identifier — `newId('gp')`. */
  resultId: string

  /** SOP that was evaluated. */
  sopId: string

  /** Workspace scope. */
  workspaceId: string

  /** Weighted aggregate score (0.0–1.0). */
  aggregateScore: number

  /** Per-category scores (13 categories). */
  categoryScores: Record<string, number>

  /** Probe version used for evaluation. */
  probeVersion: string

  /** When the evaluation was performed. */
  evaluatedAt: string
}

// ─── SOP Content Update (LLD #6) ────────────────────────────────────

/**
 * Partial content update for forking a new SOP version.
 *
 * @see HLD §3.4.8 — Version chain
 */
export interface SopContentUpdate {
  /** Updated title. */
  title?: string

  /** Updated markdown content. */
  markdownContent?: string

  /** Updated risk tier. */
  riskTier?: RiskLevel

  /** Updated complexity tier. */
  complexityTier?: ComplexityTier
}

// ─── SOP Lifecycle Transition Rules (LLD #6 §4.2) ──────────────────

/**
 * Result of a lifecycle state transition attempt.
 */
export interface SopLifecycleTransitionResult {
  /** Whether the transition succeeded. */
  success: boolean
  /** SOP that was (or was not) transitioned. */
  sopId: string
  /** State before the transition. */
  fromState: SopLifecycleState
  /** Requested target state. */
  toState: SopLifecycleState
  /** Reason for failure (undefined on success). */
  reason?: string
}

/**
 * The 10 valid lifecycle transitions in the 7-state FSM.
 *
 * @see HLD §3.4 — SOP Lifecycle
 */
export const VALID_SOP_TRANSITIONS: ReadonlyArray<{ from: SopLifecycleState; to: SopLifecycleState; description: string }> = [
  { from: 'DRAFT', to: 'PENDING_REVIEW', description: 'Submit for review' },
  { from: 'PENDING_REVIEW', to: 'GENERATED', description: 'Gödel score passes threshold' },
  { from: 'PENDING_REVIEW', to: 'DRAFT', description: 'Return to draft for edits' },
  { from: 'GENERATED', to: 'HYPOTHESIZED', description: 'Deploy in shadow mode' },
  { from: 'HYPOTHESIZED', to: 'REFINED', description: 'Refine based on shadow results' },
  { from: 'HYPOTHESIZED', to: 'INVALIDATED', description: 'Hypothesis disproved' },
  { from: 'REFINED', to: 'VALIDATED', description: 'Promote to active enforcement' },
  { from: 'REFINED', to: 'INVALIDATED', description: 'Refinement failed' },
  { from: 'VALIDATED', to: 'INVALIDATED', description: 'Invalidated by cascade or manual' },
  { from: 'VALIDATED', to: 'PENDING_REVIEW', description: 'Cascade invalidation triggers re-review' },
] as const

/**
 * Maps lifecycle state to enforcement mode.
 */
export const ENFORCEMENT_BY_STATE: Record<SopLifecycleState, 'NONE' | 'SHADOW' | 'ACTIVE'> = {
  DRAFT: 'NONE',
  PENDING_REVIEW: 'NONE',
  GENERATED: 'NONE',
  HYPOTHESIZED: 'SHADOW',
  REFINED: 'SHADOW',
  VALIDATED: 'ACTIVE',
  INVALIDATED: 'NONE',
}

// ─── SOP Graph (LLD #6 §4.3) ────────────────────────────────────────

/** Edge types in the SOP dependency graph. */
export type SopEdgeType = 'DEPENDS_ON' | 'DERIVES_FROM' | 'VALIDATES'

/** An edge in the SOP dependency graph. */
export interface SopGraphEdge {
  fromId: string
  toId: string
  edgeType: SopEdgeType
  metadata?: Record<string, unknown>
}

// ─── Cascade Invalidation (LLD #6 §4.4) ─────────────────────────────

/** Preview of cascade invalidation impact (read-only). */
export interface CascadeImpactResult {
  rootSopId: string
  affectedSopIds: string[]
  affectedCount: number
  depth: number
}

/** Result of an executed cascade invalidation. */
export interface CascadeInvalidationResult {
  rootSopId: string
  invalidatedSopIds: string[]
  invalidatedCount: number
  depth: number
}

// ─── Anti-Gaming Gate (LLD #6 §4.5 / HLD §7.6) ─────────────────────

/** Result of anti-gaming analysis on a SOP change. */
export interface AntiGamingResult {
  changeClassification: ChangeClassification
  requiresElevatedApproval: boolean
  impactSummary: string
}

// ─── Plans (LLD #6 §4.6 / EU AI Act Art. 14) ────────────────────────

/** Deviation types during plan execution. */
export type DeviationType =
  | 'TOOL_SUBSTITUTION'
  | 'STEP_SKIP'
  | 'STEP_REORDER'
  | 'EXTRA_STEP'
  | 'PARAMETER_DRIFT'

/** A single deviation from a stored plan. */
export interface PlanDeviation {
  stepIndex: number
  deviationType: DeviationType
  expectedTool?: string
  actualTool?: string
  details?: string
}

/** Adherence score for a stored plan. */
export interface PlanAdherenceScore {
  planId: string
  totalSteps: number
  completedSteps: number
  deviationCount: number
  adherencePercent: number
}

/** A stored plan artifact. */
export interface StoredPlan {
  planId: string
  workspaceId: string
  sopId: string | null
  createdBy: string
  approvedBy: string | null
  approvalTimestamp: string | null
  harnessType: string
  lifecycleState: string
  steps: Record<string, unknown>[]
  executionOutcome: string | null
  deviationLog: PlanDeviation[]
  approvalRationale: string | null
}

// ─── Decision Mining (LLD #6 §4.7 / HLD §7.4) ──────────────────────

/** Recommendation types from decision mining analysis. */
export type DecisionRecommendation =
  | 'THRESHOLD_RELAXATION'
  | 'AUTO_KILL_UPGRADE'
  | 'SOP_REFINEMENT'
  | 'NO_ACTION'

/** Aggregated decision mining analysis. */
export interface DecisionMiningAnalysis {
  sopId: string | null
  totalDecisions: number
  approvedRate: number
  rejectedRate: number
  recommendation: DecisionRecommendation
}

// ─── Gödel Guardrails (LLD #6 §4.8 / HLD §3.7) ─────────────────────

/** Gate result from Gödel scoring. */
export type GodelGateResult = 'BLOCKED' | 'PENDING_REVIEW' | 'GENERATED'

/** Score result from the 13-category Gödel rubric. */
export interface GodelScore {
  totalScore: number
  categories: Record<string, number>
  gateResult: GodelGateResult
}

// ─── Proof Tree Diff (LLD #6 §4.9) ──────────────────────────────────

/** Diff between two proof tree versions. */
export interface ProofTreeDiff {
  fromVersion: number
  toVersion: number
  addedNodes: string[]
  removedNodes: string[]
  modifiedNodes: string[]
}

// ─── SOP Query & List ────────────────────────────────────────────────

/** Summary row of an SOP for lists in the UI. */
export interface SopSummary {
  sopId: string
  title: string
  version: string
  lifecycleState: SopLifecycleState | string
  riskTier: RiskLevel | string
  complexityTier: ComplexityTier | string
  contentHash?: string
  isActive?: boolean
  createdAt?: string
  updatedAt?: string
}

/** Paginated result from SOP listing. */
export interface SopListResult {
  items: SopSummary[]
  total: number
  page: number
  limit: number
}

/** Filters for SOP query. */
export interface SopFilters {
  page?: number
  limit?: number
  lifecycle_state?: string
  risk_tier?: string
  all_versions?: boolean
}

export interface DecisionEntry {
  entry_id: string
  session_id: string
  workspace_id: string
  original_tool_call: string
  hijacked_tool_call: string
  rationale: string
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PROMOTED' | string
  created_at: string | null
}

export interface DecisionListResult {
  items: DecisionEntry[]
  total: number
}


