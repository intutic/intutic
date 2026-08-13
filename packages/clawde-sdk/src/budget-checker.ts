import { BudgetCheckResult } from './types'
import { ClawdeConnectionError } from './errors'

interface CacheEntry {
  result: BudgetCheckResult
  timestamp: number
}

/** `GET /api/v1/budget`'s real response shape (services/control-plane/src/routes/budget.ts). */
interface WorkspaceBudgetStatus {
  budget_remaining_usd: number
  alert_triggered: boolean
}

export class BudgetChecker {
  private cache = new Map<string, CacheEntry>()
  private cacheTtl = 30000 // 30s TTL
  private controlPlaneUrl: string
  private apiKey: string

  constructor(controlPlaneUrl: string, apiKey: string) {
    this.controlPlaneUrl = controlPlaneUrl
    this.apiKey = apiKey
  }

  /**
   * Historically called a `/v1/budget/check` route on the proxy that never
   * existed anywhere in the backend -- every real call threw. The only real
   * budget endpoint is `GET /api/v1/budget` on the control plane, which
   * reports current workspace-level spend/remaining, not a per-request
   * allow/decision for a specific `model`+`estimatedTokens` pair (the real
   * endpoint takes no such params). This is therefore a narrower, honestly
   * different check than the name implies: "does this workspace currently
   * have budget headroom at all", not "would this specific call fit" --
   * `model`/`estimatedTokens` are kept only as the existing cache key shape,
   * for API/cache-behavior compatibility with callers already using them.
   */
  public async checkBudget(model: string, estimatedTokens: number): Promise<BudgetCheckResult> {
    const cacheKey = `${model}:${estimatedTokens}`
    const now = Date.now()
    const cached = this.cache.get(cacheKey)

    if (cached && now - cached.timestamp < this.cacheTtl) {
      return cached.result
    }

    try {
      const response = await fetch(`${this.controlPlaneUrl}/api/v1/budget`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Budget check failed with status: ${response.status}`)
      }

      const body = (await response.json()) as WorkspaceBudgetStatus
      const result: BudgetCheckResult = {
        allowed: body.budget_remaining_usd > 0,
        remaining_usd: body.budget_remaining_usd,
        reason: body.alert_triggered
          ? 'Workspace is at or above its budget alert threshold'
          : undefined,
      }
      this.cache.set(cacheKey, { result, timestamp: now })
      return result
    } catch (err: any) {
      throw new ClawdeConnectionError(`Could not reach control-plane budget endpoint: ${err.message}`)
    }
  }

  // Helper to manually update/pre-populate budget cache from response headers
  public updateCachedBudget(model: string, estimatedTokens: number, remainingUsd: number, allowed: boolean) {
    const cacheKey = `${model}:${estimatedTokens}`
    this.cache.set(cacheKey, {
      result: { allowed, remaining_usd: remainingUsd },
      timestamp: Date.now(),
    })
  }
}
