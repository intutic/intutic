/**
 * Antigravity adapter — .gemini/settings.json
 *
 * Merges SOP content into the customInstructions field of the workspace's
 * Gemini settings JSON file, and installs the Gemini CLI `BeforeTool` gate in
 * `~/.gemini/settings.json` (see antigravityHooks.ts). A settings file that is
 * not a plain JSON object is left alone and reported.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'
import { loadCredentials } from '../config/store.js'
import { keepOriginal, readJsonObjectForMerge, writeAntigravityHooks } from '@intutic/sync-daemon'

const CONFIG_FILE = '.gemini/settings.json'

export const antigravityAdapter: IHarnessAdapter = {
  type: HarnessType.ANTIGRAVITY,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await access(join(workspaceRoot, '.gemini'))
      return true
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // The gate is installed even with zero SOPs: it is what refuses tool
    // calls, and the built-in protections apply without any SOP.
    const creds = await loadCredentials()
    await writeAntigravityHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')

    if (sops.length === 0) return null
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const tmpPath = filePath + '.intutic-tmp'

    await keepOriginal(filePath, workspaceRoot)
    const settings = await readJsonObjectForMerge(filePath)
    if (settings === null) return null

    // Merge governance instructions
    const instructions = sops
      .map((sop) => `## ${sop.title}\n\n${sop.content}`)
      .join('\n\n---\n\n')

    settings.customInstructions = [
      '# Intutic Governance Rules (auto-generated)',
      `# DO NOT EDIT — managed by intutic sync daemon`,
      `# Last sync: ${newIso()}`,
      `# Proxy URL: ${proxyUrl}`,
      '',
      instructions,
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    await rename(tmpPath, filePath)
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
