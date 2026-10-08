/**
 * openhands.ts — OpenHands adapter (full implementation with hooks + llm.base_url).
 *
 * Merges SOP content ([intutic]) and llm.base_url ([llm]) into config.toml,
 * keeping the rest of the file, and injects PreToolUse hooks via
 * .openhands/hooks.json.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { access, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { writeOpenHandsHooks, mergeOpenHandsToml } from '@intutic/sync-daemon/harness/openhandsHooks'
import { log } from '../lib/logger.js'

const CONFIG_FILE = 'config.toml'

export const openhandsAdapter: IHarnessAdapter = {
  type: HarnessType.OPENHANDS,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await access(join(workspaceRoot, CONFIG_FILE))
      return true
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)

    const instructions = sops.length > 0
      ? sops.map((sop) => `## ${sop.title}\n\n${sop.content}`).join('\n\n---\n\n')
      : '# Intutic governance active — no SOP rules configured yet.'

    // Merged into the user's config.toml: [llm] base_url and an [intutic]
    // table for the SOP text; everything else is kept. A file that does not
    // parse is left alone.
    let raw = ''
    try { raw = await readFile(filePath, 'utf-8') } catch { /* no config.toml yet */ }
    const merged = mergeOpenHandsToml(raw, proxyUrl, instructions)
    let written: string | null = null
    if (merged === null) {
      log.warn(`${filePath} is not valid TOML — left untouched`)
    } else {
      const tmpPath = filePath + '.intutic-tmp'
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(tmpPath, merged, 'utf-8')
      await rename(tmpPath, filePath)
      written = filePath
    }

    // Inject .openhands/hooks.json PreToolUse hook
    await writeOpenHandsHooks(workspaceRoot, proxyUrl)

    return written
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
