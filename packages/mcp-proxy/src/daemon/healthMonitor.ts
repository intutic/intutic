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
// Intutic does not control. The upload lives in statusReporter.ts, which puts
// the key on the control-plane request only.

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

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * The server maps Claude Code reads: `~/.claude.json` holds the user-scope
 * `mcpServers` and, under `projects[<path>]`, each project's local-scope
 * `mcpServers`; the project-scope ones live in `<path>/.mcp.json`, which the
 * daemon finds through the same project paths. (`~/.claude/mcp.json`, read
 * here before, is not a file Claude Code uses.) The sync daemon wraps the
 * first two (services/sync-daemon/src/harness/mcpAutoWrite.ts) and governs a
 * project's `.mcp.json` through local-scope shadows of its approved servers,
 * never writing the shared file — so a server not yet approved is unwrapped,
 * and belongs in the registry report all the same.
 */
function claudeCodeServerMaps(home: string): Array<Record<string, unknown>> {
  let state: unknown
  try {
    state = readJson(path.join(home, '.claude.json'))
  } catch {
    return [] // Claude Code not set up on this machine
  }
  if (!isRecord(state)) return []
  const maps = [readServerMap(state)]
  const projects = state['projects']
  if (isRecord(projects)) {
    for (const [projectPath, project] of Object.entries(projects)) {
      maps.push(readServerMap(project))
      try {
        maps.push(readServerMap(readJson(path.join(projectPath, '.mcp.json'))))
      } catch {
        // Most projects have no .mcp.json; an unreadable one costs only its own servers.
      }
    }
  }
  return maps
}

/** Exported for tests; `home` defaults to the user's home directory. */
export function discoverServers(home: string = os.homedir()): McpServerConfig[] {
  const discovered: McpServerConfig[] = []

  const configPaths = [
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalSettings.json')
      : process.platform === 'win32'
      ? path.join(process.env['APPDATA'] ?? '', 'Cursor', 'User', 'globalSettings.json')
      : path.join(home, '.config', 'Cursor', 'User', 'globalSettings.json'),
  ]

  const maps = [...claudeCodeServerMaps(home)]
  for (const configPath of configPaths) {
    try {
      if (!fs.existsSync(configPath)) continue
      maps.push(readServerMap(readJson(configPath)))
    } catch {
      // This config path belongs to a harness the user may not have installed,
      // so an unreadable or malformed file is the expected case, not an error:
      // discovery probes Claude Code, Claude Desktop and Cursor locations and
      // most machines have only one. Skip this path and keep discovering the
      // others — a parse failure on one config must not cost us the servers
      // declared in the rest.
    }
  }

  for (const map of maps) {
    for (const [name, entry] of Object.entries(map)) {
      if (name === 'intutic') continue // Skip self
      const url = entryToUrl(entry)
      if (url && !discovered.some((s) => s.name === name)) {
        discovered.push({ name, url, credentialExpiryAt: undefined })
      }
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
    // statusReporter.ts uploads these through getHealthSnapshot() to
    // POST /api/v1/mcp-daemon/report, which also records each server in the
    // workspace's MCP server registry.
  }, HEARTBEAT_MS)
  timer.unref()
}

export function stopHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}

export function getHealthSnapshot(): McpServerHealth[] {
  return Array.from(latestHealth.values())
}
