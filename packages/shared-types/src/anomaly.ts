/**
 * Anomaly detection types for the Anomaly Recognition Engine (ARE).
 *
 * These types support the 12-category runtime anomaly taxonomy,
 * corrective prompt card system, trust scoring, and ARE probe battery.
 *
 * HLD §3.5 (Anomaly Detection), HLD §7.7 (Drift Detector)
 * LLD #5 — Anomaly Detection + ARE
 *
 * @module
 */

import type { AnomalyType } from './enums.js'

// ─── Anomaly Event ───────────────────────────────────────────────────

/**
 * A detected anomaly event emitted by the ARE pipeline.
 *
 * Anomaly events are evaluated per-trace and may trigger enforcement
 * actions, governance incidents, or corrective prompt injection.
 *
 * HLD §3.5 — 12-category runtime taxonomy
 */
export interface AnomalyEvent {
  /** Classification from the 12-category anomaly taxonomy. */
  type: AnomalyType

  /** Detection confidence score (0.0–1.0). */
  confidence: number

  /** Optional structured metadata for forensic analysis. */
  metadata?: Record<string, unknown>
}

// ─── Anomaly Classification Result ───────────────────────────────────

/**
 * Full classification result from the anomaly detector.
 * Includes severity mapping and whether an incident was created.
 *
 * LLD #5 §2.2 — classifyAnomaly() return type
 */
export interface AnomalyClassification {
  /** Whether an anomaly was detected. */
  detected: boolean

  /** Classification from the 12-category taxonomy. Null if not detected. */
  anomalyType: AnomalyType | null

  /** Detection confidence score (0.0–1.0). */
  confidence: number

  /** Severity level derived from anomaly type. */
  severity: AnomalySeverity

  /** Generated corrective prompt card, if applicable. */
  correctiveCard: CorrectivePromptCard | null

  /** Probe results that contributed to the classification. */
  probeResults: ProbeResult[]

  /** ID of the governance incident created, if severity >= HIGH. */
  incidentId: string | null
}

// ─── Anomaly Severity ────────────────────────────────────────────────

/**
 * Anomaly severity levels, mapped from anomaly type.
 *
 * HLD §3.5 — Alert Route column
 */
export type AnomalySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL'

/**
 * Static mapping from anomaly type to default severity.
 *
 * HLD §3.5 — 12-category table, Alert Route column
 * LLD #5 Appendix B
 */
export const ANOMALY_SEVERITY_MAP: Record<AnomalyType, AnomalySeverity> = {
  TOOL_ABUSE: 'HIGH',
  TOKEN_WASTE: 'MEDIUM',
  LOOP_DETECTED: 'HIGH',
  UNAUTHORIZED_TOOL: 'HIGH',
  DATA_EXFILTRATION: 'CRITICAL',
  PROMPT_INJECTION: 'CRITICAL',
  HALLUCINATION: 'HIGH',
  SCOPE_VIOLATION: 'MEDIUM',
  BUDGET_BREACH: 'HIGH',
  SPAWN_BUDGET_BREACH: 'HIGH',
  WORKFLOW_BUDGET_BREACH: 'HIGH',
  WORKFLOW_GOAL_DRIFT: 'MEDIUM',
} as const

// ─── Corrective Prompt Card ──────────────────────────────────────────

/**
 * A corrective prompt card generated in response to an anomaly.
 *
 * Prompt cards contain a remediation prompt, evidence chain, and a
 * link to the SOP that governs the expected behavior. They are injected
 * into the agent context to steer it back on track.
 *
 * HLD §3.5 — Corrective prompt injection
 */
export interface CorrectivePromptCard {
  /** The corrective prompt text to inject into agent context. */
  promptText: string

  /** Confidence that this prompt will resolve the anomaly (0.0–1.0). */
  confidence: number

  /** Evidence chain supporting the corrective action. */
  sourceEvidence: string[]

  /** SOP ID that defines the expected behavior — `newId('sp')`. */
  sopId: string | null
}

// ─── ARE Probe Types ─────────────────────────────────────────────────

/**
 * ARE probe tier classification.
 *
 * HLD §3.5 — ARE Probe Battery table
 */
export type ProbeType = 'PATTERN' | 'SCHEMA' | 'LLM'

/**
 * Result from an individual ARE probe execution.
 *
 * LLD #5 §2.2 — runProbes() return type
 */
export interface ProbeResult {
  /** Probe tier. */
  probeType: ProbeType

  /** Probe name (e.g., 'WorkspaceHygieneProbe', 'MCPHealthProbe'). */
  probeName: string

  /** Whether the probe detected an issue. */
  triggered: boolean

  /** Confidence score if triggered (0.0–1.0). */
  confidence: number

  /** Whether the probe was skipped (e.g., LLM probe in Phase 1). */
  skipped: boolean

  /** Reason for skip if applicable. */
  skipReason?: string

  /** Execution latency in milliseconds. */
  latencyMs: number

  /** Additional probe-specific details. */
  details?: Record<string, unknown>
}

// ─── Trust Scoring ───────────────────────────────────────────────────

/**
 * Trust score for a user/agent within a workspace.
 *
 * LLD #5 §4.4 — Trust Score Algorithm
 * Decay: score * 0.85 per anomaly
 * Boost: score * 1.02 per clean session
 * Clamped to [0, 100]. Initial: 80.
 */
export interface TrustScoreResult {
  /** Trust score ID — `newId('ts')`. */
  scoreId: string

  /** Workspace ID. */
  workspaceId: string

  /** User/agent ID. */
  userId: string

  /** Current trust score (0–100). */
  currentScore: number

  /** Total anomaly count. */
  anomalyCount: number

  /** Total clean sessions. */
  cleanSessions: number

  /** Timestamp of last anomaly. */
  lastAnomalyAt: string | null

  /** Timestamp of last boost. */
  lastBoostAt: string | null
}

/**
 * Result of a trust score update operation.
 *
 * LLD #5 §2.2 — updateTrustScore() return type
 */
export interface TrustScoreUpdate {
  /** Previous score before update. */
  previousScore: number

  /** New score after update. */
  newScore: number

  /** Delta applied. */
  delta: number

  /** Reason for the update. */
  reason: string
}

/**
 * Events that can modify a trust score.
 *
 * LLD #5 §4.4
 */
export interface TrustEvent {
  type: 'ANOMALY_DETECTED' | 'CLEAN_SESSION'
  anomalyType?: AnomalyType
  traceId?: string
  sessionId?: string
}

import type { IncidentStatus } from './enums.js'

/**
 * @deprecated Use {@link IncidentStatus} from enums.ts instead.
 * Kept as alias for backward compatibility.
 */
export type GovernanceIncidentStatus = IncidentStatus


// ─── Capability Miss ─────────────────────────────────────────────────

/**
 * CAPABILITY_MISS event — logged when an agent encounters a task
 * for which no governing SOP exists.
 *
 * HLD §3.5 — CAPABILITY_MISS (Non-Anomaly Informational Event)
 */
export interface CapabilityMissEvent {
  /** Miss ID — `newId('cm')`. */
  missId: string

  /** Workspace ID. */
  workspaceId: string

  /** Session ID where the miss occurred. */
  sessionId: string | null

  /** Brief description of the ungoverned task. */
  taskDescription: string

  /** Tools the agent attempted. */
  toolSequence: string[]

  /** Closest SOP by embedding similarity, or null. */
  nearestSopId: string | null

  /** How close the nearest SOP was (0.0–1.0). */
  similarityScore: number | null

  /** Recommended action for Dream Cycle. */
  recommendedAction: 'AUTHOR_NEW_SOP' | 'EXTEND_EXISTING_SOP'
}

/**
 * Input for recording a capability miss.
 *
 * LLD #5 §2.2 — recordCapabilityMiss() parameter
 */
export interface CapabilityMissInput {
  workspaceId: string
  sessionId?: string
  taskDescription: string
  toolSequence: string[]
  nearestSopId?: string
  similarityScore?: number
  recommendedAction?: 'AUTHOR_NEW_SOP' | 'EXTEND_EXISTING_SOP'
}

// ─── Drift Detection ─────────────────────────────────────────────────

/**
 * Drift direction classification.
 *
 * HLD §7.7 — Behavioral Drift Detector
 */
export type DriftDirection = 'POSITIVE_DRIFT' | 'NEGATIVE_DRIFT' | 'NEUTRAL_DRIFT'

/**
 * Drift detection event payload.
 *
 * LLD #5 §2.3 — anomaly.drift.detected event
 */
export interface DriftEvent {
  workspaceId: string
  sopId: string
  driftScore: number
  driftDirection: DriftDirection
  baselineScore: number
  currentScore: number
}

