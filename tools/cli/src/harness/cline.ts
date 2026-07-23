/**
 * cline.ts — Cline adapter (full implementation).
 *
 * Detects the Cline VS Code extension, writes Intutic governance rules
 * as .clinerules (flat file), injects the PreToolUse blocking hook into .cline/hooks/,
 * and configures the proxy base URL via VS Code settings + .env.intutic sidecar.
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
import { writeClineHooks } from '@intutic/sync-daemon/harness/clineHooks'
import { injectClineProxySettings } from './vscodeSettingsWriter.js'

const CONFIG_FILE = '.clinerules'

export const clineAdapter: IHarnessAdapter = {
  type: HarnessType.CLINE,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // Check for .clinerules in workspace
    try {
      await access(join(workspaceRoot, CONFIG_FILE))
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
    // 1. Write .clinerules text rules
    const filePath = join(workspaceRoot, CONFIG_FILE)
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

    await mkdir(dirname(filePath), { recursive: true })
    const tmp = filePath + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)

    // 2. Write PreToolUse blocking hooks into .cline/hooks/
    await writeClineHooks(workspaceRoot, proxyUrl)

    // 3. Inject proxy URL into VS Code settings + .env.intutic sidecar
    await injectClineProxySettings(workspaceRoot, proxyUrl)

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
