/**
 * intutic-mcp-daemon entry point
 *
 * Long-lived process listening on ~/.intutic/mcp-proxy.sock.
 * Manages policy cache, telemetry batching, and MCP server health monitoring.
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 *
 * Usage:
 *   node dist/daemon/index.js
 *   (managed by LaunchAgent / systemd via `intutic daemon mcp start`)
 *
 * @module
 */
// Must be first: OTel instrumentation needs to monkey-patch before other
// modules import the libraries it instruments. No-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set. Deliberately not imported by
// src/index.ts (the stdio JSON-RPC proxy) -- see instrumentation.ts's
// own doc comment for why.
import './instrumentation.js'

import fs   from 'node:fs'
import path from 'node:path'
import os   from 'node:os'
import { createLogger } from '@intutic/logger'
import { startBatcher, stopBatcher } from './telemetryBatcher.js'
import { startHealthMonitor, stopHealthMonitor } from './healthMonitor.js'
import { startStatusReporter, stopStatusReporter } from './statusReporter.js'
import { createSocketServer, getSocketPath } from './socketServer.js'

const logger = createLogger('intutic-mcp-daemon')
const PID_FILE = path.join(os.homedir(), '.intutic', 'mcp-daemon.pid')

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

async function main(): Promise<void> {
  const socketPath = getSocketPath()
  logger.info({ pid: process.pid, socketPath }, 'mcp_daemon.starting')

  // Ensure the socket's own directory exists with correct permissions. This is
  // ~/.intutic only by default: MCP_DAEMON_SOCKET (honoured by getSocketPath())
  // can put the socket anywhere, so this call says nothing about where the PID
  // file lives. The PID file's directory is ensured separately below.
  ensureDir(path.dirname(socketPath))

  // Remove stale socket file
  try {
    fs.unlinkSync(socketPath)
  } catch {
    // ENOENT — no socket left by a previous run. That is the normal clean
    // start, so there is nothing to report. A removal failure for any other
    // reason is not actually swallowed: listen() below then fails with
    // EADDRINUSE and the server 'error' handler exits the process.
  }

  // Write PID file. PID_FILE always lives under ~/.intutic, which is a
  // different directory from the socket's whenever MCP_DAEMON_SOCKET is set —
  // so it needs its own ensureDir, or this write is an ENOENT out of main().
  ensureDir(path.dirname(PID_FILE))
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })

  // Seed the policy cache from the local snapshot before accepting connections.
  //
  // Without it the first tool call after every daemon restart pays a blocking
  // HTTP GET with a 5s socket timeout, on the agent's critical path. The sync
  // daemon has already written the same policy locally.
  //
  // Awaited rather than fired-and-forgotten so the seed is in place before the
  // socket accepts anything — a race here would just reintroduce the cold fetch
  // it exists to remove. It never throws and never blocks on the network; a
  // missing snapshot returns null and the cold path stands.
  const { seedFromSnapshot } = await import('./policyCache.js')
  const seeded = await seedFromSnapshot()
  if (seeded) logger.info({ workspaceId: seeded }, 'mcp_daemon.policy_seeded')

  // Start subsystems
  startBatcher()
  startHealthMonitor()
  startStatusReporter()

  const server = createSocketServer()
  server.listen(socketPath, () => {
    // Restrict socket to owner only
    try {
      fs.chmodSync(socketPath, 0o600)
    } catch (err) {
      // Platforms without unix-socket file permissions (Windows named pipes)
      // fail here, so this must not be fatal. It is still worth surfacing:
      // ensureDir() only applies mode 0o700 when it creates ~/.intutic, so on
      // a pre-existing looser directory this chmod is the only thing keeping
      // the control socket owner-only.
      logger.warn({ err, socketPath }, 'mcp_daemon.socket_chmod_failed')
    }
    logger.info({ socketPath, pid: process.pid }, 'mcp_daemon.running')
    process.stdout.write(JSON.stringify({ event: 'mcp_daemon.started', pid: process.pid }) + '\n')
  })

  server.on('error', (err) => {
    logger.error({ err }, 'mcp_daemon.socket_error')
    process.exit(1)
  })

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'mcp_daemon.stopping')
    server.close()
    stopHealthMonitor()
    await stopStatusReporter()
    await stopBatcher()
    // Best-effort cleanup: both files are routinely already gone (ENOENT) when
    // an operator or a service manager removed them, or when listen() never
    // got far enough to create the socket. The process is exiting either way,
    // and a leftover file is handled by the stale-socket unlink on next start.
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // socket already removed or never created — nothing to clean up
    }
    try {
      fs.unlinkSync(PID_FILE)
    } catch {
      // pid file already removed or never written — nothing to clean up
    }
    logger.info('mcp_daemon.stopped')
    process.exit(0)
  }

  // Same reasoning as the main().catch below: shutdown() ends in process.exit,
  // so a rejection on the way there leaves the daemon alive and unresponsive
  // until the service manager escalates to SIGKILL. Exit non-zero instead.
  const onSignal = (signal: string) => {
    void shutdown(signal).catch((err: unknown) => {
      logger.error({ err, signal }, 'mcp_daemon.shutdown_failed')
      process.exit(1)
    })
  }

  process.on('SIGTERM', () => { onSignal('SIGTERM') })
  process.on('SIGINT',  () => { onSignal('SIGINT')  })
}

// main() is the whole of startup, and everything it does before listen() —
// ensureDir, the PID write, subsystem start — can throw. Without a handler
// those were an unhandled rejection, which under Node's default mode prints a
// raw V8 stack to stderr and exits 1: the exit status is fine, but nothing goes
// through the structured logger, so the failure carries no mcp_daemon.* event
// for a log pipeline to alert on and no socketPath to point at the cause. Under
// --unhandled-rejections=warn it is worse — the process stays up as a daemon
// that will never listen. Both become one logged event and a definite exit.
main().catch((err: unknown) => {
  logger.error({ err }, 'mcp_daemon.startup_failed')
  process.exit(1)
})
