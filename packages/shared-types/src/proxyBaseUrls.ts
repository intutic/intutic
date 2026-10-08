/**
 * proxyBaseUrls.ts — the base URL each SDK family needs to reach the proxy.
 *
 * The proxy serves exactly `/v1/messages`, `/v1/chat/completions` and
 * `/v1/responses`. The two SDK families append different suffixes to the base
 * URL they are given, so one URL cannot serve both:
 *
 * - Anthropic SDKs (and Claude Code) append `/v1/messages` — they need the
 *   bare proxy host.
 * - OpenAI SDKs append `/chat/completions` or `/responses` — they need the
 *   host plus `/v1`.
 *
 * Every writer that hands a harness a base URL goes through these helpers so
 * the two can never be swapped again. `INTUTIC_PROXY_URL` and the sync
 * payload's `proxyUrl` both mean the bare host; a trailing `/v1` on either is
 * tolerated and removed, because older configs and docs carried one.
 *
 * @module
 */

/** Where `intutic start` and `intutic connect` run the proxy by default. */
export const DEFAULT_PROXY_HOST = 'http://localhost:4000'

/**
 * Normalise a configured proxy URL to its bare host form: no trailing slash,
 * no trailing `/v1`. An empty value means "not configured" and resolves to
 * {@link DEFAULT_PROXY_HOST}.
 */
export function proxyHost(proxyUrl: string | undefined | null): string {
  let host = trimTrailingSlashes((proxyUrl ?? '').trim())
  if (host.endsWith('/v1')) host = trimTrailingSlashes(host.slice(0, -'/v1'.length))
  return host === '' ? DEFAULT_PROXY_HOST : host
}

/**
 * Trims trailing `/` characters with a loop rather than `/\/+$/`, which static
 * analysis flags as a polynomial-time pattern on external input.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/** Base URL for Anthropic SDKs (`ANTHROPIC_BASE_URL`): the bare host. */
export function anthropicBaseUrl(proxyUrl: string | undefined | null): string {
  return proxyHost(proxyUrl)
}

/** Base URL for OpenAI-compatible SDKs (`OPENAI_BASE_URL`): host + `/v1`. */
export function openaiBaseUrl(proxyUrl: string | undefined | null): string {
  return `${proxyHost(proxyUrl)}/v1`
}
