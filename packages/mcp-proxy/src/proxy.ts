/**
 * proxy.ts — McpGovernanceProxy: transparent stdio MCP proxy with governance interception.
 *
 * Architecture (proxy mode):
 *   Harness stdin → [McpGovernanceProxy] → real MCP server stdin
 *   Real MCP server stdout → [McpGovernanceProxy] → Harness stdout
 *
 * Architecture (standalone mode — the `intutic` harness entry):
 *   Harness ↔ [McpGovernanceProxy as MCP Server] ↔ Control Plane REST API
 *   Exposes governance tools: intutic_governance_status, intutic_list_sops, intutic_list_incidents.
 *
 * CRITICAL: Never write to process.stdout except for valid JSON-RPC frames.
 *           All logging MUST go to process.stderr via @intutic/logger.
 *
 * JSON-RPC framing: newline-delimited JSON (one JSON object per line).
 *
 * @module
 */

import * as node_child from 'node:child_process'
import * as node_readline from 'node:readline'
import { createStderrLogger as createLogger } from './stderrLog.js'
import type { ProxyConfig } from './config.js'
import { PolicyClient } from './policy.js'
import { GovernanceEmitter } from './emitter.js'
import { ToolCallInterceptor } from './interceptor.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const log = createLogger('mcp-governance-proxy')

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolsCallParams {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Build a JSON-RPC 2.0 error response for a blocked tool call.
 */
function buildBlockResponse(id: string | number | null, reason: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603, // Internal error (closest standard code to "blocked")
      message: `[Intutic Governance] Tool call blocked: ${reason}`,
    },
  }
}

/**
 * Write a JSON-RPC frame to stdout (the ONLY valid place to write in a stdio MCP proxy).
 */
function writeFrame(frame: unknown): void {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

export class McpGovernanceProxy {
  private readonly policy: PolicyClient
  private readonly emitter: GovernanceEmitter
  private readonly interceptor: ToolCallInterceptor
  private realServer: node_child.ChildProcess | null = null

  constructor(private readonly config: ProxyConfig) {
    this.policy = new PolicyClient(
      config.controlPlaneUrl,
      config.apiKey,
      config.workspaceId,
      config.policyTtlMs,
      config.mcpProxyMode
    )

    this.emitter = new GovernanceEmitter(
      config.controlPlaneUrl,
      config.apiKey,
      config.eventsFilePath,
      config.workspaceId,
      config.mcpProxyMode
    )

    this.interceptor = new ToolCallInterceptor(this.policy, this.emitter, config.failOpen)
  }

  /**
   * Start the proxy. Dispatches to standalone or proxy mode based on config.
   */
  async run(): Promise<void> {
    if (this.config.standalone) {
      return this.runStandalone()
    }
    return this.runProxy()
  }

  // ─── Standalone MCP Server Mode ──────────────────────────────────────────────

  /**
   * Run as a standalone MCP server (the `intutic` harness entry).
   * Exposes Intutic governance tools directly to the harness.
   * Gracefully degrades when the control plane is unreachable.
   */
  private async runStandalone(): Promise<void> {
    log.info(
      { action: 'standalone_start', workspaceId: this.config.workspaceId },
      'Starting Intutic MCP governance server (standalone mode)'
    )

    const server = new McpServer({
      name: 'intutic',
      version: '0.1.0',
    })

    const cpUrl = this.config.controlPlaneUrl
    const apiKey = this.config.apiKey
    const workspaceId = this.config.workspaceId

    /**
     * Helper: call control plane REST API.
     * Returns null on any error (graceful degradation — never crashes the MCP server).
     */
    async function callControlPlane(path: string): Promise<unknown> {
      try {
        const res = await fetch(`${cpUrl}${path}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-workspace-id': workspaceId,
          },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return null
        return res.json()
      } catch {
        return null
      }
    }

    // Tool: intutic_governance_status
    server.tool(
      'intutic_governance_status',
      'Returns the current governance status and health of the Intutic control plane for this workspace.',
      {},
      async () => {
        const health = await callControlPlane('/healthz') as Record<string, unknown> | null
        const status = health
          ? { connected: true, controlPlane: cpUrl, workspaceId, ...health }
          : { connected: false, controlPlane: cpUrl, workspaceId, error: 'Control plane unreachable' }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        }
      }
    )

    // Tool: intutic_list_sops
    server.tool(
      'intutic_list_sops',
      'Lists Standard Operating Procedures (SOPs) active in this workspace.',
      { limit: z.number().int().min(1).max(50).default(10).describe('Number of SOPs to return (1–50)') },
      async ({ limit }) => {
        const data = await callControlPlane(
          `/api/v1/sops?workspaceId=${workspaceId}&limit=${limit}`
        ) as Record<string, unknown> | null
        const text = data
          ? JSON.stringify(data, null, 2)
          : 'Could not reach control plane to list SOPs.'

        return {
          content: [{ type: 'text' as const, text }],
        }
      }
    )

    // Tool: intutic_list_incidents
    server.tool(
      'intutic_list_incidents',
      'Lists recent governance incidents (policy violations, blocked tool calls) in this workspace.',
      { limit: z.number().int().min(1).max(50).default(10).describe('Number of incidents to return (1–50)') },
      async ({ limit }) => {
        const data = await callControlPlane(
          `/api/v1/incidents?workspaceId=${workspaceId}&limit=${limit}`
        ) as Record<string, unknown> | null
        const text = data
          ? JSON.stringify(data, null, 2)
          : 'Could not reach control plane to list incidents.'

        return {
          content: [{ type: 'text' as const, text }],
        }
      }
    )

    const transport = new StdioServerTransport()
    await server.connect(transport)
    log.info({ action: 'standalone_ready' }, 'Intutic MCP server ready')

    // Keep alive until stdin closes (harness disconnects)
    await new Promise<void>((resolve) => {
      process.stdin.on('close', resolve)
      process.on('SIGINT', resolve)
      process.on('SIGTERM', resolve)
    })

    await server.close()
  }

  // ─── Proxy Mode ───────────────────────────────────────────────────────────────

  /**
   * Start the proxy. Spawns the real MCP server and begins proxying stdin/stdout.
   * Returns a promise that resolves when the real server exits.
   */
  private async runProxy(): Promise<void> {
    const [cmd, ...args] = this.config.realServerCommand

    log.info(
      { action: 'proxy_start', cmd, args, workspaceId: this.config.workspaceId },
      'Starting MCP governance proxy'
    )

    // Start background policy refresh
    this.policy.start()

    // Spawn the real MCP server
    const realServer = node_child.spawn(cmd!, args, {
      stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr so real server logs appear normally
    })

    this.realServer = realServer

    // Handle graceful shutdown
    const shutdown = (signal: string) => {
      log.info({ action: 'proxy_shutdown', signal }, 'Shutting down MCP governance proxy')
      this.policy.stop()
      if (!realServer.killed) {
        realServer.kill()
      }
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Real server stdout → harness stdout (pass through)
    realServer.stdout!.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
    })

    // Harness stdin → governance interceptor → real server stdin
    const rl = node_readline.createInterface({ input: process.stdin, terminal: false })

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let msg: JsonRpcRequest
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest
      } catch {
        log.warn({ action: 'parse_error', line: trimmed.slice(0, 100) }, 'Failed to parse JSON-RPC line')
        return
      }

      // Intercept tools/call
      if (msg.method === 'tools/call') {
        const params = msg.params as McpToolsCallParams | undefined
        const toolName = params?.name ?? '<unknown>'
        const toolInput = params?.arguments ?? {}

        // Run governance check asynchronously
        this.interceptor.decide(toolName, toolInput).then((decision) => {
          if (decision.action === 'block') {
            log.warn(
              { action: 'tool_blocked', toolName, reason: decision.reason },
              'Tool call blocked by governance proxy'
            )
            writeFrame(buildBlockResponse(msg.id, decision.reason))
          } else {
            // Allow: forward to real server
            realServer.stdin!.write(line + '\n')
          }
        }).catch((err) => {
          // Governance check failed — fail-open: forward to real server
          log.error({ action: 'interceptor_error', err: (err as Error).message }, 'Interceptor error — failing open')
          realServer.stdin!.write(line + '\n')
        })
      } else {
        // Non-tools/call messages pass through immediately
        realServer.stdin!.write(line + '\n')
      }
    })

    rl.on('close', () => {
      log.info({ action: 'stdin_closed' }, 'Harness stdin closed — shutting down')
      this.policy.stop()
      if (!realServer.killed) {
        realServer.kill()
      }
    })

    // Wait for the real server to exit
    return new Promise((resolve, reject) => {
      realServer.on('exit', (code, signal) => {
        log.info({ action: 'real_server_exit', code, signal }, 'Real MCP server exited')
        this.policy.stop()
        resolve()
      })
      realServer.on('error', (err) => {
        log.error({ action: 'real_server_error', err: err.message }, 'Real MCP server process error')
        this.policy.stop()
        reject(err)
      })
    })
  }
}
