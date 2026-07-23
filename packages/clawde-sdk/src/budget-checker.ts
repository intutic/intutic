import { BudgetCheckResult } from './types'
import { ClawdeConnectionError } from './errors'

interface CacheEntry {
  result: BudgetCheckResult
  timestamp: number
}

export class BudgetChecker {
  private cache = new Map<string, CacheEntry>()
  private cacheTtl = 30000 // 30s TTL
  private baseUrl: string
  private apiKey: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
  }

  public async checkBudget(model: string, estimatedTokens: number): Promise<BudgetCheckResult> {
    const cacheKey = `${model}:${estimatedTokens}`
    const now = Date.now()
    const cached = this.cache.get(cacheKey)

    if (cached && now - cached.timestamp < this.cacheTtl) {
      return cached.result
    }

    try {
      const url = new URL(`${this.baseUrl}/v1/budget/check`)
      url.searchParams.append('model', model)
      url.searchParams.append('estimated_tokens', String(estimatedTokens))

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Budget check failed with status: ${response.status}`)
      }

      const result = (await response.json()) as BudgetCheckResult
      this.cache.set(cacheKey, { result, timestamp: now })
      return result
    } catch (err: any) {
      throw new ClawdeConnectionError(`Could not reach budget check endpoint: ${err.message}`)
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
