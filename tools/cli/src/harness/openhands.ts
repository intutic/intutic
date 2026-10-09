/**
 * openhands.ts — OpenHands adapter (full implementation with hooks + llm.base_url).
 *
 * - rules: `.openhands/microagents/intutic-governance.md`, a repository
 *   microagent with no triggers, which OpenHands keeps active in every
 *   conversation (V0's `microagent.py`: "no triggers -> REPO (always
 *   active)"; the V1 software-agent SDK loads the same directory as legacy
 *   skills, "no keywords -> always active"). Earlier versions put the rules
 *   in an `[intutic]` table of `config.toml`, which OpenHands never reads;
 *   connect drops that table and disconnect removes it;
 * - `[llm] base_url` merged into `config.toml`, keeping the rest of the file;
 * - the PreToolUse hook in `.openhands/hooks.json`.
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
import { writeOwnRulesFile } from './rulesFiles.js'

const CONFIG_FILE = 'config.toml'
const RULES_FILE = '.openhands/microagents/intutic-governance.md'

export const openhandsAdapter: IHarnessAdapter = {
  type: HarnessType.OPENHANDS,
  configFileName: RULES_FILE,

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
    // Merged into the user's config.toml: [llm] base_url; everything else is
    // kept. A file that does not parse is left alone.
    const configPath = join(workspaceRoot, CONFIG_FILE)
    let raw = ''
    try { raw = await readFile(configPath, 'utf-8') } catch { /* no config.toml yet */ }
    const merged = mergeOpenHandsToml(raw, proxyUrl)
    let written: string | null = null
    if (merged === null) {
      log.warn(`${configPath} is not valid TOML — left untouched`)
    } else if (merged !== raw) {
      const tmpPath = configPath + '.intutic-tmp'
      await keepOriginal(configPath, workspaceRoot)
      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(tmpPath, merged, 'utf-8')
      await rename(tmpPath, configPath)
      written = configPath
    }

    return (await writeOwnRulesFile(workspaceRoot, RULES_FILE, sops, proxyUrl)) ?? written
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, RULES_FILE))
    } catch {
      return null
    }
  },
}
