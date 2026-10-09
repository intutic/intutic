/**
 * cursor.ts — Cursor adapter (full implementation with 3-level hooks).
 *
 * - Writes the rule sets to `.cursor/rules/intutic-governance.mdc`, a project
 *   rule with `alwaysApply: true`, which Cursor adds to every request
 *   (https://cursor.com/docs/context/rules; a plain `.md` there is ignored).
 *   Earlier versions overwrote `.cursorrules`, a single file the current docs
 *   no longer describe; the user's own copy of it comes back.
 * - Injects hooks.json at project-level AND user-level
 * - Enterprise system-level (/etc/cursor) is handled by the system administrator
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
import { writeCursorHooks } from '@intutic/sync-daemon/harness/cursorHooks'
import { ownRulesFileHash, retireLegacyRulesFile, writeOwnRulesFile } from './rulesFiles.js'

const CONFIG_FILE = '.cursor/rules/intutic-governance.mdc'
const LEGACY_FILE = '.cursorrules'
const FRONT_MATTER = 'description: Intutic governance rules\nalwaysApply: true'

export const cursorAdapter: IHarnessAdapter = {
  type: HarnessType.CURSOR,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // .cursorrules or .cursor/ directory
    for (const marker of [LEGACY_FILE, '.cursor']) {
      try { await access(join(workspaceRoot, marker)); return true } catch { /* fall through */ }
    }
    // ~/.cursor directory (user has Cursor installed)
    try { await access(join(homedir(), '.cursor')); return true } catch { return false }
  },

  /** hooks.json at project + user level; the system level needs
   *  administrator rights and is `intutic enterprise install`'s job. */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeCursorHooks(workspaceRoot, proxyUrl, '', false)
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    await retireLegacyRulesFile(workspaceRoot, LEGACY_FILE)
    return writeOwnRulesFile(workspaceRoot, CONFIG_FILE, sops, proxyUrl, FRONT_MATTER)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return ownRulesFileHash(workspaceRoot, CONFIG_FILE)
  },
}
