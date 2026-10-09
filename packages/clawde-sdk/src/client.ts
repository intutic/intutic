import {
  ClawdeClientOptions,
  ChatParams,
  ChatResponse,
  ResolvedContext,
  BudgetCheckResult,
  EventCallback,
  CircuitBreakerOptions,
  VerdictEvent,
} from './types'
import { ClawdeBlockedError, ClawdeConnectionError } from './errors'
import { parseRefusal, headerRefusal, streamRefusal, REFUSAL_HEADER, REFUSAL_RULE_HEADER, type ProxyRefusal } from './refusals'
import { normalizeRequest, normalizeResponse } from './schema-enforcer'
import { resolveContext } from './context-resolver'
import { BudgetChecker } from './budget-checker'
import { CircuitBreaker } from './circuit-breaker'
import { ClawdeEventEmitter } from './event-emitter'
import { deriveIdentity, identityHeaders, type GraphIdentity } from './graph-identity'

export class ClawdeClient {
  private apiKey: string
  private baseUrl: string
  private controlPlaneUrl: string
  private provider?: 'openai' | 'anthropic' | 'google'
  private autoContext: boolean
  private timeout: number
  private retries: number

  /** This client's position in the agent graph — see `graph-identity`. */
  private identity: GraphIdentity

  private budgetChecker: BudgetChecker
  private circuitBreakerWrapper: CircuitBreaker
  private eventEmitter: ClawdeEventEmitter

  constructor(options: ClawdeClientOptions) {
    if (!options.apiKey) {
      throw new Error('API key is required to initialize ClawdeClient.')
    }
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl || process.env.INTUTIC_BASE_URL || 'http://localhost:4000'
    this.controlPlaneUrl =
      options.controlPlaneUrl || process.env.INTUTIC_CONTROL_PLANE_URL || 'https://app.intutic.ai'
    this.provider = options.provider
    this.autoContext = options.autoContext ?? true
    this.timeout = options.timeout ?? 30000
    this.retries = options.retries ?? 2

    // Inherited from the process that spawned this one, so an agent that runs
    // another agent is recorded as its parent without either of them being told.
    this.identity = deriveIdentity(options.graphIdentity)

    this.budgetChecker = new BudgetChecker(this.controlPlaneUrl, this.apiKey)
    this.circuitBreakerWrapper = new CircuitBreaker(this)
    this.eventEmitter = new ClawdeEventEmitter()
  }

  // Event emitter delegates
  public on(event: VerdictEvent, callback: EventCallback): void {
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

  /**
   * Send a chat request through the proxy.
   *
   * Resolves with `verdict: 'allow'` when the proxy let the request through. A
   * governance refusal, including one the proxy answers with a 200 and names in
   * `x-intutic-refusal` (or, on a stream, in its `: intutic-refusal` line),
   * fires the matching event and rejects with `ClawdeBlockedError`, unretried.
   * Transport failures, timeouts and 5xx answers are retried; anything else
   * rejects with `ClawdeConnectionError`.
   */
  public async chat(params: ChatParams): Promise<ChatResponse> {
    const anthropic = this.provider === 'anthropic'
    // The proxy picks the wire format by route: an Anthropic Messages body
    // sent to /v1/chat/completions is parsed as an OpenAI one.
    const url = `${this.baseUrl}${anthropic ? '/v1/messages' : '/v1/chat/completions'}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(anthropic
        ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Authorization': `Bearer ${this.apiKey}` }),
      // Without these the proxy sees graph_id == session_id, treats every
      // request as a graph of one, and skips membership, fleet spend and
      // node counting entirely.
      ...identityHeaders(this.identity),
    }
    const body = JSON.stringify(normalizeRequest(params, this.provider))

    let lastError = ''
    const maxAttempts = this.retries + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        if (process.env.INTUTIC_DEBUG === 'true') {
          console.warn(`[Clawde SDK] Attempt ${attempt - 1} failed, retrying... Error: ${lastError}`)
        }
        await new Promise((resolve) => setTimeout(resolve, (attempt - 1) * 100))
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout)
      let status: number
      let text: string
      let refusedBy: string | null
      let refusedRule: string | null
      try {
        const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
        status = response.status
        refusedBy = response.headers.get(REFUSAL_HEADER)
        refusedRule = response.headers.get(REFUSAL_RULE_HEADER)
        text = await response.text()
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        continue
      } finally {
        clearTimeout(timer)
      }

      if (status >= 200 && status < 300) {
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          // A `stream: true` request comes back as an event stream, which
          // `chat()` does not parse; it still must not pass off a refusal
          // the stream names as a transport failure.
          const streamed = streamRefusal(text)
          if (streamed) this.refuse(streamed, status)
          throw new ClawdeConnectionError(`Proxy answered ${status} with a body that is not JSON: ${text}`)
        }
        const normalized = normalizeResponse(json, this.provider)
        // A refusal answered as an assistant turn: a withheld tool call, a
        // withheld body, or the cost-prediction gate.
        const content = normalized.choices?.[0]?.message?.content
        const answered = headerRefusal(refusedBy, refusedRule, typeof content === 'string' ? content : '')
        if (answered) this.refuse(answered, status)
        normalized.verdict = 'allow'
        return normalized
      }

      const refusal = parseRefusal(status, text)
      if (refusal) this.refuse(refusal, status)

      lastError = `HTTP error ${status}: ${text}`
      // A 4xx that is not a refusal (bad key, malformed body) fails the same
      // way every time; only a 5xx is worth another attempt.
      if (status < 500) throw new ClawdeConnectionError(lastError)
    }

    throw new ClawdeConnectionError(`Request failed after ${maxAttempts} attempts. Last error: ${lastError}`)
  }

  /** Fires the refusal's event, then throws it. */
  private refuse(refusal: ProxyRefusal, status: number): never {
    this.eventEmitter.emit(refusal.verdict, { ...refusal, status })
    throw new ClawdeBlockedError(refusal.verdict, refusal.code, status, refusal.message, refusal.ruleId)
  }
}
