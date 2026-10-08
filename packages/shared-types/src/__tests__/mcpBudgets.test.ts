import { describe, expect, it } from 'vitest'

import {
  McpBudgetSettingsSchema,
  budgetWarnAt,
  budgetWindow,
  budgetsForCall,
  describeMcpBudget,
  parseMcpBudgetPolicy,
  type McpBudget,
} from '../mcpBudgets.js'

const server: McpBudget = { id: 'gh-hourly', scope: 'server', server: 'github', period: 'hour', limit: 100 }
const tool: McpBudget = { id: 'gh-issues', scope: 'tool', server: 'github', tool: 'create_issue', period: 'day', limit: 20 }
const eachMember: McpBudget = { id: 'per-dev', scope: 'member', period: 'day', limit: 500 }
const oneMember: McpBudget = { id: 'contractor', scope: 'member_server', server: 'postgres', memberId: 'mem_1', period: 'hour', limit: 5 }

describe('McpBudgetSettingsSchema', () => {
  it('accepts every scope written the way it is meant', () => {
    expect(McpBudgetSettingsSchema.safeParse({ budgets: [server, tool, eachMember, oneMember], warnAtPct: 75 }).success).toBe(true)
  })

  it.each([
    ['a server budget without a server', { id: 'a', scope: 'server', period: 'hour', limit: 1 }],
    ['a tool budget without a tool', { id: 'a', scope: 'tool', server: 's', period: 'hour', limit: 1 }],
    ['a member budget naming a server', { id: 'a', scope: 'member', server: 's', period: 'hour', limit: 1 }],
    ['a server budget naming a member', { id: 'a', scope: 'server', server: 's', memberId: 'm', period: 'hour', limit: 1 }],
    ['a zero limit', { id: 'a', scope: 'server', server: 's', period: 'hour', limit: 0 }],
    ['a fractional limit', { id: 'a', scope: 'server', server: 's', period: 'hour', limit: 1.5 }],
    ['a week period', { id: 'a', scope: 'server', server: 's', period: 'week', limit: 1 }],
    ['an id with a colon', { id: 'a:b', scope: 'server', server: 's', period: 'hour', limit: 1 }],
    ['an unknown field', { id: 'a', scope: 'server', server: 's', period: 'hour', limit: 1, cost: 2 }],
  ])('refuses %s', (_name, budget) => {
    expect(McpBudgetSettingsSchema.safeParse({ budgets: [budget] }).success).toBe(false)
  })

  it('refuses duplicate ids and an out-of-range warning percentage', () => {
    expect(McpBudgetSettingsSchema.safeParse({ budgets: [server, server] }).success).toBe(false)
    expect(McpBudgetSettingsSchema.safeParse({ budgets: [], warnAtPct: 100 }).success).toBe(false)
  })
})

describe('parseMcpBudgetPolicy', () => {
  it('keeps the valid budgets and drops a malformed one rather than all of them', () => {
    const policy = parseMcpBudgetPolicy({ budgets: [server, { id: 'bad', scope: 'server' }, tool, { ...tool }], warnAtPct: 60 })
    expect(policy).toEqual({ budgets: [server, tool], warnAtPct: 60 })
  })

  it('reads anything else as no budgets, warning at 80%', () => {
    for (const value of [undefined, null, [], 'x', { budgets: 'x' }]) {
      expect(parseMcpBudgetPolicy(value)).toEqual({ budgets: [], warnAtPct: 80 })
    }
  })
})

describe('budgetsForCall', () => {
  const policy = { budgets: [server, tool, eachMember, oneMember], warnAtPct: 80 }

  it('charges a call to every budget that covers it', () => {
    const charges = budgetsForCall(policy, { server: 'github', tool: 'create_issue', memberId: 'mem_2', fallbackCaller: 'key:vk_x' })
    expect(charges.map((c) => [c.budget.id, c.subject])).toEqual([
      ['gh-hourly', ''],
      ['gh-issues', ''],
      ['per-dev', 'mem_2'],
    ])
  })

  it('applies a one-member budget to that member only', () => {
    expect(budgetsForCall(policy, { server: 'postgres', tool: 'q', memberId: 'mem_1', fallbackCaller: '' }).map((c) => c.budget.id)).toEqual(['per-dev', 'contractor'])
    expect(budgetsForCall(policy, { server: 'postgres', tool: 'q', memberId: 'mem_2', fallbackCaller: '' }).map((c) => c.budget.id)).toEqual(['per-dev'])
  })

  it('counts an unidentified caller against the fallback identity', () => {
    const [charge] = budgetsForCall({ budgets: [eachMember], warnAtPct: 80 }, { server: 's', tool: 't', memberId: null, fallbackCaller: 'key:vk_abc' })
    expect(charge?.subject).toBe('key:vk_abc')
  })
})

describe('budget windows and thresholds', () => {
  it('aligns hours and days to UTC', () => {
    const now = Date.parse('2026-10-08T14:37:12.345Z')
    expect(budgetWindow('hour', now)).toEqual({ startMs: Date.parse('2026-10-08T14:00:00Z'), resetAtMs: Date.parse('2026-10-08T15:00:00Z') })
    expect(budgetWindow('day', now)).toEqual({ startMs: Date.parse('2026-10-08T00:00:00Z'), resetAtMs: Date.parse('2026-10-09T00:00:00Z') })
  })

  it('warns at the percentage rounded up, never below one call', () => {
    expect(budgetWarnAt(100, 80)).toBe(80)
    expect(budgetWarnAt(7, 80)).toBe(6)
    expect(budgetWarnAt(1, 10)).toBe(1)
  })

  it('describes each scope', () => {
    expect(describeMcpBudget(server)).toBe('calls to github: 100 per hour')
    expect(describeMcpBudget(tool)).toBe('calls to github › create_issue: 20 per day')
    expect(describeMcpBudget(eachMember)).toBe('MCP calls by each member: 500 per day')
    expect(describeMcpBudget(oneMember, 'dana@example.test')).toBe('calls to postgres by dana@example.test: 5 per hour')
  })
})
