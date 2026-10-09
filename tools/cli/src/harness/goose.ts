/**
 * goose.ts — Goose adapter (full implementation).
 *
 * Detects the Goose CLI agent, writes the rule sets as a marked section of
 * the workspace's `.goosehints` (which Goose loads, with `AGENTS.md`, from
 * every directory between the git root and where it runs, at the start of
 * every session;
 * https://github.com/block/goose/blob/0f4768025f517f5812f6d962a90aa52d509863cf/crates/goose/src/hints/load_hints.rs),
 * injects the Intutic governance plugin (PreToolUse hooks + immutable flags),
 * and merges the proxy URL into ~/.config/goose/config.yaml.
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
import { writeGooseHooks } from '@intutic/sync-daemon/harness/gooseHooks'
import { rulesSectionHash, writeRulesSectionFile } from './rulesFiles.js'

const RULES_FILE = '.goosehints'
const GOOSE_CONFIG = join(homedir(), '.config', 'goose', 'config.yaml')

export const gooseAdapter: IHarnessAdapter = {
  type: HarnessType.GOOSE,
  configFileName: RULES_FILE,

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

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeRulesSectionFile(workspaceRoot, RULES_FILE, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return rulesSectionHash(workspaceRoot, RULES_FILE)
  },
}
