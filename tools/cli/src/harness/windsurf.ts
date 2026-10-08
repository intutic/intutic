/**
 * windsurf.ts — Windsurf adapter (full implementation with hooks + TLS MITM proxy config).
 *
 * Writes .windsurfrules governance text and injects Cascade hook scripts
 * at user-level (~/.codeium/windsurf/hooks.json) and workspace-level
 * (.windsurf/hooks.json), merged with any hooks already there. Also merges
 * HTTP proxy settings into Windsurf's user settings.json, and switches
 * the IDE HTTP proxy of every JetBrains IDE where the Windsurf plugin is set
 * up, so Windsurf's AI traffic goes through the Intutic TLS MITM proxy.
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
import { loadCredentials } from '../config/store.js'
import { writeWindsurfHooks } from '@intutic/sync-daemon/harness/windsurfHooks'
import { writeOwnedFile } from '@intutic/sync-daemon'

const CONFIG_FILE = '.windsurfrules'
const WINDSURF_USER_DIR = join(homedir(), '.codeium', 'windsurf')

export const windsurfAdapter: IHarnessAdapter = {
  type: HarnessType.WINDSURF,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    for (const marker of [CONFIG_FILE, '.windsurf']) {
      try { await access(join(workspaceRoot, marker)); return true } catch { /* fall through */ }
    }
    try { await access(WINDSURF_USER_DIR); return true } catch { return false }
  },

  /** Cascade hooks.json at user + workspace level, and the TLS MITM proxy.
   *  The proxy serves HTTP CONNECT on the same listener as its API, so the
   *  port is the one `intutic connect` runs it on (PORT, 4000 by default). */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const proxyPort = parseInt(process.env.PORT || '4000', 10)
    const creds = await loadCredentials()
    await writeWindsurfHooks(workspaceRoot, proxyUrl, proxyPort, creds?.workspaceId || 'local')
  },

  /** .windsurfrules markdown governance text. */
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
