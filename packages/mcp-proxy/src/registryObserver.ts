/**
 * registryObserver.ts — tells the control plane which MCP server this proxy
 * fronts, and which tools it declares.
 *
 * The MCP daemon's heartbeat reports the servers it finds in harness configs,
 * but a per-session proxy runs without the daemon on most machines, and only
 * the proxy ever sees a server's tools/list. So the proxy reports its own
 * server: once at start (so a server refused under a `deny` default still
 * reaches the approval queue, even if its tools/list never gets through) and
 * again whenever the tools it sees change — a tool added or removed, or a
 * description or input schema changed. The report carries the tool names (for
 * the registry's per-tool toggles) and the definitions as the server declared
 * them, before curation, which the control plane compares with the last ones
 * it stored to score the change's risk. The control plane creates a candidate
 * on first sight and notifies the workspace.
 *
 * Best-effort and quiet: a failed report costs one registry refresh, never a
 * tool call.
 *
 * @module
 */

import type { McpToolDefinition } from '@intutic/shared-types'
import { createStderrLogger as createLogger } from './stderrLog.js'
import { postJson } from './httpJson.js'

const log = createLogger('mcp-proxy-registry')

export class RegistryObserver {
  private lastReported: string | null = null

  constructor(
    private readonly controlPlaneUrl: string,
    private readonly apiKey: string,
    private readonly serverName: string,
    private readonly transport: 'stdio' | 'http' | 'sse',
  ) {}

  /**
   * Reports the server, with its tools when known. A report identical to the
   * last successful one is skipped. Without an API key, or without a
   * `--server-name` to report, there is nothing the registry could record.
   */
  async observe(tools?: readonly McpToolDefinition[]): Promise<void> {
    if (!this.apiKey || this.serverName === 'unknown') return
    let definitions: McpToolDefinition[] | undefined
    if (tools) {
      // One entry per name, the first declared — the rule the risk score matches by.
      const byName = new Map<string, McpToolDefinition>()
      for (const t of tools) if (!byName.has(t.name)) byName.set(t.name, t)
      definitions = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    }
    const key = JSON.stringify(definitions ?? null)
    if (key === this.lastReported || (definitions === undefined && this.lastReported !== null)) return
    try {
      await postJson(`${this.controlPlaneUrl}/api/v1/mcp/servers/observe`, this.apiKey, {
        serverName: this.serverName,
        transport: this.transport,
        ...(definitions ? { tools: definitions.map((t) => t.name), toolDefinitions: definitions } : {}),
      })
      this.lastReported = key
    } catch (err) {
      log.debug({ action: 'registry_observe_failed', err: (err as Error).message }, 'Could not report this MCP server to the registry')
    }
  }
}
