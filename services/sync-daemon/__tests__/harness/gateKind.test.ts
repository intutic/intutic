/**
 * gateKind.test.ts — `gateKindForHarness` and its consistency with the
 * gate registry's own NO_GATE decisions.
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { HarnessType } from '@intutic/shared-types'
import {
  gateKindForHarness,
  SDK_GATED_HARNESSES,
  NO_GATE_HARNESSES,
  DELEGATED_GATE_HARNESSES,
} from '../../src/harness/gateKind.js'
import { GATES, NO_GATE } from './gateRegistry.js'

describe('gateKindForHarness', () => {
  it("classifies a hook-based harness (claude-code) as 'hook'", () => {
    expect(gateKindForHarness(HarnessType.CLAUDE_CODE)).toBe('hook')
  })

  it("classifies LangGraph and every Wave 1 SDK-gated framework as 'sdk'", () => {
    for (const h of [
      HarnessType.LANGGRAPH,
      HarnessType.LANGCHAIN,
      HarnessType.CREWAI,
      HarnessType.AUTOGEN,
      HarnessType.AG2,
      HarnessType.GOOGLE_ADK,
      HarnessType.OPENAI_AGENTS,
      HarnessType.PYDANTIC_AI,
      HarnessType.SMOLAGENTS,
      HarnessType.MASTRA,
      HarnessType.VERCEL_AI_SDK,
    ]) {
      expect(gateKindForHarness(h), h).toBe('sdk')
    }
  })

  it("classifies aider as 'none' — it has no tool-call gate at all", () => {
    expect(gateKindForHarness(HarnessType.AIDER)).toBe('none')
  })

  it("classifies xirp as 'delegated' — it wraps other already-gated harnesses", () => {
    expect(gateKindForHarness(HarnessType.XIRP)).toBe('delegated')
  })

  it('defaults to hook for every other known harness', () => {
    const other = Object.values(HarnessType).filter(
      (h) => !SDK_GATED_HARNESSES.has(h) && !NO_GATE_HARNESSES.has(h) && !DELEGATED_GATE_HARNESSES.has(h),
    )
    expect(other.length).toBeGreaterThan(10)
    for (const h of other) {
      expect(gateKindForHarness(h), h).toBe('hook')
    }
  })

  it('SDK_GATED_HARNESSES, NO_GATE_HARNESSES, and DELEGATED_GATE_HARNESSES do not overlap', () => {
    for (const h of SDK_GATED_HARNESSES) {
      expect(NO_GATE_HARNESSES.has(h), h).toBe(false)
      expect(DELEGATED_GATE_HARNESSES.has(h), h).toBe(false)
    }
    for (const h of NO_GATE_HARNESSES) {
      expect(DELEGATED_GATE_HARNESSES.has(h), h).toBe(false)
    }
  })

  it('is consistent with gateRegistry.ts: every sdk-kind harness has a file:null NO_GATE row', () => {
    // gateRegistry.ts is the authoritative per-harness decision (exercised by
    // generatedGateBehaviour.test.ts's completeness checks); this test-only
    // cross-check is what gateKind.ts's module doc promises keeps the two
    // from silently drifting apart, since gateKind.ts itself cannot import
    // the test-only registry at runtime.
    const noGateFileNull = new Set(NO_GATE.filter((n) => n.file === null).map((n) => n.harness))
    for (const h of SDK_GATED_HARNESSES) {
      expect(noGateFileNull.has(h), `${h} should have a file:null NO_GATE row`).toBe(true)
    }
  })

  it('is consistent with gateRegistry.ts: every delegated-kind harness has a file:null NO_GATE row', () => {
    const noGateFileNull = new Set(NO_GATE.filter((n) => n.file === null).map((n) => n.harness))
    for (const h of DELEGATED_GATE_HARNESSES) {
      expect(noGateFileNull.has(h), `${h} should have a file:null NO_GATE row`).toBe(true)
    }
  })

  it('is consistent with gateRegistry.ts: every none-kind harness is NOT in GATES', () => {
    const gateNames = new Set(GATES.map((g) => g.name))
    for (const h of NO_GATE_HARNESSES) {
      expect(gateNames.has(h), `${h} should not appear in GATES (it has no gate)`).toBe(false)
    }
  })

  it('is consistent with gateRegistry.ts: every delegated-kind harness is NOT in GATES', () => {
    // A delegated harness has no gate row of its own — the gate it benefits
    // from is credited to the harness that actually writes it (e.g. 'claudeCode'),
    // not duplicated under the delegating harness's own name.
    const gateNames = new Set(GATES.map((g) => g.name))
    for (const h of DELEGATED_GATE_HARNESSES) {
      expect(gateNames.has(h), `${h} should not appear in GATES (its gate is credited to the wrapped harness)`).toBe(false)
    }
  })
})
