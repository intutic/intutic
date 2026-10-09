/**
 * aider.ts — Aider adapter (full implementation with safe YAML merge).
 *
 * Merges proxy routing into .aider.conf.yml using the aiderConfigMerger,
 * which keeps the user's own keys, strips dangerous auto-exec keys
 * (test-cmd, lint-cmd) that Aider auto-executes on startup, and lists the
 * SOP text as a read-only context file (.intutic/aider-sops.md) by absolute
 * path: Aider loads no instructions file it is not told about
 * (https://aider.chat/docs/usage/conventions.html).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { AIDER_SOPS_FILE, mergeAiderConfig } from '@intutic/sync-daemon/harness/aiderConfigMerger'
import { buildSopSections } from './rulesFiles.js'

const CONFIG_FILE = '.aider.conf.yml'

export const aiderAdapter: IHarnessAdapter = {
  type: HarnessType.AIDER,
  // Drift is tracked on the rules file, which .aider.conf.yml lists under `read:`.
  configFileName: AIDER_SOPS_FILE,

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

    const sopsText = sops.length > 0 ? buildSopSections(sops) : undefined

    // Safe merge: strips test-cmd/lint-cmd, preserves all other user keys,
    // routes OpenAI (openai-api-base) and Anthropic (set-env) models through
    // the proxy and lists the SOPs as a read-only context file.
    return (await mergeAiderConfig(filePath, proxyUrl, sopsText)) ? filePath : null
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, AIDER_SOPS_FILE))
    } catch {
      return null
    }
  },
}
