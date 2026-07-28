/**
 * The Intutic runtime anomaly taxonomy.
 *
 * Twelve categories describing how an agent run can go wrong, with the
 * severity each carries. This is the shared vocabulary: the Rust proxy raises
 * these on the hot path, the control plane classifies against them
 * asynchronously, and governance notifications carry the value in `category`.
 *
 * It is a package rather than a constant in one service because it is declared
 * in two languages. The proxy has its own copy in Rust — the hot path cannot
 * call into TypeScript — and two hand-maintained lists drift. Drift here is
 * silent: a renamed category simply stops being classified downstream, with no
 * error raised anywhere. The proxy therefore parses this file at test time and
 * fails its build on any divergence.
 *
 * Deliberately **types and constants only**. No detection logic, no
 * thresholds, no probes. Detection is a separate concern with a separate
 * licence, and mixing them here would make the vocabulary impossible to share.
 *
 * @packageDocumentation
 */

/** The twelve runtime anomaly categories. */
export const AnomalyType = {
  /** Tool use inconsistent with any plausible task. */
  TOOL_ABUSE: 'TOOL_ABUSE',
  /** Spend without progress — context growth, repetition, no advancement. */
  TOKEN_WASTE: 'TOKEN_WASTE',
  /** A cycle: a spin, an alternation, or runaway recursion. */
  LOOP_DETECTED: 'LOOP_DETECTED',
  /** A tool or harness the policy in force does not permit. */
  UNAUTHORIZED_TOOL: 'UNAUTHORIZED_TOOL',
  /** Secrets or personal data leaving the boundary. */
  DATA_EXFILTRATION: 'DATA_EXFILTRATION',
  /** Text attempting to override the instructions the agent operates under. */
  PROMPT_INJECTION: 'PROMPT_INJECTION',
  /** Work proceeding on a premise that no longer holds. */
  HALLUCINATION: 'HALLUCINATION',
  /** Action outside the bounds the task was scoped to. */
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  /** A session past its spending ceiling. */
  BUDGET_BREACH: 'BUDGET_BREACH',
  /** A fan-out costing far more than any single node was budgeted. */
  SPAWN_BUDGET_BREACH: 'SPAWN_BUDGET_BREACH',
  /** A workflow past the ceiling it was started with. */
  WORKFLOW_BUDGET_BREACH: 'WORKFLOW_BUDGET_BREACH',
  /** A run no longer pursuing the goal it was given. */
  WORKFLOW_GOAL_DRIFT: 'WORKFLOW_GOAL_DRIFT',
} as const

/** Union of every anomaly category. */
export type AnomalyType = (typeof AnomalyType)[keyof typeof AnomalyType]

/** How urgently a category needs attention. */
export type AnomalySeverity =
  | 'CRITICAL'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'INFORMATIONAL'

/**
 * Severity per category.
 *
 * `CRITICAL` is reserved for categories where the damage is done the moment
 * the request succeeds — data leaving the boundary, or the agent's
 * instructions being replaced. Everything else is recoverable by stopping.
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

/** Every category, for exhaustive iteration. */
export const ALL_ANOMALY_TYPES = Object.values(AnomalyType) as AnomalyType[]

/** Whether an arbitrary string is a known category. */
export function isAnomalyType(value: string): value is AnomalyType {
  return (ALL_ANOMALY_TYPES as string[]).includes(value)
}
