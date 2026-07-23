/**
 * JSON-RPC over Unix Domain Socket server
 *
 * Accepts newline-delimited JSON requests from MCP shims.
 * Methods: proxy.tool_call, proxy.health_check, policy.get, telemetry.flush
 *
 * LLD #28: MCP Daemon Mode, WS-5MCP
 * @module
 */
import net  from 'node:net'
import path from 'node:path'
import os   from 'node:os'
import { createLogger } from '@intutic/logger'
import { resolvePolicy, getCacheStats, invalidatePolicy } from './policyCache.js'
import { enqueueEvent } from './telemetryBatcher.js'
import { getHealthSnapshot } from './healthMonitor.js'
import type { HookEvent } from './telemetryBatcher.js'

const logger = createLogger('mcp-proxy.socketServer')

export function getSocketPath(): string {
  return process.env['MCP_DAEMON_SOCKET'] ??
    path.join(os.homedir(), '.intutic', 'mcp-proxy.sock')
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id:      string | number
  method:  string
  params:  Record<string, unknown>
}

function respond(socket: net.Socket, id: string | number, result: unknown): void {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(socket: net.Socket, id: string | number, code: number, message: string): void {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handleRequest(socket: net.Socket, req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req

  switch (method) {
    case 'proxy.health_check':
      respond(socket, id, { status: 'ok', version: process.env['npm_package_version'] ?? '0.0.0',
        cacheStats: getCacheStats(), mcpServers: getHealthSnapshot() })
      break

    case 'proxy.tool_call': {
      const workspaceId = params['workspaceId'] as string
      const policy = await resolvePolicy(workspaceId)
      // Simplified enforcement: if policy loaded, apply it
      const allowed = policy !== null
      respond(socket, id, { allowed, policy: policy ?? null })
      break
    }

    case 'policy.get': {
      const workspaceId = params['workspaceId'] as string
      const policy = await resolvePolicy(workspaceId)
      respond(socket, id, policy)
      break
    }

    case 'policy.invalidate': {
      const workspaceId = params['workspaceId'] as string
      invalidatePolicy(workspaceId)
      respond(socket, id, { invalidated: true })
      break
    }

    case 'telemetry.enqueue': {
      enqueueEvent(params as unknown as HookEvent)
      respond(socket, id, { queued: true })
      break
    }

    default:
      respondError(socket, id, -32601, `Method not found: ${method}`)
  }
}

export function createSocketServer(): net.Server {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const req = JSON.parse(trimmed) as JsonRpcRequest
          void handleRequest(socket, req).catch(err =>
            respondError(socket, req.id, -32603, String(err)))
        } catch {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: null,
            error: { code: -32700, message: 'Parse error' } }) + '\n')
        }
      }
    })

    socket.on('error', (err) => logger.warn({ err }, 'socket.client_error'))
  })

  return server
}
