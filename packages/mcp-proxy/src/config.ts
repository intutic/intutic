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
  /**
   * Remote MCP server URL, from `--remote-url <url>`. When set, the proxy's
   * upstream is an HTTP/SSE MCP server (remoteBridge.ts) instead of a spawned
   * stdio child process — `realServerCommand` is empty in that case, and
   * `loadConfig` rejects a config that sets both (see the mutual-exclusion
   * check below). `undefined` in every other mode.
   */
  remoteUrl?: string
  /**
   * Remote transport selection, from `--remote-transport <sse|http>`. Only
   * meaningful when `remoteUrl` is set. Defaults to `'http'`
   * (`StreamableHTTPClientTransport` — the SDK's current, non-deprecated
   * transport) when `--remote-url` is passed without an explicit
   * `--remote-transport`.
   */
  remoteTransport?: 'sse' | 'http'
  /**
   * Auth headers for the remote MCP connection (e.g. `Authorization: Bearer
   * <token>`), parsed from the `INTUTIC_REMOTE_HEADERS` env var — a JSON
   * object string. Deliberately NOT a CLI flag: argv is visible to any local
   * process via `ps`, and these headers carry bearer tokens/API keys that
   * must never leak that way. Empty object when unset, malformed, or not a
   * plain JSON object.
   */
  remoteHeaders: Record<string, string>
  /**
   * Default prompt-injection disposition (injection.ts / interceptor.ts),
   * from `INTUTIC_MCP_INJECTION_ACTION` — the env-var fallback for
   * standalone/open-core use documented on `PolicyClient.getInjectionAction`
   * (policy.ts), which the control plane's `mcpInjectionAction` policy field
   * overrides when present. Defaults to `'warn'`, matching the Rust proxy's
   * own steer-not-kill posture for injection: `PromptInjectionDetector`
   * (detectors.rs) never disposes `Kill` on its own — only `Reask` (at the
   * ≥2-technique/untrusted-source threshold) or `Steer` below it — so a
   * default of unconditional blocking would be a stricter posture than the
   * capability this was ported from.
   */
  mcpInjectionAction: 'warn' | 'block'
  /**
   * Default anomaly-detection mode (anomaly/index.ts, Phase 2), from
   * `INTUTIC_MCP_ANOMALY_MODE` — the env-var fallback for standalone/
   * open-core use, overridden by the control plane's `mcpAnomalyMode` policy
   * field when present (`PolicyClient.getAnomalyMode`). Defaults to
   * `'enforce'`: unlike injection scanning, 5 of the 7 ported anomaly
   * detectors already carry a non-`kill` Rust-declared ceiling
   * (`consecutive_repeat`/`ping_pong_cycle` reask, `landmark_cycle`/
   * `tool_diversity_collapse`/`tool_poisoning` steer), so "enforce" here
   * still respects every detector's own measured-or-unmeasured severity via
   * `resolveEffectiveDisposition` — it is not a blanket "block on suspicion"
   * setting.
   */
  mcpAnomalyMode: 'enforce' | 'warn' | 'off'
  /**
   * Per-detector disposition override map, from `INTUTIC_MCP_ANOMALY_OVERRIDES`
   * — a JSON object string, same "env var, not a CLI flag" treatment as
   * `remoteHeaders` (though these values are not secrets; the JSON-object
   * convention is just kept consistent). Keys are detector ids
   * (`anomaly/index.ts`'s `DETECTOR_BASE_DISPOSITION`); values are
   * `'steer' | 'reask' | 'kill' | 'off'`, clamped at each detector's own
   * Rust-declared ceiling by `resolveEffectiveDisposition` — never able to
   * promote past it. Overridden wholesale by the control plane's
   * `mcpAnomalyOverrides` policy field when present. Empty object when
   * unset, malformed, or not a plain JSON object.
   */
  mcpAnomalyOverrides: Record<string, 'steer' | 'reask' | 'kill' | 'off'>
  /**
   * The "config" tier of Phase 3's WASM rule directory resolution — ported
   * from `local_loader.rs`'s `resolve_local_dir`, whose three-tier order is
   * `INTUTIC_WASM_DIR` env var (checked directly inside
   * `wasm/loader.ts`'s `resolveWasmDir`, not here) → this config value →
   * `~/.intutic/wasm` home default. Sourced from `~/.intutic/env/runtime.env`'s
   * `INTUTIC_WASM_LOCAL_DIR` — the closest local analogue this package has
   * to the Rust proxy's `intutic_settings.wasm_local_dir` dashboard setting
   * (there is no control-plane-delivered equivalent on the MCP policy
   * channel). `undefined` when unset, which `resolveWasmDir` reads as
   * "fall through to the home default."
   */
  mcpWasmDir: string | undefined
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
 * Parse CLI arguments for --workspace-id, --server-name, --remote-url,
 * --remote-transport, and the real server command (after --).
 */
function parseCliArgs(argv: string[]): {
  workspaceId?: string
  serverName?: string
  remoteUrl?: string
  remoteTransport?: string
  realServerCommand: string[]
} {
  let workspaceId: string | undefined
  let serverName: string | undefined
  let remoteUrl: string | undefined
  let remoteTransport: string | undefined
  let separatorIndex = -1

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id' && i + 1 < argv.length) {
      workspaceId = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--server-name' && i + 1 < argv.length) {
      serverName = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--remote-url' && i + 1 < argv.length) {
      remoteUrl = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--remote-transport' && i + 1 < argv.length) {
      remoteTransport = argv[i + 1]
      i++ // skip value
    } else if (argv[i] === '--') {
      separatorIndex = i
      break
    }
  }

  const realServerCommand = separatorIndex !== -1 ? argv.slice(separatorIndex + 1) : []
  return { workspaceId, serverName, remoteUrl, remoteTransport, realServerCommand }
}

/**
 * Parse `INTUTIC_REMOTE_HEADERS` — a JSON object string of header name/value
 * pairs carried via environment variable rather than argv (see
 * `ProxyConfig.remoteHeaders`'s doc comment for why). Never throws: a
 * missing, malformed, or non-object value degrades to "no extra headers"
 * rather than crashing config load over a bad env var.
 */
function parseRemoteHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') headers[key] = value
  }
  return headers
}

const VALID_ANOMALY_OVERRIDE_VALUES = new Set(['steer', 'reask', 'kill', 'off'])

/**
 * Parse `INTUTIC_MCP_ANOMALY_OVERRIDES` — a JSON object string of detector-id
 * → disposition-override pairs. Never throws: a missing, malformed, or
 * non-object value degrades to "no overrides," same posture as
 * `parseRemoteHeaders`.
 */
function parseAnomalyOverrides(raw: string | undefined): Record<string, 'steer' | 'reask' | 'kill' | 'off'> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const overrides: Record<string, 'steer' | 'reask' | 'kill' | 'off'> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_ANOMALY_OVERRIDE_VALUES.has(value)) {
      overrides[key] = value as 'steer' | 'reask' | 'kill' | 'off'
    }
  }
  return overrides
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

  const serverName = cli.serverName ?? 'unknown'

  // Remote (HTTP/SSE) bridge mode and stdio proxy mode are mutually
  // exclusive upstream modes — `--remote-url` together with a positional
  // stdio command (`--` followed by a command) is a config error, not a
  // "remote wins" or "stdio wins" fallback. Caught here rather than left to
  // whichever of remoteBridge.ts/runProxy happened to be invoked, so the
  // failure surfaces at config-load time with a clear reason (index.ts's
  // existing `loadConfig` catch already writes config errors to stderr and
  // exits 1 — this reuses that path, not a new one).
  if (cli.remoteUrl !== undefined && cli.realServerCommand.length > 0) {
    throw new Error(
      'Configuration error: --remote-url and a stdio server command (after --) are ' +
        'mutually exclusive upstream modes. Wrap either a remote (HTTP/SSE) MCP server ' +
        '(--remote-url) or a local stdio command (-- <command> [args...]), not both.',
    )
  }

  let remoteTransport: 'sse' | 'http' | undefined
  if (cli.remoteUrl !== undefined) {
    if (cli.remoteTransport === undefined) {
      // StreamableHTTPClientTransport is the SDK's current, non-deprecated
      // transport — SSEClientTransport exists only for servers that have not
      // migrated off the older SSE transport, so it defaults on rather than off.
      remoteTransport = 'http'
    } else if (cli.remoteTransport === 'sse' || cli.remoteTransport === 'http') {
      remoteTransport = cli.remoteTransport
    } else {
      throw new Error(
        `Configuration error: --remote-transport must be "sse" or "http" (got "${cli.remoteTransport}").`,
      )
    }
  }

  const standalone = cli.realServerCommand.length === 0 && cli.remoteUrl === undefined

  const mcpInjectionAction: 'warn' | 'block' =
    (process.env['INTUTIC_MCP_INJECTION_ACTION'] ?? runtimeEnv['INTUTIC_MCP_INJECTION_ACTION']) === 'block'
      ? 'block'
      : 'warn'

  const rawAnomalyMode = process.env['INTUTIC_MCP_ANOMALY_MODE'] ?? runtimeEnv['INTUTIC_MCP_ANOMALY_MODE']
  const mcpAnomalyMode: 'enforce' | 'warn' | 'off' =
    rawAnomalyMode === 'warn' || rawAnomalyMode === 'off' ? rawAnomalyMode : 'enforce'

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
    remoteUrl: cli.remoteUrl,
    remoteTransport,
    remoteHeaders: parseRemoteHeaders(process.env['INTUTIC_REMOTE_HEADERS']),
    mcpInjectionAction,
    mcpAnomalyMode,
    mcpAnomalyOverrides: parseAnomalyOverrides(process.env['INTUTIC_MCP_ANOMALY_OVERRIDES']),
    mcpWasmDir: runtimeEnv['INTUTIC_WASM_LOCAL_DIR'] || undefined,
  }
}
