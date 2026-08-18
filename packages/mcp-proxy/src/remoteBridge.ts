/**
 * remoteBridge.ts — stdio→HTTP/SSE bridge for the MCP governance proxy.
 *
 * The harness still spawns `@intutic/mcp-governance-proxy` as an ordinary
 * stdio child process — nothing about how a harness launches this proxy
 * changes, no new listener or port is opened, and there is no daemon-
 * lifecycle change. What changes is the UPSTREAM side: instead of spawning a
 * child process and talking to its stdin/stdout (proxy.ts's `runProxy`),
 * this module talks to a remote MCP server over HTTP or SSE using the MCP
 * SDK's client transports (`SSEClientTransport` / `StreamableHTTPClientTransport`),
 * used RAW — never wrapped in the SDK's `Client` class, which would present a
 * filtered view of the protocol rather than every message this proxy's
 * governance pipeline needs to see.
 *
 * Architecture:
 *   Harness stdin  → [handleHarnessLine, proxy.ts] → transport.send()
 *   transport.onmessage → [handleServerLine, proxy.ts] → Harness stdout
 *
 * Both directions delegate to the exact functions `proxy.ts`'s stdio mode
 * uses — `handleHarnessLine` (a free function, parameterized by a `forward`
 * callback) and `handleServerLine` (a public method on `McpGovernanceProxy`,
 * built from the SAME `ProxyConfig` this module receives). TOFU pinning, DLP
 * redaction, tools/list curation, and event emission therefore apply
 * identically regardless of which upstream transport is in play — this
 * module supplies a different upstream and a different `forward`, nothing
 * about the governance pipeline itself is reimplemented.
 *
 * CRITICAL: Never write to process.stdout except for valid JSON-RPC frames —
 *           same invariant proxy.ts documents; all logging goes to stderr
 *           via stderrLog.ts.
 *
 * @module
 */

import * as node_readline from 'node:readline'
import { createStderrLogger as createLogger } from './stderrLog.js'
import type { ProxyConfig } from './config.js'
import { McpGovernanceProxy, handleHarnessLine, type PendingRequest } from './proxy.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

const log = createLogger('mcp-remote-bridge')

/**
 * Build the raw SDK client transport for `config.remoteUrl` /
 * `config.remoteTransport`. "Raw" is deliberate: this is the `Transport`
 * interface's `start`/`send`/`close`/`onmessage`/`onerror`/`onclose` surface
 * only, never handed to the SDK's `Client` class — `Client` negotiates and
 * filters the protocol on the caller's behalf, which is exactly the
 * transparency this governance proxy cannot give up. Auth headers ride via
 * `requestInit.headers`, which both transports merge into every request they
 * make (including SSE's initial `EventSource` connection, confirmed by
 * reading the installed SDK's `_commonHeaders`/`_startOrAuth` — not merely
 * assumed from the public types).
 */
function buildRemoteTransport(config: ProxyConfig): Transport {
  const url = new URL(config.remoteUrl!)
  const hasHeaders = Object.keys(config.remoteHeaders).length > 0
  const opts = hasHeaders ? { requestInit: { headers: config.remoteHeaders } } : undefined

  return config.remoteTransport === 'sse'
    ? new SSEClientTransport(url, opts)
    : new StreamableHTTPClientTransport(url, opts)
}

/**
 * Run the proxy in remote bridge mode: connect to `config.remoteUrl` over
 * HTTP or SSE and proxy the harness's stdio traffic through it, applying the
 * identical governance pipeline `runProxy` (proxy.ts) applies to a spawned
 * stdio child process.
 *
 * On connect failure (remote server unreachable, auth rejected, TLS error,
 * etc.) this logs the failure and rethrows — mirroring the existing failure
 * surface for a stdio command that doesn't exist: `runProxy`'s spawned child
 * process emits `error` on ENOENT, logs `real_server_error`, and rejects the
 * promise `run()` returns, which `index.ts`'s `main()` catches as
 * `proxy_fatal` and exits 1. This function rethrows into that SAME catch
 * block rather than calling `process.exit` itself, so both failure modes
 * surface through one place with one log shape.
 */
export async function runRemoteProxy(config: ProxyConfig): Promise<void> {
  if (config.remoteUrl === undefined) {
    throw new Error('runRemoteProxy called without config.remoteUrl')
  }

  log.info(
    {
      action: 'remote_bridge_start',
      remoteUrl: config.remoteUrl,
      remoteTransport: config.remoteTransport ?? 'http',
      workspaceId: config.workspaceId,
      serverName: config.serverName,
    },
    'Starting MCP governance remote bridge',
  )

  const proxy = new McpGovernanceProxy(config)
  const interceptor = proxy.getInterceptor()

  // Requests whose responses this proxy must inspect on the way back — same
  // role, same shape, as `runProxy`'s own `pending` map.
  const pending = new Map<string | number, PendingRequest>()

  const transport = buildRemoteTransport(config)

  let shuttingDown = false

  // Callbacks MUST be installed before `transport.start()` — the `Transport`
  // interface's own contract (see shared/transport.ts) is that starting
  // before callbacks are wired can lose messages. `onclose`'s `shutdown` call
  // is wired up below, once `shutdown` exists — the SDK only ever fires
  // `onclose` asynchronously, well after this synchronous setup completes.
  transport.onmessage = (message: JSONRPCMessage) => {
    void proxy.handleServerLine(JSON.stringify(message), pending)
  }
  transport.onerror = (err: Error) => {
    log.error({ action: 'remote_transport_error', err: err.message }, 'Remote MCP transport error')
  }

  try {
    await transport.start()
  } catch (err) {
    log.error(
      {
        action: 'remote_connect_error',
        err: (err as Error).message,
        remoteUrl: config.remoteUrl,
        remoteTransport: config.remoteTransport ?? 'http',
      },
      'Failed to connect to remote MCP server',
    )
    // Rethrow — see this function's doc comment: index.ts's existing
    // proxy_fatal/exit(1) catch is the shared failure surface, not a second one.
    throw err
  }

  proxy.startPolicy()

  // Harness stdin → governance interceptor → remote transport. Delegates to
  // the exact `handleHarnessLine` proxy.ts's stdio mode uses; `forward` here
  // parses the line back to a JSON-RPC message object (transports send
  // structured messages, not raw text) and hands it to `transport.send()`.
  // Created before `shutdown`/`onclose`/signal handlers below are wired up so
  // none of them can ever reference `rl` before it exists.
  const rl = node_readline.createInterface({ input: process.stdin, terminal: false })

  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ action: 'remote_bridge_shutdown', reason }, 'Shutting down MCP governance remote bridge')
    proxy.stopPolicy()
    rl.close()
    transport.close().catch(() => {
      // Already shutting down — a close-of-a-closing-transport error changes nothing.
    })
    process.exit(exitCode)
  }

  transport.onclose = () => {
    if (!shuttingDown) {
      log.error(
        { action: 'remote_transport_closed_unexpectedly' },
        'Remote MCP server connection closed unexpectedly — shutting down',
      )
      shutdown('remote_closed', 1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  rl.on('line', (line) => {
    handleHarnessLine(line, pending, interceptor, (forwardedLine) => {
      let message: JSONRPCMessage
      try {
        message = JSON.parse(forwardedLine) as JSONRPCMessage
      } catch {
        // handleHarnessLine already parsed this line once to reach `forward`
        // at all, so a re-parse failure here is not expected — fail loud via
        // stderr rather than silently dropping a message the remote server
        // will never see.
        log.error(
          { action: 'remote_forward_parse_error', line: forwardedLine.slice(0, 100) },
          'Failed to re-parse an already-validated JSON-RPC line before sending to remote server',
        )
        return
      }
      transport.send(message).catch((err: unknown) => {
        log.error(
          { action: 'remote_send_error', err: (err as Error).message },
          'Failed to send message to remote MCP server',
        )
      })
    })
  })

  rl.on('close', () => {
    log.info({ action: 'stdin_closed' }, 'Harness stdin closed — shutting down remote bridge')
    shutdown('stdin_closed')
  })

  // Keep the process alive until `shutdown()` calls `process.exit()` — stdin
  // close, a signal, or the remote transport closing unexpectedly.
  await new Promise<never>(() => {})
}
