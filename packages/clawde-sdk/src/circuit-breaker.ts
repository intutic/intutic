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
      // 1. Pre-Check: Context & pre-flight budget validation
      try {
        const context = await this.client.resolveContext()
        // If maxCostUsd is specified, check against current budget limit or remaining
        if (options.maxCostUsd !== undefined) {
          // Pre-flight check
          const budget = await this.client.checkBudget('default', 1)
          if (!budget.allowed) {
            throw new ClawdeVerdictError('kill', `Circuit breaker tripped for tool '${toolName}': budget exceeded. Remaining: $${budget.remaining_usd}`)
          }
        }
      } catch (err: any) {
        if (!failOpen) {
          throw err
        }
        // If failOpen is true, we log the error and continue execution
        if (process.env.INTUTIC_DEBUG === 'true') {
          console.warn(`[Clawde SDK] Circuit breaker pre-check failed (failing open): ${err.message}`)
        }
      }

      // 2. Execute the function
      try {
        const result = await fn()
        
        // 3. Post-Check: If the result is a ChatResponse (or has verdict headers), inspect it
        if (result && typeof result === 'object') {
          const res = result as any
          if (res.verdict === 'kill') {
            throw new ClawdeVerdictError('kill', `Execution blocked by governance policy (Verdict: KILL)`)
          }
        }
        
        return result;
      } catch (err: any) {
        if (err instanceof ClawdeVerdictError && !failOpen) {
          throw err
        }
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
