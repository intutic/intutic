/**
 * FinOps ledger types for cost tracking and attribution.
 *
 * These types correspond to the `execution_traces` table and the
 * `finops_attribution_4d` materialized view defined in
 * LLD 01-data-architecture §3.1.
 *
 * HLD §3.6 (FinOps Ledger), §3.19 (4D Attribution)
 *
 * @module
 */

import type {
  AnomalyType,
  EnforcementAction,
  RoutingTier,
  TokenUtility,
} from './enums.js'

// ─── Trace Entry ─────────────────────────────────────────────────────

/**
 * A single row in the `execution_traces` table — the append-only FinOps ledger.
 *
 * This is the canonical financial audit trail for every LLM call flowing
 * through the platform. INSERT only; UPDATE and DELETE are forbidden by
 * a database trigger.
 *
 * LLD §3.1 — execution_traces table definition
 */
export interface TraceEntry {
  /** Unique trace identifier — `newId('tr')`. */
  traceId: string

  /** Session that produced this trace — FK to `agent_sessions`. */
  sessionId: string

  /** Idempotency key — UNIQUE constraint. */
  requestId: string

  /** Timestamp of the trace event. */
  timestamp: string

  /** Effective date of the SOP governing this call. */
  sopEffectiveDate: string

  // ── Model routing ──
  /** Model requested by the agent/user. */
  requestedModel: string

  /** Model actually routed to after complexity scoring. */
  actualModelRouted: string

  /** Routing tier for this call. */
  routingTier: RoutingTier

  /** Complexity score used for routing (0.0–1.0). */
  complexityScore: number

  // ── Token accounting ──
  /** Raw input tokens before compression. */
  rawInputTokens: number

  /**
   * Input tokens after compression.
   *
   * Written equal to `rawInputTokens` by every proxy trace path — the input
   * compressor is not wired. Do not derive a saving from the difference.
   */
  compressedInputTokens: number

  /**
   * Bytes the SnipCompactor removed from the response body.
   *
   * The measured saving, in bytes rather than tokens, and response-side: it
   * reduces the *next* turn's prompt, not this trace's input count.
   */
  toolResultBytesSaved?: number

  /** Output tokens generated. */
  outputTokens: number

  // ── Cost accounting (append-only, tamper-evident) ──
  /** Cost at the raw model rate (USD). */
  rawCostUsd: number

  /** Actual cost after routing optimization (USD). */
  actualCostUsd: number

  /** Savings from routing optimization (USD) — generated column. */
  savingsUsd: number

  // ── Token utility classification ──
  /** Whether the token spend was useful or wasted. */
  tokenUtility: TokenUtility

  /** Utility confidence score (0.0–1.0). */
  tokenUtilityScore: number

  // ── Enforcement ──
  /** Compliance score from policy evaluation (0.0–1.0). */
  complianceScore: number

  /** Enforcement action applied to this call. */
  enforcementAction: EnforcementAction

  // ── Anomaly detection ──
  /** Detected anomaly type, if any. */
  anomalyDetected: AnomalyType | null

  /** Anomaly detection confidence score (0.0–1.0). */
  anomalyConfidenceScore: number | null

  /** Additional anomaly taxonomy metadata. */
  taxonomyMetadata: Record<string, unknown> | null

  // ── Forensics ──
  /** Raw request/response payload for audit. SENSITIVE. */
  rawPayloadJson: Record<string, unknown> | null

  // ── 4D Attribution (§3.19) ──
  /** Application identifier for attribution. */
  appId: string | null

  /** Agent chain identifier for attribution. */
  agentChainId: string | null

  /** Full agent delegation chain (JSON). */
  agentChain: Record<string, unknown> | null

  // ── Cache accounting ──
  /** Whether this call was served from cache. */
  cacheHit: boolean

  /** Savings from cache hit (USD). */
  cacheSavingsUsd: number

  // ── Root cause & corrective action ──
  /** Structured root cause attribution for anomalies. */
  rootCauseAttribution: Record<string, unknown> | null

  /** Corrective prompt card generated for this anomaly. */
  correctivePromptCard: Record<string, unknown> | null
}

// ─── Cost Breakdown ──────────────────────────────────────────────────

/**
 * Summarized cost breakdown for a session, workspace, or time window.
 *
 * HLD §3.6 — FinOps cost accounting
 */
export interface CostBreakdown {
  /** Cost at raw model rates (USD). */
  rawCost: number

  /** Actual cost after optimization (USD). */
  actualCost: number

  /** Total savings from model routing (USD). */
  savings: number

  /** Total savings from cache hits (USD). */
  cacheSavings: number
}

// ─── 4D Attribution ──────────────────────────────────────────────────

/**
 * Four-dimensional attribution key for FinOps rollup.
 *
 * Maps to the `finops_attribution_4d` materialized view's grouping dimensions:
 * Person × Harness × App × Agent Chain.
 *
 * HLD §3.19, LLD §3.1 — finops_attribution_4d materialized view
 */
export interface Attribution4D {
  /** User/person identifier. */
  personId: string

  /** Harness/IDE type that produced the cost. */
  harnessType: string

  /** Optional application identifier. */
  appId?: string

  /** Optional agent chain identifier. */
  agentChainId?: string
}

// ─── Trace Query & List ──────────────────────────────────────────────

/** Summary row for listing traces in the UI. */
export interface TraceSummary {
  traceId: string
  timestamp: string
  requestedModel: string
  actualModelRouted: string
  enforcementAction: EnforcementAction | string
  complianceScore: number
  actualCostUsd: number
  anomalyDetected: AnomalyType | string | null
}

/** Paginated result from trace listing. */
export interface TraceListResult {
  traces: TraceSummary[]
  total: number
  limit: number
  offset: number
}

/**
 * One persisted detector finding on a trace, from `detector_findings`
 * (migration 115). Distinct from `TraceDetail.anomalyDetected` /
 * `anomalyConfidenceScore`, which carry only the single winning finding —
 * this is every detector that fired, which is what lets a reviewer see two
 * independent detectors agreeing (`detector_findings.md`-shaped corroboration)
 * instead of one winner masking the rest.
 */
export interface TraceFindingSummary {
  findingId: string
  detectorId: string
  anomalyKind: string
  severity: string
  /** STEER | REASK | ASK | KILL — what this finding actually did. */
  disposition: string
  confidence: number
  reason: string
  /** True when the workspace was in shadow mode — recorded, not enforced. */
  shadowed: boolean
}

export interface TraceStep {
  logId: string
  toolName: string
  toolArguments: unknown
  riskCategory: string | null
  verdict: string
  confidence: number
  reason: string
  loopDetected: boolean
  latencyMs: number | null
  timestamp: string
}

/** Full detail of a single trace. */
export interface TraceDetail {
  traceId: string
  sessionId: string
  requestId: string
  timestamp: string
  sopEffectiveDate: string
  requestedModel: string
  actualModelRouted: string
  routingTier: RoutingTier | string
  complexityScore: number
  rawInputTokens: number
  compressedInputTokens: number
  toolResultBytesSaved?: number
  outputTokens: number
  rawCostUsd: number
  actualCostUsd: number
  savingsUsd: number
  /** Who re-classified this trace, if anyone. Null when it holds its insert-time value. */
  tokenUtilityClassifiedBy?: string | null
  tokenUtility: TokenUtility | string
  tokenUtilityScore: number
  complianceScore: number
  enforcementAction: EnforcementAction | string
  anomalyDetected: AnomalyType | string | null
  anomalyConfidenceScore: number | null
  taxonomyMetadata: unknown | null
  rootCauseAttribution: unknown | null
  correctivePromptCard: unknown | null
  reasoningTokens?: number | null
  toolCallMetrics?: unknown | null
  /**
   * 0–100 integrity score backing a WASTED `tokenUtility` verdict; null when
   * the trace was never scored (e.g. it wasn't a candidate for waste
   * classification). Written at ingest; previously selected nowhere, so a
   * WASTED badge had no way to explain itself — see `qualityFault` below.
   */
  responseIntegrity?: number | null
  /**
   * The specific check that failed when `responseIntegrity` is low — e.g.
   * the first-failing-check name. Pairs with `responseIntegrity`; both are
   * null together.
   */
  qualityFault?: string | null
  /**
   * The model a shadow-routing evaluation would have picked for this trace,
   * if the workspace has shadow routing configured; null otherwise. Written
   * at ingest on both the streaming and non-streaming ingest paths; reading
   * it back is what the shadow-routing savings report aggregates.
   */
  routingShadowModel?: string | null
  /**
   * What this request touched (migration 105). `toolCallMetrics` is token
   * accounting per tool; this is the files, URLs and commands they named.
   */
  changeManifest?: ChangeManifestEntry[] | null
  steps?: TraceStep[]
  /**
   * Every detector finding persisted for this trace, most severe first —
   * see {@link TraceFindingSummary}. `anomalyDetected`/`anomalyConfidenceScore`
   * above stay as the single winner for backward compatibility; this is the
   * full set, present on allowed traces as well as blocked ones.
   */
  findings?: TraceFindingSummary[]
}

/**
 * One thing an agent touched, as recorded by the proxy's change manifest.
 * Mirrors `ChangeEntry` in `packages/proxy/src/manifest.rs`.
 */
export interface ChangeManifestEntry {
  tool: string
  op: 'write' | 'edit' | 'delete' | 'move' | 'execute' | 'read' | 'fetch' | 'unknown'
  target: string
  target_kind: 'path' | 'url' | 'command' | 'opaque'
  risk?: string[]
  bytes?: number
}

/** Filters for trace query. */
export interface TraceFilters {
  enforcement?: string
  model?: string
  since?: string
  limit?: number
  offset?: number
}

