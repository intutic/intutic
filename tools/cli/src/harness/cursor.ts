/**
 * cursor.ts — Cursor adapter (full implementation with 3-level hooks).
 *
 * Replaces the minimal createMarkdownAdapter stub with a full adapter that:
 * - Writes .cursorrules governance text (existing behaviour, kept)
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
import { hashFile } from '../lib/hash.js'
import { buildMarkdownContent } from './base.js'
import { writeCursorHooks } from '@intutic/sync-daemon/harness/cursorHooks'
import { writeOwnedFile } from '@intutic/sync-daemon'

const CONFIG_FILE = '.cursorrules'

export const cursorAdapter: IHarnessAdapter = {
  type: HarnessType.CURSOR,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // .cursorrules or .cursor/ directory
    for (const marker of [CONFIG_FILE, '.cursor']) {
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

  /** .cursorrules markdown governance text. */
  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const content = buildMarkdownContent(sops, proxyUrl)
    await writeOwnedFile(filePath, workspaceRoot, content)
    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(join(workspaceRoot, CONFIG_FILE)) } catch { return null }
  },
}
