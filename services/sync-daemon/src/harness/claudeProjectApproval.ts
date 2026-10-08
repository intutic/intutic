/**
 * claudeProjectApproval.ts — which of a repo's `.mcp.json` servers Claude Code
 * would start, decided the way Claude Code decides it.
 *
 * The sync daemon governs project-scope servers through wrapped local-scope
 * copies (mcpAutoWrite.ts's `shadowProjectServers`), and a local-scope server
 * starts without Claude Code's project-server approval. So a copy may exist
 * only for a server Claude Code would itself start; anything looser would let
 * a cloned repository approve its own server and have us wrap and start it.
 *
 * Claude Code's rules (https://code.claude.com/docs/en/mcp, "Project server
 * approvals and workspace trust"):
 *
 * - Approvals (`enableAllProjectMcpServers`, `enabledMcpjsonServers`) from
 *   the user's `~/.claude/settings.json`, managed settings and the user's own
 *   record in `~/.claude.json` always apply.
 * - Approvals from the project's `.claude/settings.json` and
 *   `.claude/settings.local.json` apply only once the folder is trusted.
 *   Trust is `projects[<repository root>].hasTrustDialogAccepted` in
 *   `~/.claude.json` — keyed on the git root, or the main checkout's root for
 *   a worktree, or the folder itself outside a repository. Anything we cannot
 *   confirm counts as untrusted.
 * - `disabledMcpjsonServers` in any of those files rejects the server,
 *   trusted folder or not.
 *
 * Managed policy can also arrive through MDM (a macOS configuration profile)
 * or the Windows registry, neither of which this module reads. Where one may
 * be present, no project server is approved here: missing an organization's
 * disable is the one mistake this check must not make.
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

interface ApprovalSource {
  enableAllProjectMcpServers?: unknown
  enabledMcpjsonServers?: unknown
  disabledMcpjsonServers?: unknown
}

export interface ProjectApproval {
  /** Whether Claude Code would start this project server. */
  approved(name: string): boolean
  /** Set when no project server can be approved here, and why. */
  blockedReason?: string
}

export interface ApprovalEnvironment {
  /** Claude Code's managed-settings directory; defaults to this platform's. */
  managedDir?: string
  /** Managed-preference profiles whose presence means MDM policy we do not read. */
  mdmProfiles?: string[]
  platform?: NodeJS.Platform
}

function defaultManagedDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

function defaultMdmProfiles(platform: NodeJS.Platform): string[] {
  if (platform !== 'darwin') return []
  const user = (() => {
    try {
      return node_os.userInfo().username
    } catch {
      return ''
    }
  })()
  return [
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    ...(user ? [`/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`] : []),
  ]
}

async function readObject(file: string): Promise<ApprovalSource | null> {
  try {
    const parsed: unknown = JSON.parse(await node_fs.readFile(file, 'utf-8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ApprovalSource) : null
  } catch {
    return null
  }
}

/** The managed-settings documents: `managed-settings.json` and the `managed-settings.d/` drop-ins. */
async function readManaged(dir: string): Promise<ApprovalSource[]> {
  const out: ApprovalSource[] = []
  const main = await readObject(node_path.join(dir, 'managed-settings.json'))
  if (main) out.push(main)
  try {
    const dropIns = (await node_fs.readdir(node_path.join(dir, 'managed-settings.d'))).filter((f) => f.endsWith('.json')).sort()
    for (const f of dropIns) {
      const doc = await readObject(node_path.join(dir, 'managed-settings.d', f))
      if (doc) out.push(doc)
    }
  } catch {
    // No drop-in directory.
  }
  return out
}

/**
 * The path(s) Claude Code may key this folder's trust on: the repository root
 * (the main checkout's root for a worktree), or the folder itself outside a
 * repository — each as given and as its real path, since `projects` keys are
 * whatever path Claude Code was started with.
 */
function trustKeys(workspaceRoot: string): string[] {
  const keys = new Set<string>([workspaceRoot])
  try {
    const common = execFileSync('git', ['-C', workspaceRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    if (common) keys.add(node_path.dirname(common))
  } catch {
    // Not a repository, or no git: the folder itself is the key.
  }
  for (const k of [...keys]) {
    try {
      keys.add(realpathSync(k))
    } catch {
      // A key that does not resolve stays as given.
    }
  }
  return [...keys]
}

/**
 * Decides which project servers Claude Code would start for `workspaceRoot`,
 * given the parsed `~/.claude.json` (`claudeState`).
 */
export async function projectServerApproval(
  workspaceRoot: string,
  claudeState: { projects?: Record<string, unknown> },
  env: ApprovalEnvironment = {},
): Promise<ProjectApproval> {
  const platform = env.platform ?? process.platform
  const mdmProfiles = env.mdmProfiles ?? defaultMdmProfiles(platform)
  if (platform === 'win32' || mdmProfiles.some((p) => existsSync(p))) {
    return {
      approved: () => false,
      blockedReason:
        'Claude Code managed policy may be deployed through MDM or the registry, which Intutic cannot read, so no project server is copied',
    }
  }

  const projectEntry = (key: string): ApprovalSource & { hasTrustDialogAccepted?: unknown } => {
    const entry = claudeState.projects?.[key]
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as ApprovalSource) : {}
  }
  const keys = trustKeys(workspaceRoot)
  const trusted = keys.some((k) => projectEntry(k).hasTrustDialogAccepted === true)

  const userSources: ApprovalSource[] = [
    projectEntry(workspaceRoot),
    ...(await readManaged(env.managedDir ?? defaultManagedDir(platform))),
  ]
  const userSettings = await readObject(node_path.join(node_os.homedir(), '.claude', 'settings.json'))
  if (userSettings) userSources.push(userSettings)

  const projectSources: ApprovalSource[] = []
  for (const file of ['settings.json', 'settings.local.json']) {
    const doc = await readObject(node_path.join(workspaceRoot, '.claude', file))
    if (doc) projectSources.push(doc)
  }

  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [])
  const approving = trusted ? [...userSources, ...projectSources] : userSources
  const all = approving.some((src) => src.enableAllProjectMcpServers === true)
  const enabled = new Set(approving.flatMap((src) => names(src.enabledMcpjsonServers)))
  // A disable counts from every file, the committed ones included.
  const disabled = new Set([...userSources, ...projectSources].flatMap((src) => names(src.disabledMcpjsonServers)))
  return { approved: (name) => !disabled.has(name) && (all || enabled.has(name)) }
}
