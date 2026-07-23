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
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. Write .cursorrules markdown governance text
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const content = buildMarkdownContent(sops, proxyUrl)
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = filePath + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)

    // 2. Inject hooks.json at project + user level (writeSystemLevel=false;
    //    system level requires sudo execution)
    await writeCursorHooks(workspaceRoot, proxyUrl, '', false)

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(join(workspaceRoot, CONFIG_FILE)) } catch { return null }
  },
}
