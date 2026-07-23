/**
 * windsurf.ts — Windsurf adapter (full implementation with hooks + TLS MITM proxy config).
 *
 * Writes .windsurfrules governance text and injects Cascade hook scripts
 * at user-level (~/.codeium/windsurf/hooks.json) and workspace-level
 * (.windsurf/hooks.json). Also writes HTTP proxy settings so Windsurf
 * routes its AI traffic through the Intutic TLS MITM proxy.
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
import { writeWindsurfHooks } from '@intutic/sync-daemon/harness/windsurfHooks'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. Write .windsurfrules markdown governance text
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const content = buildMarkdownContent(sops, proxyUrl)
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = filePath + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)

    // 2. Write Cascade hooks.json at user + workspace level, configure TLS MITM proxy
    const proxyPort = parseInt(process.env.INTUTIC_PROXY_PORT ?? '8877', 10)
    await writeWindsurfHooks(workspaceRoot, proxyUrl, proxyPort)

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(join(workspaceRoot, CONFIG_FILE)) } catch { return null }
  },
}
