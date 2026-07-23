import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return {
    ...original,
    homedir: () => '/tmp/intutic_test_home',
  }
})

import { syncOfflineTraces } from '../../src/syncLoop.js'

// Mock HTTP server
interface CapturedRequest {
  method: string
  url: string
  body: string
}

function createMockServer(): {
  server: http.Server
  captured: CapturedRequest[]
  url: string
  close: () => Promise<void>
} {
  const captured: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'POST',
        url: req.url ?? '/',
        body,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, syncedCount: JSON.parse(body || '{}').traces?.length ?? 0 }))
    })
  })

  return {
    server,
    captured,
    url: '',
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('Sync Offline Traces', () => {
  let mockServer: ReturnType<typeof createMockServer>
  let serverPort: number
  let tracesDir: string
  let tracesPath: string

  beforeEach(async () => {
    mockServer = createMockServer()
    await new Promise<void>((resolve) => {
      mockServer.server.listen(0, '127.0.0.1', () => {
        const addr = mockServer.server.address() as any
        serverPort = addr.port
        mockServer.url = `http://127.0.0.1:${serverPort}`
        resolve()
      })
    })

    tracesDir = '/tmp/intutic_test_home/.intutic/logs'
    fs.mkdirSync(tracesDir, { recursive: true })
    tracesPath = path.join(tracesDir, 'traces-2026-07-03.jsonl')
  })

  afterEach(async () => {
    await mockServer.close()
    try {
      fs.rmSync('/tmp/intutic_test_home', { recursive: true, force: true })
    } catch {}
  })

  it('should read, upload, and truncate traces file on success', async () => {
    const trace1 = { trace_id: 'tr_1', actual_cost_usd: 0.005 }
    const trace2 = { trace_id: 'tr_2', actual_cost_usd: 0.003 }
    
    fs.writeFileSync(tracesPath, `${JSON.stringify(trace1)}\n${JSON.stringify(trace2)}\n`, 'utf-8')

    await syncOfflineTraces(mockServer.url, 'test-key')

    expect(mockServer.captured.length).toBe(1)
    expect(mockServer.captured[0].url).toBe('/api/v1/traces/sync-back')
    
    const body = JSON.parse(mockServer.captured[0].body)
    expect(body.traces.length).toBe(2)
    expect(body.traces[0].trace_id).toBe('tr_1')

    // Expect trace file to be deleted
    expect(fs.existsSync(tracesPath)).toBe(false)
  })
})
