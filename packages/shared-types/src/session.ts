/**
 * Session management types.
 *
 * These types correspond to the `agent_sessions` table and the
 * Valkey session checkpoint keys defined in
 * LLD 01-data-architecture §3.1 and §3.3.
 *
 * HLD §4.5 (Session Tracking)
 *
 * @module
 */

import type {
  BudgetTier,
  ExecutionMode,
  HarnessType,
} from './enums.js'

// ─── Session ─────────────────────────────────────────────────────────

/**
 * An active or completed agent session.
 *
 * Maps to the `agent_sessions` table. Sessions track which user,
 * project, SOP, and harness are active, plus the budget tier
 * and execution mode.
 *
 * LLD §3.1 — agent_sessions table
 */
export interface Session {
  /** Unique session identifier — `newId('ss')`. */
  sessionId: string

  /** Project this session belongs to — FK to `projects`. */
  projectId: string | null

  /** Workspace this session belongs to — FK to `workspaces`. */
  workspaceId: string

  /** User who initiated this session. */
  userId: string

  /** Active SOP governing this session — FK to `sop_registry`. */
  activeSopId: string | null

  /** Agent harness/IDE type. */
  harnessType: HarnessType

  /** Budget authority tier. */
  budgetTier: BudgetTier

  /** Execution mode controlling autonomy level. */
  executionMode: ExecutionMode

  /** ISO 8601 timestamp when the session was created — `newIso()`. */
  createdAt: string

  /** ISO 8601 timestamp when the session ended, or null if still active. */
  endedAt: string | null
}

// ─── Session Checkpoint ──────────────────────────────────────────────

/**
 * A session checkpoint stored in Valkey for DAG state recovery.
 *
 * Checkpoints allow resuming an agent session from the last known
 * good state after a crash or disconnect.
 *
 * LLD §3.3 — Valkey key `v2:session:{session_id}:state` (TTL 24h)
 */
export interface SessionCheckpoint {
  /** Session this checkpoint belongs to. */
  sessionId: string

  /** Hash of the DAG execution state at this checkpoint. */
  dagStateHash: string

  /** Step index in the execution plan (0-based). */
  stepIndex: number

  /** ISO 8601 timestamp of this checkpoint. */
  timestamp: string
}
