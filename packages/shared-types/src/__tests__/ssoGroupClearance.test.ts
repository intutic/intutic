import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeSsoGroupRecord,
  encodeSsoGroupRecord,
  evaluateSsoGroupClearance,
  parseSsoGroupPolicy,
  ssoGroupRuleId,
  SSO_GROUP_RECORD_TAG,
} from '../ssoGroupClearance.js'

interface Vectors {
  policies: Record<string, unknown>
  cases: Array<{ name: string; policy: string; memberGroups: string[] | null; toolName: string; clearance: string; ruleId: string | null }>
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/sso-group-clearance-vectors.json'), 'utf8'),
)

describe('SSO-group clearance vectors', () => {
  it('reads a non-empty vector file covering all three clearances', () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(20)
    expect(new Set(VECTORS.cases.map((c) => c.clearance))).toEqual(new Set(['GRANTED', 'DENIED', 'REQUIRES_OBO']))
  })

  for (const c of VECTORS.cases) {
    it(c.name, () => {
      const d = evaluateSsoGroupClearance(parseSsoGroupPolicy(VECTORS.policies[c.policy]), c.toolName, c.memberGroups)
      expect(d.clearance).toBe(c.clearance)
      expect(d.ruleId).toBe(c.ruleId)
    })
  }
})

describe('evaluateSsoGroupClearance', () => {
  const policy = parseSsoGroupPolicy({ highRiskTools: ['create_issue'], requiredGroups: ['sre'], requireOboFor: ['mcp__gh__deploy'] })

  it('matches any of several names a call goes by, and names the rule by the one that matched', () => {
    expect(evaluateSsoGroupClearance(policy, ['deploy', 'mcp__gh__deploy'], ['sre'])).toMatchObject({
      clearance: 'REQUIRES_OBO',
      ruleId: 'sso_group.require_obo.mcp__gh__deploy',
    })
    expect(evaluateSsoGroupClearance(policy, ['create_issue', 'mcp__gh__create_issue'], [])).toMatchObject({
      clearance: 'DENIED',
      ruleId: 'sso_group.high_risk.create_issue',
    })
  })

  it('says why, and says when the groups are unknown rather than missing', () => {
    expect(evaluateSsoGroupClearance(policy, 'create_issue', ['eng']).reason).toBe(
      'SSO group policy: create_issue requires one of the SSO groups sre, and this member holds none of them',
    )
    expect(evaluateSsoGroupClearance(policy, 'create_issue', null).reason).toBe(
      'SSO group policy: create_issue requires one of the SSO groups sre, and this gate does not know the member\'s groups',
    )
    expect(evaluateSsoGroupClearance(policy, 'mcp__gh__deploy', ['sre']).reason).toBe(
      'SSO group policy: mcp__gh__deploy is on-behalf-of only, and a tool-call gate has no OBO token to present',
    )
    expect(evaluateSsoGroupClearance(policy, 'Read', null).reason).toBe('')
  })
})

describe('ssoGroupRuleId', () => {
  it('keeps the characters a rule id may carry and replaces the rest', () => {
    expect(ssoGroupRuleId('high_risk', 'mcp__git-hub__create.issue:v2')).toBe('sso_group.high_risk.mcp__git-hub__create.issue:v2')
    expect(ssoGroupRuleId('require_obo', 'run cmd/x')).toBe('sso_group.require_obo.run_cmd_x')
  })
})

describe('parseSsoGroupPolicy', () => {
  it('is null only for something that is not an object', () => {
    expect(parseSsoGroupPolicy(null)).toBeNull()
    expect(parseSsoGroupPolicy('x')).toBeNull()
    expect(parseSsoGroupPolicy([])).toBeNull()
    expect(parseSsoGroupPolicy({})).toEqual({ highRiskTools: [], requiredGroups: [], requireOboFor: [] })
  })
})

describe('the snapshot record', () => {
  it('round-trips the policy and the member, and refuses anything else', () => {
    const record = {
      policy: { highRiskTools: ['Bash'], requiredGroups: ['sre'], requireOboFor: [] },
      member: { memberId: 'mem_1', ssoGroups: ['sre', 'team\tx'] },
      issuedAt: '2026-10-08T00:00:00.000Z',
    }
    const line = encodeSsoGroupRecord(record)
    expect(line.startsWith(`${SSO_GROUP_RECORD_TAG}\t`)).toBe(true)
    expect(line.split('\t')).toHaveLength(2)
    expect(decodeSsoGroupRecord(line)).toEqual(record)
    expect(decodeSsoGroupRecord(encodeSsoGroupRecord({ ...record, member: null }))?.member).toBeNull()
    expect(decodeSsoGroupRecord('@sso_groups\tnot-base64-json')).toBeNull()
    expect(decodeSsoGroupRecord('sop.x\tblock\t-\ttool\tr\t (Bash) ')).toBeNull()
  })
})
