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
   * WS-5 Q2 — stored and propagated but 'daemon' is not yet active in Phase 4.
   */
  mcpProxyMode: string
  /**
   * Standalone mode — when true, the proxy acts as the Intutic MCP server
   * directly (no downstream server to proxy). Used for the `intutic` harness
   * entry that exposes Intutic governance tools to the harness.
   */
  standalone: boolean
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
 * Parse CLI arguments for --workspace-id and the real server command (after --).
 */
function parseCliArgs(argv: string[]): { workspaceId?: string; realServerCommand: string[] } {
  let workspaceId: string | undefined
  let separatorIndex = -1

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id' && i + 1 < argv.length) {
      workspaceId = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--') {
      separatorIndex = i
      break
    }
  }

  const realServerCommand = separatorIndex !== -1 ? argv.slice(separatorIndex + 1) : []
  return { workspaceId, realServerCommand }
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

  const mcpProxyMode = runtimeEnv['INTUTIC_MCP_PROXY_MODE'] ?? 'per-session'
  if (mcpProxyMode === 'daemon') {
    console.warn(
      '[mcp-proxy] INTUTIC_MCP_PROXY_MODE=daemon is stored but not yet active — '
      + 'running in per-session mode (Phase 4). Will be activated in Phase 5.'
    )
  }

  const standalone = cli.realServerCommand.length === 0

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
  }
}
