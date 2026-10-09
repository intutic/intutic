/**
 * `intutic mcp` — the workspace's MCP server registry and the decisions every
 * MCP proxy enforces on it.
 *
 * Subcommands:
 *   - `intutic mcp list [--json]`
 *   - `intutic mcp approve|block|reset <server_id> [--json]`
 *   - `intutic mcp enable-tool|disable-tool <server_id> <tool> [--json]`
 *
 * Server side: services/control-plane/src/routes/mcpServers.ts. Approving,
 * blocking, resetting and switching tools need OWNER or ADMIN; listing needs
 * any member. The registry-wide settings (`mcpDefaultPolicy`,
 * `mcpHighRiskToolChange`, `mcpBudgets`) are workspace settings, changed with
 * `intutic settings set`.
 *
 * @module
 */

import pc from 'picocolors'
import { log } from '../lib/logger.js'
import { runApiCommand, type ApiCommandOpts } from './apiCommand.js'

interface McpServerRow {
  serverId: string
  serverName: string
  status: 'candidate' | 'approved' | 'blocked'
  tools: string[]
  disabledTools: string[]
  lastSeenAt: string
  heldForReview: boolean
}

interface McpServerListResponse {
  servers: McpServerRow[]
  defaultPolicy: 'allow' | 'deny'
  highRiskToolChange: 'notify' | 'hold'
  pendingCount: number
}

interface McpServerDecisionResponse {
  ok: boolean
  server: McpServerRow
}

const STATUS_FOR = { approve: 'approved', block: 'blocked', reset: 'candidate' } as const

function statusLabel(s: McpServerRow): string {
  const label = s.status === 'approved' ? pc.green(s.status) : s.status === 'blocked' ? pc.red(s.status) : pc.yellow(s.status)
  return s.heldForReview ? `${label} (held: high-risk tool change)` : label
}

/** `intutic mcp list` */
export async function runMcpList(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list MCP servers',
    (client) => client.get<McpServerListResponse>('/api/v1/mcp/servers'),
    (res) => {
      log.header('Intutic — MCP Servers')
      log.field('Default policy', res.defaultPolicy)
      log.field('High-risk tool change', res.highRiskToolChange)
      log.field('Awaiting a decision', String(res.pendingCount))
      if (res.servers.length === 0) {
        log.dim('  No MCP servers seen yet.')
        return
      }
      for (const s of res.servers) {
        console.log('')
        log.field('Server ID', s.serverId)
        log.field('Name', s.serverName)
        log.field('Status', statusLabel(s))
        log.field('Tools', `${s.tools.length}${s.disabledTools.length > 0 ? ` (disabled: ${s.disabledTools.join(', ')})` : ''}`)
        log.field('Last seen', s.lastSeenAt)
      }
    },
  )
}

/** `intutic mcp approve|block|reset <server_id>` */
export async function runMcpDecide(
  action: keyof typeof STATUS_FOR,
  serverId: string,
  opts: ApiCommandOpts,
): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to ${action} MCP server ${serverId}`,
    (client) =>
      client.post<McpServerDecisionResponse>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/status`, {
        status: STATUS_FOR[action],
      }),
    (res) => {
      if (action === 'reset') log.success(`${res.server.serverName} is back in the approval queue.`)
      else log.success(`${res.server.serverName} ${STATUS_FOR[action]}.`)
    },
  )
}

/** `intutic mcp enable-tool|disable-tool <server_id> <tool>` */
export async function runMcpTool(
  serverId: string,
  tool: string,
  enabled: boolean,
  opts: ApiCommandOpts,
): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to ${enabled ? 'enable' : 'disable'} ${tool}`,
    (client) =>
      client.post<McpServerDecisionResponse>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`, {
        tool,
        enabled,
      }),
    (res) => log.success(`${tool} on ${res.server.serverName} ${enabled ? 'enabled' : 'disabled'}.`),
  )
}
