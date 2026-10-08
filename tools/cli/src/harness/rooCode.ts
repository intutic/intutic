/**
 * rooCode.ts — Roo Code adapter.
 *
 * Detects the Roo Code VS Code extension and writes Intutic governance rules
 * as .roorules. Roo Code has no hook system to install a tool-call gate into,
 * and keeps its API provider and base URL in its own settings panel rather
 * than in any file this adapter can write, so routing it through the proxy is
 * a manual step (see the Roo Code integration page).
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
import { newIso } from '@intutic/id'
import { writeOwnedFile } from '@intutic/sync-daemon'

const CONFIG_FILE = '.roorules'

export const rooCodeAdapter: IHarnessAdapter = {
  type: HarnessType.ROO_CODE,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // Check for .roomodes or .roorules in workspace
    for (const marker of ['.roomodes', '.roorules']) {
      try {
        await access(join(workspaceRoot, marker))
        return true
      } catch {
        // fall through
      }
    }

    // Check for VS Code extension directory
    try {
      const extensionsDir = join(homedir(), '.vscode', 'extensions')
      const entries = await readdir(extensionsDir)
      return entries.some((entry) => entry.startsWith('rooveterinaryinc.roo-cline-'))
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], _proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const instructions = sops.length > 0
      ? sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n')
      : '# Intutic governance active — no SOP rules configured yet.'

    const content = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '# NOTE: Roo Code has no hook system, so these rules are advisory.',
      '# Governance is enforced via the proxy and the drift guard.',
      '',
      instructions,
      '',
    ].join('\n')

    await writeOwnedFile(filePath, workspaceRoot, content)

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
