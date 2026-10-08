import { CircuitBreakerOptions } from './types'
import { ClawdeVerdictError } from './errors'

export class CircuitBreaker {
  private client: any

  constructor(client: any) {
    this.client = client
  }

  public wrap<T>(
    toolName: string,
    options: CircuitBreakerOptions = {}
  ): (fn: () => Promise<T>) => Promise<T> {
    const failOpen = options.failOpen ?? false

    return async (fn: () => Promise<T>): Promise<T> => {
      // 1. Pre-check: workspace budget, when asked for. `failOpen` covers a
      // check that could not be made; a check that answered "no budget" is a
      // verdict and refuses either way, or the breaker would let every call
      // through exactly when the budget is gone.
      if (options.requireBudget || options.maxCostUsd !== undefined) {
        let budget: { allowed: boolean; remaining_usd?: number } | null = null
        try {
          budget = await this.client.checkBudget('default', 1)
        } catch (err: any) {
          if (!failOpen) {
            throw err
          }
          if (process.env.INTUTIC_DEBUG === 'true') {
            console.warn(`[Clawde SDK] Circuit breaker pre-check failed (failing open): ${err.message}`)
          }
        }
        if (budget && !budget.allowed) {
          throw new ClawdeVerdictError('kill', `Circuit breaker tripped for tool '${toolName}': budget exceeded. Remaining: $${budget.remaining_usd}`)
        }
      }

      // 2. Run the function. A refusal from chat() arrives as a thrown
      // ClawdeBlockedError, so fail-closed needs nothing beyond rethrowing.
      try {
        return await fn()
      } catch (err: any) {
        if (!failOpen) {
          throw err
        }
        if (process.env.INTUTIC_DEBUG === 'true') {
          console.warn(`[Clawde SDK] Circuit breaker execution failed (failing open): ${err.message}`)
        }
        return null as any // Fail open returns null or empty
      }
    }
  }
}
