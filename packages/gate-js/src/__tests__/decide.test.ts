/**
 * Decide rules in the gate SDK: this package carries a byte-identical copy of
 * the shared module, and runs the shared vectors through it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bandValue, choiceAtoms, choiceOrders, decideCallOutcome, decideRuleOutcome, kAnd, kNot, kOr, parseDecideLine, selectDecideRules, validateDecideRule } from '../decide.js'

const FIXTURES = join(__dirname, '../../../shared-types/fixtures')
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed by the shared-types test; only replayed here
const V = JSON.parse(readFileSync(join(FIXTURES, 'decide-vectors.json'), 'utf-8')) as any

it('carries a byte-identical copy of the shared decide module', () => {
  expect(readFileSync(join(__dirname, '../decide.ts'), 'utf-8')).toBe(readFileSync(join(__dirname, '../../../shared-types/src/decide.ts'), 'utf-8'))
})

describe('the shared vectors, through this copy', () => {
  it('validates every line as the vectors say', () => {
    expect(V.validate.length).toBeGreaterThan(0)
    for (const c of V.validate) {
      const d = parseDecideLine(c.raw ?? JSON.stringify(c.rule))
      expect(d.kind === 'rule' ? { ok: true } : { ok: false, error: d.error }, c.name).toEqual(c.expect.ok ? { ok: true } : { ok: false, error: c.expect.error })
    }
  })

  it('composes as the vectors say', () => {
    for (const r of V.compose.kleene) expect([kAnd(r.a, r.b), kOr(r.a, r.b), kNot(r.a)]).toEqual([r.and, r.or, r.notA])
    for (const r of V.compose.band) expect(bandValue(r.p, r.band)).toBe(r.value)
    for (const r of V.compose.orders) expect(choiceOrders(r.n)).toEqual(r.orders)
    for (const c of V.compose.choice) expect(choiceAtoms(c.options, c.perOrder, c.band), c.name).toEqual(c.atoms)
    for (const c of V.compose.rule) {
      const v = validateDecideRule(c.rule)
      if (!v.ok) throw new Error(v.reason)
      const got = decideRuleOutcome(v.rule, v.expr, c.answers, c.combiner)
      expect({ value: got.value, outcome: got.outcome, code: got.code, via: got.via }, c.name).toEqual({
        value: c.expect.value,
        outcome: c.expect.outcome,
        code: c.expect.code,
        via: c.expect.via,
      })
    }
    for (const c of V.compose.call) {
      const sel = selectDecideRules(c.candidates, c.tool)
      const refs = (xs: Array<{ ref: string }>) => xs.map((x) => x.ref)
      expect({ evaluate: refs(sel.evaluate), skipped: refs(sel.skipped), ...decideCallOutcome(sel, c.results) }, c.name).toEqual(c.expect)
    }
  })
})
