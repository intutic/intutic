/**
 * mcpAutoWrite.ts — Injects Intutic MCP server configurations and wraps existing
 * MCP servers with the @intutic/mcp-governance-proxy.
 *
 * Injects and proxy-wraps MCP server entries in:
 * - Claude Code:      ~/.claude/mcp.json
 * - Claude Desktop:   ~/Library/Application Support/Claude/claude_desktop_config.json
 * - Cursor (global):  ~/Library/Application Support/Cursor/User/globalSettings.json
 * - Cursor (project): <workspaceRoot>/.cursor/mcp.json
 * - Cline:            <workspaceRoot>/.cline/mcp.json
 * - Windsurf:         ~/.codeium/windsurf/mcp_config.json
 * - Continue:         ~/.continue/config.json (mcpServers section)
 * - Goose:            ~/.config/goose/config.yaml (mcp section)
 * - OpenHands:        <workspaceRoot>/.openhands/mcp.json
 *
 * That is 9 config paths across 8 `HarnessType` values (Cursor alone owns two
 * paths — global and project). `discoverMcpServers` below reads all nine
 * read-only, for reporting; the injectors above are the only thing that writes.
 *
 * Proxy-wrapping convention:
 *   Each existing stdio MCP server entry is rewritten so that the governance
 *   proxy binary is the command, and the original server command is passed
 *   after `--`, tagged with `--server-name <name>` so the proxy can attribute
 *   traffic to the server it fronts. A `__intutic_wrapped: true` flag is added
 *   to prevent double-wrapping. Remote (HTTP/SSE, `url`-keyed) entries have no
 *   command to wrap and are left untouched — see TD-354.
 *
 * Continuous invariant, not one-shot: `injectMcpServer` is called once from
 * `intutic connect` (tools/cli) AND once per sync-loop iteration
 * (services/sync-daemon/src/syncLoop.ts), so a server a user adds to a harness
 * config after their first `connect` still gets wrapped on the next sync
 * cycle rather than staying invisible to governance forever. Running this
 * every ~30s only works because `writeJsonFile` below is write-if-changed —
 * an already-wrapped, unchanged config produces zero bytes written.
 *
 * LLD #14 — mcpAutoWrite.ts
 * HLD §3.14 — GUI Harness Interception (MCP registration + Universal MCP Governance)
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { existsSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-mcp-autowrite')

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpServerEntry {
  /** Absent on remote (HTTP/SSE) transport entries — see `url`. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Remote MCP transport marker. When present (instead of `command`), this
   *  is not a stdio entry and `wrapWithProxy` leaves it alone — see TD-354. */
  url?: string
  /** Some harnesses tag a `url` entry `"sse"` explicitly; absent/other = http. */
  type?: string
  /** Intutic governance marker — prevents double-wrapping */
  __intutic_wrapped?: boolean
}

interface McpServersMap {
  [serverName: string]: McpServerEntry
}

/** One MCP server as discovered across every known harness config format,
 *  without writing anything. See {@link discoverMcpServers}. */
export interface DiscoveredMcpServer {
  server: string
  harness: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  wrapped: boolean
}

// ─── Proxy Binary Resolution ─────────────────────────────────────────────────

/**
 * Resolve the path to the @intutic/mcp-governance-proxy binary.
 *
 * Resolution order:
 * 1. `<workspaceRoot>/node_modules/@intutic/mcp-governance-proxy/dist/index.js`
 *    — created by pnpm after `pnpm install` (post-install production path)
 * 2. `<workspaceRoot>/packages/mcp-proxy/dist/index.js`
 *    — direct monorepo source path (dev without pnpm install, or if symlink is missing)
 *
 * Using synchronous existsSync is intentional — this runs at daemon init time
 * (not in a hot path), and avoids async complexity in callers.
 */
function resolveProxyBin(workspaceRoot: string): string {
  const nmPath = node_path.join(
    workspaceRoot, 'node_modules', '@intutic', 'mcp-governance-proxy', 'dist', 'index.js'
  )
  if (existsSync(nmPath)) return nmPath

  // Fallback: direct monorepo package path for dev environments
  const pkgPath = node_path.join(workspaceRoot, 'packages', 'mcp-proxy', 'dist', 'index.js')
  return pkgPath
}

// ─── Config Path Resolution ───────────────────────────────────────────────────
//
// Shared by both the injectors (which write) and discoverMcpServers (which
// only reads), so the two can never independently drift about where a
// harness keeps its config.

function claudeCodeConfigPath(): string {
  return node_path.join(node_os.homedir(), '.claude', 'mcp.json')
}

function claudeDesktopConfigPath(): string {
  const home = node_os.homedir()
  if (process.platform === 'darwin') {
    return node_path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  } else if (process.platform === 'win32') {
    return node_path.join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
  }
  return node_path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

function cursorGlobalConfigPath(): string {
  const home = node_os.homedir()
  if (process.platform === 'darwin') {
    return node_path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalSettings.json')
  } else if (process.platform === 'win32') {
    return node_path.join(process.env['APPDATA'] ?? '', 'Cursor', 'User', 'globalSettings.json')
  }
  return node_path.join(home, '.config', 'Cursor', 'User', 'globalSettings.json')
}

function cursorProjectConfigPath(workspaceRoot: string): string {
  return node_path.join(workspaceRoot, '.cursor', 'mcp.json')
}

function clineConfigPath(workspaceRoot: string): string {
  return node_path.join(workspaceRoot, '.cline', 'mcp.json')
}

function windsurfConfigPath(): string {
  return node_path.join(node_os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')
}

function continueConfigPath(): string {
  return node_path.join(node_os.homedir(), '.continue', 'config.json')
}

function gooseConfigPath(): string {
  return node_path.join(node_os.homedir(), '.config', 'goose', 'config.yaml')
}

function openHandsConfigPath(workspaceRoot: string): string {
  return node_path.join(workspaceRoot, '.openhands', 'mcp.json')
}

// ─── Proxy Wrapping ───────────────────────────────────────────────────────────

/**
 * Wrap a single MCP server entry with the governance proxy.
 * Returns the entry unmodified if it's already wrapped, or if it has no
 * `command` to wrap (a remote HTTP/SSE server — see TD-354).
 */
function wrapWithProxy(
  entry: McpServerEntry,
  workspaceId: string,
  workspaceRoot: string,
  serverName: string
): McpServerEntry {
  if (entry.__intutic_wrapped) return entry

  // Remote (HTTP/SSE) transport servers have no `command` to wrap — wrapping
  // is a stdio-process convention (spawn our proxy binary, hand it the
  // original command after `--`). Leave non-stdio entries untouched rather
  // than building an args array around `undefined`.
  if (typeof entry.command !== 'string') return entry

  const proxyBin = resolveProxyBin(workspaceRoot)
  const originalArgs = entry.args ?? []

  return {
    command: 'node',
    args: [
      proxyBin,
      '--workspace-id', workspaceId,
      '--server-name', serverName,
      '--',
      entry.command,
      ...originalArgs,
    ],
    env: {
      ...(entry.env ?? {}),
      INTUTIC_WORKSPACE_ID: workspaceId,
    },
    __intutic_wrapped: true,
  }
}

/**
 * Wrap all servers in an mcpServers map, preserving the `intutic` entry as-is.
 * The `intutic` entry is the control plane MCP server — it must NOT be proxied
 * through itself (circular dependency).
 */
function wrapAllServers(
  servers: McpServersMap,
  workspaceId: string,
  workspaceRoot: string
): McpServersMap {
  const result: McpServersMap = {}
  for (const [name, entry] of Object.entries(servers)) {
    if (name === 'intutic') {
      // Never wrap the Intutic server through itself
      result[name] = entry
    } else {
      result[name] = wrapWithProxy(entry, workspaceId, workspaceRoot, name)
    }
  }
  return result
}

// ─── Intutic MCP Server Entry ─────────────────────────────────────────────────

function buildIntuticMcpEntry(workspaceRoot: string): McpServerEntry {
  return {
    command: 'node',
    args: [
      resolveProxyBin(workspaceRoot),
    ],
    env: {
      NODE_ENV: 'production',
      // CRITICAL: pino must write to stderr so stdout stays pure JSON-RPC.
      // ESM hoists imports above process.env mutations in code, so we set
      // this in the environment before node starts rather than in index.ts.
      PINO_DEST: 'stderr',
    },
  }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await node_fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/**
 * Write JSON to disk, but only if the content actually changed.
 *
 * `injectMcpServer` now runs every sync-loop iteration (~every 30s, see
 * syncLoop.ts) instead of only once at `connect` time — re-running the same
 * wrap against an already-wrapped, unchanged config must not touch the file,
 * or every cycle would churn the file's mtime and fire a spurious inotify /
 * FSEvents event for every harness config on every developer machine.
 *
 * Compares the parsed object structurally (`isDeepStrictEqual`), not the
 * serialized string — a naive string compare would report a false "changed"
 * on nothing more than JSON.stringify key-ordering differences between two
 * semantically identical objects.
 */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  let existing: unknown
  let hasExisting: boolean
  try {
    existing = JSON.parse(await node_fs.readFile(filePath, 'utf-8'))
    hasExisting = true
  } catch {
    hasExisting = false
  }

  if (hasExisting && isDeepStrictEqual(existing, data)) {
    return
  }

  await node_fs.mkdir(node_path.dirname(filePath), { recursive: true })
  await node_fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

// ─── Target: Claude Code ─────────────────────────────────────────────────────

async function injectClaudeCode(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = claudeCodeConfigPath()
  const current = await readJsonFile<{ mcpServers?: McpServersMap }>(configPath, {})

  current.mcpServers = wrapAllServers(
    { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
    workspaceId,
    workspaceRoot
  )

  await writeJsonFile(configPath, current)
  log.info({ action: 'claude_code_mcp_injected' }, 'Claude Code ~/.claude/mcp.json updated')
}

// ─── Target: Claude Desktop ───────────────────────────────────────────────────

async function injectClaudeDesktop(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = claudeDesktopConfigPath()

  // Skip if Claude Desktop directory doesn't exist (not installed)
  try {
    await node_fs.access(node_path.dirname(configPath))
  } catch {
    log.debug({ action: 'claude_desktop_skip' }, 'Claude Desktop not installed — skipping')
    return
  }

  const current = await readJsonFile<{ mcpServers?: McpServersMap }>(configPath, {})
  current.mcpServers = wrapAllServers(
    { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
    workspaceId,
    workspaceRoot
  )

  await writeJsonFile(configPath, current)
  log.info({ action: 'claude_desktop_mcp_injected' }, 'Claude Desktop config updated')
}

// ─── Target: Cursor (global + project) ───────────────────────────────────────

async function injectCursor(workspaceId: string, workspaceRoot: string): Promise<void> {
  // Global settings
  const globalPath = cursorGlobalConfigPath()

  try {
    await node_fs.access(node_path.dirname(globalPath))
    const current = await readJsonFile<{ mcpServers?: McpServersMap }>(globalPath, {})
    current.mcpServers = wrapAllServers(
      { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
      workspaceId,
      workspaceRoot
    )
    await writeJsonFile(globalPath, current)
    log.info({ action: 'cursor_global_mcp_injected' }, 'Cursor globalSettings.json updated')
  } catch {
    log.debug({ action: 'cursor_global_skip' }, 'Cursor not installed — skipping global settings')
  }

  // Project-level .cursor/mcp.json
  const projectPath = cursorProjectConfigPath(workspaceRoot)
  try {
    const current = await readJsonFile<{ mcpServers?: McpServersMap }>(projectPath, {})
    current.mcpServers = wrapAllServers(
      { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
      workspaceId,
      workspaceRoot
    )
    await writeJsonFile(projectPath, current)
    log.info({ action: 'cursor_project_mcp_injected' }, 'Cursor .cursor/mcp.json updated')
  } catch (err) {
    log.warn({ action: 'cursor_project_mcp_failed', err: (err as Error).message }, 'Could not update .cursor/mcp.json')
  }
}

// ─── Target: Cline ────────────────────────────────────────────────────────────

async function injectCline(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = clineConfigPath(workspaceRoot)
  try {
    const current = await readJsonFile<{ mcpServers?: McpServersMap }>(configPath, {})
    current.mcpServers = wrapAllServers(
      { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
      workspaceId,
      workspaceRoot
    )
    await writeJsonFile(configPath, current)
    log.info({ action: 'cline_mcp_injected' }, 'Cline .cline/mcp.json updated')
  } catch (err) {
    log.debug({ action: 'cline_mcp_skip', err: (err as Error).message }, 'Cline config not found — skipping')
  }
}

// ─── Target: Windsurf ─────────────────────────────────────────────────────────

async function injectWindsurf(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = windsurfConfigPath()

  try {
    await node_fs.access(node_path.dirname(configPath))
    const current = await readJsonFile<{ mcpServers?: McpServersMap }>(configPath, {})
    current.mcpServers = wrapAllServers(
      { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
      workspaceId,
      workspaceRoot
    )
    await writeJsonFile(configPath, current)
    log.info({ action: 'windsurf_mcp_injected' }, 'Windsurf mcp_config.json updated')
  } catch {
    log.debug({ action: 'windsurf_skip' }, 'Windsurf not installed — skipping')
  }
}

// ─── Target: Continue ─────────────────────────────────────────────────────────

interface ContinueServerEntry {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: string
  __intutic_wrapped?: boolean
}

interface ContinueConfig {
  mcpServers?: ContinueServerEntry[]
  [key: string]: unknown
}

async function injectContinue(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = continueConfigPath()

  try {
    await node_fs.access(node_path.dirname(configPath))
    const current = await readJsonFile<ContinueConfig>(configPath, {})

    // Continue uses an array format for mcpServers
    if (!Array.isArray(current.mcpServers)) {
      current.mcpServers = []
    }

    // Remove any existing intutic entry and add the wrapped one
    current.mcpServers = current.mcpServers.filter((s) => s.name !== 'intutic')

    // Wrap existing non-intutic servers — routed through the same
    // wrapWithProxy used by every other harness, so the stdio-only guard and
    // --server-name threading stay in one place instead of two.
    current.mcpServers = current.mcpServers.map((s) => {
      const wrapped = wrapWithProxy(
        { command: s.command, args: s.args, env: s.env, url: s.url, type: s.type, __intutic_wrapped: s.__intutic_wrapped },
        workspaceId,
        workspaceRoot,
        s.name
      )
      return { name: s.name, ...wrapped }
    })

    // Add Intutic MCP server
    const entry = buildIntuticMcpEntry(workspaceRoot)
    current.mcpServers.unshift({ name: 'intutic', ...entry })

    await writeJsonFile(configPath, current)
    log.info({ action: 'continue_mcp_injected' }, 'Continue ~/.continue/config.json updated')
  } catch {
    log.debug({ action: 'continue_skip' }, 'Continue not installed — skipping')
  }
}

// ─── Target: Goose ────────────────────────────────────────────────────────────

async function injectGoose(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = gooseConfigPath()

  try {
    await node_fs.access(node_path.dirname(configPath))
    let yaml = ''
    try {
      yaml = await node_fs.readFile(configPath, 'utf-8')
    } catch {
      yaml = ''
    }
    const originalYaml = yaml

    // Inject MCP server block if not present (simple string injection — avoids yaml dep)
    const proxyBin = resolveProxyBin(workspaceRoot)
    const intuticBlock = [
      'mcp:',
      '  intutic:',
      `    command: node`,
      `    args: [${JSON.stringify(proxyBin)}, "--workspace-id", ${JSON.stringify(workspaceId)}]`,
    ].join('\n')

    if (!yaml.includes('intutic:')) {
      yaml = yaml.trimEnd() + '\n\n' + intuticBlock + '\n'
    }

    if (yaml === originalYaml) {
      // Already present and unchanged — write-if-changed applies here too
      // (see writeJsonFile's doc comment for why: this runs every sync cycle now).
      return
    }

    await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
    await node_fs.writeFile(configPath, yaml, 'utf-8')
    log.info({ action: 'goose_mcp_injected' }, 'Goose config.yaml updated')
  } catch {
    log.debug({ action: 'goose_skip' }, 'Goose not installed — skipping')
  }
}

// ─── Target: OpenHands ────────────────────────────────────────────────────────

async function injectOpenHands(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = openHandsConfigPath(workspaceRoot)
  try {
    const current = await readJsonFile<{ mcpServers?: McpServersMap }>(configPath, {})
    current.mcpServers = wrapAllServers(
      { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcpServers ?? {}) },
      workspaceId,
      workspaceRoot
    )
    await writeJsonFile(configPath, current)
    log.info({ action: 'openhands_mcp_injected' }, 'OpenHands .openhands/mcp.json updated')
  } catch (err) {
    log.debug({ action: 'openhands_mcp_skip', err: (err as Error).message }, 'OpenHands config not found — skipping')
  }
}

// ─── Discovery (read-only — writes nothing) ───────────────────────────────────

/** Classify a raw server entry's transport + wrapped status, tolerant of any shape. */
function classifyEntry(entry: unknown): { transport: DiscoveredMcpServer['transport']; wrapped: boolean } {
  if (!entry || typeof entry !== 'object') return { transport: 'unknown', wrapped: false }
  const e = entry as Record<string, unknown>
  const wrapped = e.__intutic_wrapped === true
  if (typeof e.command === 'string') return { transport: 'stdio', wrapped }
  if (typeof e.url === 'string') {
    const type = typeof e.type === 'string' ? e.type.toLowerCase() : ''
    return { transport: type === 'sse' ? 'sse' : 'http', wrapped }
  }
  return { transport: 'unknown', wrapped }
}

/** Read a `{ mcpServers: { [name]: entry } }` shaped config file (the shape
 *  shared by Claude Code, Claude Desktop, both Cursor configs, Cline,
 *  Windsurf and OpenHands) without writing anything back. */
async function discoverJsonObjectHarness(harness: string, filePath: string): Promise<DiscoveredMcpServer[]> {
  if (!existsSync(filePath)) return []
  const current = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(filePath, {})
  const out: DiscoveredMcpServer[] = []
  for (const [name, entry] of Object.entries(current.mcpServers ?? {})) {
    const { transport, wrapped } = classifyEntry(entry)
    out.push({ server: name, harness, transport, wrapped })
  }
  return out
}

/** Continue's `~/.continue/config.json` keeps `mcpServers` as an array, not a map. */
async function discoverContinue(): Promise<DiscoveredMcpServer[]> {
  const filePath = continueConfigPath()
  if (!existsSync(filePath)) return []
  const current = await readJsonFile<ContinueConfig>(filePath, {})
  const out: DiscoveredMcpServer[] = []
  for (const s of current.mcpServers ?? []) {
    const { transport, wrapped } = classifyEntry(s)
    out.push({ server: s.name, harness: 'continue', transport, wrapped })
  }
  return out
}

/**
 * Goose's `~/.config/goose/config.yaml` is YAML, and `injectGoose` above
 * avoids a yaml dependency by string-injecting a flat block rather than
 * parsing the file. Discovery mirrors that: a line scan for 2-space-indented
 * `<name>:` keys under a top-level `mcp:` block — the exact shape `injectGoose`
 * itself writes — not a real YAML parser, so a server nested any other way
 * (anchors, flow style, deeper indentation) is invisible here just as it
 * would be to the writer. `injectGoose` also never rewrites a pre-existing,
 * non-`intutic` server entry, so nothing discovered here is ever `wrapped`.
 */
async function discoverGoose(): Promise<DiscoveredMcpServer[]> {
  const filePath = gooseConfigPath()
  let yaml: string
  try {
    yaml = await node_fs.readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const out: DiscoveredMcpServer[] = []
  let inMcpBlock = false
  for (const line of yaml.split('\n')) {
    if (/^mcp:\s*$/.test(line)) {
      inMcpBlock = true
      continue
    }
    if (!inMcpBlock) continue
    if (/^\S/.test(line)) {
      // Dedented back to column 0 — the mcp: block ended.
      inMcpBlock = false
      continue
    }
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (m) {
      out.push({ server: m[1], harness: 'goose', transport: 'stdio', wrapped: false })
    }
  }
  return out
}

/**
 * Discover every MCP server declared in any harness config this daemon knows
 * how to parse — the same 9 config paths / 8 harnesses `injectMcpServer`
 * wraps — without writing anything. Used for reporting (agentReporter's
 * `mcp_tools` facet) so visibility does not silently lag behind whatever
 * `injectMcpServer` was last run against.
 *
 * The `intutic` entry itself is excluded from the result: `wrapAllServers`
 * deliberately never wraps it (wrapping our own governance server through
 * itself is circular), so it would always report `wrapped: false` and drag
 * down a wrapped-ratio reading of a workspace that is, in fact, fully covered.
 */
export async function discoverMcpServers(workspaceRoot: string): Promise<DiscoveredMcpServer[]> {
  const results = await Promise.all([
    discoverJsonObjectHarness('claude-code', claudeCodeConfigPath()),
    discoverJsonObjectHarness('claude-desktop', claudeDesktopConfigPath()),
    discoverJsonObjectHarness('cursor', cursorGlobalConfigPath()),
    discoverJsonObjectHarness('cursor', cursorProjectConfigPath(workspaceRoot)),
    discoverJsonObjectHarness('cline', clineConfigPath(workspaceRoot)),
    discoverJsonObjectHarness('windsurf', windsurfConfigPath()),
    discoverJsonObjectHarness('openhands', openHandsConfigPath(workspaceRoot)),
    discoverContinue(),
    discoverGoose(),
  ])
  return results.flat().filter((s) => s.server !== 'intutic')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Injects and proxy-wraps the Intutic MCP server configuration into all supported harnesses.
 *
 * Non-fatal: a failure in one harness does not prevent other harnesses from being updated.
 *
 * Called from two places by design: once from `intutic connect` (tools/cli)
 * for immediate effect, and once per sync-loop iteration
 * (services/sync-daemon/src/syncLoop.ts) so it is a continuous invariant
 * rather than a one-shot — a server a user adds after their first `connect`
 * still gets wrapped on the next cycle. Safe to call every cycle because
 * `writeJsonFile` is write-if-changed: an already-wrapped, unchanged config
 * writes zero bytes.
 *
 * @param workspaceId - The workspace ID for policy lookups and event attribution.
 * @param workspaceRoot - Absolute path to the project workspace root.
 */
export async function injectMcpServer(workspaceRoot: string, workspaceId = 'unknown'): Promise<void> {
  log.info({ action: 'mcp_inject_start', workspaceRoot, workspaceId }, 'Starting MCP server injection')

  await Promise.allSettled([
    injectClaudeCode(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'claude-code' }, 'MCP injection failed')),
    injectClaudeDesktop(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'claude-desktop' }, 'MCP injection failed')),
    injectCursor(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'cursor' }, 'MCP injection failed')),
    injectCline(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'cline' }, 'MCP injection failed')),
    injectWindsurf(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'windsurf' }, 'MCP injection failed')),
    injectContinue(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'continue' }, 'MCP injection failed')),
    injectGoose(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'goose' }, 'MCP injection failed')),
    injectOpenHands(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'openhands' }, 'MCP injection failed')),
  ])

  log.info({ action: 'mcp_inject_complete', workspaceRoot }, 'MCP server injection complete')
}
