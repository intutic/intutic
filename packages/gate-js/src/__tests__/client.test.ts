import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GateClient } from '../client.js'

// Port of the relevant slice of packages/intutic-clawde/tests/test_gate_client.py:
// hook-gate fail-closed/fail-open behaviour, and that emit() never throws.

describe('GateClient.hookGate', () => {
  let server: Server
  let baseUrl: string
  let lastBody: Record<string, unknown> | undefined
  let respond: (req: unknown) => { status: number; body: unknown }

  beforeAll(async () => {
    respond = () => ({ status: 200, body: { allowed: true } })
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          lastBody = raw ? JSON.parse(raw) : undefined
          const { status, body } = respond(req)
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        })
      })
      server.listen(0, () => resolve())
    })
    const address = server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(() => {
    server.close()
  })

  it('reports the server verdict on a 2xx response', async () => {
    respond = () => ({ status: 200, body: { allowed: false, reason: 'blocked by DLP', incidentId: 'inc_1' } })
    const client = new GateClient({ baseUrl, workspaceId: 'ws_1', sessionId: 's_1' })
    const resp = await client.hookGate('shell', { command: 'rm -rf /' })
    expect(resp.allowed).toBe(false)
    expect(resp.reason).toBe('blocked by DLP')
    expect(resp.incidentId).toBe('inc_1')
    expect(resp.reached).toBe(true)
    expect(lastBody).toMatchObject({ toolName: 'shell', workspaceId: 'ws_1', sessionId: 's_1' })
  })

  it('fails closed by default when the endpoint is unreachable', async () => {
    const client = new GateClient({ baseUrl: 'http://127.0.0.1:1', workspaceId: 'ws_1', timeoutMs: 200 })
    const resp = await client.hookGate('shell', {})
    expect(resp.allowed).toBe(false)
    expect(resp.reached).toBe(false)
  })

  it('fails open when failClosed is false and the endpoint is unreachable', async () => {
    const client = new GateClient({
      baseUrl: 'http://127.0.0.1:1',
      workspaceId: 'ws_1',
      failClosed: false,
      timeoutMs: 200,
    })
    const resp = await client.hookGate('shell', {})
    expect(resp.allowed).toBe(true)
    expect(resp.reached).toBe(false)
  })

  it('emit never throws, even against an unreachable endpoint', async () => {
    const client = new GateClient({ baseUrl: 'http://127.0.0.1:1', workspaceId: 'ws_1', timeoutMs: 200 })
    await expect(client.emit('tool_blocked', 'shell', 'x')).resolves.toBe(false)
  })

  it('emit rejects an event name outside the documented schema', async () => {
    const client = new GateClient({ baseUrl, workspaceId: 'ws_1' })
    await expect(client.emit('not_a_real_event', 'shell')).resolves.toBe(false)
  })
})

describe('GateClient.fromEnv', () => {
  it('throws when no session id is available anywhere', () => {
    const saved = process.env.INTUTIC_SESSION_ID
    delete process.env.INTUTIC_SESSION_ID
    try {
      expect(() => GateClient.fromEnv()).toThrow(/session id/)
    } finally {
      if (saved !== undefined) process.env.INTUTIC_SESSION_ID = saved
    }
  })
})
