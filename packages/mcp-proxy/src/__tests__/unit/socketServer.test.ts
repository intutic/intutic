import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'node:net'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { createSocketServer } from '../../daemon/socketServer.js'
import type { ResolvedPolicy } from '../../daemon/policyCache.js'
import type { McpServerHealth } from '../../daemon/healthMonitor.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: Record<string, unknown>
}

/** JSON-RPC envelope as it comes off the wire, before the result shape is known. */
interface JsonRpcEnvelope {
  jsonrpc: string
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

interface JsonRpcResponse<TResult> {
  jsonrpc: string
  id: string | number | null
  result: TResult
}

/** Result of `proxy.health_check` — see socketServer.ts handleRequest(). */
interface HealthCheckResult {
  status: string
  version: string
  cacheStats: { entries: number; hitRate: number }
  mcpServers: McpServerHealth[]
}

/** Result of `policy.invalidate`. */
interface InvalidateResult {
  invalidated: boolean
}

/** Result of `telemetry.enqueue`. */
interface EnqueueResult {
  queued: boolean
}

/** Result of `proxy.tool_call`. */
interface ToolCallResult {
  allowed: boolean
  policy: ResolvedPolicy | null
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate['jsonrpc'] !== 'string') return false
  const id = candidate['id']
  return typeof id === 'string' || typeof id === 'number' || id === null
}

describe('socketServer Unit Tests', () => {
  const socketPath = path.join(os.tmpdir(), `mcp-proxy-test-${Date.now()}.sock`)
  let server: net.Server

  /**
   * Sends one newline-delimited JSON-RPC request over the daemon socket and
   * resolves with the response line.
   *
   * The envelope is wire data, so it is checked at runtime before anything is
   * read off it. `TResult` names the result shape socketServer.ts documents for
   * the method being called; each caller then asserts those fields, which is
   * what actually holds the daemon to that shape.
   */
  function callSocket<TResult>(request: JsonRpcRequest): Promise<JsonRpcResponse<TResult>> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath)
      client.setEncoding('utf8')

      let buffer = ''

      client.on('connect', () => {
        client.write(JSON.stringify(request) + '\n')
      })

      client.on('data', (chunk: string) => {
        buffer += chunk
        if (!buffer.includes('\n')) return
        const line = buffer.trim()
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isJsonRpcEnvelope(parsed)) {
            reject(new Error(`Not a JSON-RPC response: ${line}`))
          } else if (parsed.error) {
            reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`))
          } else {
            resolve(parsed as JsonRpcResponse<TResult>)
          }
        } catch (err) {
          reject(err)
        } finally {
          client.end()
        }
      })

      client.on('error', reject)
    })
  }

  beforeAll(async () => {
    process.env['MCP_DAEMON_SOCKET'] = socketPath
    await fs.rm(socketPath, { force: true })
    server = createSocketServer()
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(socketPath, { force: true })
  })

  it('binds to unix socket and responds to proxy.health_check JSON-RPC', async () => {
    const response = await callSocket<HealthCheckResult>({
      jsonrpc: '2.0',
      id: 'req_123',
      method: 'proxy.health_check',
      params: {},
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_123')
    expect(response.result).toBeDefined()
    expect(response.result.status).toBe('ok')
  })

  it('responds to policy.get JSON-RPC', async () => {
    // No control plane is running in this unit test, so policyCache resolves to
    // null and the daemon answers with a null result rather than an error.
    const response = await callSocket<ResolvedPolicy | null>({
      jsonrpc: '2.0',
      id: 'req_policy_get',
      method: 'policy.get',
      params: { workspaceId: 'ws_test' },
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_policy_get')
    expect(response.result).toBeDefined()
  })

  it('responds to policy.invalidate JSON-RPC', async () => {
    const response = await callSocket<InvalidateResult>({
      jsonrpc: '2.0',
      id: 'req_policy_invalidate',
      method: 'policy.invalidate',
      params: { workspaceId: 'ws_test' },
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_policy_invalidate')
    expect(response.result.invalidated).toBe(true)
  })

  it('responds to telemetry.enqueue JSON-RPC', async () => {
    const response = await callSocket<EnqueueResult>({
      jsonrpc: '2.0',
      id: 'req_telemetry_enqueue',
      method: 'telemetry.enqueue',
      params: {
        event: 'tool_allowed',
        toolName: 'read_file',
        workspaceId: 'ws_test',
        harnessType: 'mcp-governance-proxy',
        timestamp: new Date().toISOString(),
      },
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_telemetry_enqueue')
    expect(response.result.queued).toBe(true)
  })

  it('responds to proxy.tool_call JSON-RPC', async () => {
    const response = await callSocket<ToolCallResult>({
      jsonrpc: '2.0',
      id: 'req_tool_call',
      method: 'proxy.tool_call',
      params: { workspaceId: 'ws_test' },
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe('req_tool_call')
    expect(response.result.allowed).toBeDefined()
  })
})
