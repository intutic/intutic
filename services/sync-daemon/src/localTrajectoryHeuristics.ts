/**
 * Local trajectory heuristics (Wave 7, audit-remediation).
 *
 * Ports 4 of the 5 deterministic pre-screen rules from the enterprise
 * control plane's `trajectoryAnalysisService.ts` (`HEURISTIC_RULES`) so an
 * open-core or standalone daemon — no control plane connection required —
 * still gets a trajectory guardrail, matching this codebase's tier boundary:
 * free = local/deterministic, paid = judge/team/auto-learning.
 *
 * `BUDGET_EXCEEDED` does NOT port. It reads `budgetUtilization`,
 * workspace-scoped spend-vs-cap state that only the control plane resolves
 * today — `trajectoryMonitor.ts`'s `submitSummary` calls
 * `buffer.toSummary([], 0)` with the comment "SOPs and budget filled by CP",
 * meaning the daemon has no real value for this field at all, only a
 * placeholder `0`. The proxy's own `local_spend.rs` tracks a DIFFERENT
 * thing — a per-machine daily dollar cap, not this workspace-scoped budget
 * percentage — so porting a rule under the same name against that source
 * would silently change what the rule means, not just where it runs.
 *
 * Deterministic only, matching this package's own standing doctrine
 * (`trajectoryMonitor.ts`'s module doc: "No LLM calls on developer
 * machine — all judgment is server-side"). This module makes the same true
 * of a fourth thing: a local guardrail that needs no server round trip at
 * all, judgment or otherwise.
 *
 * @module
 */

export type LocalHeuristicRule = 'RUNAWAY_VELOCITY' | 'LOOP_DETECTED' | 'ERROR_STORM' | 'TOOL_ABUSE'
export type LocalHeuristicSeverity = 'HIGH' | 'MEDIUM'

export interface LocalHeuristicResult {
  triggered: true
  rule: LocalHeuristicRule
  severity: LocalHeuristicSeverity
  message: string
}

/** The subset of `TrajectorySummaryPayload` these four rules need — every
 *  one of these fields is computed locally in `TrajectoryBuffer.toSummary`,
 *  unlike `budgetUtilization`. */
export interface LocalHeuristicInput {
  tokenVelocity: number
  toolCallVelocity: number
  maxConsecutiveIdenticalCalls: number
  errorCount: number
}

/** Thresholds and severities mirror `HEURISTIC_RULES` in the enterprise
 *  `trajectoryAnalysisService.ts` exactly — this is a port, not a redesign. */
const LOCAL_HEURISTIC_RULES: Array<{
  rule: LocalHeuristicRule
  check: (s: LocalHeuristicInput) => LocalHeuristicResult | null
}> = [
  {
    rule: 'RUNAWAY_VELOCITY',
    check: (s) =>
      s.tokenVelocity > 50_000
        ? {
            triggered: true,
            rule: 'RUNAWAY_VELOCITY',
            severity: 'HIGH',
            message: `Token velocity: ${s.tokenVelocity.toFixed(0)} tokens/min (threshold: 50,000)`,
          }
        : null,
  },
  {
    rule: 'LOOP_DETECTED',
    check: (s) =>
      s.maxConsecutiveIdenticalCalls >= 5
        ? {
            triggered: true,
            rule: 'LOOP_DETECTED',
            severity: 'HIGH',
            message: `${s.maxConsecutiveIdenticalCalls} consecutive identical tool calls detected`,
          }
        : null,
  },
  {
    rule: 'ERROR_STORM',
    check: (s) =>
      s.errorCount > 10
        ? {
            triggered: true,
            rule: 'ERROR_STORM',
            severity: 'MEDIUM',
            message: `${s.errorCount} errors in current window`,
          }
        : null,
  },
  {
    rule: 'TOOL_ABUSE',
    check: (s) =>
      s.toolCallVelocity > 30
        ? {
            triggered: true,
            rule: 'TOOL_ABUSE',
            severity: 'MEDIUM',
            message: `Tool call velocity: ${s.toolCallVelocity.toFixed(1)} calls/min (threshold: 30)`,
          }
        : null,
  },
]

/**
 * Runs the four portable heuristics against a locally-computed trajectory
 * summary. Pure and synchronous — no I/O, no network, safe to call on every
 * window regardless of control-plane reachability.
 */
export function runLocalTrajectoryHeuristics(summary: LocalHeuristicInput): LocalHeuristicResult[] {
  const results: LocalHeuristicResult[] = []
  for (const { check } of LOCAL_HEURISTIC_RULES) {
    const result = check(summary)
    if (result) results.push(result)
  }
  return results
}
