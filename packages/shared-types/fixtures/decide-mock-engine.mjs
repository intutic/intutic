// A decide engine that replays recorded responses, for the
// engine client tests: logprob chat completions, System One and Decisions
// replies, and Ollama's /api/tags. No model runs anywhere.
//
// Each replay entry answers the first requests with its method and path whose
// raw body contains `match` (when given), `times` of them (default once):
//   { method, path, match?, status, body? | bodyRaw?, delayMs?, times? }
// `body` is sent as JSON, `bodyRaw` as it is. A request nothing matches gets
// 404 and is listed in `unmatched`. Faults (an always-allow answer, a wrong
// field, a changed digest, latency) are replay entries like any other.
//
// The cases live in decide-engine-vectors.json. The Python and Rust tests
// replay the same entries with their own servers (http.server, wiremock).
import { createServer } from 'node:http'

export async function startDecideMockEngine(replay = []) {
  const entries = replay.map((e) => ({ ...e, uses: 0 }))
  const requests = []
  const unmatched = []
  let inFlight = 0
  let maxInFlight = 0
  const server = createServer((req, res) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      let body
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = undefined
      }
      requests.push({ method: req.method, path, raw, body, headers: req.headers })
      const entry = entries.find(
        (e) => e.uses < (e.times ?? 1) && e.method === req.method && e.path === path && (e.match === undefined || raw.includes(e.match)),
      )
      const finish = (status, text) => {
        inFlight--
        if (res.destroyed) return
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(text)
      }
      if (!entry) {
        unmatched.push({ method: req.method, path, raw })
        finish(404, JSON.stringify({ error: 'no recorded response' }))
        return
      }
      entry.uses++
      const text = entry.bodyRaw !== undefined ? entry.bodyRaw : JSON.stringify(entry.body ?? {})
      if (entry.delayMs) setTimeout(() => finish(entry.status, text), entry.delayMs)
      else finish(entry.status, text)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unmatched,
    get maxInFlight() {
      return maxInFlight
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/**
 * A port nothing listens on. Port 1 is privileged, so no mock server a
 * parallel test starts can take it; a port borrowed from the OS and released
 * could be handed straight to another test's server.
 */
export async function closedPort() {
  return 1
}
