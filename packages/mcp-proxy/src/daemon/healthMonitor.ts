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

const CP_URL          = process.env['CONTROL_PLANE_URL'] ?? 'http://localhost:3001'
const DAEMON_API_KEY  = process.env['INTUTIC_API_KEY']   ?? ''
const WORKSPACE_ID    = process.env['INTUTIC_WORKSPACE_ID'] ?? ''

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
      const parsed = JSON.parse(raw)
      const mcpServers = parsed.mcpServers ?? parsed.mcp ?? {}
      for (const [name, entry] of Object.entries(mcpServers)) {
        if (name === 'intutic') continue // Skip self
        const serverEntry = entry as any
        
        let url = ''
        if (serverEntry.url) {
          url = serverEntry.url
        } else if (serverEntry.command) {
          url = `stdio://${serverEntry.command}`
        }

        if (url && !discovered.some(s => s.name === name)) {
          discovered.push({
            name,
            url,
            credentialExpiryAt: undefined
          })
        }
      }
    } catch {}
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

async function uploadSnapshots(snapshots: McpServerHealth[]): Promise<void> {
  if (snapshots.length === 0 || !WORKSPACE_ID) return
  const body = JSON.stringify({ mcpServers: snapshots })
  const url = new URL('/api/v1/mcp-daemon/health-snapshot', CP_URL)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  return new Promise((resolve) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${DAEMON_API_KEY}`,
          'x-workspace-id': WORKSPACE_ID
        }
      },
      (res: any) => {
        res.resume()
        resolve()
      }
    )
    req.on('error', () => resolve())
    req.setTimeout(5000, () => { req.destroy(); resolve() })
    req.write(body)
    req.end()
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
    if (snapshots.length > 0) {
      await uploadSnapshots(snapshots)
    }
  }, HEARTBEAT_MS)
  timer.unref()
}

export function stopHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}

export function getHealthSnapshot(): McpServerHealth[] {
  return Array.from(latestHealth.values())
}
