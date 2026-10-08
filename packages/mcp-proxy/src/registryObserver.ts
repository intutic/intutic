/**
 * registryObserver.ts — tells the control plane which MCP server this proxy
 * fronts, and which tools it declares.
 *
 * The MCP daemon's heartbeat reports the servers it finds in harness configs,
 * but a per-session proxy runs without the daemon on most machines, and only
 * the proxy ever sees a server's tools/list. So the proxy reports its own
 * server: once at start (so a server refused under a `deny` default still
 * reaches the approval queue, even if its tools/list never gets through) and
 * again whenever the tool names it sees change (so the registry can offer
 * per-tool toggles). The control plane creates a candidate on first sight and
 * notifies the workspace.
 *
 * Best-effort and quiet: a failed report costs one registry refresh, never a
 * tool call.
 *
 * @module
 */

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
   * Reports the server, with `tools` when known. A report identical to the
   * last successful one is skipped. Without an API key, or without a
   * `--server-name` to report, there is nothing the registry could record.
   */
  async observe(tools?: readonly string[]): Promise<void> {
    if (!this.apiKey || this.serverName === 'unknown') return
    const toolNames = tools ? [...new Set(tools)].sort() : undefined
    const key = JSON.stringify(toolNames ?? null)
    if (key === this.lastReported || (toolNames === undefined && this.lastReported !== null)) return
    try {
      await postJson(`${this.controlPlaneUrl}/api/v1/mcp/servers/observe`, this.apiKey, {
        serverName: this.serverName,
        transport: this.transport,
        ...(toolNames ? { tools: toolNames } : {}),
      })
      this.lastReported = key
    } catch (err) {
      log.debug({ action: 'registry_observe_failed', err: (err as Error).message }, 'Could not report this MCP server to the registry')
    }
  }
}
