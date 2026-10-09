/**
 * cline.ts — Cline adapter.
 *
 * Detects the Cline VS Code extension, writes Intutic governance rules to
 * `.clinerules/intutic-governance.md` and installs the PreToolUse gate at
 * `.clinerules/hooks/PreToolUse` (see clineHooks.ts — `.clinerules` is a
 * directory so both fit; a flat `.clinerules` an earlier version wrote is
 * converted, one the user wrote is left alone).
 *
 * Cline keeps its API provider and base URL in its own settings panel, not in
 * any file this adapter can write, so routing Cline through the proxy is a
 * manual step (see the Cline integration page).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { writeClineHooks, ensureClinerulesDirectory } from '@intutic/sync-daemon/harness/clineHooks'
import { keepOriginal } from '@intutic/sync-daemon'
import { writeOwnRulesFile } from './rulesFiles.js'

const CONFIG_FILE = '.clinerules/intutic-governance.md'

export const clineAdapter: IHarnessAdapter = {
  type: HarnessType.CLINE,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // Check for .clinerules (file or directory) in workspace
    try {
      await access(join(workspaceRoot, '.clinerules'))
      return true
    } catch {
      // fall through
    }

    // Check for VS Code extension directory
    try {
      const extensionsDir = join(homedir(), '.vscode', 'extensions')
      const entries = await readdir(extensionsDir)
      return entries.some((entry) => entry.startsWith('saoudrizwan.claude-dev-'))
    } catch {
      return false
    }
  },

  /** The PreToolUse gate in .clinerules/hooks/. */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const creds = await loadCredentials()
    await writeClineHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  /** Rules, as one file in the .clinerules directory Cline reads; every
   *  file there is applied (https://docs.cline.bot/features/cline-rules). */
  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    if (sops.length === 0) return null
    // Kept before `.clinerules` is created, so disconnect knows it made the directory.
    await keepOriginal(join(workspaceRoot, CONFIG_FILE), workspaceRoot)
    if (!(await ensureClinerulesDirectory(workspaceRoot))) return null
    return writeOwnRulesFile(workspaceRoot, CONFIG_FILE, sops, proxyUrl)
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
