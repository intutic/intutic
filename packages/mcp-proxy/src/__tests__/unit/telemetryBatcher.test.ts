import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

describe('telemetryBatcher Unit Tests', () => {
  let mockServer: http.Server
  let port: number
  let receivedPayloads: any[] = []

  let enqueueEvent: any
  let startBatcher: any
  let stopBatcher: any

  beforeAll(async () => {
    // Clear stale disk buffer file to ensure hermetic tests
    const bufPath = path.join(os.homedir(), '.intutic', 'telemetry-buffer.ndjson')
    await fs.rm(bufPath, { force: true })

    mockServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c.toString()
      })
      req.on('end', () => {
        try {
          receivedPayloads.push(JSON.parse(body))
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as net.AddressInfo | null
        port = addr?.port ?? 3001
        process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${port}`
        process.env['MCP_DAEMON_TELEMETRY_FLUSH_MS'] = '100' // Flush fast for test
        resolve()
      })
    })

    // Import after process.env is set to ensure it uses the mock URL
    const mod = await import('../../daemon/telemetryBatcher.js')
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

    const event = {
      event: 'tool_blocked',
      toolName: 'Bash',
      workspaceId: 'ws_test_telemetry',
      harnessType: 'mcp-governance-proxy',
      timestamp: new Date().toISOString(),
    }

    enqueueEvent(event)

    // Wait for the 100ms flush timer to trigger
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(receivedPayloads).toHaveLength(1)
    expect(receivedPayloads[0].events).toHaveLength(1)
    expect(receivedPayloads[0].events[0].toolName).toBe('Bash')
  })
})
