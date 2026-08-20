/**
 * governanceCoverage.ts — pin the enforcement-input mapping (TD-443).
 *
 * These mirror the four "enforcement input derivation" cases in
 * `services/control-plane/__tests__/unit/harnessGradeSweep.test.ts` (the
 * original home of this logic before it moved here), adapted to call
 * `deriveEnforcementInputs` directly rather than through
 * `resolveEnforcementTier` — that helper stays in
 * `services/control-plane/src/services/harnessGradeService.ts` and is not
 * something this leaf package can depend on.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { deriveEnforcementInputs } from '../governanceCoverage.js'

describe('deriveEnforcementInputs', () => {
  it('treats absent facets as ungoverned rather than defaulting to enforced', () => {
    for (const facets of [undefined, null, {}]) {
      const inputs = deriveEnforcementInputs(facets)
      expect(inputs).toEqual({
        mcpProxyActive: false,
        nativeHookActive: false,
        llmProxyActive: false,
        hasRulesFile: false,
      })
    }
  })

  it('requires at least one MCP tool before claiming tool calls are mediated', () => {
    expect(deriveEnforcementInputs({ mcp_tools: [] }).mcpProxyActive).toBe(false)
    expect(
      deriveEnforcementInputs({ mcp_tools: [{ server: 'fs', tool: 'read' }] }).mcpProxyActive,
    ).toBe(true)
  })

  it('reads each guardrail strictly — a truthy non-true value must not pass', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose: any = { guardrails: { hook_gate: 'yes', pcas: 1 }, harness: { config_synced: 'y' } }
    const inputs = deriveEnforcementInputs(loose)
    expect(inputs.nativeHookActive).toBe(false)
    expect(inputs.llmProxyActive).toBe(false)
    expect(inputs.hasRulesFile).toBe(false)
  })

  it('maps a fully-governed agent to every input true', () => {
    const inputs = deriveEnforcementInputs({
      mcp_tools: [{ server: 'fs', tool: 'read' }],
      guardrails: { hook_gate: true, pcas: true },
      harness: { config_synced: true },
    })
    expect(inputs).toEqual({
      mcpProxyActive: true,
      nativeHookActive: true,
      llmProxyActive: true,
      hasRulesFile: true,
    })
  })
})
