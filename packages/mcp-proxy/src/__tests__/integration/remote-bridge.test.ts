/**
 * remote-bridge.test.ts — end-to-end coverage for remote (HTTP/SSE) bridge
 * mode (config.ts's `--remote-url`/`--remote-transport`, remoteBridge.ts).
 *
 * Nothing here mocks the proxy itself: every test spawns the actual BUILT
 * proxy binary (`dist/index.js`, the same file harnesses invoke) as a child
 * process and drives it over piped stdio exactly the way a harness would,
 * against small local `node:http` fixture servers standing in for a remote
 * MCP server — one plain-JSON streamable-HTTP responder, one SSE
 * endpoint-event + data-frame responder, per the MCP spec each transport
 * implements (verified against the installed SDK's client transport source,
 * not merely the public .d.ts — see remoteBridge.ts's own doc comments).
 *
 * A second small `node:http` server stands in for the Intutic control plane,
 * so SOP rules / curation / DLP patterns can be varied per workspace without
 * a real control-plane instance.
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as readline from 'node:readline'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..')
const PROXY_BIN = path.join(PACKAGE_ROOT, 'dist', 'index.js')

// `test` depends on `build` in turbo.json, so dist/index.js normally already
// exists by the time this file runs — this is a safety net for running this
// file in isolation (`vitest run` without the turbo `build` dependency).
beforeAll(() => {
  if (!fs.existsSync(PROXY_BIN)) {
    execFileSync('npx', ['tsc'], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  }
}, 60_000)

// ─── Remote MCP server fixtures ─────────────────────────────────────────────

type JsonRpcLike = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: unknown }
type RpcHandler = (msg: JsonRpcLike, headers: http.IncomingHttpHeaders) => unknown | undefined

/**
 * Minimal streamable-HTTP MCP server (per the SDK's `StreamableHTTPClientTransport`,
 * read directly from the installed package — see remoteBridge.ts): POST carries a
 * JSON-RPC message and gets a plain `application/json` response (202 with no body
 * for notifications); GET (the transport's optional "offer a server-initiated
 * stream" probe on `start()`) answers 405, which the SDK treats as "no stream
 * offered", not an error.
 */
function createHttpFixture(handleRpc: RpcHandler): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => { body += c })
    req.on('end', () => {
      let msg: JsonRpcLike
      try {
        msg = JSON.parse(body) as JsonRpcLike
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const result = handleRpc(msg, req.headers)
      if (result === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    })
  })
}

/**
 * Minimal SSE MCP server (per the SDK's `SSEClientTransport`, same
 * source-level verification): GET opens the event stream and announces the
 * POST endpoint via an `endpoint` event; POST bodies land there (answered
 * 202, body ignored per spec) and any reply is pushed back over the
 * still-open GET stream as a default (`message`) SSE event.
 */
function createSseFixture(handleRpc: RpcHandler): http.Server {
  let sseRes: http.ServerResponse | null = null
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('event: endpoint\ndata: /messages\n\n')
      sseRes = res
      req.on('close', () => { if (sseRes === res) sseRes = null })
      return
    }
    if (req.method === 'POST' && req.url === '/messages') {
      let body = ''
      req.on('data', (c: Buffer) => { body += c })
      req.on('end', () => {
        res.writeHead(202)
        res.end()
        let msg: JsonRpcLike
        try {
          msg = JSON.parse(body) as JsonRpcLike
        } catch {
          return
        }
        const result = handleRpc(msg, req.headers)
        if (result !== undefined && sseRes) {
          sseRes.write(`data: ${JSON.stringify(result)}\n\n`)
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as net.AddressInfo).port
}

/** A tools/list result with one tool an allowlist test hides and one it keeps. */
const TOOLS_V1 = {
  tools: [
    { name: 'safe_tool', description: 'A safe tool', inputSchema: { type: 'object', properties: {} } },
    { name: 'dangerous_tool', description: 'A dangerous tool', inputSchema: { type: 'object', properties: {} } },
  ],
}
/** Same tool names, one description changed — a TOFU-mismatch fixture. */
const TOOLS_V2_CHANGED = {
  tools: [
    { name: 'safe_tool', description: 'A safe tool', inputSchema: { type: 'object', properties: {} } },
    { name: 'dangerous_tool', description: 'A RUG-PULLED dangerous tool', inputSchema: { type: 'object', properties: {} } },
  ],
}

/** Builds an `RpcHandler` that answers `initialize`/`tools/list`/`tools/call`
 *  from fixed tables, and records every request's headers it sees. */
function makeHandler(opts: {
  toolsList?: unknown
  toolCallResults?: Record<string, unknown>
  seenHeaders?: http.IncomingHttpHeaders[]
}): RpcHandler {
  return (msg, headers) => {
    opts.seenHeaders?.push(headers)
    if (msg.id === undefined || msg.id === null) return undefined // notification
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '0.0.0' } },
      }
    }
    if (msg.method === 'tools/list') {
      return { jsonrpc: '2.0', id: msg.id, result: opts.toolsList ?? { tools: [] } }
    }
    if (msg.method === 'tools/call') {
      const params = msg.params as { name?: string } | undefined
      const result = (params?.name && opts.toolCallResults?.[params.name]) ?? { content: [{ type: 'text', text: 'ok' }] }
      return { jsonrpc: '2.0', id: msg.id, result }
    }
    return { jsonrpc: '2.0', id: msg.id, result: {} }
  }
}

// ─── Mock control plane ─────────────────────────────────────────────────────

interface WorkspacePolicy {
  sopRules?: Array<{ id: string; toolPattern: string; argPattern?: string; action: string; reason: string }>
  dlpPatterns?: string[]
  allowedTools?: string[]
  allowedServers?: string[]
  toolDescriptionOverrides?: Record<string, string>
}

/** Serves both the per-session (`GET /api/v1/sop/rules`) and daemon-mode
 *  (`GET /api/v1/policy/resolve`) shapes `policy.ts`/`policyCache.ts` expect,
 *  from the SAME per-workspace fixture table — the parity this daemon-mode
 *  M1 fix exists to guarantee (see daemon-shim.test.ts). Also answers
 *  `POST /api/v1/hook-events` so the emitter's telemetry never fails open
 *  into a warning that would otherwise clutter every test's stderr. */
function createMockControlPlane(policies: Record<string, WorkspacePolicy>): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspaceId') ?? ''
    const policy = policies[workspaceId] ?? {}

    if (url.pathname === '/api/v1/sop/rules') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        rules: policy.sopRules ?? [],
        dlpPatterns: policy.dlpPatterns ?? [],
        allowedTools: policy.allowedTools ?? [],
        allowedServers: policy.allowedServers ?? [],
        toolDescriptionOverrides: policy.toolDescriptionOverrides ?? {},
      }))
      return
    }
    if (url.pathname === '/api/v1/policy/resolve') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        workspaceId,
        sopRules: policy.sopRules ?? [],
        dlpPatterns: policy.dlpPatterns ?? [],
        allowedTools: policy.allowedTools ?? [],
        allowedServers: policy.allowedServers ?? [],
        toolDescriptionOverrides: policy.toolDescriptionOverrides ?? {},
        interventionMode: 'BLOCK',
      }))
      return
    }
    if (url.pathname === '/api/v1/hook-events') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
}

// ─── Proxy child-process harness ────────────────────────────────────────────

interface ProxyHarness {
  send: (msg: unknown) => void
  waitForResponse: (id: string | number, timeoutMs?: number) => Promise<Record<string, unknown>>
  stderrLines: string[]
  stop: () => Promise<void>
}

/** Spawns `dist/index.js` (the built proxy) exactly the way a harness would
 *  — piped stdio, args after the binary path — and gives back a small
 *  request/response driver over its stdout/stdin plus the raw stderr log
 *  lines for asserting on TOFU/redaction/curation log actions. */
function startProxy(args: string[], env: NodeJS.ProcessEnv): ProxyHarness {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [PROXY_BIN, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const buffered = new Map<string | number, Record<string, unknown>>()
  const waiters = new Map<string | number, (v: Record<string, unknown>) => void>()
  const stderrLines: string[] = []

  const outRl = readline.createInterface({ input: child.stdout, terminal: false })
  outRl.on('line', (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = msg['id'] as string | number | undefined
    if (id === undefined || id === null) return
    const waiter = waiters.get(id)
    if (waiter) {
      waiters.delete(id)
      waiter(msg)
    } else {
      buffered.set(id, msg)
    }
  })

  const errRl = readline.createInterface({ input: child.stderr, terminal: false })
  errRl.on('line', (line) => { stderrLines.push(line) })

  function send(msg: unknown): void {
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  function waitForResponse(id: string | number, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const existing = buffered.get(id)
    if (existing) {
      buffered.delete(id)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for response id=${String(id)}`))
      }, timeoutMs)
      waiters.set(id, (v) => {
        clearTimeout(timer)
        resolve(v)
      })
    })
  }

  async function stop(): Promise<void> {
    try {
      child.stdin.end()
    } catch {
      // Already closed — nothing to do.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return { send, waitForResponse, stderrLines, stop }
}

/** Fresh temp $HOME per test group — isolates `~/.intutic/mcp-pins/`
 *  (TOFU) and `~/.intutic/env/runtime.env` (fail-open/closed) from both the
 *  real environment and other test groups. */
async function makeTempHome(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

function baseEnv(home: string, controlPlanePort: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    INTUTIC_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
    CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
    INTUTIC_API_KEY: 'test-api-key',
    ...extra,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('remote bridge — streamable HTTP transport', () => {
  let cp: http.Server
  let cpPort: number
  let remote: http.Server
  let remotePort: number
  let home: string
  const seenHeaders: http.IncomingHttpHeaders[] = []

  beforeAll(async () => {
    home = await makeTempHome('intutic-remote-bridge-http-')
    cp = createMockControlPlane({
      ws_plain: {},
      ws_curation: { allowedTools: ['safe_tool'] },
      ws_block: { sopRules: [{ id: 'r-block', toolPattern: '^dangerous_tool$', action: 'block', reason: 'Dangerous tool blocked in test' }] },
      ws_dlp: {},
      ws_auth: {},
      ws_tofu_open: {},
      ws_tofu_closed: {},
    })
    cpPort = await listen(cp)

    remote = createHttpFixture(makeHandler({
      toolsList: TOOLS_V1,
      toolCallResults: {
        safe_tool: { content: [{ type: 'text', text: 'safe result' }] },
        dangerous_tool: { content: [{ type: 'text', text: 'dangerous result' }] },
        leaky_tool: { content: [{ type: 'text', text: 'here is a key sk-abcdefghijklmnopqrstuvwx' }] },
      },
      seenHeaders,
    }))
    remotePort = await listen(remote)
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => cp.close(() => resolve()))
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    await fsp.rm(home, { recursive: true, force: true })
  })

  it('completes an MCP initialize round-trip through the bridge', async () => {
    const proxy = startProxy(
      ['--workspace-id', 'ws_plain', '--server-name', 'remote-http', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort),
    )
    try {
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      const res = await proxy.waitForResponse(1)
      expect(res['result']).toMatchObject({ serverInfo: { name: 'fixture' } })
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('curates tools/list per the workspace allowlist (allowed tool kept, denied tool hidden)', async () => {
    const proxy = startProxy(
      ['--workspace-id', 'ws_curation', '--server-name', 'remote-http-curation', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort),
    )
    try {
      // Give the policy client's initial background refresh a moment to land
      // before the request that depends on it.
      await new Promise((r) => setTimeout(r, 300))
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      const res = await proxy.waitForResponse(1)
      const result = res['result'] as { tools: Array<{ name: string }> }
      const names = result.tools.map((t) => t.name)
      expect(names).toContain('safe_tool')
      expect(names).not.toContain('dangerous_tool')
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('allows a tools/call the interceptor permits, and blocks one an SOP rule denies', async () => {
    const proxy = startProxy(
      ['--workspace-id', 'ws_block', '--server-name', 'remote-http-block', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort),
    )
    try {
      await new Promise((r) => setTimeout(r, 300))

      proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe_tool', arguments: {} } })
      const allowed = await proxy.waitForResponse(1)
      expect(allowed['error']).toBeUndefined()
      expect((allowed['result'] as { content: Array<{ text: string }> }).content[0]?.text).toBe('safe result')

      proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } })
      const blocked = await proxy.waitForResponse(2)
      expect(blocked['result']).toBeUndefined()
      expect((blocked['error'] as { message: string }).message).toContain('Dangerous tool blocked in test')
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('redacts a DLP-matched secret out of a tools/call result before it reaches the harness', async () => {
    const proxy = startProxy(
      ['--workspace-id', 'ws_dlp', '--server-name', 'remote-http-dlp', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort),
    )
    try {
      await new Promise((r) => setTimeout(r, 300))
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'leaky_tool', arguments: {} } })
      const res = await proxy.waitForResponse(1)
      const text = (res['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? ''
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx')
      expect(text).toContain('[REDACTED_SECRET]')
      expect(proxy.stderrLines.some((l) => l.includes('"action":"result_redacted"'))).toBe(true)
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('forwards INTUTIC_REMOTE_HEADERS as an Authorization header on every request to the remote server', async () => {
    seenHeaders.length = 0
    const proxy = startProxy(
      ['--workspace-id', 'ws_auth', '--server-name', 'remote-http-auth', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort, { INTUTIC_REMOTE_HEADERS: JSON.stringify({ Authorization: 'Bearer test-bridge-token' }) }),
    )
    try {
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      await proxy.waitForResponse(1)
      expect(seenHeaders.some((h) => h.authorization === 'Bearer test-bridge-token')).toBe(true)
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('pins tool definitions on first contact (TOFU) and, in fail-open mode, forwards a later mismatch with a warning rather than blocking it', async () => {
    const args = ['--workspace-id', 'ws_tofu_open', '--server-name', 'remote-http-tofu-open', '--remote-url', `http://127.0.0.1:${remotePort}`]
    const env = baseEnv(home, cpPort) // no runtime.env written — failOpen defaults to true

    const first = startProxy(args, env)
    try {
      first.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      await first.waitForResponse(1)
      expect(first.stderrLines.some((l) => l.includes('"action":"tofu_first_contact"'))).toBe(true)
    } finally {
      await first.stop()
    }

    const pinPath = path.join(home, '.intutic', 'mcp-pins', 'ws_tofu_open__remote-http-tofu-open.json')
    expect(fs.existsSync(pinPath)).toBe(true)

    // Second process, same $HOME (same pin), remote server now serving a
    // CHANGED tools/list — a rug pull.
    const changedRemote = createHttpFixture(makeHandler({ toolsList: TOOLS_V2_CHANGED }))
    const changedPort = await listen(changedRemote)
    try {
      const second = startProxy(
        ['--workspace-id', 'ws_tofu_open', '--server-name', 'remote-http-tofu-open', '--remote-url', `http://127.0.0.1:${changedPort}`],
        env,
      )
      try {
        second.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        const res = await second.waitForResponse(1)
        // Fail-open: forwarded despite the mismatch, not replaced with a block frame.
        expect(res['error']).toBeUndefined()
        expect(second.stderrLines.some((l) => l.includes('"action":"mcp_server_definition_changed"'))).toBe(true)
      } finally {
        await second.stop()
      }
    } finally {
      await new Promise<void>((resolve) => changedRemote.close(() => resolve()))
    }
  }, 20_000)

  it('blocks a later TOFU mismatch outright when the workspace is fail-closed', async () => {
    await fsp.mkdir(path.join(home, '.intutic', 'env'), { recursive: true })
    // Fail-closed applies to THIS workspace/server's runtime.env — write it,
    // run the two spawns, and restore fail-open (the default the rest of
    // this describe block's later tests, if any ran after this, would expect).
    await fsp.writeFile(path.join(home, '.intutic', 'env', 'runtime.env'), 'INTUTIC_MCP_FAIL_OPEN=false\n', 'utf-8')

    const args = ['--workspace-id', 'ws_tofu_closed', '--server-name', 'remote-http-tofu-closed', '--remote-url', `http://127.0.0.1:${remotePort}`]
    const env = baseEnv(home, cpPort)

    const first = startProxy(args, env)
    try {
      first.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      await first.waitForResponse(1)
    } finally {
      await first.stop()
    }

    const changedRemote = createHttpFixture(makeHandler({ toolsList: TOOLS_V2_CHANGED }))
    const changedPort = await listen(changedRemote)
    try {
      const second = startProxy(
        ['--workspace-id', 'ws_tofu_closed', '--server-name', 'remote-http-tofu-closed', '--remote-url', `http://127.0.0.1:${changedPort}`],
        env,
      )
      try {
        second.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        const res = await second.waitForResponse(1)
        expect(res['result']).toBeUndefined()
        expect((res['error'] as { message: string }).message).toContain('Blocked by workspace policy (fail-closed mode)')
      } finally {
        await second.stop()
      }
    } finally {
      await new Promise<void>((resolve) => changedRemote.close(() => resolve()))
      await fsp.rm(path.join(home, '.intutic', 'env', 'runtime.env'), { force: true })
    }
  }, 20_000)
})

describe('remote bridge — SSE transport', () => {
  let cp: http.Server
  let cpPort: number
  let remote: http.Server
  let remotePort: number
  let home: string
  const seenHeaders: http.IncomingHttpHeaders[] = []

  beforeAll(async () => {
    home = await makeTempHome('intutic-remote-bridge-sse-')
    cp = createMockControlPlane({
      ws_sse_plain: {},
      ws_sse_curation: { allowedTools: ['safe_tool'] },
      ws_sse_block: { sopRules: [{ id: 'r-block', toolPattern: '^dangerous_tool$', action: 'block', reason: 'Dangerous tool blocked in SSE test' }] },
      ws_sse_auth: {},
    })
    cpPort = await listen(cp)

    remote = createSseFixture(makeHandler({
      toolsList: TOOLS_V1,
      toolCallResults: {
        safe_tool: { content: [{ type: 'text', text: 'safe result' }] },
        dangerous_tool: { content: [{ type: 'text', text: 'dangerous result' }] },
      },
      seenHeaders,
    }))
    remotePort = await listen(remote)
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => cp.close(() => resolve()))
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    await fsp.rm(home, { recursive: true, force: true })
  })

  it('completes an MCP initialize round-trip and curates tools/list over SSE', async () => {
    const proxy = startProxy(
      [
        '--workspace-id', 'ws_sse_curation', '--server-name', 'remote-sse-curation',
        '--remote-url', `http://127.0.0.1:${remotePort}`, '--remote-transport', 'sse',
      ],
      baseEnv(home, cpPort),
    )
    try {
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      await proxy.waitForResponse(1)

      await new Promise((r) => setTimeout(r, 300))
      proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const res = await proxy.waitForResponse(2)
      const names = (res['result'] as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
      expect(names).toContain('safe_tool')
      expect(names).not.toContain('dangerous_tool')
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('allows and blocks tools/call over SSE the same way the streamable-HTTP transport does', async () => {
    const proxy = startProxy(
      [
        '--workspace-id', 'ws_sse_block', '--server-name', 'remote-sse-block',
        '--remote-url', `http://127.0.0.1:${remotePort}`, '--remote-transport', 'sse',
      ],
      baseEnv(home, cpPort),
    )
    try {
      await new Promise((r) => setTimeout(r, 300))

      proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe_tool', arguments: {} } })
      const allowed = await proxy.waitForResponse(1)
      expect(allowed['error']).toBeUndefined()

      proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } })
      const blocked = await proxy.waitForResponse(2)
      expect((blocked['error'] as { message: string }).message).toContain('Dangerous tool blocked in SSE test')
    } finally {
      await proxy.stop()
    }
  }, 15_000)

  it('forwards INTUTIC_REMOTE_HEADERS on the SSE connection and its POST messages', async () => {
    seenHeaders.length = 0
    const proxy = startProxy(
      [
        '--workspace-id', 'ws_sse_auth', '--server-name', 'remote-sse-auth',
        '--remote-url', `http://127.0.0.1:${remotePort}`, '--remote-transport', 'sse',
      ],
      baseEnv(home, cpPort, { INTUTIC_REMOTE_HEADERS: JSON.stringify({ Authorization: 'Bearer sse-bridge-token' }) }),
    )
    try {
      proxy.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      await proxy.waitForResponse(1)
      expect(seenHeaders.some((h) => h.authorization === 'Bearer sse-bridge-token')).toBe(true)
    } finally {
      await proxy.stop()
    }
  }, 15_000)
})

describe('remote bridge — daemon proxy mode', () => {
  let cp: http.Server
  let cpPort: number
  let remote: http.Server
  let remotePort: number
  let home: string
  let socketPath: string
  let server: net.Server
  let startBatcher: () => void
  let stopBatcher: () => Promise<void>

  beforeAll(async () => {
    home = await makeTempHome('intutic-remote-bridge-daemon-')
    socketPath = path.join(os.tmpdir(), `mcp-remote-bridge-daemon-${Date.now()}.sock`)
    await fsp.rm(socketPath, { force: true })

    cp = createMockControlPlane({
      ws_daemon: { sopRules: [{ id: 'r-block', toolPattern: '^dangerous_tool$', action: 'block', reason: 'Dangerous tool blocked via daemon socket' }] },
    })
    cpPort = await listen(cp)

    remote = createHttpFixture(makeHandler({
      toolsList: TOOLS_V1,
      toolCallResults: {
        safe_tool: { content: [{ type: 'text', text: 'safe result' }] },
        dangerous_tool: { content: [{ type: 'text', text: 'dangerous result' }] },
      },
    }))
    remotePort = await listen(remote)

    // Same daemon process this package already runs in daemon mode — started
    // in-process (not spawned) the same way daemon-shim.test.ts does, with
    // CONTROL_PLANE_URL pointed at our mock CP before the module is imported
    // (its module-level constants are read at import time).
    process.env['MCP_DAEMON_SOCKET'] = socketPath
    process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${cpPort}`
    process.env['INTUTIC_API_KEY'] = 'daemon-api-key'
    const socketServerModule = await import('../../daemon/socketServer.js')
    const batcherModule = await import('../../daemon/telemetryBatcher.js')
    startBatcher = batcherModule.startBatcher
    stopBatcher = batcherModule.stopBatcher
    server = socketServerModule.createSocketServer()
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
    startBatcher()
  }, 30_000)

  afterAll(async () => {
    await stopBatcher()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => cp.close(() => resolve()))
    await new Promise<void>((resolve) => remote.close(() => resolve()))
    await fsp.rm(socketPath, { force: true })
    await fsp.rm(home, { recursive: true, force: true })
  })

  it('enforces workspace SOP policy delivered over the daemon socket, in remote bridge mode, exactly as stdio daemon mode does', async () => {
    // The proxy binary reads INTUTIC_MCP_PROXY_MODE=daemon from
    // ~/.intutic/env/runtime.env (config.ts), not from process.env directly —
    // MUST be written before the child spawns, or it may start in
    // per-session mode and never see this file.
    await fsp.mkdir(path.join(home, '.intutic', 'env'), { recursive: true })
    await fsp.writeFile(path.join(home, '.intutic', 'env', 'runtime.env'), 'INTUTIC_MCP_PROXY_MODE=daemon\n', 'utf-8')

    const proxy = startProxy(
      ['--workspace-id', 'ws_daemon', '--server-name', 'remote-daemon', '--remote-url', `http://127.0.0.1:${remotePort}`],
      baseEnv(home, cpPort, { MCP_DAEMON_SOCKET: socketPath }),
    )

    try {
      await new Promise((r) => setTimeout(r, 300))

      proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'safe_tool', arguments: {} } })
      const allowed = await proxy.waitForResponse(1)
      expect(allowed['error']).toBeUndefined()

      proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } })
      const blocked = await proxy.waitForResponse(2)
      expect((blocked['error'] as { message: string }).message).toContain('Dangerous tool blocked via daemon socket')
    } finally {
      await proxy.stop()
      await fsp.rm(path.join(home, '.intutic', 'env', 'runtime.env'), { force: true })
    }
  }, 20_000)
})
