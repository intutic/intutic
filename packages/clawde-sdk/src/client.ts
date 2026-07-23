import {
  ClawdeClientOptions,
  ChatParams,
  ChatResponse,
  ResolvedContext,
  BudgetCheckResult,
  EventCallback,
  CircuitBreakerOptions,
} from './types'
import { ClawdeConnectionError, ClawdeVerdictError } from './errors'
import { normalizeRequest, normalizeResponse } from './schema-enforcer'
import { resolveContext } from './context-resolver'
import { BudgetChecker } from './budget-checker'
import { CircuitBreaker } from './circuit-breaker'
import { ClawdeEventEmitter } from './event-emitter'

export class ClawdeClient {
  private apiKey: string
  private baseUrl: string
  private provider?: 'openai' | 'anthropic' | 'google'
  private autoContext: boolean
  private timeout: number
  private retries: number

  private budgetChecker: BudgetChecker
  private circuitBreakerWrapper: CircuitBreaker
  private eventEmitter: ClawdeEventEmitter

  constructor(options: ClawdeClientOptions) {
    if (!options.apiKey) {
      throw new Error('API key is required to initialize ClawdeClient.')
    }
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl || process.env.INTUTIC_BASE_URL || 'http://localhost:4000'
    this.provider = options.provider
    this.autoContext = options.autoContext ?? true
    this.timeout = options.timeout ?? 30000
    this.retries = options.retries ?? 2

    this.budgetChecker = new BudgetChecker(this.baseUrl, this.apiKey)
    this.circuitBreakerWrapper = new CircuitBreaker(this)
    this.eventEmitter = new ClawdeEventEmitter()
  }

  // Event emitter delegates
  public on(event: 'hijack' | 'enhance' | 'kill' | 'bypass', callback: EventCallback): void {
    this.eventEmitter.on(event, callback)
  }

  public off(event: string, callback: EventCallback): void {
    this.eventEmitter.off(event, callback)
  }

  // Budget checker delegate
  public async checkBudget(model: string, estimatedTokens: number): Promise<BudgetCheckResult> {
    return this.budgetChecker.checkBudget(model, estimatedTokens)
  }

  // Context resolution delegate
  public async resolveContext(): Promise<ResolvedContext> {
    if (!this.autoContext) {
      return {}
    }
    return resolveContext()
  }

  // Circuit breaker wrapper delegate
  public circuitBreaker<T>(
    toolName: string,
    options: CircuitBreakerOptions = {}
  ): (fn: () => Promise<T>) => Promise<T> {
    return this.circuitBreakerWrapper.wrap<T>(toolName, options)
  }

  // Chat completion endpoint wrapper
  public async chat(params: ChatParams): Promise<ChatResponse> {
    // 1. Resolve context
    const context = await this.resolveContext()

    // 2. Normalize payload based on provider
    const requestPayload = normalizeRequest(params, this.provider)

    // 3. Make the API request with headers
    let lastError: any = null
    const maxAttempts = this.retries + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Intutic-Context': JSON.stringify(context),
        }

        if (params.max_cost_usd !== undefined) {
          headers['X-Intutic-Cost-Limit'] = String(params.max_cost_usd)
        }
        if (params.sensitivity_tier !== undefined) {
          headers['X-Intutic-Sensitivity'] = String(params.sensitivity_tier)
        }

        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        })

        clearTimeout(timer)

        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}: ${await response.text()}`)
        }

        const json = await response.json()
        const normalized = normalizeResponse(json, this.provider)

        // 4. Extract Intutic response headers
        const verdictHeader = response.headers.get('x-intutic-verdict') || 'allow'
        const budgetRemainingHeader = response.headers.get('x-intutic-budget-remaining')
        const budgetPctHeader = response.headers.get('x-intutic-budget-pct')

        normalized.verdict = verdictHeader as any
        if (budgetRemainingHeader) {
          normalized.budgetRemainingUsd = parseFloat(budgetRemainingHeader)
        }
        if (budgetPctHeader) {
          normalized.budgetPctUsed = parseFloat(budgetPctHeader)
        }

        // 5. Update local budget cache
        if (normalized.budgetRemainingUsd !== undefined) {
          this.budgetChecker.updateCachedBudget(
            params.model,
            params.messages.length, // approximation
            normalized.budgetRemainingUsd,
            verdictHeader !== 'kill'
          )
        }

        // 6. Trigger event emitters
        if (normalized.verdict && normalized.verdict !== 'allow') {
          this.eventEmitter.emit(normalized.verdict, normalized)
        }

        // 7. Policy enforcement
        if (normalized.verdict === 'kill') {
          throw new ClawdeVerdictError('kill', 'Request blocked by policy (Verdict: KILL)')
        }

        return normalized
      } catch (err: any) {
        clearTimeout(timer)
        lastError = err

        if (err instanceof ClawdeVerdictError) {
          throw err // Do not retry on explicit policy blocks
        }

        if (attempt < maxAttempts) {
          if (process.env.INTUTIC_DEBUG === 'true') {
            console.warn(`[Clawde SDK] Attempt ${attempt} failed, retrying... Error: ${err.message}`)
          }
          // backoff delay
          await new Promise((resolve) => setTimeout(resolve, attempt * 100))
          continue
        }
      }
    }

    throw new ClawdeConnectionError(`Request failed after ${maxAttempts} attempts. Last error: ${lastError.message}`)
  }
}
