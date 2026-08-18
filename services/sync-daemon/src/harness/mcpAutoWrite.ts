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
 * - Muse Code:        ~/.config/muse/settings.json (`mcp_servers` section)
 * - Grok Build:       ~/.grok/config.toml + <workspaceRoot>/.grok/config.toml
 *                      ([mcp_servers.*] tables)
 *
 * That is 12 config paths across 10 `HarnessType` values (Cursor and Grok
 * Build each own two paths — global/project for Cursor, user/project for
 * Grok Build). `discoverMcpServers` below reads all twelve read-only, for
 * reporting; the injectors above are the only thing that writes.
 *
 * # Grok Build's compat-path overlap — dedup, not a bug
 *
 * Grok Build ALSO natively reads `.cursor/mcp.json` (a compatibility
 * feature) — which `injectCursor`/`discoverJsonObjectHarness` below ALREADY
 * wrap/discover under `harness: 'cursor'`, independently of anything this
 * file does for Grok Build specifically. A server declared in BOTH
 * `.cursor/mcp.json` and Grok Build's own `[mcp_servers.*]` table therefore
 * produces TWO rows in `discoverMcpServers`' output — one tagged `cursor`,
 * one tagged `grok` — not one row silently merged or dropped. That is
 * consistent with how every other harness pair already behaves here (this
 * file reports per CONFIG FILE, never cross-harness-deduplicated), and it is
 * the correct behaviour, not a defect to fix: the two configs are genuinely
 * separate on disk, a user (or a future sync) could point them at different
 * servers, and a naive same-name merge would hide that a `.cursor/mcp.json`
 * entry is unwrapped while the `[mcp_servers.*]` entry with the same name is
 * wrapped (or vice versa). See `grokHooks.test.ts`'s dedup test for the pin:
 * the same server name in both files must total exactly two DISTINCT rows,
 * never one collapsed row and never three.
 *
 * (Grok Build is also documented to read a bare project-root `.mcp.json` —
 * a convention this file does not wrap or discover for ANY harness today,
 * Grok Build included; that is a pre-existing gap in this file predating
 * this harness, out of scope for this phase, not something newly introduced
 * here.)
 *
 * Muse's `mcp_servers` map carries both `stdio` and `streamable_http` server
 * entries, but its ON-DISK shape (`command`/`args`/`env` for stdio,
 * `url`/`headers` for a remote transport) was ASSUMED to match the same
 * `command`-or-`url` shape every other JSON-map harness here uses — `wrapAllServers`
 * / `wrapWithProxy` branch on exactly that, so a `streamable_http` entry is
 * wrapped through the SAME remote-bridge path a `url`-keyed Claude Desktop/
 * Windsurf entry gets, without new code. See TD-362 for why this is recorded
 * as an assumption rather than a confirmation.
 *
 * Proxy-wrapping convention:
 *   Each existing stdio MCP server entry is rewritten so that the governance
 *   proxy binary is the command, and the original server command is passed
 *   after `--`, tagged with `--server-name <name>` so the proxy can attribute
 *   traffic to the server it fronts. A `__intutic_wrapped: true` flag is added
 *   to prevent double-wrapping. Remote (HTTP/SSE, `url`-keyed) entries are now
 *   ALSO wrapped — TD-354's stdio→HTTP bridge phase closed the gap this
 *   comment used to describe as "left untouched": the entry is rewritten to
 *   spawn the SAME proxy binary in bridge mode (`--remote-url`/
 *   `--remote-transport`, headers riding in `INTUTIC_REMOTE_HEADERS` env, not
 *   argv — `ps` visibility). `__intutic_original` preserves the entry's
 *   pre-wrap `url`/`type`/`headers` so `classifyEntry` can report the TRUE
 *   transport of what got wrapped, and so a wrapped entry could be unwrapped
 *   later. See TECH_DEBT.md TD-354 for the historical decline this phase
 *   supersedes.
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
import { parseDocument, isMap } from 'yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

const log = createLogger('sync-mcp-autowrite')

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpServerEntry {
  /** Absent on an UNWRAPPED remote (HTTP/SSE) transport entry — see `url`.
   *  Present (== `'node'`) on any wrapped entry, stdio or remote alike, since
   *  wrapping always rewrites the entry to spawn the proxy binary. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Remote MCP transport marker on an UNWRAPPED entry. When present (instead
   *  of `command`), `wrapWithProxy` rewrites it into a remote-bridge-mode
   *  stdio entry (`--remote-url`/`--remote-transport`) rather than leaving it
   *  alone — see TD-354, now superseded. */
  url?: string
  /** Some harnesses tag a `url` entry `"sse"` explicitly; absent/other = http. */
  type?: string
  /** Auth headers for a remote (HTTP/SSE) entry, e.g. `{ Authorization:
   *  "Bearer …" }`. Carried into the wrapped entry's `INTUTIC_REMOTE_HEADERS`
   *  env var, never argv — the same `ps`-visibility reasoning `--remote-url`
   *  keeps headers out of argv for in `packages/mcp-proxy/src/config.ts`. */
  headers?: Record<string, string>
  /** Intutic governance marker — prevents double-wrapping */
  __intutic_wrapped?: boolean
  /**
   * Preserves a WRAPPED remote entry's pre-wrap `url`/`type`/`headers` — the
   * wrap rewrites the entry's top-level shape to a stdio one (`command`/
   * `args`, so the harness can spawn the proxy binary at all), which would
   * otherwise make the entry indistinguishable from an originally-stdio
   * server. `classifyEntry` reads this to report the TRUE transport rather
   * than misreporting every wrapped remote server as stdio. Absent on stdio
   * entries and on unwrapped entries.
   */
  __intutic_original?: { url?: string; type?: string; headers?: Record<string, string> }
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

function museConfigPath(): string {
  return node_path.join(node_os.homedir(), '.config', 'muse', 'settings.json')
}

function grokUserConfigPath(): string {
  return node_path.join(node_os.homedir(), '.grok', 'config.toml')
}

function grokProjectConfigPath(workspaceRoot: string): string {
  return node_path.join(workspaceRoot, '.grok', 'config.toml')
}

// ─── Proxy Wrapping ───────────────────────────────────────────────────────────

/**
 * Wrap a single MCP server entry with the governance proxy.
 *
 * Returns the entry unmodified if it's already wrapped, or if its shape is
 * neither a stdio entry (`command`) nor a remote entry (`url`) — an unknown
 * shape has nothing safe to rewrite it into.
 *
 * Two wrap conventions, chosen by the entry's pre-wrap shape:
 *   - stdio (`command`/`args`): the proxy binary becomes the command, the
 *     original command is passed after `--`, tagged `--server-name`.
 *   - remote (`url`, HTTP/SSE — TD-354, now superseded): the proxy binary is
 *     invoked in bridge mode (`--remote-url`/`--remote-transport` instead of
 *     `--`), also tagged `--server-name`. Any `headers` on the original entry
 *     ride into the wrapped entry's env as `INTUTIC_REMOTE_HEADERS` (a JSON
 *     object string) — never argv, for the same `ps`-visibility reasoning
 *     `packages/mcp-proxy/src/config.ts` documents for `--remote-url` itself.
 * Both conventions end up with the SAME top-level shape (`command: 'node'`,
 * `args: […]`) since the harness only knows how to spawn a stdio process —
 * `__intutic_original` is what lets `classifyEntry` tell them apart again.
 */
function wrapWithProxy(
  entry: McpServerEntry,
  workspaceId: string,
  workspaceRoot: string,
  serverName: string
): McpServerEntry {
  if (entry.__intutic_wrapped) return entry

  const proxyBin = resolveProxyBin(workspaceRoot)

  if (typeof entry.command === 'string') {
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

  if (typeof entry.url === 'string') {
    const remoteTransport = entry.type?.toLowerCase() === 'sse' ? 'sse' : 'http'
    const hasHeaders = entry.headers !== undefined && Object.keys(entry.headers).length > 0

    const original: NonNullable<McpServerEntry['__intutic_original']> = { url: entry.url }
    if (entry.type !== undefined) original.type = entry.type
    if (entry.headers !== undefined) original.headers = entry.headers

    const env: Record<string, string> = {
      ...(entry.env ?? {}),
      INTUTIC_WORKSPACE_ID: workspaceId,
    }
    if (hasHeaders) {
      env['INTUTIC_REMOTE_HEADERS'] = JSON.stringify(entry.headers)
    }

    return {
      command: 'node',
      args: [
        proxyBin,
        '--workspace-id', workspaceId,
        '--server-name', serverName,
        '--remote-url', entry.url,
        '--remote-transport', remoteTransport,
      ],
      env,
      __intutic_wrapped: true,
      __intutic_original: original,
    }
  }

  // Neither a stdio command nor a remote url — an unrecognised shape has
  // nothing safe to rewrite it into. Leave it alone rather than building an
  // args array around `undefined`.
  return entry
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

/**
 * The pre-YAML-dep fallback: append-only string injection of an `intutic:`
 * MCP block, never touching (or even parsing) anything else in the file.
 * This is now ONLY the fallback path (see `injectGoose`) for a config.yaml
 * that does not parse as YAML at all — a parser that cannot safely represent
 * the file cannot safely round-trip it either, so falling back to "never
 * touch anything but the block we control" is the safe degrade, not a
 * regression. Never rewraps a pre-existing remote MCP server entry (it never
 * looks at `mcp:` beyond the literal string `intutic:`), which is why
 * `discoverGoose` cannot claim more than it can actually verify when THIS
 * path was the one that ran.
 */
async function injectGooseAppendOnly(configPath: string, existingYaml: string, workspaceId: string, proxyBin: string): Promise<void> {
  let text = existingYaml
  const intuticBlock = [
    'mcp:',
    '  intutic:',
    `    command: node`,
    `    args: [${JSON.stringify(proxyBin)}, "--workspace-id", ${JSON.stringify(workspaceId)}]`,
  ].join('\n')

  if (!text.includes('intutic:')) {
    text = text.trimEnd() + '\n\n' + intuticBlock + '\n'
  }

  if (text === existingYaml) {
    // Already present and unchanged — write-if-changed applies here too
    // (see writeJsonFile's doc comment for why: this runs every sync cycle now).
    return
  }

  await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
  await node_fs.writeFile(configPath, text, 'utf-8')
  log.info({ action: 'goose_mcp_injected', mode: 'append_only_fallback' }, 'Goose config.yaml updated (append-only fallback)')
}

/**
 * Structurally edits `~/.config/goose/config.yaml`'s `mcp:` block via the
 * `yaml` package's `parseDocument` — unlike every other harness here (plain
 * `JSON.parse`/`JSON.stringify`), this is a user's hand-maintained YAML file,
 * and `parseDocument` preserves comments and formatting for everything this
 * function does NOT touch (`Document#setIn` replaces only the specific
 * `['mcp', <name>]` paths whose wrapped shape actually changed).
 *
 * Applies the SAME `wrapWithProxy` convention every other harness uses —
 * stdio entries wrapped with `--`, remote (`url`-keyed) entries wrapped with
 * `--remote-url`/`--remote-transport` — so a remote MCP server declared in
 * Goose's config gets the identical bridge coverage a remote entry in
 * `~/.claude/mcp.json` would get, not a second, divergent convention.
 *
 * Falls back to `injectGooseAppendOnly` (append-only text injection, the
 * pre-existing behaviour) when the file does not parse as YAML at all —
 * logged as `goose_yaml_unparseable` so the fallback is diagnosable rather
 * than silently degrading coverage. A parser that cannot safely represent a
 * malformed file cannot safely round-trip it either; corrupting a user's
 * hand-maintained config is a worse failure than leaving non-`intutic`
 * entries in that file unwrapped for one more sync cycle.
 */
async function injectGoose(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = gooseConfigPath()

  try {
    await node_fs.access(node_path.dirname(configPath))
  } catch {
    log.debug({ action: 'goose_skip' }, 'Goose not installed — skipping')
    return
  }

  let existingYaml: string
  try {
    existingYaml = await node_fs.readFile(configPath, 'utf-8')
  } catch {
    existingYaml = ''
  }

  const proxyBin = resolveProxyBin(workspaceRoot)

  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(existingYaml)
    if (doc.errors.length > 0) {
      throw doc.errors[0]
    }
  } catch (err) {
    log.warn(
      { action: 'goose_yaml_unparseable', err: (err as Error).message },
      'Goose config.yaml did not parse as YAML — falling back to append-only text injection',
    )
    await injectGooseAppendOnly(configPath, existingYaml, workspaceId, proxyBin)
    return
  }

  const intuticEntry: McpServerEntry = {
    command: 'node',
    args: [proxyBin, '--workspace-id', workspaceId],
  }

  let changed = false
  const mcpNode = doc.get('mcp')
  const mcpIsMap = isMap(mcpNode)
  const servers: Record<string, McpServerEntry> = mcpIsMap
    ? ((doc.toJS() as { mcp?: Record<string, McpServerEntry> }).mcp ?? {})
    : {}

  if (mcpNode !== undefined && !mcpIsMap) {
    // `mcp:` exists but isn't a mapping (e.g. `mcp: null`, `mcp: []`,
    // `mcp: "x"`) — nothing safe to preserve there. Replace with a fresh
    // empty map so the `setIn` calls below have a collection to write into
    // (`Document#setIn` throws on a non-collection intermediate path).
    doc.set('mcp', {})
    changed = true
  }

  if (!isDeepStrictEqual(servers['intutic'], intuticEntry)) {
    doc.setIn(['mcp', 'intutic'], intuticEntry)
    changed = true
  }

  for (const [name, entry] of Object.entries(servers)) {
    if (name === 'intutic') continue
    const wrapped = wrapWithProxy(entry, workspaceId, workspaceRoot, name)
    if (!isDeepStrictEqual(wrapped, entry)) {
      doc.setIn(['mcp', name], wrapped)
      changed = true
    }
  }

  if (!changed) {
    // Already present and unchanged — write-if-changed applies here too
    // (see writeJsonFile's doc comment for why: this runs every sync cycle now).
    return
  }

  await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
  await node_fs.writeFile(configPath, doc.toString(), 'utf-8')
  log.info({ action: 'goose_mcp_injected', mode: 'yaml' }, 'Goose config.yaml updated (structural YAML edit)')
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

// ─── Target: Muse Code ────────────────────────────────────────────────────────

/**
 * `~/.config/muse/settings.json` carries `schema_version` (documented as a
 * mandatory field — defaulted to `1` if this is genuinely the first thing to
 * ever write the file), `mcp_servers` (this function's target), and
 * `managed_hooks_path` (written by `museHooks.ts`). Read-modify-write, same as
 * every other JSON-object harness here — `mergeMuseSettingsJson` in
 * `museHooks.ts` performs the identical pattern for the hooks half of this
 * same file, sequentially, the same way `gooseHooks.ts`'s `mergeGooseConfig`
 * and `injectGoose` both write `config.yaml` without coordinating.
 */
async function injectMuse(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = museConfigPath()

  try {
    await node_fs.access(node_path.dirname(configPath))
  } catch {
    log.debug({ action: 'muse_skip' }, 'Muse Code not installed — skipping')
    return
  }

  const current = await readJsonFile<{ schema_version?: number; mcp_servers?: McpServersMap; [key: string]: unknown }>(
    configPath,
    {},
  )
  current.mcp_servers = wrapAllServers(
    { intutic: buildIntuticMcpEntry(workspaceRoot), ...(current.mcp_servers ?? {}) },
    workspaceId,
    workspaceRoot
  )
  if (current.schema_version === undefined) current.schema_version = 1

  await writeJsonFile(configPath, current)
  log.info({ action: 'muse_mcp_injected' }, 'Muse Code ~/.config/muse/settings.json mcp_servers updated')
}

// ─── Target: Grok Build ───────────────────────────────────────────────────────

/** Structural TOML shape this file cares about; anything else — `[model.*]`,
 *  whatever grokHooks.ts's own merge wrote, unrelated tables a user added —
 *  round-trips through smol-toml untouched. */
interface GrokTomlMcpDoc {
  mcp_servers?: McpServersMap
  [key: string]: unknown
}

/**
 * The pre-parser fallback for a `config.toml` that does not parse as TOML at
 * all — append an `[mcp_servers.intutic]` block only, mirroring
 * `injectGooseAppendOnly`'s exact reasoning: a parser that cannot safely
 * represent a malformed file cannot safely round-trip it either, so this
 * never touches (or even parses) anything else already in the file. Never
 * rewraps a pre-existing `[mcp_servers.*]` entry when this path runs — same
 * honest limit `injectGooseAppendOnly`/`discoverGooseLineScanFallback`
 * document for their own fallback.
 */
async function injectGrokConfigAppendOnly(
  configPath: string,
  existingToml: string,
  workspaceId: string,
  proxyBin: string,
): Promise<void> {
  let text = existingToml
  if (!text.includes('[mcp_servers.intutic]') && !text.includes('[mcp_servers."intutic"]')) {
    const block = [
      '[mcp_servers.intutic]',
      'command = "node"',
      `args = [${JSON.stringify(proxyBin)}, "--workspace-id", ${JSON.stringify(workspaceId)}]`,
    ].join('\n')
    text = text.trimEnd() + '\n\n' + block + '\n'
  }
  if (text === existingToml) return

  await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
  await node_fs.writeFile(configPath, text, 'utf-8')
  log.info({ action: 'grok_mcp_injected', mode: 'append_only_fallback' }, 'Grok config.toml updated (append-only fallback)')
}

/**
 * Structurally edits `config.toml`'s `[mcp_servers.*]` tables via `smol-toml`
 * — the TOML counterpart of `injectGoose`'s YAML edit above, applying the
 * SAME `wrapWithProxy` convention every other harness uses (stdio entries
 * wrapped with `--`, remote/`url`-keyed entries wrapped with
 * `--remote-url`/`--remote-transport`) so a remote MCP server declared for
 * Grok Build gets identical bridge coverage to one in `~/.claude/mcp.json`,
 * not a second, divergent convention.
 *
 * Unlike `injectGoose`'s `Document#setIn` (which preserves comments/
 * formatting for untouched YAML), `smol-toml` round-trips through a plain
 * object — no TOML-parsing dependency preserving comments existed anywhere
 * in this monorepo to reuse (checked; see grokHooks.ts's module doc for the
 * same finding), so a table this function DOES touch loses any inline
 * comments it carried. Tables it does not touch (`[model.*]`, anything
 * else) are written back byte-for-byte equal in content, just
 * re-serialized. Falls back to `injectGrokConfigAppendOnly` when the file
 * does not parse as TOML at all.
 *
 * @param configPath - Absolute path to the `config.toml` to edit (project or
 *   user level — this function is level-agnostic; the caller supplies both).
 */
async function injectGrokConfig(configPath: string, workspaceId: string, workspaceRoot: string): Promise<void> {
  let existingToml = ''
  try {
    existingToml = await node_fs.readFile(configPath, 'utf-8')
  } catch {
    // Deliberate fail-open: no config.toml yet, or unreadable — falls
    // through with '' so a fresh file is written below.
  }

  const proxyBin = resolveProxyBin(workspaceRoot)

  let doc: GrokTomlMcpDoc
  try {
    doc = existingToml.trim() ? (parseToml(existingToml) as GrokTomlMcpDoc) : {}
  } catch (err) {
    log.warn(
      { action: 'grok_toml_unparseable', path: configPath, err: (err as Error).message },
      'Grok config.toml did not parse as TOML — falling back to append-only text injection',
    )
    await injectGrokConfigAppendOnly(configPath, existingToml, workspaceId, proxyBin)
    return
  }

  const servers: McpServersMap = doc.mcp_servers && typeof doc.mcp_servers === 'object' ? doc.mcp_servers : {}
  const intuticEntry = buildIntuticMcpEntry(workspaceRoot)
  let changed = false

  if (!isDeepStrictEqual(servers['intutic'], intuticEntry)) {
    servers['intutic'] = intuticEntry
    changed = true
  }

  for (const [name, entry] of Object.entries(servers)) {
    if (name === 'intutic') continue
    const wrapped = wrapWithProxy(entry, workspaceId, workspaceRoot, name)
    if (!isDeepStrictEqual(wrapped, entry)) {
      servers[name] = wrapped
      changed = true
    }
  }

  if (!changed) {
    // write-if-changed, same reasoning as writeJsonFile/injectGoose: this
    // runs every sync cycle, so a no-op merge must not churn the file's mtime.
    return
  }

  doc.mcp_servers = servers
  await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
  const tmp = configPath + '.intutic-tmp'
  await node_fs.writeFile(tmp, stringifyToml(doc), 'utf-8')
  await node_fs.rename(tmp, configPath)
  log.info({ action: 'grok_mcp_injected', path: configPath, mode: 'toml' }, 'Grok config.toml updated (structural TOML edit)')
}

async function injectGrok(workspaceId: string, workspaceRoot: string): Promise<void> {
  await injectGrokConfig(grokProjectConfigPath(workspaceRoot), workspaceId, workspaceRoot)
  await injectGrokConfig(grokUserConfigPath(), workspaceId, workspaceRoot)
}

// ─── Discovery (read-only — writes nothing) ───────────────────────────────────

/** Classify a raw server entry's transport + wrapped status, tolerant of any shape. */
function classifyEntry(entry: unknown): { transport: DiscoveredMcpServer['transport']; wrapped: boolean } {
  if (!entry || typeof entry !== 'object') return { transport: 'unknown', wrapped: false }
  const e = entry as Record<string, unknown>
  const wrapped = e.__intutic_wrapped === true

  // A wrapped remote entry's TOP-LEVEL shape is stdio (`command: 'node'`,
  // `args: […]`) — that IS the bridge, not a lie, but it would misreport
  // every wrapped remote server as though wrapping made it stdio if checked
  // first. `__intutic_original` (see `wrapWithProxy`) records what was
  // actually wrapped, so this checks it BEFORE falling through to the
  // generic `command`/`url` shape check below — visibility must stay honest.
  const original = e.__intutic_original
  if (wrapped && original !== null && typeof original === 'object') {
    const o = original as Record<string, unknown>
    if (typeof o.url === 'string') {
      const type = typeof o.type === 'string' ? o.type.toLowerCase() : ''
      return { transport: type === 'sse' ? 'sse' : 'http', wrapped: true }
    }
  }

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

/** Muse Code's `~/.config/muse/settings.json` keeps servers under `mcp_servers`,
 *  not `mcpServers` — otherwise the same JSON-map shape `discoverJsonObjectHarness`
 *  reads, so this is that function with one key renamed rather than a new format. */
async function discoverMuse(): Promise<DiscoveredMcpServer[]> {
  const filePath = museConfigPath()
  if (!existsSync(filePath)) return []
  const current = await readJsonFile<{ mcp_servers?: Record<string, unknown> }>(filePath, {})
  const out: DiscoveredMcpServer[] = []
  for (const [name, entry] of Object.entries(current.mcp_servers ?? {})) {
    const { transport, wrapped } = classifyEntry(entry)
    out.push({ server: name, harness: 'muse-code', transport, wrapped })
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
 * Goose's `~/.config/goose/config.yaml` is YAML. `injectGoose` now
 * structurally parses and edits it (via the `yaml` package), and — per
 * `wrapWithProxy` — DOES rewrap a pre-existing, non-`intutic` server entry
 * (both stdio and remote), so a blanket "nothing discovered here is ever
 * `wrapped`" claim is no longer true. Discovery mirrors the writer: a real
 * YAML parse via `classifyEntry` (the SAME classifier every JSON-shaped
 * harness below uses), reporting each entry's true transport and wrapped
 * status honestly, exactly like every other harness in this file.
 *
 * Falls back to the old line-scan (2-space-indented `<name>:` keys under a
 * top-level `mcp:` block) when the file does not parse as YAML — matching
 * `injectGoose`'s own fallback to append-only injection for the same
 * malformed-file case. The line-scan fallback still cannot see a server
 * nested any other way (anchors, flow style, deeper indentation) and still
 * never reports one `wrapped`, because it never inspects a value, only a key
 * — an honest limit of a best-effort fallback over a file real parsing
 * already gave up on.
 */
async function discoverGoose(): Promise<DiscoveredMcpServer[]> {
  const filePath = gooseConfigPath()
  let rawYaml: string
  try {
    rawYaml = await node_fs.readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  try {
    const doc = parseDocument(rawYaml)
    if (doc.errors.length > 0) throw doc.errors[0]
    const mcpNode = doc.get('mcp')
    if (!isMap(mcpNode)) return []
    // Not filtering out 'intutic' here — `discoverMcpServers` below does that
    // once, for every harness alike (see its own doc comment), the same
    // convention `discoverJsonObjectHarness`/`discoverContinue` already rely on.
    const servers = (doc.toJS() as { mcp?: Record<string, unknown> }).mcp ?? {}
    const out: DiscoveredMcpServer[] = []
    for (const [name, entry] of Object.entries(servers)) {
      const { transport, wrapped } = classifyEntry(entry)
      out.push({ server: name, harness: 'goose', transport, wrapped })
    }
    return out
  } catch {
    return discoverGooseLineScanFallback(rawYaml)
  }
}

/** Best-effort fallback for a `config.yaml` that does not parse as YAML —
 *  see `discoverGoose`'s doc comment for why this exists and what it cannot see. */
function discoverGooseLineScanFallback(rawYaml: string): DiscoveredMcpServer[] {
  const out: DiscoveredMcpServer[] = []
  let inMcpBlock = false
  for (const line of rawYaml.split('\n')) {
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
 * Grok Build's `config.toml`, discovered read-only. Mirrors `injectGrokConfig`:
 * a real structural TOML parse via `classifyEntry` (the SAME classifier every
 * other harness below uses), so a wrapped `[mcp_servers.*]` entry reports its
 * true pre-wrap transport honestly. Falls back to a best-effort line-scan
 * (top-level keys under `[mcp_servers.` — never reports one `wrapped`, the
 * same honest limit `discoverGooseLineScanFallback` documents for its own
 * fallback) when the file does not parse as TOML at all.
 */
async function discoverGrokConfig(configPath: string): Promise<DiscoveredMcpServer[]> {
  let rawToml: string
  try {
    rawToml = await node_fs.readFile(configPath, 'utf-8')
  } catch {
    return []
  }

  try {
    const doc = parseToml(rawToml) as GrokTomlMcpDoc
    const servers = doc.mcp_servers && typeof doc.mcp_servers === 'object' ? doc.mcp_servers : {}
    const out: DiscoveredMcpServer[] = []
    for (const [name, entry] of Object.entries(servers)) {
      const { transport, wrapped } = classifyEntry(entry)
      out.push({ server: name, harness: 'grok', transport, wrapped })
    }
    return out
  } catch {
    return discoverGrokLineScanFallback(rawToml)
  }
}

/** Best-effort fallback for a `config.toml` that does not parse as TOML —
 *  see `discoverGrokConfig`'s doc comment for why this exists and what it
 *  cannot see. */
function discoverGrokLineScanFallback(rawToml: string): DiscoveredMcpServer[] {
  const out: DiscoveredMcpServer[] = []
  for (const line of rawToml.split('\n')) {
    const m = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*$/)
    if (m) {
      out.push({ server: (m[1] ?? m[2] ?? m[3])!, harness: 'grok', transport: 'stdio', wrapped: false })
    }
  }
  return out
}

async function discoverGrok(workspaceRoot: string): Promise<DiscoveredMcpServer[]> {
  const [project, user] = await Promise.all([
    discoverGrokConfig(grokProjectConfigPath(workspaceRoot)),
    discoverGrokConfig(grokUserConfigPath()),
  ])
  return [...project, ...user]
}

/**
 * Discover every MCP server declared in any harness config this daemon knows
 * how to parse — the same 12 config paths / 10 harnesses `injectMcpServer`
 * wraps — without writing anything. Used for reporting (agentReporter's
 * `mcp_tools` facet) so visibility does not silently lag behind whatever
 * `injectMcpServer` was last run against.
 *
 * The `intutic` entry itself is excluded from the result: `wrapAllServers`
 * deliberately never wraps it (wrapping our own governance server through
 * itself is circular), so it would always report `wrapped: false` and drag
 * down a wrapped-ratio reading of a workspace that is, in fact, fully covered.
 *
 * A server declared in BOTH `.cursor/mcp.json` (Grok Build's compat read
 * path, already discovered under `harness: 'cursor'` below) AND Grok
 * Build's own `[mcp_servers.*]` table legitimately produces two rows here —
 * one per harness config file — not one merged row. See this module's
 * top-of-file doc comment ("Grok Build's compat-path overlap — dedup, not a
 * bug") for why that is correct, not a double-count to fix.
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
    discoverMuse(),
    discoverGrok(workspaceRoot),
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
    injectMuse(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'muse-code' }, 'MCP injection failed')),
    injectGrok(workspaceId, workspaceRoot).catch((err) =>
      log.error({ err: (err as Error).message, target: 'grok' }, 'MCP injection failed')),
  ])

  log.info({ action: 'mcp_inject_complete', workspaceRoot }, 'MCP server injection complete')
}
