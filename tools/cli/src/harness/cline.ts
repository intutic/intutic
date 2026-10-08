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
import { newIso } from '@intutic/id'
import { writeClineHooks, ensureClinerulesDirectory } from '@intutic/sync-daemon/harness/clineHooks'
import { keepOriginal, writeOwnedFile } from '@intutic/sync-daemon'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. Rules, as one file in the .clinerules directory Cline reads.
    let filePath: string | null = null
    // Kept before `.clinerules` is created, so disconnect knows it made the directory.
    await keepOriginal(join(workspaceRoot, CONFIG_FILE), workspaceRoot)
    if (await ensureClinerulesDirectory(workspaceRoot)) {
      filePath = join(workspaceRoot, CONFIG_FILE)
      const instructions = sops.length > 0
        ? sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n')
        : '# Intutic governance active — no SOP rules configured yet.'

      const content = [
        '# Intutic Governance Rules (auto-generated)',
        '# DO NOT EDIT — managed by intutic sync daemon',
        `# Last sync: ${newIso()}`,
        '',
        instructions,
        '',
      ].join('\n')

      await writeOwnedFile(filePath, workspaceRoot, content)
    }

    // 2. The PreToolUse gate in .clinerules/hooks/.
    const creds = await loadCredentials()
    await writeClineHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
