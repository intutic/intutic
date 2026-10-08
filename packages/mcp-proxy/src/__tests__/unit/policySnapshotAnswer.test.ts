/**
 * A daemon-mode proxy and the daemon's snapshot answer.
 *
 * After a restart the MCP daemon answers `policy.get` from the sync daemon's
 * snapshot until its first fetch. The snapshot has the rules and the server
 * allowlist and nothing else, so a proxy that had already loaded a full
 * policy used to absorb it and drop its tool allowlist, description
 * overrides and the rest — a daemon restart lifted the workspace's curation.
 * These tests drive the real PolicyClient against a stand-in daemon socket.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PolicyClient } from '../../policy.js'

const FULL = {
  workspaceId: 'ws_snap',
  sopRules: [{ id: 'r1', toolPattern: '^Bash$', action: 'block', reason: 'no shell' }],
  dlpPatterns: ['acme_[a-z]{8}'],
  interventionMode: 'TRANSPARENT',
  allowedTools: ['read_file'],
  toolDescriptionOverrides: { read_file: 'Reads one file' },
  allowedServers: ['filesystem'],
  mcpInjectionPatterns: ['exfiltrate now'],
  mcpInjectionAction: 'block',
  mcpAnomalyOverrides: { code_as_action: 'steer' },
  mcpRegistry: { defaultPolicy: 'deny', approvedServers: ['filesystem'], blockedServers: [], disabledTools: {} },
  cachedAt: Date.now(),
}

const SNAPSHOT = {
  workspaceId: 'ws_snap',
  sopRules: [
    { id: 'r1', toolPattern: '^Bash$', action: 'block', reason: 'no shell' },
    { id: 'r2', toolPattern: '^Write$', action: 'block', reason: 'no writes' },
  ],
  dlpPatterns: [],
  interventionMode: 'TRANSPARENT',
  allowedTools: [],
  toolDescriptionOverrides: {},
  allowedServers: ['filesystem', 'github'],
  mcpInjectionPatterns: [],
  mcpAnomalyOverrides: {},
  fromSnapshot: true,
  cachedAt: 0,
}

describe('PolicyClient and the daemon snapshot answer', () => {
  let server: net.Server
  let socketPath: string
  let answer: Record<string, unknown> = FULL
  let previousSocket: string | undefined

  beforeAll(async () => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-snap-')), 'd.sock')
    server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        const req = JSON.parse(chunk.split('\n')[0]!) as { id: string }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: answer }) + '\n')
      })
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    previousSocket = process.env['MCP_DAEMON_SOCKET']
    process.env['MCP_DAEMON_SOCKET'] = socketPath
  })

  afterAll(async () => {
    if (previousSocket === undefined) delete process.env['MCP_DAEMON_SOCKET']
    else process.env['MCP_DAEMON_SOCKET'] = previousSocket
    await new Promise<void>((r) => server.close(() => r()))
  })

  beforeEach(() => {
    answer = FULL
  })

  function daemonClient(): PolicyClient {
    return new PolicyClient('http://127.0.0.1:1', 'vk_test', 'ws_snap', 60_000, 'daemon')
  }

  it('keeps every loaded restriction when a later answer comes from the snapshot, and takes its rules', async () => {
    const client = daemonClient()
    await client.refresh()
    expect(client.getAllowedTools()).toEqual(['read_file'])

    answer = SNAPSHOT
    await client.refresh()
    expect(client.getAllowedTools()).toEqual(['read_file'])
    expect(client.getAllowedServers()).toEqual(['filesystem'])
    expect(client.getToolDescriptionOverrides()).toEqual({ read_file: 'Reads one file' })
    expect(client.getDlpPatterns()).toEqual(['acme_[a-z]{8}'])
    expect(client.getInjectionPatterns()).toEqual(['exfiltrate now'])
    expect(client.getInjectionAction()).toBe('block')
    expect(client.getAnomalyOverrides()).toEqual({ code_as_action: 'steer' })
    expect(client.getRegistry()?.defaultPolicy).toBe('deny')
    expect(client.getRules().map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('takes the snapshot whole when nothing has loaded yet, server allowlist included', async () => {
    answer = SNAPSHOT
    const client = daemonClient()
    await client.refresh()
    expect(client.getAllowedServers()).toEqual(['filesystem', 'github'])
    expect(client.getRules().map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(client.getRegistry()).toBeUndefined()
  })

  it('a full answer after the snapshot replaces everything again', async () => {
    const client = daemonClient()
    answer = SNAPSHOT
    await client.refresh()
    answer = { ...FULL, allowedTools: [] }
    await client.refresh()
    expect(client.getAllowedTools()).toEqual([])
    expect(client.getAllowedServers()).toEqual(['filesystem'])
  })
})
