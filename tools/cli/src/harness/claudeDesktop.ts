/**
 * claudeDesktop.ts — Claude Desktop adapter (drift guard only).
 *
 * Claude Desktop has no hook system and no proxy override capability.
 * Its config file (claude_desktop_config.json) is writable by any user
 * process, so we register it with the drift watcher to detect tampering
 * (e.g., a malicious MCP server added by another tool).
 *
 * writeConfig() returns null — no governance content can be injected.
 * readCurrentHash() returns the hash of the config file so the drift
 * watcher can detect changes and emit a governance_drift incident.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'

/** Platform-specific path to claude_desktop_config.json. */
function getClaudeDesktopConfigPath(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'win32':
      return join(process.env.APPDATA ?? homedir(), 'Claude', 'claude_desktop_config.json')
    default: // linux / WSL
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

const CONFIG_PATH = getClaudeDesktopConfigPath()

export const claudeDesktopAdapter: IHarnessAdapter = {
  type: HarnessType.CLAUDE_DESKTOP,
  configFileName: CONFIG_PATH,

  async detect(_workspaceRoot: string): Promise<boolean> {
    // Check for /Applications/Claude.app (macOS)
    try { await access('/Applications/Claude.app'); return true } catch { /* fall through */ }
    // Check for the config file directly
    try { await access(CONFIG_PATH); return true } catch { return false }
  },

  /** No governance content can be injected into Claude Desktop. */
  async writeConfig(): Promise<string | null> {
    return null
  },

  /**
   * Hash the config file so the drift watcher can detect if an
   * unauthorized MCP server entry is added between sync cycles.
   */
  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(CONFIG_PATH)
    } catch {
      return null
    }
  },
}
