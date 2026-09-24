/**
 * sessionScope.ts — the shared-window scope a proxy process derives for
 * itself (TD-437, Wave 5.3).
 *
 * The sync daemon wraps EACH MCP server entry with its own proxy process, so
 * one harness session runs several `McpGovernanceProxy` processes at once —
 * and the proxy has no wire-level session id: it never inspects `initialize`,
 * no harness sets one, and the daemon writes static config files so it cannot
 * inject a per-session value. What the sibling processes DO share is their
 * parent: the harness process that spawned them (`wrapWithProxy` emits
 * `command: 'node'` with no shell in between, and the MCP SDK spawns with
 * `shell: false`). So the scope is the workspace plus the parent pid, plus a
 * best-effort token derived from the parent's start time so a recycled pid on
 * a long-lived machine cannot inherit a finished session's window.
 *
 * `undefined` means "no shareable identity" and the proxy keeps today's
 * per-process window. A shell wrapper somewhere would give each proxy a
 * distinct parent and degrade to exactly that — never merge two sessions.
 *
 * @module
 */

import * as node_crypto from 'node:crypto'
import * as node_fs from 'node:fs/promises'
import { execFile as node_execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(node_execFile)

/** An explicit scope, for tests and for harnesses that can set one per session. */
export const SESSION_SCOPE_ENV = 'INTUTIC_MCP_SESSION_SCOPE'

/** How long the parent-start lookup may take before the scope goes without it. */
const START_TOKEN_TIMEOUT_MS = 500

export interface SessionScopeInput {
  workspaceId: string
  ppid: number
  parentStartToken?: string
  envOverride?: string
}

/**
 * Pure. Builds the scope string from its inputs, or `undefined` when there is
 * no shareable identity (an orphaned process, `ppid <= 1`).
 */
export function buildSessionScope(input: SessionScopeInput): string | undefined {
  const override = input.envOverride?.trim()
  if (override) {
    const safe = override.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
    if (safe) return `${input.workspaceId}:mcp:env:${safe}`
  }
  if (!Number.isInteger(input.ppid) || input.ppid <= 1) return undefined
  const token = input.parentStartToken?.trim()
  return token ? `${input.workspaceId}:mcp:${input.ppid}:${token}` : `${input.workspaceId}:mcp:${input.ppid}`
}

/**
 * A short token identifying WHEN the parent process started, so that pid
 * reuse cannot alias two sessions. Linux reads `/proc/<pid>/stat` field 22
 * (starttime, in clock ticks since boot); macOS asks `ps` for `lstart`. Never
 * throws and never takes longer than {@link START_TOKEN_TIMEOUT_MS}; any
 * failure returns `undefined` and the scope goes without the token.
 */
export async function readParentStartToken(ppid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    if (platform === 'linux') {
      const stat = await node_fs.readFile(`/proc/${ppid}/stat`, 'utf8')
      return startTokenFromProcStat(stat)
    }
    if (platform === 'darwin') {
      const { stdout } = await execFile('ps', ['-o', 'lstart=', '-p', String(ppid)], { timeout: START_TOKEN_TIMEOUT_MS })
      const lstart = stdout.trim()
      return lstart ? hashToken(lstart) : undefined
    }
  } catch {
    // Best effort: a missing /proc entry, a `ps` that is not there, a timeout.
  }
  return undefined
}

/**
 * `/proc/<pid>/stat` is `pid (comm) state ppid …`; the comm may itself contain
 * spaces and parentheses, so the fields are split AFTER the last `)`. Field 22
 * (starttime) is index 19 of that remainder.
 */
export function startTokenFromProcStat(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  const starttime = fields[19]
  return starttime && /^\d+$/.test(starttime) ? hashToken(starttime) : undefined
}

function hashToken(raw: string): string {
  return node_crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
}

/** The scope this process shares with its sibling proxies, or `undefined`. */
export async function deriveSessionScope(workspaceId: string): Promise<string | undefined> {
  const envOverride = process.env[SESSION_SCOPE_ENV]
  const ppid = process.ppid
  const parentStartToken = envOverride ? undefined : await readParentStartToken(ppid)
  return buildSessionScope({ workspaceId, ppid, parentStartToken, envOverride })
}
