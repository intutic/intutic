/**
 * PCAS (Policy-Controlled Agent Sandbox) and enforcement types.
 *
 * These types define the permission resolution, policy verdict, and
 * Delegation Capability Token (DCT) structures used by the Circuit
 * Breaker and PCAS subsystems.
 *
 * HLD §3.3 (PCAS), LLD 01-data-architecture §3.2 (FalkorDB org graph)
 *
 * @module
 */

import type { BudgetTier, EnforcementAction } from './enums.js'

// ─── Permission Set ──────────────────────────────────────────────────

/**
 * Resolved permission set for a user/agent within a workspace.
 *
 * Produced by PCAS permission resolution (Valkey cache or FalkorDB query).
 * The allowed/denied tool lists are evaluated against the current SOP.
 *
 * HLD §3.3 — PCAS permission resolution
 */
export interface PermissionSet {
  /** Tool names explicitly permitted for this session. */
  allowedTools: string[]

  /** Tool names explicitly denied for this session. */
  deniedTools: string[]

  /** Remaining budget in USD for this session or workspace. */
  budgetRemaining: number

  /** Budget authority tier of the user/agent. */
  tier: BudgetTier
}

// ─── Policy Verdict ──────────────────────────────────────────────────

/**
 * Result of a policy evaluation against a pending tool call.
 *
 * Produced by the Circuit Breaker's PCAS evaluation cascade.
 * Routes enforce the verdict before forwarding the call to the provider.
 *
 * HLD §3.3 — Enforcement actions
 */
export interface PolicyVerdict {
  /** Enforcement action to apply. */
  action: EnforcementAction

  /** Confidence score of the verdict (0.0–1.0). */
  confidence: number

  /** Human-readable reason for the verdict. */
  reason: string

  /** ID of the policy rule that produced this verdict, if applicable. */
  policyId?: string
}

// ─── Delegation Capability Token ─────────────────────────────────────

/**
 * Delegation Capability Token (DCT) for agent-to-agent permission attenuation.
 *
 * When an agent spawns a sub-agent, it issues a DCT that contains the
 * parent's chain of authority and any attenuations (permission restrictions).
 * The chain is append-only — sub-agents can only narrow permissions, never widen.
 *
 * HLD §3.3 — DCT lineage, LLD §3.2 — SPAWNED_BY edge
 */
export interface DctToken {
  /** Ordered chain of session IDs from root agent to current agent. */
  chain: string[]

  /** Permission attenuations applied at each delegation step. */
  attenuation: Record<string, unknown>

  /** Session ID of the parent agent that issued this token. */
  parentSessionId: string
}

// ─── Risk Category ───────────────────────────────────────────────────

/**
 * Tool-call risk classification for PCAS policy evaluation.
 *
 * HLD §3.2 — Circuit Breaker risk categories
 */
export type RiskCategory = 'NONE' | 'DESTRUCTIVE' | 'CREDENTIAL_ACCESS'

// ─── Intervention Mode ──────────────────────────────────────────────

/**
 * Display mode controlling how enforcement decisions are surfaced to the user.
 *
 * HLD §3.3 — PCAS intervention modes
 */
export type InterventionMode = 'TRANSPARENT' | 'OPAQUE' | 'SILENT_LOG'

// ─── Plugin Verdict ──────────────────────────────────────────────────

/**
 * Individual verdict from a single evaluation plugin in the cascade.
 *
 * HLD §3.2 — Evaluation cascade plugin output
 */
export interface PluginVerdict {
  /** Name of the plugin that produced this verdict. */
  pluginName: string

  /** The policy verdict returned by this plugin. */
  verdict: PolicyVerdict

  /** Time taken by this plugin to evaluate, in milliseconds. */
  latencyMs: number
}

// ─── Evaluation Cascade Result ──────────────────────────────────────

/**
 * Aggregated result from the full evaluation cascade across all plugins.
 *
 * HLD §3.2 — Cascade merge logic
 */
export interface EvaluationCascadeResult {
  /** Ordered list of per-plugin verdicts. */
  pluginVerdicts: PluginVerdict[]

  /** Final merged verdict after cascade resolution. */
  mergedVerdict: PolicyVerdict

  /** Total wall-clock latency of the full cascade, in milliseconds. */
  totalLatencyMs: number
}
