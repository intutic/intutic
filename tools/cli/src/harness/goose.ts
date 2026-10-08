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

  /** The governance plugin and the config proxy URL (gooseHooks handles both). */
  async installGate(_workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeGooseHooks(proxyUrl)
  },

  // Unlike every markdown adapter, Goose has no text-rules file to write rule
  // sets to — `HARNESS_CONFIG_FILES.goose` is empty, and its governance is
  // the PreToolUse plugin, whose gate is compiled from the shared
  // protected-path list rather than from the rule sets.
  async writeConfig(): Promise<string | null> {
    return null
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(GOOSE_CONFIG)
    } catch {
      return null
    }
  },
}
