import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import { callDaemonSocket } from '../../daemonClient.js'
import { PolicyClient } from '../../policy.js'
import { GovernanceEmitter } from '../../emitter.js'
import type { ResolvedPolicy } from '../../daemon/policyCache.js'
import type { HookEvent } from '../../daemon/telemetryBatcher.js'

// Type-only views of the daemon modules. Their value imports are dynamic and
// live in beforeAll — see the note there.
type SocketServerModule = typeof import('../../daemon/socketServer.js')
type TelemetryBatcherModule = typeof import('../../daemon/telemetryBatcher.js')

/** One POST /api/v1/hook-events the mock control plane received. */
interface ReceivedBatch {
  authorization: string | undefined
  events: HookEvent[]
}

function isHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['event'] === 'string' &&
    typeof candidate['toolName'] === 'string' &&
    typeof candidate['workspaceId'] === 'string' &&
    typeof candidate['harnessType'] === 'string' &&
    typeof candidate['timestamp'] === 'string'
  )
}

/** Parses a hook-events request body, or returns null if it is not one. */
function parseHookEvents(body: string): HookEvent[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rawEvents: unknown = (parsed as { events?: unknown }).events
  if (!Array.isArray(rawEvents)) return null
  const events: HookEvent[] = []
  for (const raw of rawEvents) {
    if (!isHookEvent(raw)) return null
    events.push(raw)
  }
  return events
}

/** Polls `probe` until it returns a value, or throws once `timeoutMs` elapses. */
async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = probe()
    if (hit !== undefined) return hit
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('Daemon-Shim Integration Tests', () => {
  const socketPath = path.join(os.tmpdir(), `mcp-daemon-shim-test-${Date.now()}.sock`)
  // GovernanceEmitter's dual-path fallback appends here. Nothing should ever
  // write it in this file; the telemetry test asserts it stays absent.
  const fallbackEventsPath = path.join(os.tmpdir(), `mcp-daemon-shim-fallback-${Date.now()}.jsonl`)
  let server: net.Server
  let mockCp: http.Server
  let cpPort: number
  let lastWorkspaceId: string | null = null
  let startBatcher: TelemetryBatcherModule['startBatcher']
  let stopBatcher: TelemetryBatcherModule['stopBatcher']
  const telemetryBatches: ReceivedBatch[] = []
  const malformedTelemetryBodies: string[] = []

  beforeAll(async () => {
    process.env['MCP_DAEMON_SOCKET'] = socketPath
    await fs.rm(socketPath, { force: true })
    await fs.rm(fallbackEventsPath, { force: true })
    // startBatcher() drains ~/.intutic/telemetry-buffer.ndjson into the ring on
    // start; clearing it first keeps a previous run's events out of the batches
    // asserted on below.
    await fs.rm(path.join(os.homedir(), '.intutic', 'telemetry-buffer.ndjson'), { force: true })

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
          const events = parseHookEvents(body)
          if (events) {
            telemetryBatches.push({ authorization: req.headers.authorization, events })
          } else {
            // Recorded, not swallowed. The telemetry test asserts this array
            // stays empty, so a body neither the batcher nor the emitter could
            // have produced fails loudly instead of merely never arriving.
            malformedTelemetryBodies.push(body)
          }
          // Answer 200 either way: the emitter and batcher under test must
          // follow their success paths rather than their fallback paths.
          // Throwing here would escape an HTTP 'end' callback as an uncaught
          // exception and tear down the worker.
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
        process.env['INTUTIC_API_KEY'] = 'daemon-api-key'
        process.env['MCP_DAEMON_TELEMETRY_FLUSH_MS'] = '50'
        resolve()
      })
    })

    // Imported here, not at the top of the file: telemetryBatcher.ts reads
    // CONTROL_PLANE_URL, INTUTIC_API_KEY and MCP_DAEMON_TELEMETRY_FLUSH_MS into
    // module-level constants at import time, and socketServer.ts imports it. A
    // static import would evaluate both before the mock control plane's port is
    // known, freezing CP_URL at the http://localhost:3001 default so no batch
    // could ever reach the mock.
    const socketServerModule: SocketServerModule = await import('../../daemon/socketServer.js')
    const batcherModule: TelemetryBatcherModule = await import('../../daemon/telemetryBatcher.js')
    startBatcher = batcherModule.startBatcher
    stopBatcher = batcherModule.stopBatcher

    // Start daemon socket server
    server = socketServerModule.createSocketServer()
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))

    // daemon/index.ts is the only production caller of startBatcher(), and this
    // file builds the daemon from createSocketServer() directly. Without this
    // call no flush timer exists and enqueued events sit in the batcher's ring
    // forever, which is why the telemetry assertions below used to be absent.
    startBatcher()
  })

  afterAll(async () => {
    await stopBatcher()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => mockCp.close(() => resolve()))
    await fs.rm(socketPath, { force: true })
    await fs.rm(fallbackEventsPath, { force: true })
  })

  it('client callDaemonSocket requests policy.get and gets cached policy', async () => {
    // policy.get answers with the daemon's ResolvedPolicy (socketServer.ts).
    const res = (await callDaemonSocket('policy.get', {
      workspaceId: 'ws_integration',
    })) as ResolvedPolicy | null
    expect(res).toBeDefined()
    expect(res?.workspaceId).toBe('ws_integration')
    expect(res?.sopRules).toHaveLength(1)
    expect(res?.sopRules[0]?.['id']).toBe('rule_xyz')
  })

  it('PolicyClient uses daemon when mcpProxyMode is daemon', async () => {
    const client = new PolicyClient(`http://127.0.0.1:${cpPort}`, 'shim-api-key', 'ws_integration', 60000, 'daemon')
    await client.refresh()
    const rules = client.getRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.id).toBe('rule_xyz')
  })

  it('GovernanceEmitter enqueues telemetry to the daemon, which batches it to the control plane', async () => {
    const emitter = new GovernanceEmitter(
      `http://127.0.0.1:${cpPort}`,
      'shim-api-key',
      fallbackEventsPath,
      'ws_integration',
      'daemon'
    )
    emitter.emit('tool_blocked', 'Bash', { args: ['rm -rf'] }, 'Blocked in test')

    const received = await waitFor(() => {
      for (const batch of telemetryBatches) {
        const event = batch.events.find(
          (e) => e.workspaceId === 'ws_integration' && e.toolName === 'Bash'
        )
        if (event) return { batch, event }
      }
      return undefined
    }, 'the emitted tool_blocked event to reach the mock control plane')

    expect(malformedTelemetryBodies).toEqual([])
    expect(received.event.event).toBe('tool_blocked')
    expect(received.event.harnessType).toBe('mcp-governance-proxy')
    expect(received.event['reason']).toBe('Blocked in test')
    expect(received.event['toolInput']).toEqual({ args: ['rm -rf'] })

    // GovernanceEmitter falls back to its dual path — a direct POST to this
    // same /api/v1/hook-events route, plus a JSONL append — when the daemon
    // socket call fails. Three things separate "the daemon path works" from
    // "the fallback quietly covered for it": the batch carries the daemon's own
    // INTUTIC_API_KEY rather than the emitter's key, only the fallback stamps
    // an incidentId, and only the fallback writes the JSONL file.
    expect(received.batch.authorization).toBe('Bearer daemon-api-key')
    expect(received.event['incidentId']).toBeUndefined()
    await expect(fs.access(fallbackEventsPath)).rejects.toThrow()
  })

  it('shim client falls back to direct control plane requests if daemon socket is offline', async () => {
    // Set socket path to invalid location
    process.env['MCP_DAEMON_SOCKET'] = path.join(os.tmpdir(), `nonexistent-${Date.now()}.sock`)

    const client = new PolicyClient(`http://127.0.0.1:${cpPort}`, 'shim-api-key', 'ws_fallback', 60000, 'daemon')
    await client.refresh()
    const rules = client.getRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.id).toBe('rule_xyz')
    expect(lastWorkspaceId).toBe('ws_fallback') // hit CP directly

    // Restore
    process.env['MCP_DAEMON_SOCKET'] = socketPath
  })
})
