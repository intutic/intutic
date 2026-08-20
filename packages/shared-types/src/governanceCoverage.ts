/**
 * Governance-coverage enforcement-input mapping — declared once.
 *
 * `POST /api/v1/governance-coverage/snapshot` takes four booleans
 * (`mcpProxyActive`, `nativeHookActive`, `llmProxyActive`, `hasRulesFile`)
 * that grade one harness's enforcement tier. Two independent producers
 * compute them from the same underlying signal — an agent's reported
 * `facets` — with what used to be the identical mapping written out twice:
 *
 *   - `services/control-plane/src/services/harnessGradeSweep.ts`'s
 *     `deriveEnforcementInputs`, run hourly for every workspace, reading
 *     `agents.facets` back out of Postgres.
 *   - `services/sync-daemon/src/syncLoop.ts`'s `runSyncIteration` (step 5b),
 *     run every sync cycle, reading the `facets` object `collectAgentReport`
 *     just built in memory for the same cycle's `POST /api/v1/agents/report`
 *     call.
 *
 * Hand-copying this mapping between the two is how it drifted (TD-443):
 * `syncLoop.ts`'s copy read `report.facets.mcp_tools.length > 0` with no
 * `Array.isArray` guard, while `harnessGradeSweep.ts`'s copy guarded it —
 * the exact two-hand-kept-copies failure `secretPatterns.ts`'s module doc
 * comment describes for credential-value patterns. This module is the fix:
 * one mapping, one source, both sides import it.
 *
 * `EnforcementFacets` is deliberately a NEW, narrower structural type, not a
 * re-export of either service's own facets type. Neither service's
 * `AgentFacets` moves here — `services/control-plane/src/lib/agentPosture.ts`'s
 * and `services/sync-daemon/src/agentReporter.ts`'s each carry a great deal
 * more shape (skills, sops, budgets, memory, …) than this mapping needs, and
 * `services/sync-daemon` is publicly mirrored byte-identical into the
 * open-core `intutic` repo and must not import from `services/control-plane`
 * (or any enterprise-only package) — so there is no single existing type both
 * sides could share directly even if one of them exported it. Both services'
 * `AgentFacets` are structurally assignable to `EnforcementFacets` as it
 * stands (checked, not just asserted — see this module's tests and the two
 * call sites), which is all a structural type needs.
 *
 * @module
 */

/**
 * The narrow slice of an agent's reported `facets` this mapping reads. Both
 * `services/control-plane/src/lib/agentPosture.ts#AgentFacets` and
 * `services/sync-daemon/src/agentReporter.ts`'s local `AgentFacets` are
 * structurally assignable to this — neither type moves here, this is a new
 * narrower type they both already satisfy.
 */
export interface EnforcementFacets {
  /** Only `Array.isArray` and `.length` are read — element shape differs
   *  between the two producers' real facets types, so it is not narrowed
   *  further here. */
  mcp_tools?: readonly unknown[]
  guardrails?: {
    hook_gate?: boolean
    pcas?: boolean
  }
  harness?: {
    config_synced?: boolean
  }
}

/**
 * The four enforcement inputs `POST /api/v1/governance-coverage/snapshot`
 * (and `resolveEnforcementTier` on the control-plane side) expect.
 */
export interface GovernanceCoverageInputs {
  mcpProxyActive: boolean
  nativeHookActive: boolean
  llmProxyActive: boolean
  hasRulesFile: boolean
}

/**
 * Map reported facets onto the four enforcement inputs a harness's
 * enforcement tier is graded from. Pure function — no I/O, testable without
 * a DB or a running daemon.
 *
 * Every field is read with the same strictness the original control-plane
 * implementation used: `Array.isArray` (not just truthy) for `mcp_tools`,
 * and `=== true` (not merely truthy) for every guardrail/harness boolean —
 * a wrong mapping overstates enforcement, which is worse than an empty grid,
 * so a loosely-truthy value (e.g. `hook_gate: 'yes'`) must not pass.
 */
export function deriveEnforcementInputs(
  facets: EnforcementFacets | null | undefined,
): GovernanceCoverageInputs {
  const f = facets ?? {}
  return {
    // Tool calls are mediated only if the agent actually has MCP tools
    // routed through the governance proxy. An empty list means nothing to
    // mediate.
    mcpProxyActive: Array.isArray(f.mcp_tools) && f.mcp_tools.length > 0,
    // The daemon writes the hook gate for every harness it supports, so this
    // is a genuine "native hooks installed" signal rather than a constant.
    nativeHookActive: f.guardrails?.hook_gate === true,
    // pcas is set from the presence of a control-plane URL, i.e. LLM traffic
    // is being proxied through governance rather than going direct.
    llmProxyActive: f.guardrails?.pcas === true,
    // A synced harness config is the rules file being in place and
    // undrifted.
    hasRulesFile: f.harness?.config_synced === true,
  }
}
