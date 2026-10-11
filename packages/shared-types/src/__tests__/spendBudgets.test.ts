import { describe, expect, it } from 'vitest'

import { UpdateApiKeyInputSchema } from '../auth.js'
import {
  KeyRateLimitSchema,
  SpendBudgetListSchema,
  describeSpendBudget,
  spendBudgetWindow,
} from '../spendBudgets.js'

describe('SpendBudgetListSchema', () => {
  it('accepts a day and a month budget, and defaults enforcement to hard', () => {
    const parsed = SpendBudgetListSchema.parse([
      { period: 'day', limitUsd: 5 },
      { period: 'month', limitUsd: 100, enforcement: 'soft' },
    ])
    expect(parsed).toEqual([
      { period: 'day', limitUsd: 5, enforcement: 'hard' },
      { period: 'month', limitUsd: 100, enforcement: 'soft' },
    ])
  })

  it.each([
    ['two budgets for one period', [{ period: 'day', limitUsd: 1 }, { period: 'day', limitUsd: 2 }]],
    ['a zero limit', [{ period: 'day', limitUsd: 0 }]],
    ['a week period', [{ period: 'week', limitUsd: 1 }]],
    ['an unknown enforcement', [{ period: 'day', limitUsd: 1, enforcement: 'warn' }]],
    ['an unknown field', [{ period: 'day', limitUsd: 1, scope: 'key' }]],
  ])('refuses %s', (_name, list) => {
    expect(SpendBudgetListSchema.safeParse(list).success).toBe(false)
  })
})

describe('KeyRateLimitSchema', () => {
  it('takes whole numbers or null for each limit', () => {
    expect(KeyRateLimitSchema.parse({ rpm: 60, tpm: null })).toEqual({ rpm: 60, tpm: null })
    expect(KeyRateLimitSchema.safeParse({ rpm: 1.5 }).success).toBe(false)
    expect(KeyRateLimitSchema.safeParse({ rpm: 0 }).success).toBe(false)
    expect(KeyRateLimitSchema.safeParse({ rps: 1 }).success).toBe(false)
  })
})

describe('UpdateApiKeyInputSchema', () => {
  it('needs budgets or a rate limit', () => {
    expect(UpdateApiKeyInputSchema.safeParse({}).success).toBe(false)
    expect(UpdateApiKeyInputSchema.safeParse({ budgets: [] }).success).toBe(true)
    expect(UpdateApiKeyInputSchema.safeParse({ rateLimit: { rpm: null } }).success).toBe(true)
  })
})

describe('spendBudgetWindow', () => {
  const t = Date.UTC(2026, 9, 9, 23, 59, 30) // 2026-10-09T23:59:30Z

  it('puts a day on its UTC date and resets at the next midnight', () => {
    const w = spendBudgetWindow('day', t)
    expect(w.id).toBe('2026-10-09')
    expect(new Date(w.startMs).toISOString()).toBe('2026-10-09T00:00:00.000Z')
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-10-10T00:00:00.000Z')
  })

  it('rolls over at midnight UTC', () => {
    expect(spendBudgetWindow('day', t + 30_000).id).toBe('2026-10-10')
  })

  it('puts a month on its UTC month and resets on the 1st, across a year end', () => {
    const w = spendBudgetWindow('month', t)
    expect(w.id).toBe('2026-10')
    expect(new Date(w.resetAtMs).toISOString()).toBe('2026-11-01T00:00:00.000Z')
    const dec = spendBudgetWindow('month', Date.UTC(2026, 11, 31, 12))
    expect(dec.id).toBe('2026-12')
    expect(new Date(dec.resetAtMs).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('describeSpendBudget', () => {
  it('names whose budget it is, its enforcement and its size', () => {
    expect(describeSpendBudget('key', { period: 'day', limitUsd: 5, enforcement: 'hard' }, 'vk_abc')).toBe(
      'Key vk_abc hard budget: $5.00 per day',
    )
    expect(describeSpendBudget('member', { period: 'month', limitUsd: 200, enforcement: 'soft' }, 'default')).toBe(
      'Member soft budget: $200.00 per month',
    )
    expect(describeSpendBudget('workspace', { period: 'month', limitUsd: 1000, enforcement: 'hard' })).toBe(
      'Workspace hard budget: $1000.00 per month',
    )
  })
})
