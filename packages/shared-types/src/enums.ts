/**
 * Domain enums for the Intutic governance platform.
 *
 * Each enum is defined as a frozen `as const` object with a corresponding
 * TypeScript union type extracted via `typeof Obj[keyof typeof Obj]`.
 * This pattern gives us runtime values (for comparisons, iteration) and
 * compile-time narrowing without Drizzle or Postgres dependencies.
 *
 * These mirror the Postgres enum types defined in
 * LLD 01-data-architecture §3.1.
 *
 * @module
 */

// ─── Risk Level ──────────────────────────────────────────────────────
// HLD §3.5, LLD §3.1 — risk_level enum

/** Risk severity classification for SOPs, anomalies, and incidents. */
export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const

/** Union of all risk level values. */
export type RiskLevel = typeof RiskLevel[keyof typeof RiskLevel]

// ─── Enforcement Action ──────────────────────────────────────────────
// HLD §3.3, LLD §3.1 — enforcement_action_type enum

/**
 * PCAS enforcement action applied to a tool call.
 *
 * BYPASS..KILL are listed in increasing severity. `REASK` sits between
 * `HIJACK` and `KILL`: the attempt is refused and the reason handed back to
 * the agent, which may retry a bounded number of times before the finding
 * escalates to a block.
 *
 * It exists because the proxy's promotion rule
 * (`packages/proxy/src/plugins/anomaly/mod.rs`) forbids a heuristic from
 * killing until its false-positive rate has been measured, and five detectors
 * were doing exactly that. Demoting them to `HIJACK` would have honoured the
 * rule and lost the enforcement; `REASK` keeps both.
 *
 * Mirrors `enforcement_action_type` — see migration 114.
 *
 * `OBSERVED` (migration 156) is deliberately OUTSIDE that severity ladder —
 * it does not mean "PCAS acted with this severity", it means "PCAS took no
 * action because the request never produced a response to act on". It is
 * `mapVerdict`'s (`services/control-plane/src/lib/valkeySubscriber.ts`)
 * target for the proxy's `"upstream_error"` verdict — a provider 5xx or an
 * unservable-model rejection. Before this value existed, `mapVerdict`'s
 * fail-closed default mapped every unrecognised verdict to `KILL`, so every
 * upstream_error trace was recorded as an enforcement block that never
 * happened: an honest failure record read as PCAS having stopped the
 * request. `BYPASS` was considered and rejected for the same reason in the
 * other direction — it means the call went through and completed, which an
 * upstream_error trace never did. Nothing existing fit, so this is the
 * smallest addition that lets "PCAS did not enforce anything here, the
 * provider itself failed" be recorded truthfully.
 */
export const EnforcementAction = {
  BYPASS: 'BYPASS',
  ENHANCE: 'ENHANCE',
  HIJACK: 'HIJACK',
  REASK: 'REASK',
  KILL: 'KILL',
  OBSERVED: 'OBSERVED',
} as const

/** Union of all enforcement action values. */
export type EnforcementAction = typeof EnforcementAction[keyof typeof EnforcementAction]

// ─── Token Utility ───────────────────────────────────────────────────
// HLD §3.6, LLD §3.1 — token_utility_type enum

/** Classification of whether a token expenditure was useful or wasted. */
export const TokenUtility = {
  USEFUL: 'USEFUL',
  WASTED: 'WASTED',
} as const

/** Union of all token utility values. */
export type TokenUtility = typeof TokenUtility[keyof typeof TokenUtility]

// ─── Budget Tier ─────────────────────────────────────────────────────
// HLD §3.3, LLD §3.1 — budget_tier_type enum

/** Budget authority level assigned to a user or agent session. */
export const BudgetTier = {
  JUNIOR: 'JUNIOR',
  SENIOR: 'SENIOR',
  STAFF: 'STAFF',
  PRINCIPAL: 'PRINCIPAL',
} as const

/** Union of all budget tier values. */
export type BudgetTier = typeof BudgetTier[keyof typeof BudgetTier]

// ─── Complexity Tier ─────────────────────────────────────────────────
// HLD §3.4, LLD §3.1 — complexity_tier enum

/** Task complexity classification for model routing. */
export const ComplexityTier = {
  TIER_0: 'TIER_0',
  TIER_1: 'TIER_1',
  TIER_2: 'TIER_2',
} as const

/** Union of all complexity tier values. */
export type ComplexityTier = typeof ComplexityTier[keyof typeof ComplexityTier]

// ─── Change Classification ──────────────────────────────────────────
// HLD §3.4, LLD §3.1 — change_classification enum

/** Classification of how an SOP change affects the prior version. */
export const ChangeClassification = {
  STRENGTHEN: 'STRENGTHEN',
  CLARIFY: 'CLARIFY',
  NARROW: 'NARROW',
  WEAKEN: 'WEAKEN',
} as const

/** Union of all change classification values. */
export type ChangeClassification = typeof ChangeClassification[keyof typeof ChangeClassification]

// ─── Anomaly Type ────────────────────────────────────────────────────
// HLD §3.5, LLD §3.1 — anomaly_type enum (12-category runtime taxonomy)

/**
 * Runtime anomaly classification taxonomy.
 *
 * Re-exported from `@intutic/anomaly-taxonomy`, which is the source of truth.
 * It lives in its own package because the Rust proxy declares the same twelve
 * categories — the hot path cannot call into TypeScript — and the proxy's
 * tests parse that package to fail the build if the two ever diverge.
 *
 * Re-exported rather than redeclared so this file cannot become a third copy.
 */
export { AnomalyType } from '@intutic/anomaly-taxonomy'
export type {
  AnomalySeverity,
} from '@intutic/anomaly-taxonomy'

// ─── Harness Type ────────────────────────────────────────────────────
// HLD §3.14, §4.5 — Supported AI agent harness integrations
// Full matrix: HLD §3.14 Harness Onboarding Matrix (19 harnesses)

/** Supported AI agent harness/IDE integrations. */
export const HarnessType = {
  CURSOR: 'cursor',
  CLAUDE_CODE: 'claude-code',
  ANTIGRAVITY: 'antigravity',
  N8N: 'n8n',
  CODEX: 'codex',
  WINDSURF: 'windsurf',
  AIDER: 'aider',
  OPENHANDS: 'openhands',
  OPENCLAW: 'openclaw',
  HERMES: 'hermes',
  PI: 'pi',
  CLINE: 'cline',
  ROO_CODE: 'roo-code',
  CONTINUE: 'continue',
  CLAUDE_DESKTOP: 'claude-desktop',
  GOOSE: 'goose',
  OPEN_WEBUI: 'open-webui',
  GITHUB_COPILOT: 'github-copilot',
  LANGGRAPH: 'langgraph',
} as const

/** Union of all harness type values. */
export type HarnessType = typeof HarnessType[keyof typeof HarnessType]

// ─── Execution Mode ──────────────────────────────────────────────────
// HLD §3.4 — Agent execution modes

/** Agent execution mode controlling autonomy level. */
export const ExecutionMode = {
  STANDARD: 'STANDARD',
  PLAN_ONLY: 'PLAN_ONLY',
  SHADOW: 'SHADOW',
  AUTONOMOUS: 'AUTONOMOUS',
} as const

/** Union of all execution mode values. */
export type ExecutionMode = typeof ExecutionMode[keyof typeof ExecutionMode]

// ─── Incident Status ─────────────────────────────────────────────────
// HLD §3.6.1, LLD §3.1 — Governance incident lifecycle

/** Lifecycle state of a governance incident. */
export const IncidentStatus = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
} as const

/** Union of all incident status values. */
export type IncidentStatus = typeof IncidentStatus[keyof typeof IncidentStatus]

// ─── Plan Lifecycle State ────────────────────────────────────────────
// HLD §3.4.1 — Stored plan compliance trail lifecycle

/** Lifecycle state for stored execution plans. */
export const PlanLifecycleState = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
} as const

/** Union of all plan lifecycle state values. */
export type PlanLifecycleState = typeof PlanLifecycleState[keyof typeof PlanLifecycleState]

// ─── Plan Execution Outcome ──────────────────────────────────────────
// HLD §3.4.1 — result category recorded when a plan is closed
// (lifecycleState -> COMPLETED). Meaningful only in that state; null
// otherwise — a REJECTED plan never executed, so it has no outcome.

/** Result category for a closed (COMPLETED) stored plan. */
export const PlanExecutionOutcome = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
  ABORTED: 'ABORTED',
} as const

/** Union of all plan execution outcome values. */
export type PlanExecutionOutcome = typeof PlanExecutionOutcome[keyof typeof PlanExecutionOutcome]

// ─── SOP Lifecycle State ─────────────────────────────────────────────
// HLD §3.4, LLD #6 §4.2 — 7-state FSM: DRAFT → PENDING_REVIEW → GENERATED
//   → HYPOTHESIZED → REFINED → VALIDATED → INVALIDATED

/** Lifecycle state for SOPs in the registry. */
export const SopLifecycleState = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  GENERATED: 'GENERATED',
  HYPOTHESIZED: 'HYPOTHESIZED',
  REFINED: 'REFINED',
  VALIDATED: 'VALIDATED',
  INVALIDATED: 'INVALIDATED',
} as const

/** Union of all SOP lifecycle state values. */
export type SopLifecycleState = typeof SopLifecycleState[keyof typeof SopLifecycleState]

// ─── SOP Type ────────────────────────────────────────────────────────
// TD-022 item 0.4 — SOP classification for hook pipeline

/** SOP type: standard markdown or executable V8 hook. */
export const SopType = {
  /** Standard SOP — markdown content enforced via SSL. */
  STANDARD: 'standard',
  /** Hook SOP — V8-executable script that fires at a pipeline phase. */
  HOOK: 'hook',
} as const

/** Union of all SOP type values. */
export type SopType = typeof SopType[keyof typeof SopType]

// ─── Hook Phase ──────────────────────────────────────────────────────
// TD-022 item 0.4 — Pipeline phase for hook-type SOPs

/** Pipeline phase where a hook-type SOP fires. */
export const HookPhase = {
  /** Before tool call evaluation. */
  PRE_TOOL: 'PRE_TOOL',
  /** After tool call evaluation. */
  POST_TOOL: 'POST_TOOL',
  /** Before forwarding to LLM provider. */
  PRE_RESPONSE: 'PRE_RESPONSE',
  /** After LLM response received. */
  POST_RESPONSE: 'POST_RESPONSE',
} as const

/** Union of all hook phase values. */
export type HookPhase = typeof HookPhase[keyof typeof HookPhase]

// ─── Routing Tier ────────────────────────────────────────────────────
// HLD §3.6, LLD §3.1 — Model routing tier classification

/** Model routing tier for cost optimization. */
export const RoutingTier = {
  FRONTIER: 'frontier',
  ECONOMY: 'economy',
  LOCAL: 'local',
} as const

/** Union of all routing tier values. */
export type RoutingTier = typeof RoutingTier[keyof typeof RoutingTier]

// ─── Workspace Role ──────────────────────────────────────────────────
// HLD §5.1, LLD #7 — RBAC role hierarchy

/** Workspace member role for RBAC. OWNER > ADMIN > EM > DEVELOPER > VIEWER. */
export const WorkspaceRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  EM: 'EM',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER',
} as const

/** Union of all workspace role values. */
export type WorkspaceRole = typeof WorkspaceRole[keyof typeof WorkspaceRole]

// ─── MCP Proxy Settings ──────────────────────────────────────────────
// WS-5 — Q1 fail behavior, Q2 deployment model, Q3 bypass enforcement
// TD-151, TD-152, TD-153, TD-154, TD-155

/**
 * MCP proxy fail behavior when the Intutic control plane is unreachable.
 * - `open`   (default): pass through the tool call + emit a warning event
 * - `closed`: block the tool call with a user-visible error message
 *
 * Note: `closed` only affects harnesses with MCP proxy injection (8/19 —
 * 9 config paths across 8 harnesses, see sync-daemon mcpAutoWrite.ts).
 * For harnesses without MCP proxy injection (e.g. n8n, pi, codex,
 * open-webui), see TD-151.
 */
export const McpProxyFailBehavior = {
  OPEN:   'open',
  CLOSED: 'closed',
} as const
export type McpProxyFailBehavior = typeof McpProxyFailBehavior[keyof typeof McpProxyFailBehavior]

/**
 * MCP proxy deployment model.
 * - `per-session` (default, Phase 4): new proxy process per MCP connection
 * - `daemon`      (Phase 5): long-lived daemon, per-session shims delegate via Unix socket
 *
 * See TD-153 — daemon requires macOS notarization. Both modes are active: the
 * mcp-proxy honours `daemon` by answering policy lookups over the daemon socket.
 */
export const McpProxyMode = {
  PER_SESSION: 'per-session',
  DAEMON:      'daemon',
} as const
export type McpProxyMode = typeof McpProxyMode[keyof typeof McpProxyMode]

/**
 * Bypass enforcement tier — how aggressively the sync-daemon defends harness configs
 * against manual edits.
 * - `rewrite`    (default): drift watcher detects edits → immediate config rewrite (~1s)
 * - `immutable`  (opt-in):  after each write, sets macOS `chflags uchg` (user-immutable flag)
 * - `alert-only`: no rewrite; drift creates a governance incident only (audit mode)
 *
 * See TD-154 for immutable-flag UX risk notes.
 */
export const BypassEnforcementTier = {
  REWRITE:    'rewrite',
  IMMUTABLE:  'immutable',
  ALERT_ONLY: 'alert-only',
} as const
export type BypassEnforcementTier = typeof BypassEnforcementTier[keyof typeof BypassEnforcementTier]

// ─── Phase 5 Enums ───────────────────────────────────────────────────
// LLD #27: Production Hardening & SOC 2

/** TurboVec behavioral drift classification. @see HLD §7.7 */
export const DriftClassification = {
  POSITIVE_DRIFT: 'POSITIVE_DRIFT',
  NEGATIVE_DRIFT: 'NEGATIVE_DRIFT',
  NEUTRAL_DRIFT:  'NEUTRAL_DRIFT',
} as const
export type DriftClassification = typeof DriftClassification[keyof typeof DriftClassification]

/** Drift detection mode — TurboVec cosine-distance or compliance-score fallback. */
export const DriftDetectionMode = {
  TURBOVEC:                  'turbovec',
  COMPLIANCE_SCORE_FALLBACK: 'compliance_score_fallback',
} as const
export type DriftDetectionMode = typeof DriftDetectionMode[keyof typeof DriftDetectionMode]

