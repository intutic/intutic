import type { RefusalVerdict } from './types'

/**
 * The proxy's governance refusals, by code, with the status the proxy sends
 * each with and the verdict it represents.
 *
 * Most arrive as an error: the code is the `error.type` of the proxy's JSON
 * error body (`{"error": {"type", "message"}}`, `json_error` in
 * packages/proxy/src/proxy.rs). Matching on the status and the code together
 * matters because the same statuses also carry errors that are not decisions:
 * a provider's own 429 rate limit, a 403 for a key used against the wrong
 * workspace, a 400 for a malformed body. Those are not refusals and must not
 * be reported as one.
 *
 * The rest (status 200, and `COST_GATE_EXCEEDED` on a non-streaming request)
 * arrive in band: an assistant turn explaining the refusal, named by
 * `REFUSAL_HEADER`, or on a stream by the `STREAM_REFUSAL_MARKER` comment line.
 *
 * `__tests__/refusals.test.ts` holds this table to
 * packages/shared-types/fixtures/refusal-codes.json, the one list the proxy
 * and the Python SDK are held to as well, so a refusal the proxy adds or
 * renames fails the build instead of silently turning back into an `allow` or
 * a retried connection error.
 */
export const PROXY_REFUSALS: Readonly<Record<string, { status: number; verdict: RefusalVerdict }>> = {
  policy_denied: { status: 403, verdict: 'kill' },
  model_not_allowed: { status: 403, verdict: 'kill' },
  LOOP_RUN_TERMINATED: { status: 403, verdict: 'kill' },
  LOOP_RUN_PENDING_REVIEW: { status: 403, verdict: 'hold' },
  policy_reask: { status: 409, verdict: 'reask' },
  BUDGET_EXCEEDED: { status: 429, verdict: 'kill' },
  OVERAGE_HARD_CAP_EXCEEDED: { status: 429, verdict: 'kill' },
  COST_GATE_EXCEEDED: { status: 402, verdict: 'kill' },
  dlp_policy_violation: { status: 400, verdict: 'kill' },
  TOOL_DENIED: { status: 200, verdict: 'kill' },
  SSO_GROUP: { status: 200, verdict: 'kill' },
  SQL_GUARD: { status: 200, verdict: 'kill' },
  RESPONSE_UNPARSEABLE: { status: 200, verdict: 'kill' },
  OUTPUT_DLP: { status: 200, verdict: 'kill' },
}

export interface ProxyRefusal {
  verdict: RefusalVerdict
  code: string
  message: string
  /** The rule that decided, for a refusal the proxy answered in band. */
  ruleId?: string
}

/** The refusal an error response carries, or `null` when it is any other kind of failure. */
export function parseRefusal(status: number, body: string): ProxyRefusal | null {
  let error: { type?: unknown; message?: unknown } | undefined
  try {
    error = JSON.parse(body)?.error
  } catch {
    return null
  }
  if (!error || typeof error.type !== 'string') return null
  const known = PROXY_REFUSALS[error.type]
  if (!known || known.status !== status) return null
  return {
    verdict: known.verdict,
    code: error.type,
    message: typeof error.message === 'string' ? error.message : error.type,
  }
}

/**
 * The headers the proxy sets on a 200 that is a refusal in the shape of an
 * answer: the response gate withheld a tool call the model made, output DLP
 * withheld the body, or the cost-prediction gate answered instead of the
 * model. The first names the refusal's code, the second the rule that decided.
 */
export const REFUSAL_HEADER = 'x-intutic-refusal'
export const REFUSAL_RULE_HEADER = 'x-intutic-refusal-rule'

/** The refusal a 2xx response names in `REFUSAL_HEADER`, or `null` for a real answer. */
export function headerRefusal(code: string | null, ruleId: string | null, message: string): ProxyRefusal | null {
  if (!code) return null
  return named(code, ruleId || undefined, message)
}

/**
 * The prefix of the SSE comment line that names a refusal on a stream:
 * `: intutic-refusal {"code", "rule", "message"}`. The response headers went
 * out before the refusal happened, so a stream says it in band; every SSE
 * parser skips comment lines, so clients that do not look for it are
 * unaffected.
 */
export const STREAM_REFUSAL_MARKER = ': intutic-refusal '

/**
 * The refusal named anywhere in a stream's text, or `null` when there is
 * none. Pass the whole body, or each line as it arrives.
 */
export function streamRefusal(text: string): ProxyRefusal | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith(STREAM_REFUSAL_MARKER)) continue
    let payload: { code?: unknown; rule?: unknown; message?: unknown }
    try {
      payload = JSON.parse(line.slice(STREAM_REFUSAL_MARKER.length))
    } catch {
      continue
    }
    if (typeof payload?.code !== 'string') continue
    return named(
      payload.code,
      typeof payload.rule === 'string' ? payload.rule : undefined,
      typeof payload.message === 'string' ? payload.message : '',
    )
  }
  return null
}

function named(code: string, ruleId: string | undefined, message: string): ProxyRefusal {
  // A code this SDK version does not know is still a refusal: the proxy only
  // names a response it did not let through.
  const known = PROXY_REFUSALS[code]
  return {
    verdict: known?.verdict ?? 'kill',
    code,
    message: message || code,
    ...(ruleId ? { ruleId } : {}),
  }
}
