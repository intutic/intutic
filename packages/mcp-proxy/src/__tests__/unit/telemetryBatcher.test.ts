import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { HookEvent } from '../../daemon/telemetryBatcher.js'

/** Type-only view of the module under test; the value import is dynamic (see below). */
type TelemetryBatcherModule = typeof import('../../daemon/telemetryBatcher.js')

/** Body shape the batcher POSTs to /api/v1/hook-events. */
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

describe('telemetryBatcher Unit Tests', () => {
  let mockServer: http.Server
  let port: number
  const receivedBatches: ReceivedBatch[] = []
  const malformedBodies: string[] = []

  let enqueueEvent: TelemetryBatcherModule['enqueueEvent']
  let startBatcher: TelemetryBatcherModule['startBatcher']
  let stopBatcher: TelemetryBatcherModule['stopBatcher']

  beforeAll(async () => {
    // Clear stale disk buffer file to ensure hermetic tests: startBatcher()
    // drains it into the ring, and a previous run's events would then show up
    // in the batches asserted on below.
    const bufPath = path.join(os.homedir(), '.intutic', 'telemetry-buffer.ndjson')
    await fs.rm(bufPath, { force: true })

    mockServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c.toString()
      })
      req.on('end', () => {
        const events = parseHookEvents(body)
        if (events) {
          receivedBatches.push({ authorization: req.headers.authorization, events })
        } else {
          // Recorded, not swallowed. The test asserts this array stays empty,
          // so a body the batcher could not have produced fails loudly instead
          // of merely never appearing in receivedBatches.
          malformedBodies.push(body)
        }
        // Answer 200 either way: the batcher under test must follow its success
        // path rather than its retry/disk-buffer path. Throwing here would
        // escape an HTTP 'end' callback as an uncaught exception and tear down
        // the worker with no useful assertion diff.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as net.AddressInfo | null
        port = addr?.port ?? 3001
        process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${port}`
        process.env['INTUTIC_API_KEY'] = 'test-telemetry-key'
        process.env['MCP_DAEMON_TELEMETRY_FLUSH_MS'] = '100' // Flush fast for test
        resolve()
      })
    })

    // Import after process.env is set: telemetryBatcher.ts reads
    // CONTROL_PLANE_URL, INTUTIC_API_KEY and MCP_DAEMON_TELEMETRY_FLUSH_MS into
    // module-level constants at import time.
    const mod: TelemetryBatcherModule = await import('../../daemon/telemetryBatcher.js')
    enqueueEvent = mod.enqueueEvent
    startBatcher = mod.startBatcher
    stopBatcher = mod.stopBatcher
  })

  afterAll(async () => {
    await stopBatcher()
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  it('batches and uploads enqueued telemetry events', async () => {
    startBatcher()

    const event: HookEvent = {
      event: 'tool_blocked',
      toolName: 'Bash',
      workspaceId: 'ws_test_telemetry',
      harnessType: 'mcp-governance-proxy',
      timestamp: new Date().toISOString(),
    }

    enqueueEvent(event)

    // Wait for the 100ms flush timer to trigger
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(malformedBodies).toEqual([])
    expect(receivedBatches).toHaveLength(1)
    expect(receivedBatches[0].events).toHaveLength(1)
    expect(receivedBatches[0].events[0].toolName).toBe('Bash')
    // The daemon's own credential reaches the control plane on the upload.
    expect(receivedBatches[0].authorization).toBe('Bearer test-telemetry-key')
  })
})
