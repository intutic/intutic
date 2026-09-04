/**
 * The TypeScript reading of a predicate mirrors the guest's defaults and the
 * renderer's guards (LLD #71, Wave 7). The binary-level parity is pinned in
 * packages/wasm-sdk/__tests__/generatedRules.test.ts; this file pins the
 * semantics that do not need a compiler: absent fields read as the guest's
 * defaults, unknown is never "under the limit", an empty list is
 * unrestricted, and a predicate outside the vocabulary is refused rather
 * than read as "fires on nothing".
 */
import { describe, it, expect } from 'vitest'
import { compilePredicate, evaluatePredicate, predicateStringValues, PredicateError, type Predicate } from '../index.js'

const p = (all: Predicate['all']): Predicate => ({ all })

describe('evaluatePredicate', () => {
  it('reads an absent string as empty and an absent list as empty', () => {
    expect(evaluatePredicate(p([{ field: 'harness', op: 'equals', value: 'cursor' }]), {})).toBe(false)
    expect(evaluatePredicate(p([{ field: 'harness', op: 'notEquals', value: 'cursor' }]), {})).toBe(true)
    expect(evaluatePredicate(p([{ field: 'denied_tools', op: 'listEmpty' }]), {})).toBe(true)
    expect(evaluatePredicate(p([{ field: 'denied_tools', op: 'notContains', value: 'Bash' }]), {})).toBe(true)
  })

  it('never reads unknown (-1) as under the limit', () => {
    const under = p([{ field: 'graph_spend_usd', op: 'atMost', value: 10 }])
    expect(evaluatePredicate(under, {})).toBe(false)
    expect(evaluatePredicate(under, { graph_spend_usd: -1 })).toBe(false)
    expect(evaluatePredicate(under, { graph_spend_usd: 4 })).toBe(true)
    const over = p([{ field: 'graph_spend_usd', op: 'atLeast', value: 10 }])
    expect(evaluatePredicate(over, {})).toBe(false)
    expect(evaluatePredicate(over, { graph_spend_usd: 50 })).toBe(true)
  })

  it('a plain numeric has no unknown sentinel: absent reads as 0', () => {
    expect(evaluatePredicate(p([{ field: 'depth', op: 'atMost', value: 2 }]), {})).toBe(true)
    expect(evaluatePredicate(p([{ field: 'depth', op: 'atLeast', value: 1 }]), {})).toBe(false)
    expect(evaluatePredicate(p([{ field: 'budget_remaining_usd', op: 'atLeast', value: 50 }]), { budget_remaining_usd: 50 })).toBe(true)
    expect(evaluatePredicate(p([{ field: 'budget_remaining_usd', op: 'atLeast', value: 50 }]), { budget_remaining_usd: 50.5 })).toBe(true)
  })

  it('exceedsField needs both sides known and a non-zero budget', () => {
    const over = p([{ field: 'graph_spend_usd', op: 'exceedsField', value: 'graph_budget_usd' }])
    expect(evaluatePredicate(over, { graph_spend_usd: 12, graph_budget_usd: 10 })).toBe(true)
    expect(evaluatePredicate(over, { graph_spend_usd: 12, graph_budget_usd: 0 })).toBe(false)
    expect(evaluatePredicate(over, { graph_spend_usd: 12 })).toBe(false)
    expect(evaluatePredicate(over, { graph_budget_usd: 10 })).toBe(false)
    expect(evaluatePredicate(over, { graph_spend_usd: 9, graph_budget_usd: 10 })).toBe(false)
  })

  it('distinguishes this turn from the whole session', () => {
    const turn = p([{ field: 'new_tool_calls', op: 'contains', value: 'terraform' }])
    const session = p([{ field: 'tool_sequence', op: 'contains', value: 'terraform' }])
    const ctx = { tool_sequence: ['terraform', 'Read'], new_tool_calls: ['Read'] }
    expect(evaluatePredicate(turn, ctx)).toBe(false)
    expect(evaluatePredicate(session, ctx)).toBe(true)
  })

  it('ANDs its conditions and reads a wrong-typed field as the default', () => {
    const both = p([
      { field: 'harness', op: 'equals', value: 'cursor' },
      { field: 'tool_contract_changed', op: 'isTrue' },
    ])
    expect(evaluatePredicate(both, { harness: 'cursor', tool_contract_changed: true })).toBe(true)
    expect(evaluatePredicate(both, { harness: 'cursor', tool_contract_changed: 'yes' })).toBe(false)
    expect(evaluatePredicate(both, { harness: 42, tool_contract_changed: true })).toBe(false)
  })
})

describe('compilePredicate', () => {
  it('validates once and refuses anything outside the vocabulary', () => {
    expect(() => compilePredicate({ all: [{ field: 'prompt', op: 'equals', value: 'x' }] })).toThrow(PredicateError)
    expect(() => compilePredicate({ all: [] })).toThrow(PredicateError)
    expect(() => compilePredicate(null)).toThrow(PredicateError)
    const fires = compilePredicate({ all: [{ field: 'agent_role', op: 'equals', value: 'contractor' }] })
    expect(fires({ agent_role: 'contractor' })).toBe(true)
    expect(fires({ agent_role: 'staff' })).toBe(false)
  })
})

describe('predicateStringValues', () => {
  it('names every string literal a citation must ground, and never a field name', () => {
    const values = predicateStringValues(
      p([
        { field: 'harness', op: 'equals', value: 'cursor' },
        { field: 'new_tool_calls', op: 'contains', value: 'terraform' },
        { field: 'graph_spend_usd', op: 'exceedsField', value: 'graph_budget_usd' },
        { field: 'depth', op: 'atLeast', value: 3 },
        { field: 'harness', op: 'notEquals', value: 'cursor' },
      ]),
    )
    expect(values).toEqual(['cursor', 'terraform'])
  })
})
