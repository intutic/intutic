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
import { writeOpenHandsHooks, mergeOpenHandsToml, isOpenHandsConfig } from '@intutic/sync-daemon/harness/openhandsHooks'
import { keepOriginal } from '@intutic/sync-daemon'
import { log } from '../lib/logger.js'

const CONFIG_FILE = 'config.toml'

export const openhandsAdapter: IHarnessAdapter = {
  type: HarnessType.OPENHANDS,
  configFileName: CONFIG_FILE,

  // `.openhands/` is OpenHands' own per-repository directory (`setup.sh`,
  // microagents). Without it, a `config.toml` counts only when it is an
  // OpenHands configuration: the file name alone matched every Hugo site and
  // any other project with a config.toml.
  async detect(workspaceRoot: string): Promise<boolean> {
    try {
      await access(join(workspaceRoot, '.openhands'))
      return true
    } catch {
      // No per-repository directory: look at config.toml.
    }
    try {
      return isOpenHandsConfig(await readFile(join(workspaceRoot, CONFIG_FILE), 'utf-8'))
    } catch {
      return false
    }
  },

  /** The .openhands/hooks.json PreToolUse hook. */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeOpenHandsHooks(workspaceRoot, proxyUrl)
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
      await keepOriginal(filePath, workspaceRoot)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(tmpPath, merged, 'utf-8')
      await rename(tmpPath, filePath)
      written = filePath
    }

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
