import { describe, it, expect } from 'vitest'
import { DEFAULT_MAX_DAILY_BUDGET_USD, resolveLocalDailyBudget } from './budget.js'

/**
 * These cases used to re-type the `??` chain inline against an `any` config,
 * so they asserted a copy of the expression rather than the one `intutic
 * budget` runs — dropping the snake_case alias from budget.ts would not have
 * failed a single one. They now call the resolver the command itself calls,
 * and the config argument is typed, so a key renamed in `IntuticConfig` breaks
 * the build here instead of passing green.
 */
describe('CLI Budget Parser Compatibility', () => {
  it('correctly resolves local budget using camelCase key', () => {
    expect(resolveLocalDailyBudget({ maxDailyBudgetUsd: 15.50 })).toBe(15.50)
  })

  it('correctly resolves local budget using snake_case alias key', () => {
    expect(resolveLocalDailyBudget({ max_daily_budget_usd: 22.75 })).toBe(22.75)
  })

  it('prefers the camelCase key when a config carries both spellings', () => {
    expect(
      resolveLocalDailyBudget({ maxDailyBudgetUsd: 15.50, max_daily_budget_usd: 22.75 }),
    ).toBe(15.50)
  })

  it('correctly defaults when neither key is present', () => {
    expect(resolveLocalDailyBudget({})).toBe(DEFAULT_MAX_DAILY_BUDGET_USD)
    expect(DEFAULT_MAX_DAILY_BUDGET_USD).toBe(10.0)
  })

  it('defaults when there is no config file at all', () => {
    // `loadConfig()` returns null on a machine that has never run `intutic
    // init`; the command passes that straight through.
    expect(resolveLocalDailyBudget(null)).toBe(DEFAULT_MAX_DAILY_BUDGET_USD)
  })
})
