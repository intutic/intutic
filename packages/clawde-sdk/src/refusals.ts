import type { RefusalVerdict } from './types'

/**
 * The proxy's governance refusals: the `error.type` of its JSON error body
 * (`{"error": {"type", "message"}}`, `json_error` in packages/proxy/src/proxy.rs),
 * the status it always pairs that type with, and the verdict it represents.
 *
 * Matching on the pair rather than the status alone matters because the same
 * statuses also carry errors that are not decisions: a provider's own 429 rate
 * limit, a 403 for a key used against the wrong workspace, a 400 for a malformed
 * body. Those are not refusals and must not be reported as one.
 *
 * `__tests__/refusals.test.ts` checks this table against proxy.rs, so a refusal
 * the proxy adds or renames fails the build instead of silently turning back
 * into a retried connection error.
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
}

export interface ProxyRefusal {
  verdict: RefusalVerdict
  code: string
  message: string
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
 * The header the proxy sets on a 200 that is a refusal in the shape of an
 * answer: the cost-prediction gate replies to a non-streaming request with an
 * assistant turn explaining the estimate, so a chat client shows the reason.
 * Its value is the refusal's code.
 */
export const REFUSAL_HEADER = 'x-intutic-refusal'

/** The refusal a 2xx response names in `REFUSAL_HEADER`, or `null` for a real answer. */
export function headerRefusal(code: string | null, message: string): ProxyRefusal | null {
  if (!code) return null
  const known = PROXY_REFUSALS[code]
  return {
    verdict: known?.verdict ?? 'kill',
    code,
    message: message || code,
  }
}
