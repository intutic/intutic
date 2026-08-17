/**
 * config.ts — MCP Governance Proxy configuration.
 *
 * Reads from ~/.intutic/env/runtime.env (written by sync-daemon runtimeEnv.ts)
 * and from CLI arguments passed after `--`.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'

export interface ProxyConfig {
  /** Workspace ID for policy lookups and event attribution */
  workspaceId: string
  /** Control plane base URL (e.g. http://localhost:3001) */
  controlPlaneUrl: string
  /** API key for control plane requests */
  apiKey: string
  /** Real MCP server command + args (everything after --). Empty = standalone mode. */
  realServerCommand: string[]
  /** Path to write hook-events JSONL (Path B) */
  eventsFilePath: string
  /** Policy cache TTL in milliseconds (default: 60_000) */
  policyTtlMs: number
  /** Whether to fail-open when control plane is unreachable (default: true) */
  failOpen: boolean
  /**
   * MCP proxy deployment model ('per-session' | 'daemon').
   * WS-5 Q2 — 'daemon' is active: when set, policy lookups are answered by the
   * long-lived daemon over its Unix socket (see policy.ts) instead of a
   * per-process fetch from the control plane. What is NOT active is daemon
   * health telemetry — the health-snapshot route was removed and the dashboard
   * flag is hardcoded off, so daemon health is not reported anywhere.
   */
  mcpProxyMode: string
  /**
   * Standalone mode — when true, the proxy acts as the Intutic MCP server
   * directly (no downstream server to proxy). Used for the `intutic` harness
   * entry that exposes Intutic governance tools to the harness.
   */
  standalone: boolean
  /**
   * Server identity, from `--server-name <name>` — the flag
   * `services/sync-daemon/src/harness/mcpAutoWrite.ts`'s `wrapWithProxy` has
   * threaded onto every wrapped invocation since Phase D, but which nothing
   * read until now. Used for the server-level allowlist check
   * (`mcpAllowedServers`, interceptor.ts) and TOFU pinning (tofu.ts) — both
   * need to know which real server this proxy process is fronting.
   * Defaults to `'unknown'`, matching `workspaceId`'s own unset default.
   */
  serverName: string
}

const DEFAULT_EVENTS_PATH = node_path.join(node_os.homedir(), '.intutic', 'events', 'hook-events.jsonl')
const RUNTIME_ENV_PATH = node_path.join(node_os.homedir(), '.intutic', 'env', 'runtime.env')

/**
 * Parse a .env-format file into a key→value record.
 * Lines starting with # are comments; blank lines are skipped.
 */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  try {
    const content = await node_fs.readFile(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      // Strip surrounding quotes from value
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  } catch {
    // File may not exist — return empty record
  }
  return result
}

/**
 * Parse CLI arguments for --workspace-id, --server-name, and the real server
 * command (after --).
 */
function parseCliArgs(argv: string[]): { workspaceId?: string; serverName?: string; realServerCommand: string[] } {
  let workspaceId: string | undefined
  let serverName: string | undefined
  let separatorIndex = -1

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id' && i + 1 < argv.length) {
      workspaceId = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--server-name' && i + 1 < argv.length) {
      serverName = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--') {
      separatorIndex = i
      break
    }
  }

  const realServerCommand = separatorIndex !== -1 ? argv.slice(separatorIndex + 1) : []
  return { workspaceId, serverName, realServerCommand }
}

/**
 * Load the proxy configuration from runtime.env + CLI args + environment.
 */
export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<ProxyConfig> {
  const runtimeEnv = await parseEnvFile(RUNTIME_ENV_PATH)
  const cli = parseCliArgs(argv)

  const controlPlaneUrl =
    process.env['INTUTIC_CONTROL_PLANE_URL'] ??
    runtimeEnv['INTUTIC_CONTROL_PLANE_URL'] ??
    'http://localhost:3001'

  const apiKey =
    process.env['INTUTIC_API_KEY'] ??
    runtimeEnv['INTUTIC_API_KEY'] ??
    ''

  const workspaceId =
    cli.workspaceId ??
    process.env['INTUTIC_WORKSPACE_ID'] ??
    runtimeEnv['INTUTIC_WORKSPACE_ID'] ??
    'unknown'

  const eventsFilePath =
    process.env['INTUTIC_EVENTS_FILE'] ??
    runtimeEnv['INTUTIC_EVENTS_FILE'] ??
    DEFAULT_EVENTS_PATH

  const failOpen =
    (runtimeEnv['INTUTIC_MCP_FAIL_OPEN'] ?? 'true').toLowerCase() !== 'false'

  // 'daemon' is honoured downstream: policy.ts routes policy lookups through
  // the daemon's Unix socket when this is set. No warning here — the mode does
  // what it says.
  const mcpProxyMode = runtimeEnv['INTUTIC_MCP_PROXY_MODE'] ?? 'per-session'

  const standalone = cli.realServerCommand.length === 0

  const serverName = cli.serverName ?? 'unknown'

  return {
    workspaceId,
    controlPlaneUrl,
    apiKey,
    realServerCommand: cli.realServerCommand,
    eventsFilePath,
    policyTtlMs: 60_000,
    failOpen,
    mcpProxyMode,
    standalone,
    serverName,
  }
}
