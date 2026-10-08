/**
 * Where the local proxy listens, for every command that talks to it.
 *
 * One source: `INTUTIC_PROXY_URL` (default `http://localhost:4000`), the
 * variable `intutic exec` already points agents at. `connect` used to take its
 * port from `PORT` while `budget` and `doctor` hardcoded 4000, so moving the
 * proxy left them probing a port nothing listened on. `PORT` is not read: in a
 * developer's shell it usually belongs to some other server.
 *
 * @module
 */

const DEFAULT_PROXY_PORT = 4000

/** The local proxy's port, from `INTUTIC_PROXY_URL` (an empty value means unset). */
export function localProxyPort(): number {
  const raw = process.env.INTUTIC_PROXY_URL
  if (!raw) return DEFAULT_PROXY_PORT
  try {
    const port = Number(new URL(raw).port)
    return port > 0 ? port : DEFAULT_PROXY_PORT
  } catch {
    return DEFAULT_PROXY_PORT
  }
}

/**
 * `http://127.0.0.1:<port>`: the loopback address, not `localhost`, so a probe
 * cannot resolve to `::1` while the proxy listens on IPv4 only.
 */
export function localProxyProbeBase(): string {
  return `http://127.0.0.1:${localProxyPort()}`
}
