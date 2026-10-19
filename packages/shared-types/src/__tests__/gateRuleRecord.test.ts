/**
 * The `@rule` snapshot record, its fallback line, and Tier R:
 * the shared vectors through the module and through the JavaScript source
 * the hook gates embed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeSnapshotFormatRecord } from '../decideRecord.js'
import { parseFrontMatterEnforcing } from '../guardrailRender.js'
import { PHRASES_JS_SOURCE } from '../phrases.js'
import { SCOPE_MATCH_JS_SOURCE } from '../scopeMatch.js'
import { TEST_OUTCOME_JS_SOURCE } from '../testOutcome.js'
import * as rules from '../gateRuleRecord.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/rule-record-vectors.json'), 'utf-8')) as any
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

type Api = Pick<typeof rules, 'decodeGateRuleRecord' | 'gateRuleFallback' | 'evaluateGateRuleRecords' | 'gateRulePlanFromResponse'>
const EMITTED = new Function(
  `${PHRASES_JS_SOURCE}\n${TEST_OUTCOME_JS_SOURCE}\n${SCOPE_MATCH_JS_SOURCE}\n${rules.RULE_RECORD_JS_SOURCE}\nreturn { decodeGateRuleRecord, gateRuleFallback, evaluateGateRuleRecords, gateRulePlanFromResponse }`,
)() as Api

describe.each([
  ['the module', rules as Api],
  ['the emitted source', EMITTED],
] as const)('rule records through %s', (_label, api) => {
  it('decodes every valid record', () => {
    for (const c of V.valid) expect(api.decodeGateRuleRecord(c.line), c.name).toEqual(c.record)
  })

  it('refuses every damaged one', () => {
    expect(V.damaged.length).toBeGreaterThan(30)
    for (const c of V.damaged) expect(api.decodeGateRuleRecord(c.line), c.name).toBeNull()
  })

  it('names the fallback line an older gate refuses with', () => {
    for (const c of V.fallbacks) expect(api.gateRuleFallback(c.record), c.name).toEqual(c.fallback)
  })

  it('reads the session plan from the plans API', () => {
    for (const c of V.planResponse) expect(api.gateRulePlanFromResponse(c.status, c.body), c.name).toEqual(c.plan)
  })

  it('decides calls in Tier R', () => {
    expect(V.evaluate.length).toBeGreaterThan(25)
    for (const c of V.evaluate) expect(api.evaluateGateRuleRecords(c.records, c.call), c.name).toEqual({ refusal: c.refusal, shadow: c.shadow })
  })
})

describe('the writer', () => {
  it('encodes every valid record to its line', () => {
    for (const c of V.valid) expect(rules.encodeGateRuleRecord(c.record), c.name).toBe(c.line)
  })

  it('converts to and from the shape policy resolve serves', () => {
    for (const c of V.served) {
      expect(rules.toServedGateRecord(c.record, c.sopId)).toEqual(c.served)
      expect(rules.fromServedGateRecord(c.served)).toEqual(c.record)
    }
    const broken = { ...V.served[0].served, payload: { ...V.served[0].served.payload, kind: 'requires_outcome' } }
    expect(rules.fromServedGateRecord(broken)).toBeNull()
    expect(rules.fromServedGateRecord({ ...V.served[0].served, fallbackId: null })).toBeNull()
  })

  it('writes format 3', () => {
    expect(rules.RULE_SNAPSHOT_FORMAT).toBe(V.format)
    expect(decodeSnapshotFormatRecord(`@format\t${rules.RULE_SNAPSHOT_FORMAT}`)).toBe(3)
  })

  it('compiles a SOP to its records and fallback lines', () => {
    for (const c of V.compile) {
      const got = rules.compileSopGateRecords(c.entry, parseFrontMatterEnforcing(c.front), sha)
      expect(got.records, c.name).toEqual(c.records)
      expect(got.fallbacks.map((f) => f.id), c.name).toEqual(c.fallbackIds)
      // Every record round-trips, and every enforcing one names its fallback line.
      for (const r of got.records) expect(rules.decodeGateRuleRecord(rules.encodeGateRuleRecord(r)), c.name).toEqual(r)
      // Portable ERE, as the snapshot writer requires: no \s, no (?, no anchors.
      for (const f of got.fallbacks) expect(f.source.replace(/\[\^/g, '['), c.name).not.toMatch(/\\s|\(\?|\^|\$/)
    }
  })

  it('names refs and fallback ids as the record format says', () => {
    expect(rules.gateRuleRef('sop', 'scope_paths', 1)).toBe('sop#scope_paths:1')
    expect(rules.gateRuleFallbackId('plan_approval', 2, 'sop', sha)).toBe(`plan_approval-fallback:2@${sha('sop').slice(0, 12)}`)
  })
})
