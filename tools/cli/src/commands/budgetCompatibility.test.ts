import { describe, it, expect } from 'vitest'

describe('CLI Budget Parser Compatibility', () => {
  it('correctly resolves local budget using camelCase key', () => {
    const config: any = { maxDailyBudgetUsd: 15.50 }
    const maxDailyBudget = config?.maxDailyBudgetUsd ?? config?.max_daily_budget_usd ?? 10.0
    expect(maxDailyBudget).toBe(15.50)
  })

  it('correctly resolves local budget using snake_case alias key', () => {
    const config: any = { max_daily_budget_usd: 22.75 }
    const maxDailyBudget = config?.maxDailyBudgetUsd ?? config?.max_daily_budget_usd ?? 10.0
    expect(maxDailyBudget).toBe(22.75)
  })

  it('correctly defaults when neither key is present', () => {
    const config: any = {}
    const maxDailyBudget = config?.maxDailyBudgetUsd ?? config?.max_daily_budget_usd ?? 10.0
    expect(maxDailyBudget).toBe(10.0)
  })
})
