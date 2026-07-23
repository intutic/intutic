import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import { createSocketServer } from '../../daemon/socketServer.js'
import { callDaemonSocket } from '../../daemonClient.js'
import { PolicyClient } from '../../policy.js'
import { GovernanceEmitter } from '../../emitter.js'

describe('Daemon-Shim Integration Tests', () => {
  const socketPath = path.join(os.tmpdir(), `mcp-daemon-shim-test-${Date.now()}.sock`)
  let server: net.Server
  let mockCp: http.Server
  let cpPort: number
  let lastWorkspaceId: string | null = null
  let telemetryEvents: any[] = []

  beforeAll(async () => {
    process.env['MCP_DAEMON_SOCKET'] = socketPath
    await fs.rm(socketPath, { force: true })

    // Setup mock control plane HTTP server
    mockCp = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      if (url.pathname === '/api/v1/policy/resolve') {
        lastWorkspaceId = url.searchParams.get('workspaceId')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            workspaceId: lastWorkspaceId,
            sopRules: [
              { id: 'rule_xyz', toolPattern: 'Bash', action: 'block', reason: 'Blocked in test' }
            ],
            dlpPatterns: [],
            interventionMode: 'BLOCK'
          })
        )
      } else if (url.pathname === '/api/v1/sop/rules') {
        lastWorkspaceId = url.searchParams.get('workspaceId')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            rules: [
              { id: 'rule_xyz', toolPattern: 'Bash', action: 'block', reason: 'Blocked in test' }
            ]
          })
        )
      } else if (url.pathname === '/api/v1/hook-events') {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          try {
            telemetryEvents.push(JSON.parse(body))
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    await new Promise<void>((resolve) => {
      mockCp.listen(0, '127.0.0.1', () => {
        const addr = mockCp.address() as net.AddressInfo | null
        cpPort = addr?.port ?? 3001
        process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${cpPort}`
        process.env['INTUTIC_API_KEY'] = 'test-api-key'
        resolve()
      })
    })

    // Start daemon socket server
    server = createSocketServer()
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => mockCp.close(() => resolve()))
    await fs.rm(socketPath, { force: true })
  })

  it('client callDaemonSocket requests policy.get and gets cached policy', async () => {
    const res = await callDaemonSocket('policy.get', { workspaceId: 'ws_integration' })
    expect(res).toBeDefined()
    expect(res.workspaceId).toBe('ws_integration')
    expect(res.sopRules).toHaveLength(1)
    expect(res.sopRules[0].id).toBe('rule_xyz')
  })

  it('PolicyClient uses daemon when mcpProxyMode is daemon', async () => {
    const client = new PolicyClient(`http://127.0.0.1:${cpPort}`, 'test-api-key', 'ws_integration', 60000, 'daemon')
    await client.refresh()
    const rules = client.getRules()
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('rule_xyz')
  })

  it('GovernanceEmitter enqueues telemetry to daemon', async () => {
    const emitter = new GovernanceEmitter(`http://127.0.0.1:${cpPort}`, 'test-api-key', 'dummy-path.jsonl', 'ws_integration', 'daemon')
    emitter.emit('tool_blocked', 'Bash', { args: ['rm -rf'] }, 'Blocked in test')
    
    const res = await callDaemonSocket('proxy.health_check', {})
    expect(res.status).toBe('ok')
  })

  it('shim client falls back to direct control plane requests if daemon socket is offline', async () => {
    // Set socket path to invalid location
    process.env['MCP_DAEMON_SOCKET'] = path.join(os.tmpdir(), `nonexistent-${Date.now()}.sock`)
    
    const client = new PolicyClient(`http://127.0.0.1:${cpPort}`, 'test-api-key', 'ws_fallback', 60000, 'daemon')
    await client.refresh()
    const rules = client.getRules()
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe('rule_xyz')
    expect(lastWorkspaceId).toBe('ws_fallback') // hit CP directly
    
    // Restore
    process.env['MCP_DAEMON_SOCKET'] = socketPath
  })
})
