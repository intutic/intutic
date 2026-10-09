/**
 * windsurf.ts — Windsurf adapter (full implementation with hooks + TLS MITM proxy config).
 *
 * Writes the rule sets to `.windsurf/rules/intutic-governance.md` with
 * `trigger: always_on`, which Cascade includes in every message
 * (https://docs.devin.ai/desktop/cascade/memories, where Windsurf's rules
 * docs now live; `.windsurfrules`, which earlier versions overwrote, is the
 * legacy single file, and the user's own copy of it comes back), and injects
 * Cascade hook scripts
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
import { HarnessType, rulesFrontMatterOf } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { writeWindsurfHooks } from '@intutic/sync-daemon/harness/windsurfHooks'
import { ownRulesFileHash, retireLegacyRulesFile, writeOwnRulesFile } from './rulesFiles.js'

const CONFIG_FILE = '.windsurf/rules/intutic-governance.md'
const LEGACY_FILE = '.windsurfrules'
const WINDSURF_USER_DIR = join(homedir(), '.codeium', 'windsurf')

export const windsurfAdapter: IHarnessAdapter = {
  type: HarnessType.WINDSURF,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    for (const marker of [LEGACY_FILE, '.windsurf']) {
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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    await retireLegacyRulesFile(workspaceRoot, LEGACY_FILE)
    return writeOwnRulesFile(workspaceRoot, CONFIG_FILE, sops, proxyUrl, rulesFrontMatterOf(HarnessType.WINDSURF, 'Intutic governance rules'))
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return ownRulesFileHash(workspaceRoot, CONFIG_FILE)
  },
}
