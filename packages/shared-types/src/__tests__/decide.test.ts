/**
 * Decide rules against the shared vectors, `fixtures/decide-vectors.json`.
 * The proxy (`tests/decide_vectors_test.rs`) and the Python gate
 * (`tests/test_decide_vectors.py`) run the same file and must reach the same
 * answers, reason text included.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bandValue,
  canonicalWhen,
  choiceAtoms,
  choiceOrders,
  decideCallOutcome,
  decideHashInput,
  decideRuleHash,
  decideRuleOutcome,
  kAnd,
  kNot,
  kOr,
  parseDecideLine,
  selectDecideRules,
  validateDecideRule,
  type DecideBand,
  type DecideCandidate,
  type DecideCombiner,
  type DecideRule,
  type DecideRuleResult,
  type Tri,
} from '../decide.js'
import { canonicalizeIr, irTokens, MAX_HOOK_TOOLS, MAX_TITLE_CHARS, TOOL_TOKEN_RE, validateGuardrailIr, type GuardrailIr } from '../guardrailIr.js'
import { isEnforceableFrontMatter, parseFrontMatterEnforcing, renderDecideFrontMatterLine } from '../guardrailRender.js'

interface ValidateCase {
  name: string
  raw?: string
  rule?: unknown
  expect: { ok: true; when: string } | { ok: false; id: string | null; error: string }
}
interface HashCase {
  name: string
  rule: DecideRule
  input: string
  ruleHash: string
  sameAs?: string
  differsFrom?: string
}
interface Vectors {
  layers: Record<string, string[]>
  validate: ValidateCase[]
  hash: HashCase[]
  compose: {
    kleene: Array<{ a: Tri; b: Tri; and: Tri; or: Tri; notA: Tri }>
    band: Array<{ p: number; band: DecideBand; value: Tri }>
    orders: Array<{ n: number; orders: number[][] }>
    choice: Array<{ name: string; options: string[]; perOrder: Array<Record<string, number>>; band: DecideBand; atoms: Record<string, { p: number; spread: number; value: Tri }> }>
    rule: Array<{
      name: string
      rule: DecideRule
      answers: Record<string, { p?: number; perOrder?: Array<Record<string, number>> }>
      combiner?: DecideCombiner
      expect: { value: Tri; outcome: string; code: string | null; via: string | null; score?: number | null }
    }>
    call: Array<{ name: string; tool: string; candidates: DecideCandidate[]; results: DecideRuleResult[]; expect: Record<string, unknown> }>
  }
  frontMatter: Array<{ name: string; front: string; expect: Array<{ rule: string; ruleHash: string } | { unreadable: { id: string | null; error: string } }> }>
}

const V = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/decide-vectors.json'), 'utf8')) as Vectors
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('decide vectors', () => {
  it('this layer has cases for every group it claims', () => {
    for (const [group, layers] of Object.entries(V.layers)) {
      if (!layers.includes('ts')) continue
      const cases = (V as unknown as Record<string, unknown>)[group]
      const n = Array.isArray(cases) ? cases.length : Object.values(cases as Record<string, unknown[]>).reduce((s, c) => s + c.length, 0)
      expect(n, group).toBeGreaterThan(0)
    }
    expect(V.validate.length).toBeGreaterThanOrEqual(100)
  })

  describe('validate', () => {
    it.each(V.validate.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const d = parseDecideLine(c.raw ?? JSON.stringify(c.rule))
      const got = d.kind === 'rule' ? { ok: true, when: canonicalWhen(d.expr) } : { ok: false, id: d.id, error: d.error }
      expect(got).toEqual(c.expect)

      // validateGuardrailIr answers a decide IR with the same reason, and its
      // zod schema agrees that a valid rule is one.
      if (c.rule !== null && typeof c.rule === 'object' && !Array.isArray(c.rule)) {
        const ir = validateGuardrailIr({ kind: 'decide', ...(c.rule as object) })
        if (c.expect.ok) expect(ir).toMatchObject({ ok: true })
        else if (c.name !== 'kind on the line') expect(ir).toEqual({ ok: false, reason: c.expect.error })
      }
    })
  })

  describe('hash', () => {
    const byName = new Map(V.hash.map((c) => [c.name, c]))
    it.each(V.hash.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      expect(validateDecideRule(c.rule).ok).toBe(true)
      expect(decideHashInput(c.rule)).toBe(c.input)
      expect(decideRuleHash(c.rule, sha256)).toBe(c.ruleHash)
      expect(canonicalizeIr({ kind: 'decide', ...c.rule } as GuardrailIr)).toBe(c.input)
      if (c.sameAs) expect(c.ruleHash).toBe(byName.get(c.sameAs)!.ruleHash)
      if (c.differsFrom) expect(c.ruleHash).not.toBe(byName.get(c.differsFrom)!.ruleHash)
    })

    it('pins the LLD worked example', () => {
      expect(byName.get('the LLD example')!.ruleHash).toBe('be5cbda58b93cf90e90d1b994c32331b05459aefba564ab9e2d190396a1b3291')
    })
  })

  describe('compose', () => {
    it('Kleene', () => {
      expect(V.compose.kleene).toHaveLength(9)
      for (const r of V.compose.kleene) {
        expect([kAnd(r.a, r.b), kOr(r.a, r.b), kNot(r.a)], `${r.a} ${r.b}`).toEqual([r.and, r.or, r.notA])
      }
    })

    it('bands', () => {
      for (const r of V.compose.band) expect(bandValue(r.p, r.band), `${r.p}`).toBe(r.value)
    })

    it('choice orders', () => {
      for (const r of V.compose.orders) expect(choiceOrders(r.n), `${r.n}`).toEqual(r.orders)
    })

    it.each(V.compose.choice.map((c) => [c.name, c] as const))('choice: %s', (_name, c) => {
      expect(choiceAtoms(c.options, c.perOrder, c.band)).toEqual(c.atoms)
    })

    it.each(V.compose.rule.map((c) => [c.name, c] as const))('rule: %s', (_name, c) => {
      const v = validateDecideRule(c.rule)
      if (!v.ok) throw new Error(v.reason)
      const got = decideRuleOutcome(v.rule, v.expr, c.answers, c.combiner)
      expect({ value: got.value, outcome: got.outcome, code: got.code, via: got.via }).toEqual({
        value: c.expect.value,
        outcome: c.expect.outcome,
        code: c.expect.code,
        via: c.expect.via,
      })
      if (c.expect.score != null) expect(Math.abs(got.score! - c.expect.score)).toBeLessThan(1e-9)
      else expect(got.score).toBeNull()
    })

    it.each(V.compose.call.map((c) => [c.name, c] as const))('call: %s', (_name, c) => {
      const sel = selectDecideRules(c.candidates, c.tool)
      const out = decideCallOutcome(sel, c.results)
      expect({ evaluate: sel.evaluate.map((x) => x.ref), skipped: sel.skipped.map((x) => x.ref), ...out }).toEqual(c.expect)
    })
  })

  describe('front matter', () => {
    it.each(V.frontMatter.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const fm = parseFrontMatterEnforcing(c.front)
      const got = fm.decide.map((d) => (d.kind === 'rule' ? { rule: d.rule.id, ruleHash: decideRuleHash(d.rule, sha256) } : { unreadable: { id: d.id, error: d.error } }))
      expect(got).toEqual(c.expect)
    })
  })
})

describe('decide in the guardrail IR', () => {
  const lld = V.hash.find((c) => c.name === 'the LLD example')!.rule

  it('keeps its own copies of the IR limits equal to guardrailIr.ts', () => {
    const src = readFileSync(join(import.meta.dirname, '../decide.ts'), 'utf8')
    expect(src).toContain(`const TOOL_TOKEN = /${TOOL_TOKEN_RE.source}/\n`)
    expect(src).toContain(`const MAX_TOOLS = ${MAX_HOOK_TOOLS}\n`)
    expect(src).toContain(`const MAX_TITLE = ${MAX_TITLE_CHARS}\n`)
  })

  it('renders one byte-stable line that parses back to the rule', () => {
    const line = renderDecideFrontMatterLine(lld)
    expect(line.startsWith('decide: {"id":"prod-data-export","on":"tool_call","tools":["Bash"],"questions":{"dest":')).toBe(true)
    expect(line).not.toContain('\n')
    const fm = parseFrontMatterEnforcing(`deny_tools: WebFetch\n${line}`)
    expect(fm.decide).toHaveLength(1)
    const back = fm.decide[0]!
    expect(back.kind).toBe('rule')
    if (back.kind !== 'rule') return
    expect(back.rule).toEqual(lld)
    expect(renderDecideFrontMatterLine(back.rule)).toBe(line)
    expect(renderDecideFrontMatterLine({ ...lld, kind: 'decide' } as DecideRule)).toBe(line)
  })

  it('counts a decide line, readable or not, as enforceable front matter', () => {
    expect(isEnforceableFrontMatter(parseFrontMatterEnforcing(renderDecideFrontMatterLine(lld)))).toBe(true)
    expect(isEnforceableFrontMatter(parseFrontMatterEnforcing('decide:'))).toBe(true)
    expect(isEnforceableFrontMatter(parseFrontMatterEnforcing('mode: shadow'))).toBe(false)
  })

  it('names its tools as the IR tokens', () => {
    const v = validateGuardrailIr({ kind: 'decide', ...lld })
    if (!v.ok) throw new Error(v.reason)
    expect(irTokens(v.ir)).toEqual(['Bash'])
  })
})
