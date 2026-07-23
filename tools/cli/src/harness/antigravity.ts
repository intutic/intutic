/**
 * Antigravity adapter — .gemini/settings.json
 *
 * Merges SOP content into the customInstructions field of the
 * Gemini settings JSON file.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

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
    if (sops.length === 0) return null
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const tmpPath = filePath + '.intutic-tmp'

    // Read existing settings or start fresh
    let settings: Record<string, unknown> = {}
    try {
      const existing = await readFile(filePath, 'utf-8')
      settings = JSON.parse(existing)
    } catch {
      // No existing file — start fresh
    }

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
