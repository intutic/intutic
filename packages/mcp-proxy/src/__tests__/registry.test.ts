/**
 * registry.test.ts — the MCP server registry from the proxy's side: how the
 * policy client loads it, how tools/list hides disabled tools, and how the
 * proxy reports its own server.
 *
 * The interceptor's decisions against a loaded registry are in
 * interceptor.test.ts; this file covers what feeds them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PolicyClient, UNRESTRICTED_REGISTRY, parseRegistry } from '../policy.js'
import { RegistryObserver } from '../registryObserver.js'
import { processServerLine, type PendingRequest } from '../proxy.js'

interface Captured {
  method: string
  url: string
  auth: string | undefined
  body: unknown
}

describe('MCP server registry (proxy side)', () => {
  let server: http.Server
  let baseUrl: string
  let captured: Captured[] = []
  let rulesBody: Record<string, unknown> = {}
  let rulesStatus = 200

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        captured.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
        if (req.url?.startsWith('/api/v1/sop/rules')) {
          res.writeHead(rulesStatus, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rulesBody))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: 'candidate', created: true }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  beforeEach(() => {
    captured = []
    rulesStatus = 200
    rulesBody = { rules: [] }
  })

  describe('PolicyClient', () => {
    it('has no registry before any policy loads', () => {
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      expect(client.getRegistry()).toBeUndefined()
    })

    it('absorbs mcpRegistry, the principal and the SSO group policy from GET /api/v1/sop/rules', async () => {
      rulesBody = {
        rules: [],
        mcpRegistry: {
          defaultPolicy: 'deny',
          approvedServers: ['github'],
          blockedServers: ['evil'],
          disabledTools: { github: ['delete_repo'], empty: [] },
        },
        principal: { memberId: 'mem_1', email: 'dev@example.com', role: 'DEVELOPER', ssoGroups: ['eng'] },
        ssoGroupPolicy: { highRiskTools: ['run_query'], requiredGroups: ['dba'] },
      }
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      await client.refresh()
      expect(client.getRegistry()).toEqual({
        defaultPolicy: 'deny',
        approvedServers: ['github'],
        blockedServers: ['evil'],
        disabledTools: { github: ['delete_repo'] },
      })
      expect(client.getPrincipal()).toEqual({ memberId: 'mem_1', email: 'dev@example.com', role: 'DEVELOPER', ssoGroups: ['eng'] })
      expect(client.getSsoGroupPolicy()).toEqual({ highRiskTools: ['run_query'], requiredGroups: ['dba'], requireOboFor: [] })
    })

    it("absorbs the workspace's fail behaviour only when the control plane sends it", async () => {
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      await client.refresh()
      expect(client.getFailOpen()).toBeUndefined()
      rulesBody = { rules: [], mcpProxyFailBehavior: 'closed' }
      await client.refresh()
      expect(client.getFailOpen()).toBe(false)
    })

    it('reads a control plane that sends no registry as unrestricted, not unknown', async () => {
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      await client.refresh()
      expect(client.getRegistry()).toEqual(UNRESTRICTED_REGISTRY)
      expect(client.getPrincipal()).toBeUndefined()
    })

    it('keeps the last loaded registry when a later refresh fails', async () => {
      rulesBody = { rules: [], mcpRegistry: { defaultPolicy: 'deny', approvedServers: [], blockedServers: [], disabledTools: {} } }
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      await client.refresh()
      rulesStatus = 503
      await expect(client.refresh()).rejects.toThrow('503')
      expect(client.getRegistry()?.defaultPolicy).toBe('deny')
    })

    it('ready() waits for the first refresh start() kicked off', async () => {
      rulesBody = { rules: [], mcpRegistry: { defaultPolicy: 'deny', approvedServers: [], blockedServers: [], disabledTools: {} } }
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      client.start()
      try {
        await client.ready()
        expect(client.getRegistry()?.defaultPolicy).toBe('deny')
      } finally {
        client.stop()
      }
    })

    it('ready() retries a never-loaded registry on demand, at most once per interval', async () => {
      rulesStatus = 503
      const client = new PolicyClient(baseUrl, 'vk_test', 'ws_1')
      client.start()
      try {
        await client.ready()
        expect(client.getRegistry()).toBeUndefined()
        const fetchesAfterStart = captured.length
        await client.ready() // inside the retry interval: no new fetch
        expect(captured.length).toBe(fetchesAfterStart)
      } finally {
        client.stop()
      }
    })

    it('parseRegistry rejects a non-object and normalises an unknown default to allow', () => {
      expect(parseRegistry(null)).toBeUndefined()
      expect(parseRegistry(['github'])).toBeUndefined()
      expect(parseRegistry({ defaultPolicy: 'sometimes', approvedServers: ['a', 3] })).toEqual({
        defaultPolicy: 'allow',
        approvedServers: ['a'],
        blockedServers: [],
        disabledTools: {},
      })
    })
  })

  describe('tools/list curation of disabled tools', () => {
    function toolsListLine(id: number, names: string[]): string {
      return JSON.stringify({ jsonrpc: '2.0', id, result: { tools: names.map((name) => ({ name, description: name })) } })
    }

    it('hides a tool the registry disabled, and still reports every upstream name', () => {
      const pending = new Map<string | number, PendingRequest>([[1, { method: 'tools/list' }]])
      const out = processServerLine(toolsListLine(1, ['list_issues', 'delete_repo']), pending, [], {}, 'warn', [], ['delete_repo'])
      const forwarded = JSON.parse(out.line) as { result: { tools: Array<{ name: string }> } }
      expect(forwarded.result.tools.map((t) => t.name)).toEqual(['list_issues'])
      expect(out.curated).toEqual({ hidden: 1, overridden: 0 })
      expect(out.toolsListUpstreamNames).toEqual(['list_issues', 'delete_repo'])
    })

    it('applies the allowlist and the disabled list together', () => {
      const pending = new Map<string | number, PendingRequest>([[2, { method: 'tools/list' }]])
      const out = processServerLine(toolsListLine(2, ['a', 'b', 'c']), pending, ['a', 'b'], {}, 'warn', [], ['b'])
      const forwarded = JSON.parse(out.line) as { result: { tools: Array<{ name: string }> } }
      expect(forwarded.result.tools.map((t) => t.name)).toEqual(['a'])
    })
  })

  describe('RegistryObserver', () => {
    it('reports the server once at start, then whenever its tool names change', async () => {
      const observer = new RegistryObserver(baseUrl, 'vk_test', 'github', 'stdio')
      await observer.observe()
      await observer.observe(['b', 'a'])
      await observer.observe(['a', 'b']) // same set: skipped
      await observer.observe() // nothing new to say: skipped
      await observer.observe(['a', 'b', 'c'])
      const reports = captured.filter((c) => c.url === '/api/v1/mcp/servers/observe')
      expect(reports.map((r) => r.body)).toEqual([
        { serverName: 'github', transport: 'stdio' },
        { serverName: 'github', transport: 'stdio', tools: ['a', 'b'] },
        { serverName: 'github', transport: 'stdio', tools: ['a', 'b', 'c'] },
      ])
      expect(reports[0]!.auth).toBe('Bearer vk_test')
    })

    it('reports nothing without an API key or a server name', async () => {
      await new RegistryObserver(baseUrl, '', 'github', 'stdio').observe(['a'])
      await new RegistryObserver(baseUrl, 'vk_test', 'unknown', 'stdio').observe(['a'])
      expect(captured).toHaveLength(0)
    })

    it('never throws when the control plane is unreachable', async () => {
      await expect(new RegistryObserver('http://127.0.0.1:1', 'vk_test', 'github', 'stdio').observe()).resolves.toBeUndefined()
    })
  })
})
