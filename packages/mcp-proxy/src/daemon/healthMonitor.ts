/**
 * MCP Server Health Monitor
 *
 * Probes MCP servers every 30s and records health snapshots.
 * Emits mcp_daemon.mcp_server_down when a server becomes unreachable.
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 * @module
 */
import https from 'node:https'
import http  from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createLogger } from '@intutic/logger'

const logger = createLogger('mcp-proxy.healthMonitor')

const HEARTBEAT_MS = 30_000
const PROBE_TIMEOUT = 5_000

// CP_URL / INTUTIC_API_KEY / INTUTIC_WORKSPACE_ID are deliberately not read
// here. They existed only for uploadSnapshots(), removed in 514eff7c because
// its target route (/api/v1/mcp-daemon/health-snapshot) is not in the control
// plane. The only outbound request left in this module is probeServer(), which
// hits third-party MCP servers named in the user's local harness config —
// attaching the Intutic workspace credential to those would send it to hosts
// Intutic does not control. If snapshot upload comes back, the key belongs on
// the control-plane request, not on the probe.

export interface McpServerConfig {
  name:     string
  url:      string
  credentialExpiryAt?: Date
}

export interface McpServerHealth {
  serverName:          string
  status:              'healthy' | 'degraded' | 'unreachable'
  p95LatencyMs?:       number
  errorRatePct?:       number
  credentialExpiryAt?: string
  checkedAt:           string
}

const servers: McpServerConfig[] = []
const latestHealth = new Map<string, McpServerHealth>()
let timer: ReturnType<typeof setInterval> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pulls the server map out of a parsed harness config. The file is written by
 * Claude Code / Claude Desktop / Cursor, not by us, so its contents are
 * `unknown` until checked: `mcpServers` (or the older `mcp`) may be absent, or
 * be a scalar or an array rather than an object.
 */
function readServerMap(parsed: unknown): Record<string, unknown> {
  if (!isRecord(parsed)) return {}
  const map = parsed['mcpServers'] ?? parsed['mcp']
  return isRecord(map) ? map : {}
}

/**
 * Derives a probe URL from one entry of a harness config's server map.
 * Returns '' when the entry declares neither a usable `url` nor `command`.
 */
function entryToUrl(entry: unknown): string {
  if (!isRecord(entry)) return ''
  const url = entry['url']
  if (typeof url === 'string' && url.length > 0) return url
  const command = entry['command']
  if (typeof command === 'string' && command.length > 0) return `stdio://${command}`
  return ''
}

function discoverServers(): McpServerConfig[] {
  const discovered: McpServerConfig[] = []
  const homedir = os.homedir()

  const configPaths = [
    path.join(homedir, '.claude', 'mcp.json'),
    process.platform === 'darwin'
      ? path.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
      : path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'),
    process.platform === 'darwin'
      ? path.join(homedir, 'Library', 'Application Support', 'Cursor', 'User', 'globalSettings.json')
      : process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? '', 'Cursor', 'User', 'globalSettings.json')
      : path.join(homedir, '.config', 'Cursor', 'User', 'globalSettings.json'),
  ]

  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue
      const raw = fs.readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      for (const [name, entry] of Object.entries(readServerMap(parsed))) {
        if (name === 'intutic') continue // Skip self

        const url = entryToUrl(entry)

        if (url && !discovered.some(s => s.name === name)) {
          discovered.push({
            name,
            url,
            credentialExpiryAt: undefined
          })
        }
      }
    } catch {
      // This config path belongs to a harness the user may not have installed,
      // so an unreadable or malformed file is the expected case, not an error:
      // discovery probes Claude Code, Claude Desktop and Cursor locations and
      // most machines have only one. Skip this path and keep discovering the
      // others — a parse failure on one config must not cost us the servers
      // declared in the rest.
    }
  }

  return discovered
}

async function probeServer(server: McpServerConfig): Promise<McpServerHealth> {
  const start = Date.now()
  if (server.url.startsWith('stdio://')) {
    const cmd = server.url.replace('stdio://', '')
    let status: 'healthy' | 'unreachable' = 'healthy'
    try {
      const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
      execSync(whichCmd, { stdio: 'ignore' })
    } catch {
      status = 'unreachable'
    }
    return {
      serverName: server.name,
      status,
      p95LatencyMs: Date.now() - start,
      credentialExpiryAt: server.credentialExpiryAt?.toISOString(),
      checkedAt: new Date().toISOString()
    }
  }

  return new Promise((resolve) => {
    try {
      const url   = new URL(server.url)
      const isHttps = url.protocol === 'https:'
      const lib   = isHttps ? https : http
      const req   = lib.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
        (res) => {
          res.resume()
          const latency = Date.now() - start
          const status  = res.statusCode && res.statusCode < 500 ? 'healthy' : 'degraded'
          resolve({ serverName: server.name, status, p95LatencyMs: latency,
            credentialExpiryAt: server.credentialExpiryAt?.toISOString(),
            checkedAt: new Date().toISOString() })
        }
      )
      req.on('error', () => resolve({ serverName: server.name, status: 'unreachable',
        checkedAt: new Date().toISOString() }))
      req.setTimeout(PROBE_TIMEOUT, () => { req.destroy(); resolve({
        serverName: server.name, status: 'unreachable', checkedAt: new Date().toISOString() }) })
      req.end()
    } catch {
      resolve({ serverName: server.name, status: 'unreachable', checkedAt: new Date().toISOString() })
    }
  })
}


export function registerServer(server: McpServerConfig): void {
  servers.push(server)
}

export function startHealthMonitor(): void {
  // Run config discovery
  const discovered = discoverServers()
  for (const s of discovered) {
    registerServer(s)
  }

  timer = setInterval(async () => {
    const snapshots: McpServerHealth[] = []
    for (const server of servers) {
      const health = await probeServer(server)
      const prev   = latestHealth.get(server.name)
      latestHealth.set(server.name, health)
      snapshots.push(health)
      if (health.status === 'unreachable' && prev?.status !== 'unreachable') {
        logger.warn({ serverName: server.name }, 'mcp_daemon.mcp_server_down')
      }
    }
    // Health stays local: getHealthSnapshot()/latestHealth serve the proxy's
    // own health_check. The former uploader posted to
    // /api/v1/mcp-daemon/health-snapshot, a route stripped from the control
    // plane — every 30s heartbeat silently 404'd and the snapshots were
    // discarded. Restore an ingest route before re-adding an upload.
  }, HEARTBEAT_MS)
  timer.unref()
}

export function stopHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}

export function getHealthSnapshot(): McpServerHealth[] {
  return Array.from(latestHealth.values())
}
