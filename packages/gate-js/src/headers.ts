/**
 * Port of `intutic_headers()` from
 * `packages/intutic-clawde/intutic_clawde/gate/framework.py`.
 */

export interface IntuticHeadersOptions {
  sessionId?: string
  workspaceId?: string
  /** Attributes traces to this adapter. Defaults to `"generic"`. */
  harness?: string
}

/**
 * Default headers for a client pointed at the Intutic proxy (an OpenAI-
 * compatible chat client, a raw `fetch` call, etc.).
 *
 * `x-session-id` matters: the proxy defaults an unset one to the literal
 * `"unknown"`, which merges every run into a single dashboard session.
 * `x-intutic-harness` attributes traces to this adapter — the proxy honours
 * it for trace attribution (unknown headers are ignored by older proxies, so
 * it is always safe to send).
 *
 * Usage:
 *
 *     const client = new OpenAI({ baseURL: proxyUrl, defaultHeaders: intuticHeaders({ sessionId: runId }) })
 */
export function intuticHeaders(opts: IntuticHeadersOptions = {}): Record<string, string> {
  const harness = opts.harness ?? 'generic'
  const headers: Record<string, string> = { 'x-intutic-harness': harness }

  const sess = opts.sessionId || process.env.INTUTIC_SESSION_ID || ''
  if (sess) headers['x-session-id'] = sess

  const ws = opts.workspaceId || process.env.INTUTIC_WORKSPACE_ID || ''
  if (ws) headers['x-workspace-id'] = ws

  return headers
}
