import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from '../src/circuit-breaker'
import { ClawdeBlockedError, ClawdeVerdictError } from '../src/errors'

describe('circuit-breaker', () => {
  it('allows execution when budget check permits it', async () => {
    let checkBudgetCalls = 0
    const dummyClient = {
      checkBudget: async (model: string, tokens: number) => {
        checkBudgetCalls++
        return { allowed: true, remaining_usd: 100.0 }
      },
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { maxCostUsd: 5.0 })

    const result = await run(async () => {
      return { status: 'success', verdict: 'allow' }
    })

    expect(result).toEqual({ status: 'success', verdict: 'allow' })
    expect(checkBudgetCalls).toBe(1)
  })

  it('throws ClawdeVerdictError when budget check returns allowed = false', async () => {
    const dummyClient = {
      checkBudget: async () => ({ allowed: false, remaining_usd: 0.0, reason: 'Budget limit hit' }),
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { maxCostUsd: 5.0, failOpen: false })

    await expect(run(async () => 'hello')).rejects.toThrow(ClawdeVerdictError)
  })

  it('fails open when failOpen is configured true', async () => {
    const dummyClient = {
      checkBudget: async () => ({ allowed: false, remaining_usd: 0.0, reason: 'Budget limit hit' }),
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { maxCostUsd: 5.0, failOpen: true })

    const result = await run(async () => 'fallback-allowed')
    expect(result).toBe('fallback-allowed')
  })

  it('runs the budget check for requireBudget, and skips it without an option asking', async () => {
    let checkBudgetCalls = 0
    const dummyClient = {
      checkBudget: async () => {
        checkBudgetCalls++
        return { allowed: false, remaining_usd: 0.0 }
      },
    }
    const breaker = new CircuitBreaker(dummyClient)

    await expect(breaker.wrap('some_action', { requireBudget: true })(async () => 'x')).rejects.toThrow(ClawdeVerdictError)
    expect(checkBudgetCalls).toBe(1)

    expect(await breaker.wrap<string>('some_action')(async () => 'ran')).toBe('ran')
    expect(checkBudgetCalls).toBe(1)
  })

  it('rethrows a proxy refusal when failOpen is false', async () => {
    const breaker = new CircuitBreaker({ checkBudget: async () => ({ allowed: true, remaining_usd: 10.0 }) })
    const run = breaker.wrap('some_action', { failOpen: false })

    await expect(run(async () => {
      throw new ClawdeBlockedError('kill', 'policy_denied', 403, 'Request blocked')
    })).rejects.toThrow(ClawdeBlockedError)
  })
})
