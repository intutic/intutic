/**
 * goose.ts — Goose adapter (full implementation).
 *
 * Detects the Goose CLI agent, writes SOP rules, injects the Intutic
 * governance plugin (PreToolUse hooks + immutable flags), and merges
 * the proxy URL into ~/.config/goose/config.yaml.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { writeGooseHooks } from '@intutic/sync-daemon/harness/gooseHooks'

const CONFIG_FILE = '.config/goose/config.yaml'
const GOOSE_CONFIG = join(homedir(), CONFIG_FILE)

export const gooseAdapter: IHarnessAdapter = {
  type: HarnessType.GOOSE,
  configFileName: CONFIG_FILE,

  async detect(_workspaceRoot: string): Promise<boolean> {
    try {
      await access(GOOSE_CONFIG)
      return true
    } catch {
      return false
    }
  },

  // `_sops` is unused by design, unlike every markdown adapter: Goose has no
  // text-rules file to write them to — `HARNESS_CONFIG_FILES.goose` is empty,
  // and its governance is the PreToolUse plugin, whose gate is compiled from
  // the shared protected-path list rather than from this array.
  async writeConfig(_workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // Write governance plugin + config proxy URL (gooseHooks handles both)
    await writeGooseHooks(proxyUrl)
    return GOOSE_CONFIG
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(GOOSE_CONFIG)
    } catch {
      return null
    }
  },
}
