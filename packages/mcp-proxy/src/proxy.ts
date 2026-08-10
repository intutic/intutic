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
import { redactText as redactMcpText } from './dlp.js'
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

/** What the harness asked for under a given request id, awaiting its response. */
export interface PendingRequest {
  method: 'tools/call' | 'tools/list' | 'resources/read'
  toolName?: string
}

/** The outcome of inspecting one server→harness line. */
export interface ServerLineOutcome {
  /** The line to forward — possibly rewritten. */
  line: string
  /** Set when result content was redacted: the tool (or resource) it came from. */
  redactedTool?: string
  /** Pattern descriptions redacted out of the result. */
  redactions?: string[]
  /** Set when a tools/list response was filtered or had descriptions overridden. */
  curated?: { hidden: number; overridden: number }
}

/**
 * Inspect one line of real-server output before it reaches the harness.
 *
 * This is the seam the byte-for-byte pipe never had: the request direction has
 * been scanned since the interceptor existed, while the real server's stdout —
 * tool results, resource reads, every tools/list — streamed into the agent's
 * context untouched. A result carrying a credential put it straight into
 * model-visible context; a `redact` Decision variant and a `tool_redacted`
 * event existed as declared types with no producer. This function is the
 * producer.
 *
 * Redaction, not blocking, on results: the call already executed, so refusing
 * the response protects nothing — keeping the secret out of the agent's
 * context is the only thing still at stake. If the redacted result no longer
 * parses (a secret that spanned JSON syntax), the whole result is withheld
 * and replaced with an error naming why — forwarding either the original or
 * a broken body would be worse, the same fail-closed reparse rule the Rust
 * proxy applies to non-streaming bodies.
 *
 * tools/list curation (the Uber-gateway mechanism): when the workspace
 * declares an additive allowlist, tools outside it are removed from the
 * listing — an agent that never sees a tool does not hallucinate calls to
 * it, and the call-time block in the interceptor stays as the enforcement
 * backstop. Operator description overrides apply to what remains, which is
 * also the counter to a poisoned upstream description — the pin detects the
 * change; the override controls what the agent actually reads.
 */
export function processServerLine(
  raw: string,
  pending: Map<string | number, PendingRequest>,
  allowedTools: readonly string[],
  overrides: Readonly<Record<string, string>>,
): ServerLineOutcome {
  const trimmed = raw.trim()
  if (!trimmed) return { line: raw }
  let msg: JsonRpcResponse & { result?: Record<string, unknown> }
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return { line: raw } // not JSON-RPC (or partial) — forward untouched
  }
  if (msg.id === undefined || msg.id === null) return { line: raw } // notification
  const req = pending.get(msg.id)
  if (!req) return { line: raw }
  pending.delete(msg.id)
  if (!msg.result || typeof msg.result !== 'object') return { line: raw }

  if (req.method === 'tools/call' || req.method === 'resources/read') {
    const serialized = JSON.stringify(msg.result)
    const { redacted, findings } = redactMcpText(serialized)
    if (findings.length === 0) return { line: raw }
    const label = req.toolName ?? req.method
    try {
      msg.result = JSON.parse(redacted) as Record<string, unknown>
      return {
        line: JSON.stringify(msg),
        redactedTool: label,
        redactions: findings.map((f) => f.description),
      }
    } catch {
      const withheld: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32603,
          message:
            `[Intutic Governance] Result withheld: it contained sensitive data ` +
            `whose redaction did not survive re-parsing. The tool ran; its output ` +
            `was not delivered. (${findings.map((f) => f.description).join('; ')})`,
        },
      }
      return {
        line: JSON.stringify(withheld),
        redactedTool: label,
        redactions: findings.map((f) => f.description),
      }
    }
  }

  if (req.method === 'tools/list') {
    const tools = msg.result['tools']
    if (!Array.isArray(tools)) return { line: raw }
    let hidden = 0
    let overridden = 0
    let kept = tools as Array<Record<string, unknown>>
    if (allowedTools.length > 0) {
      kept = kept.filter((t) => {
        const keep = typeof t['name'] === 'string' && allowedTools.includes(t['name'])
        if (!keep) hidden += 1
        return keep
      })
    }
    for (const t of kept) {
      const name = t['name']
      if (typeof name === 'string' && overrides[name] !== undefined) {
        t['description'] = overrides[name]
        overridden += 1
      }
    }
    if (hidden === 0 && overridden === 0) return { line: raw }
    msg.result['tools'] = kept
    return { line: JSON.stringify(msg), curated: { hidden, overridden } }
  }

  return { line: raw }
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
     *
     * Never throws — a failure here degrades a tool's answer, it does not crash
     * the MCP server.
     *
     * 403 is reported separately from every other failure. Collapsing it into
     * `null` told the agent "Could not reach control plane" when the control
     * plane had answered clearly and immediately, which is the kind of message
     * that sends someone debugging their network for an hour. It matters more
     * now that the incident and anomaly reads are role-gated server-side: a
     * DEVELOPER or VIEWER key reaches this path routinely and legitimately.
     */
    type ControlPlaneResult =
      | { ok: true; data: unknown }
      | { ok: false; reason: 'forbidden' | 'unreachable' }

    async function callControlPlane(path: string): Promise<ControlPlaneResult> {
      try {
        const res = await fetch(`${cpUrl}${path}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-workspace-id': workspaceId,
          },
          signal: AbortSignal.timeout(5000),
        })
        if (res.status === 403) return { ok: false, reason: 'forbidden' }
        if (!res.ok) return { ok: false, reason: 'unreachable' }
        return { ok: true, data: await res.json() }
      } catch {
        return { ok: false, reason: 'unreachable' }
      }
    }

    /** Renders a failed call as text for the agent, naming the actual cause. */
    function describeFailure(result: { reason: 'forbidden' | 'unreachable' }, what: string): string {
      return result.reason === 'forbidden'
        ? `Your Intutic role is not permitted to ${what}. This needs the OWNER, ADMIN or EM role.`
        : `Could not reach control plane to ${what}.`
    }

    // Tool: intutic_governance_status
    server.tool(
      'intutic_governance_status',
      'Returns the current governance status and health of the Intutic control plane for this workspace.',
      {},
      async () => {
        const health = await callControlPlane('/healthz')
        const status = health.ok
          ? { connected: true, controlPlane: cpUrl, workspaceId, ...(health.data as Record<string, unknown>) }
          : {
              connected: false,
              controlPlane: cpUrl,
              workspaceId,
              error:
                health.reason === 'forbidden'
                  ? 'Control plane rejected this API key'
                  : 'Control plane unreachable',
            }

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
        const result = await callControlPlane(
          `/api/v1/sops?workspaceId=${workspaceId}&limit=${limit}`
        )
        const text = result.ok
          ? JSON.stringify(result.data, null, 2)
          : describeFailure(result, 'list SOPs')

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
        const result = await callControlPlane(
          `/api/v1/incidents?workspaceId=${workspaceId}&limit=${limit}`
        )
        const text = result.ok
          ? JSON.stringify(result.data, null, 2)
          : describeFailure(result, 'list incidents')

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

    // Requests whose responses this proxy must inspect on the way back.
    // Bounded by the number of in-flight calls; entries are removed when the
    // response arrives (or lost with the process, which is fine — the map
    // exists to route inspection, not to account).
    const pending = new Map<string | number, PendingRequest>()

    // Real server stdout → response inspection → harness stdout. The pipe
    // this replaces forwarded bytes verbatim, which left the whole response
    // direction unscanned; see processServerLine. Line-framed like the input
    // direction (MCP stdio is newline-delimited JSON-RPC), so readline does
    // the chunk reassembly a byte pipe never had to think about.
    const serverRl = node_readline.createInterface({
      input: realServer.stdout!,
      terminal: false,
    })
    serverRl.on('line', (rawLine) => {
      const outcome = processServerLine(
        rawLine,
        pending,
        this.policy.getAllowedTools(),
        this.policy.getToolDescriptionOverrides(),
      )
      if (outcome.redactedTool) {
        log.warn(
          {
            action: 'result_redacted',
            toolName: outcome.redactedTool,
            redactions: outcome.redactions,
          },
          'Sensitive data redacted from a tool result before it reached the agent',
        )
        this.emitter.emit(
          'tool_redacted',
          outcome.redactedTool,
          undefined,
          `Result redacted: ${(outcome.redactions ?? []).join('; ')}`,
        )
      }
      if (outcome.curated) {
        log.info(
          { action: 'tools_list_curated', ...outcome.curated },
          'tools/list curated: allowlist filtering and/or description overrides applied',
        )
      }
      process.stdout.write(outcome.line + '\n')
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

      // Register responses that need inspecting on the way back.
      if (msg.id !== null && msg.id !== undefined) {
        if (msg.method === 'tools/list') {
          pending.set(msg.id, { method: 'tools/list' })
        } else if (msg.method === 'resources/read') {
          pending.set(msg.id, { method: 'resources/read' })
        }
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
            // Allow: the response now needs inspecting on the way back —
            // registered BEFORE forwarding, or a fast server could answer
            // into the gap.
            if (msg.id !== null && msg.id !== undefined) {
              pending.set(msg.id, { method: 'tools/call', toolName })
            }
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
