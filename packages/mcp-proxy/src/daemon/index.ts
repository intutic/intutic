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
import fs   from 'node:fs'
import path from 'node:path'
import os   from 'node:os'
import { createLogger } from '@intutic/logger'
import { startBatcher, stopBatcher } from './telemetryBatcher.js'
import { startHealthMonitor, stopHealthMonitor } from './healthMonitor.js'
import { createSocketServer, getSocketPath } from './socketServer.js'

const logger = createLogger('intutic-mcp-daemon')
const PID_FILE = path.join(os.homedir(), '.intutic', 'mcp-daemon.pid')

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

async function main(): Promise<void> {
  const socketPath = getSocketPath()
  logger.info({ pid: process.pid, socketPath }, 'mcp_daemon.starting')

  // Ensure ~/.intutic directory exists with correct permissions
  ensureDir(path.dirname(socketPath))

  // Remove stale socket file
  try { fs.unlinkSync(socketPath) } catch {}

  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })

  // Start subsystems
  startBatcher()
  startHealthMonitor()

  const server = createSocketServer()
  server.listen(socketPath, () => {
    // Restrict socket to owner only
    try { fs.chmodSync(socketPath, 0o600) } catch {}
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
    await stopBatcher()
    try { fs.unlinkSync(socketPath) } catch {}
    try { fs.unlinkSync(PID_FILE) }    catch {}
    logger.info('mcp_daemon.stopped')
    process.exit(0)
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT',  () => { void shutdown('SIGINT')  })
}

void main()
