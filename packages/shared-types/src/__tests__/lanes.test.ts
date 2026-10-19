/**
 * Reversibility lanes: the shared lane vectors through
 * lanes.ts and, for the `frontMatter` group, the front-matter parser.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_TOKENS } from '../guardrailIr.js'
import { parseFrontMatterEnforcing } from '../guardrailRender.js'
import {
  CLOSABLE_LANES,
  TOKEN_CLASS,
  laneHoldPatterns,
  laneHoldRuleId,
  laneHoldTokens,
  laneOf,
  revertHoldRuleId,
  tokenLane,
  type LaneSop,
} from '../lanes.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the vectors are typed by use
const V = JSON.parse(readFileSync(join(__dirname, '../../fixtures/lane-vectors.json'), 'utf-8')) as any

describe('lane classes', () => {
  it('classes every action token, in ACTION_TOKENS order', () => {
    expect(Object.keys(TOKEN_CLASS)).toEqual([...ACTION_TOKENS])
    expect(TOKEN_CLASS).toEqual(V.classes)
    for (const t of ACTION_TOKENS) expect(tokenLane(t)).toBe(V.classes[t])
    expect(tokenLane('Bash')).toBeNull()
    expect(tokenLane('constructor')).toBeNull()
  })

  it('closes only irreversible and reversible_wide', () => {
    expect([...CLOSABLE_LANES]).toEqual(['irreversible', 'reversible_wide'])
  })

  it('takes the strongest class', () => {
    for (const c of V.laneOf) expect(laneOf(c.tokens), JSON.stringify(c.tokens)).toBe(c.lane)
  })
})

describe('lane holds', () => {
  it('unites SOP lanes, risk tier and workspace lanes, minus open_actions', () => {
    expect(V.laneHoldTokens.length).toBeGreaterThan(10)
    for (const c of V.laneHoldTokens) {
      expect(laneHoldTokens({ sops: c.sops as LaneSop[], workspaceLanes: c.workspaceLanes }), c.name).toEqual(c.tokens)
    }
  })

  it('reads the keys from front matter as the proxy does', () => {
    for (const c of V.frontMatter) {
      const fm = parseFrontMatterEnforcing(c.front)
      expect(laneHoldTokens({ sops: [{ closedLanes: fm.closedLanes, openActions: fm.openActions, riskTier: fm.riskTier }] }), c.name).toEqual(c.tokens)
      expect(fm.errors, c.name).toEqual(c.errors)
    }
  })

  it('compiles each token to the rules the vectors name, under one id', () => {
    for (const c of V.holdPatterns) {
      expect(laneHoldRuleId(c.token), c.token).toBe(c.id)
      expect(laneHoldPatterns(c.token), c.token).toEqual(c.patterns)
    }
    for (const [subject, id] of V.revertHoldIds) expect(revertHoldRuleId(subject)).toBe(id)
  })

  it('gives every closable token a phrase rule an older gate reads, or an action rule', () => {
    for (const t of ACTION_TOKENS) {
      const patterns = laneHoldPatterns(t)
      expect(patterns.length, t).toBeGreaterThan(0)
      for (const p of patterns) {
        expect(p.source, t).not.toMatch(/[\t\n\r]/)
        if (p.subject === 'phrase') for (const phrase of p.source.split('|')) expect(phrase.length, t).toBeGreaterThan(0)
      }
      if (TOKEN_CLASS[t] !== 'reversible_contained') expect(patterns.some((p) => p.subject === 'phrase'), t).toBe(true)
    }
  })
})
