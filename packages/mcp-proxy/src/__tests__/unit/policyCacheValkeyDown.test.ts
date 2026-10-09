/**
 * A policy miss does not wait on a Valkey that cannot answer.
 *
 * ioredis queues a command until its connection is ready. With Valkey down it
 * rejects the command only after `maxRetriesPerRequest` reconnect attempts,
 * whose delays grow with the outage to seconds; a Valkey that accepts the
 * connection and never answers holds it for good. A policy miss used to await
 * a GET there before asking the control plane, and a SET after, so every miss
 * held the tool call for as long as Valkey did. Here Valkey is a socket that
 * accepts and never answers: the old miss never returned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'

type PolicyCacheModule = typeof import('../../daemon/policyCache.js')

describe('policyCache with a Valkey that never answers', () => {
  let controlPlane: http.Server
  let blackHole: net.Server
  const sockets: net.Socket[] = []
  let requests = 0
  let resolvePolicy: PolicyCacheModule['resolvePolicy']

  const listen = (server: net.Server) =>
    new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))

  beforeAll(async () => {
    blackHole = net.createServer((socket) => { sockets.push(socket) })
    controlPlane = http.createServer((req, res) => {
      requests++
      const workspaceId = new URL(req.url ?? '', `http://${req.headers.host}`).searchParams.get('workspaceId')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ workspaceId, sopRules: [], dlpPatterns: [], mcpInjectionPatterns: [], interventionMode: 'BLOCK' }))
    })
    process.env['VALKEY_URL'] = `redis://127.0.0.1:${await listen(blackHole)}`
    process.env['CONTROL_PLANE_URL'] = `http://127.0.0.1:${await listen(controlPlane)}`
    // Import after process.env is set: the module reads both at import.
    resolvePolicy = (await import('../../daemon/policyCache.js')).resolvePolicy
  })

  afterAll(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => blackHole.close(() => resolve()))
    await new Promise<void>((resolve) => controlPlane.close(() => resolve()))
  })

  it('answers every miss from the control plane', async () => {
    for (const ws of ['ws_down_1', 'ws_down_2', 'ws_down_3']) {
      expect((await resolvePolicy(ws))?.workspaceId).toBe(ws)
    }
    expect(requests).toBe(3)
  }, 30_000)
})
