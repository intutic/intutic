import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from '../src/circuit-breaker'
import { ClawdeVerdictError } from '../src/errors'

describe('circuit-breaker', () => {
  it('allows execution when budget check permits it', async () => {
    let checkBudgetCalls = 0
    const dummyClient = {
      resolveContext: async () => ({ workspaceId: 'ws_ok' }),
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
      resolveContext: async () => ({}),
      checkBudget: async () => ({ allowed: false, remaining_usd: 0.0, reason: 'Budget limit hit' }),
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { maxCostUsd: 5.0, failOpen: false })

    await expect(run(async () => 'hello')).rejects.toThrow(ClawdeVerdictError)
  })

  it('fails open when failOpen is configured true', async () => {
    const dummyClient = {
      resolveContext: async () => ({}),
      checkBudget: async () => ({ allowed: false, remaining_usd: 0.0, reason: 'Budget limit hit' }),
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { maxCostUsd: 5.0, failOpen: true })

    const result = await run(async () => 'fallback-allowed')
    expect(result).toBe('fallback-allowed')
  })

  it('blocks when response verdict is KILL and failOpen is false', async () => {
    const dummyClient = {
      resolveContext: async () => ({}),
      checkBudget: async () => ({ allowed: true, remaining_usd: 10.0 }),
    }

    const breaker = new CircuitBreaker(dummyClient)
    const run = breaker.wrap('some_action', { failOpen: false })

    await expect(run(async () => {
      return { verdict: 'kill', content: 'unsafe response' }
    })).rejects.toThrow(ClawdeVerdictError)
  })
})
