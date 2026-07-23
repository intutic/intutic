/**
 * rooCode.ts — Roo Code adapter (full implementation).
 *
 * Detects the Roo Code VS Code extension, writes Intutic governance rules
 * as .roorules, and configures the proxy base URL via VS Code settings +
 * .env.intutic sidecar. Roo Code's notification hooks are not yet blocking
 * so we rely on proxy (Vector B) and drift guard (Vector C).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'
import { injectRooCodeProxySettings } from './vscodeSettingsWriter.js'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. Write .roorules governance text
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const instructions = sops.length > 0
      ? sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n')
      : '# Intutic governance active — no SOP rules configured yet.'

    const content = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '# NOTE: Roo Code notification hooks are not blocking.',
      '# Governance is enforced via proxy (Vector B) and drift guard (Vector C).',
      '',
      instructions,
      '',
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    const tmp = filePath + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)

    // 2. Inject proxy URL into VS Code settings + .env.intutic sidecar
    await injectRooCodeProxySettings(workspaceRoot, proxyUrl)

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
