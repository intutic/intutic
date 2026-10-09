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
import { resolveGitContext } from './git-context'
import { BudgetChecker } from './budget-checker'
import { CircuitBreaker } from './circuit-breaker'
import { ClawdeEventEmitter } from './event-emitter'
import { deriveIdentity, identityHeaders, type GraphIdentity } from './graph-identity'

/** The harness a session this SDK registers is recorded under. */
export const SDK_HARNESS = 'clawde_sdk'

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

  /** The session this client's requests are filed under, resolved once, on the first `chat()`. */
  private session?: Promise<string | null>

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
    this.session ??= this.openSession()
    const sessionId = await this.session
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
      // The proxy files the trace under this session, and the control plane
      // copies the session's repository, branch and commit onto it.
      ...(sessionId ? { 'x-session-id': sessionId } : {}),
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
      let retryAfter: string | null
      try {
        const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
        status = response.status
        refusedBy = response.headers.get(REFUSAL_HEADER)
        refusedRule = response.headers.get(REFUSAL_RULE_HEADER)
        retryAfter = response.headers.get('retry-after')
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
      if (refusal) this.refuse(refusal, status, retryAfter)

      lastError = `HTTP error ${status}: ${text}`
      // A 4xx that is not a refusal (bad key, malformed body) fails the same
      // way every time; only a 5xx is worth another attempt.
      if (status < 500) throw new ClawdeConnectionError(lastError)
    }

    throw new ClawdeConnectionError(`Request failed after ${maxAttempts} attempts. Last error: ${lastError}`)
  }

  /**
   * The session to send as `x-session-id`, or null to send none.
   *
   * A session id from the environment (`INTUTIC_SESSION_ID`, or the sync
   * daemon's config) is the session that started this process, and its owner
   * reports its context, so it is used as is. Otherwise, when the working
   * directory is a git repository, this registers a session carrying its
   * repository, branch and commit (`POST /api/v1/sessions`, as the sync
   * daemon does), so cost per branch, commit and pull request includes this
   * client's calls. Only with an Intutic virtual key: any other key is a
   * provider's, and it is never sent to the control plane. `autoContext:
   * false` turns this off. Best effort: a control plane that cannot be
   * reached or refuses costs the attribution, never the call.
   */
  private async openSession(): Promise<string | null> {
    if (!this.autoContext) return null
    const context = await resolveContext()
    if (context.sessionId) return context.sessionId
    if (!this.apiKey.startsWith('vk_')) return null
    const git = await resolveGitContext(context.workingDirectory ?? process.cwd(), context.gitBranch)
    if (Object.keys(git).length === 0) return null
    try {
      // whoami first, always: the repository goes only to a control plane
      // that accepted the key. A workspace id from the environment proves
      // nothing about the key, and the session route only takes the key's own.
      const { workspaceId } = await this.controlPlane<{ workspaceId: string }>('GET', '/api/v1/auth/me')
      const session = await this.controlPlane<{ sessionId?: string }>('POST', '/api/v1/sessions', {
        workspaceId,
        harnessType: SDK_HARNESS,
        ...git,
      })
      return session.sessionId ?? null
    } catch (err) {
      if (process.env.INTUTIC_DEBUG === 'true') {
        console.warn(`[Clawde SDK] No session registered; calls carry no git context: ${err instanceof Error ? err.message : String(err)}`)
      }
      return null
    }
  }

  private async controlPlane<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.controlPlaneUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`)
    return (await res.json()) as T
  }

  /** Fires the refusal's event, then throws it. */
  private refuse(refusal: ProxyRefusal, status: number, retryAfter: string | null = null): never {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : undefined
    this.eventEmitter.emit(refusal.verdict, { ...refusal, status, ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}) })
    throw new ClawdeBlockedError(refusal.verdict, refusal.code, status, refusal.message, refusal.ruleId, seconds)
  }
}
