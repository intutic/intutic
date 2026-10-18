/**
 * The decide budget each harness's gate has for one call, and whether a
 * rule fits in it.
 *
 *   B(h) = gateDeadlineMs(h) − D(family) − 500 ms
 *
 * D is the deterministic tiers' measured worst case at the size limits:
 * 4,600 ms for the bash gates, 1,200 ms for the JavaScript ones. The bash
 * gates and the n8n gate reach the engine through `intutic decide check`, so
 * that command's cold start S comes off their budget too.
 *
 * A rule's estimate is the engine's per-call p95 times its calls over the
 * engine's parallelism: a yes/no question is one call, a choice two, or
 * three past three options (none_of_these counted).
 *
 * @module
 */

import { gateDeadlineMs, HOOK_GATE_TIMEOUTS, type HookGateHarness } from '@intutic/shared-types'

// Shared with every gate's decide tier, which skips a rule whose estimate does not fit.
export { decideRuleCalls, decideRuleEstimateMs } from '@intutic/shared-types'

export const DECIDE_BUDGET_MARGIN_MS = 500
export const DETERMINISTIC_WORST_MS = { bash: 4600, js: 1200 } as const

/**
 * S, the cold start of `intutic decide check --stdin`: spawn to answer on
 * the built CLI, 20 runs after one warm-up, on an M4 Pro (Node 26, load
 * average near 8) with a snapshot carrying one decide record for another
 * tool. Measured 2026-10-17: p50 112 ms, p95 116 ms, max 116 ms; rounded
 * up. It comes off the shell and n8n gates' budget in `doctor`'s table.
 */
export const DECIDE_CHECK_COLD_START_MS = 120

/** The harnesses whose gate is a bash script calling `intutic decide check`. */
const BASH_GATES = new Set<string>(['gemini-cli', 'goose', 'hermes', 'openhands'])

export interface HarnessBudget {
  harness: string
  family: 'js' | 'bash' | 'n8n'
  deadlineMs: number
  budgetMs: number
}

/** Every harness's decide budget, the CLI's cold start taken off where the gate calls it. */
export function decideBudgets(coldStartMs: number = DECIDE_CHECK_COLD_START_MS): HarnessBudget[] {
  const out: HarnessBudget[] = (Object.keys(HOOK_GATE_TIMEOUTS) as HookGateHarness[]).map((h) => {
    const bash = BASH_GATES.has(h)
    const deadlineMs = gateDeadlineMs(h)
    const d = bash ? DETERMINISTIC_WORST_MS.bash : DETERMINISTIC_WORST_MS.js
    return { harness: h, family: bash ? 'bash' : 'js', deadlineMs, budgetMs: deadlineMs - d - DECIDE_BUDGET_MARGIN_MS - (bash ? coldStartMs : 0) }
  })
  // n8n runs its gate in the workflow process with no limit: treated as 10 s, and it calls the CLI.
  const n8nDeadline = 9000
  out.push({ harness: 'n8n', family: 'n8n', deadlineMs: n8nDeadline, budgetMs: n8nDeadline - DETERMINISTIC_WORST_MS.js - DECIDE_BUDGET_MARGIN_MS - coldStartMs })
  return out
}
