/**
 * identity.test.ts — the caller identity on governance events and holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'
import { callerIdentity } from '../identity.js'
import { GovernanceEmitter } from '../emitter.js'
import { ApprovalHolds } from '../approvalHold.js'

describe('callerIdentity', () => {
  it('carries the vk_ key prefix — the published part only — the OS user, session and server', () => {
    const key = ['vk', 'abcdefghij', 'klmnopqrstuvwxyz'].join('_')
    const identity = callerIdentity(key, 'github', 'ws_1:mcp:123')
    expect(identity.apiKeyPrefix).toBe(key.slice(0, 12))
    expect(key.slice(12)).not.toBe('')
    expect(JSON.stringify(identity)).not.toContain(key.slice(12))
    expect(identity.osUser).toBe(node_os.userInfo().username)
    expect(identity.session).toBe('ws_1:mcp:123')
    expect(identity.serverName).toBe('github')
  })

  it('reports no key prefix for a credential that is not a vk_ key', () => {
    expect(callerIdentity('a-jwt-or-nothing', 'github', undefined)).not.toHaveProperty('apiKeyPrefix')
    expect(callerIdentity('', 'github', undefined)).not.toHaveProperty('session')
  })
})

describe('identity on the wire', () => {
  let server: http.Server
  let baseUrl: string
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (raw) bodies.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.setHeader('Content-Type', 'application/json')
        res.end(req.url?.includes('approved-bypasses') ? '{"bypasses":[]}' : '{"ok":true}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  const identity = { apiKeyPrefix: 'vk_123456789', osUser: 'dev', session: 'ws_1:mcp:1', serverName: 'github' }

  it('every governance event carries the principal on both paths', async () => {
    const dir = await node_fs.mkdtemp(node_path.join(node_os.tmpdir(), 'intutic-identity-'))
    const file = node_path.join(dir, 'events.jsonl')
    try {
      new GovernanceEmitter(baseUrl, 'vk_test', file, 'ws_1', 'per-session', identity).emit('tool_blocked', 'delete_repo', {}, 'nope')
      let line = ''
      for (let i = 0; i < 100 && !line; i++) {
        await new Promise((r) => setTimeout(r, 10))
        line = await node_fs.readFile(file, 'utf-8').catch(() => '')
      }
      expect((JSON.parse(line) as Record<string, unknown>)['principal']).toEqual(identity)

      for (let i = 0; i < 100 && !bodies.some((b) => b.url === '/api/v1/hook-events'); i++) await new Promise((r) => setTimeout(r, 10))
      const posted = bodies.find((b) => b.url === '/api/v1/hook-events')!.body as { events: Array<Record<string, unknown>> }
      expect(posted.events[0]).toMatchObject({ event: 'tool_blocked', toolName: 'delete_repo', principal: identity })
    } finally {
      await node_fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a hold record names the caller for the reviewer', async () => {
    const holds = new ApprovalHolds(baseUrl, 'vk_test', 'ws_1', 'github', identity)
    await holds.request({ id: 'r1', toolPattern: '.*', action: 'require_approval', reason: 'review' }, 'delete_repo', {})
    const posted = bodies.find((b) => b.url === '/api/v1/decisions')!.body as { holds: Array<{ context: Record<string, unknown> }> }
    expect(posted.holds[0]!.context['principal']).toEqual(identity)
  })
})
