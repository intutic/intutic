/**
 * The deterministic stage of loop verification: before any
 * judge is asked, a loop run's changes are checked against the declared file
 * scope and its tool sequence against the declared plan. The control plane
 * runs it over the workspace and org SOPs (`verifyLoop`); `intutic loop
 * verify` runs it over the local SOPs first and sends nothing when it fails.
 *
 * - Only SOPs with no `roles:` count: a loop run has no agent role.
 * - `scope_paths`: every changed path must be inside the scope in force
 *   (`collectScopePaths`, the org ceiling included). No tolerance, whatever
 *   the mode: a verify is a boundary check. Not applicable when no SOP
 *   declares a scope.
 * - `plan_steps`: `planOffSteps` with tolerance 0.4 under `advise` and 0
 *   under `enforce` (any SOP declaring a plan with `plan_steps_mode:
 *   enforce`). Not applicable when there is no plan, or the run has no
 *   gateway traces to read a sequence from (a hook-only loop).
 *
 * @module
 */

import type { RefusalScope } from './refusalDetail.js'
import { boundRefusalScope } from './refusalDetail.js'
import { collectPlanSteps, collectScopePaths, isWithinScope, planOffSteps, PLAN_DEVIATION_TOLERANCE } from './scopeMatch.js'

/** One SOP as the deterministic stage reads it (parse with `parseFrontMatterEnforcing`). */
export interface LoopVerifySop {
  title: string
  scope: 'workspace' | 'org'
  roles: readonly string[]
  scopePaths: readonly string[]
  scopeMode: 'advise' | 'enforce'
  planSteps: readonly string[]
  planMode: 'advise' | 'enforce'
}

export type LoopCheckId = 'scope_paths' | 'plan_steps'

export interface LoopCheck {
  id: LoopCheckId
  status: 'pass' | 'fail' | 'not_applicable'
  findings: string[]
  scope?: RefusalScope
}

/** The most findings one check lists; the rest are counted in a last finding. */
export const LOOP_CHECK_MAX_FINDINGS = 20

export interface LoopVerifyInput {
  /** `diffChangedPaths(diff)` ∪ `files` ∪ the change manifests' mutation targets. */
  changedPaths: readonly string[]
  /** The run's `execution_traces.tool_sequence`, by timestamp; empty for a hook-only loop. */
  toolSequence: readonly string[]
  sops: readonly LoopVerifySop[]
}

function capped(findings: string[], what: string): string[] {
  if (findings.length <= LOOP_CHECK_MAX_FINDINGS) return findings
  return [...findings.slice(0, LOOP_CHECK_MAX_FINDINGS), `… and ${findings.length - LOOP_CHECK_MAX_FINDINGS} more ${what}`]
}

/** The two deterministic checks, `scope_paths` then `plan_steps`. */
export function verifyLoopDeterministic(input: LoopVerifyInput): LoopCheck[] {
  const sops = input.sops.filter((s) => s.roles.length === 0)

  const scopes = collectScopePaths(sops, '')
  let scopeCheck: LoopCheck
  if (scopes.length === 0) {
    scopeCheck = { id: 'scope_paths', status: 'not_applicable', findings: [] }
  } else {
    const outside = [...new Set(input.changedPaths)].filter((p) => !isWithinScope(p, scopes))
    scopeCheck =
      outside.length === 0
        ? { id: 'scope_paths', status: 'pass', findings: [] }
        : {
            id: 'scope_paths',
            status: 'fail',
            findings: capped(
              outside.map((p) => `${p} is outside the declared file scope (scope: ${scopes.join(', ')})`),
              'paths outside the scope',
            ),
            scope: boundRefusalScope({ paths: outside }) ?? undefined,
          }
  }

  const plan = collectPlanSteps(sops, '')
  let planCheck: LoopCheck
  if (plan.length === 0 || input.toolSequence.length === 0) {
    planCheck = { id: 'plan_steps', status: 'not_applicable', findings: [] }
  } else {
    const enforce = sops.some((s) => s.planSteps.length > 0 && s.planMode === 'enforce')
    const off = planOffSteps(input.toolSequence, plan, enforce ? 0 : PLAN_DEVIATION_TOLERANCE)
    if (off.offPlan.length === 0) {
      planCheck = { id: 'plan_steps', status: 'pass', findings: [] }
    } else {
      const shown = off.offPlan.slice(0, 5)
      const more = off.offPlan.length > shown.length ? ', …' : ''
      planCheck = {
        id: 'plan_steps',
        status: 'fail',
        findings: [`Work outside the declared plan: ${Math.round(off.ratio * 100)}% of steps are unlisted (${shown.join(', ')}${more})`],
        scope: boundRefusalScope({ tools: off.offPlan }) ?? undefined,
      }
    }
  }
  return [scopeCheck, planCheck]
}
