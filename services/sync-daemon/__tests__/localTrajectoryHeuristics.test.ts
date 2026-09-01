/**
 * localTrajectoryHeuristics.ts (Wave 7, audit-remediation) — a port of 4 of
 * the enterprise control plane's 5 deterministic trajectory pre-screen
 * rules, so a standalone/open-core daemon with no control plane still gets
 * a guardrail. Thresholds and severities must match the enterprise source
 * (`trajectoryAnalysisService.ts`'s `HEURISTIC_RULES`) exactly — this is a
 * port, not a redesign.
 */
import { describe, it, expect } from 'vitest'
import { runLocalTrajectoryHeuristics, type LocalHeuristicInput } from '../src/localTrajectoryHeuristics.js'

const QUIET: LocalHeuristicInput = {
  tokenVelocity: 100,
  toolCallVelocity: 1,
  maxConsecutiveIdenticalCalls: 1,
  errorCount: 0,
}

describe('runLocalTrajectoryHeuristics', () => {
  it('triggers nothing for quiet, well-behaved traffic', () => {
    expect(runLocalTrajectoryHeuristics(QUIET)).toEqual([])
  })

  it('RUNAWAY_VELOCITY fires above 50,000 tokens/min, not at or below it', () => {
    expect(runLocalTrajectoryHeuristics({ ...QUIET, tokenVelocity: 50_000 })).toEqual([])
    const [result] = runLocalTrajectoryHeuristics({ ...QUIET, tokenVelocity: 50_001 })
    expect(result).toMatchObject({ triggered: true, rule: 'RUNAWAY_VELOCITY', severity: 'HIGH' })
  })

  it('LOOP_DETECTED fires at 5 or more consecutive identical calls, not at 4', () => {
    expect(runLocalTrajectoryHeuristics({ ...QUIET, maxConsecutiveIdenticalCalls: 4 })).toEqual([])
    const [result] = runLocalTrajectoryHeuristics({ ...QUIET, maxConsecutiveIdenticalCalls: 5 })
    expect(result).toMatchObject({ triggered: true, rule: 'LOOP_DETECTED', severity: 'HIGH' })
  })

  it('ERROR_STORM fires above 10 errors, not at or below it', () => {
    expect(runLocalTrajectoryHeuristics({ ...QUIET, errorCount: 10 })).toEqual([])
    const [result] = runLocalTrajectoryHeuristics({ ...QUIET, errorCount: 11 })
    expect(result).toMatchObject({ triggered: true, rule: 'ERROR_STORM', severity: 'MEDIUM' })
  })

  it('TOOL_ABUSE fires above 30 calls/min, not at or below it', () => {
    expect(runLocalTrajectoryHeuristics({ ...QUIET, toolCallVelocity: 30 })).toEqual([])
    const [result] = runLocalTrajectoryHeuristics({ ...QUIET, toolCallVelocity: 30.1 })
    expect(result).toMatchObject({ triggered: true, rule: 'TOOL_ABUSE', severity: 'MEDIUM' })
  })

  it('reports every rule that fires at once, not just the first', () => {
    const results = runLocalTrajectoryHeuristics({
      tokenVelocity: 60_000,
      toolCallVelocity: 40,
      maxConsecutiveIdenticalCalls: 6,
      errorCount: 12,
    })
    const rules = results.map((r) => r.rule).sort()
    expect(rules).toEqual(['ERROR_STORM', 'LOOP_DETECTED', 'RUNAWAY_VELOCITY', 'TOOL_ABUSE'])
  })

  it('has no BUDGET_EXCEEDED rule — that stays server-side, see the module doc', () => {
    const results = runLocalTrajectoryHeuristics({
      tokenVelocity: 1_000_000,
      toolCallVelocity: 1_000,
      maxConsecutiveIdenticalCalls: 1_000,
      errorCount: 1_000,
    })
    expect(results.map((r) => r.rule)).not.toContain('BUDGET_EXCEEDED')
  })
})
