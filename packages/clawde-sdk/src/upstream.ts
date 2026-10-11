import type { UpstreamCalls } from './types'

/** Set by the proxy when its retry layer made more than one upstream call. */
export const UPSTREAM_ATTEMPTS_HEADER = 'x-intutic-upstream-attempts'
/** Set by the proxy when a fallback answered: the model whose retries ran out. */
export const UPSTREAM_FALLBACK_HEADER = 'x-intutic-upstream-fallback-from'

/** The proxy's retry headers, or undefined on the ordinary single-call response. */
export function upstreamCalls(headers: Headers): UpstreamCalls | undefined {
  const attempts = Number(headers.get(UPSTREAM_ATTEMPTS_HEADER) ?? '')
  const fallbackFrom = headers.get(UPSTREAM_FALLBACK_HEADER) ?? undefined
  if (!(attempts > 1) && fallbackFrom === undefined) return undefined
  return { attempts: attempts > 1 ? attempts : 1, ...(fallbackFrom !== undefined && { fallbackFrom }) }
}
