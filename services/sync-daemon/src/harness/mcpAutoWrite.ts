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
 * Proxy-wrapping convention:
 *   Each existing MCP server entry is rewritten so that the governance proxy
 *   binary is the command, and the original server command is passed after `--`.
 *   A `__intutic_wrapped: true` flag is added to prevent double-wrapping.
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
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-mcp-autowrite')

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Intutic governance marker — prevents double-wrapping */
  __intutic_wrapped?: boolean
}

interface McpServersMap {
  [serverName: string]: McpServerEntry
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

// ─── Proxy Wrapping ───────────────────────────────────────────────────────────

/**
 * Wrap a single MCP server entry with the governance proxy.
 * Returns the entry unmodified if it's already wrapped.
 */
function wrapWithProxy(
  entry: McpServerEntry,
  workspaceId: string,
  workspaceRoot: string
): McpServerEntry {
  if (entry.__intutic_wrapped) return entry

  const proxyBin = resolveProxyBin(workspaceRoot)
  const originalArgs = entry.args ?? []

  return {
    command: 'node',
    args: [
      proxyBin,
      '--workspace-id', workspaceId,
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
      result[name] = wrapWithProxy(entry, workspaceId, workspaceRoot)
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

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await node_fs.mkdir(node_path.dirname(filePath), { recursive: true })
  await node_fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

// ─── Target: Claude Code ─────────────────────────────────────────────────────

async function injectClaudeCode(workspaceId: string, workspaceRoot: string): Promise<void> {
  const home = node_os.homedir()
  const configPath = node_path.join(home, '.claude', 'mcp.json')
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
  const home = node_os.homedir()
  let configPath: string
  if (process.platform === 'darwin') {
    configPath = node_path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  } else if (process.platform === 'win32') {
    configPath = node_path.join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
  } else {
    configPath = node_path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
  }

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
  const home = node_os.homedir()

  // Global settings
  let globalPath: string
  if (process.platform === 'darwin') {
    globalPath = node_path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalSettings.json')
  } else if (process.platform === 'win32') {
    globalPath = node_path.join(process.env['APPDATA'] ?? '', 'Cursor', 'User', 'globalSettings.json')
  } else {
    globalPath = node_path.join(home, '.config', 'Cursor', 'User', 'globalSettings.json')
  }

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
  const projectPath = node_path.join(workspaceRoot, '.cursor', 'mcp.json')
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
  const configPath = node_path.join(workspaceRoot, '.cline', 'mcp.json')
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
  const home = node_os.homedir()
  const configPath = node_path.join(home, '.codeium', 'windsurf', 'mcp_config.json')

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

interface ContinueConfig {
  mcpServers?: Array<{
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    __intutic_wrapped?: boolean
  }>
  [key: string]: unknown
}

async function injectContinue(workspaceId: string, workspaceRoot: string): Promise<void> {
  const home = node_os.homedir()
  const configPath = node_path.join(home, '.continue', 'config.json')

  try {
    await node_fs.access(node_path.dirname(configPath))
    const current = await readJsonFile<ContinueConfig>(configPath, {})

    // Continue uses an array format for mcpServers
    if (!Array.isArray(current.mcpServers)) {
      current.mcpServers = []
    }

    // Remove any existing intutic entry and add the wrapped one
    current.mcpServers = current.mcpServers.filter((s) => s.name !== 'intutic')

    // Wrap existing non-intutic servers
    current.mcpServers = current.mcpServers.map((s) => {
      if (s.__intutic_wrapped) return s
      return {
        name: s.name,
        command: 'node',
        args: [
          resolveProxyBin(workspaceRoot),
          '--workspace-id', workspaceId,
          '--',
          s.command,
          ...(s.args ?? []),
        ],
        env: { ...(s.env ?? {}), INTUTIC_WORKSPACE_ID: workspaceId },
        __intutic_wrapped: true,
      }
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
  const home = node_os.homedir()
  const configPath = node_path.join(home, '.config', 'goose', 'config.yaml')

  try {
    await node_fs.access(node_path.dirname(configPath))
    let yaml = ''
    try {
      yaml = await node_fs.readFile(configPath, 'utf-8')
    } catch {
      yaml = ''
    }

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

    await node_fs.mkdir(node_path.dirname(configPath), { recursive: true })
    await node_fs.writeFile(configPath, yaml, 'utf-8')
    log.info({ action: 'goose_mcp_injected' }, 'Goose config.yaml updated')
  } catch {
    log.debug({ action: 'goose_skip' }, 'Goose not installed — skipping')
  }
}

// ─── Target: OpenHands ────────────────────────────────────────────────────────

async function injectOpenHands(workspaceId: string, workspaceRoot: string): Promise<void> {
  const configPath = node_path.join(workspaceRoot, '.openhands', 'mcp.json')
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Injects and proxy-wraps the Intutic MCP server configuration into all supported harnesses.
 *
 * Non-fatal: a failure in one harness does not prevent other harnesses from being updated.
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
