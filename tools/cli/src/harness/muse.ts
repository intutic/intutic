/**
 * muse.ts — Meta "Muse Code" adapter (binary `muse`, model Muse Spark).
 *
 * Muse Code is a CLI harness, beta since 2026-08-05. Its instructions file
 * is `AGENTS.md` (it falls back to `CLAUDE.md` when that is absent); the rule
 * sets go there through the shared `AGENTS.md` writer (agentsMd.ts).
 *
 * The governance-critical half — the PreToolUse/PermissionRequest hook
 * registration and the MCP `mcp_servers` proxy-wrap — is delegated to
 * `@intutic/sync-daemon`'s `museHooks.ts`, the same split Goose's adapter
 * uses for its plugin installation.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { writeMuseHooks } from '@intutic/sync-daemon/harness/museHooks'
import { AGENTS_MD, agentsMdHash, writeAgentsMd } from './agentsMd.js'

/** `~/.config/muse/settings.json` — carries `schema_version`, `mcp_servers`,
 *  and (once `museHooks.ts` has run) `managed_hooks_path`. */
const MUSE_SETTINGS = join(homedir(), '.config', 'muse', 'settings.json')

export const museAdapter: IHarnessAdapter = {
  type: HarnessType.MUSE_CODE,
  configFileName: AGENTS_MD,

  async detect(workspaceRoot: string): Promise<boolean> {
    // 1. Project-local `.muse/` directory.
    try {
      await access(join(workspaceRoot, '.muse'))
      return true
    } catch { /* not here */ }

    // 2. User-level settings.json — installed but never run in this workspace.
    try {
      await access(MUSE_SETTINGS)
      return true
    } catch { /* not here */ }

    // 3. `muse` binary on PATH.
    const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    try {
      const { accessSync } = await import('node:fs')
      for (const dir of pathDirs) {
        try { accessSync(join(dir, 'muse')); return true } catch { /* not here */ }
      }
    } catch { /* ignore */ }
    return false
  },

  /** PreToolUse/PermissionRequest hooks (project .muse/hooks.json +
   *  managed_hooks_path merge into ~/.config/muse/settings.json). `intutic
   *  connect` has no workspace id in scope — same limitation `gooseAdapter`
   *  has — the sync daemon re-runs this with a real one on the next cycle. */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeMuseHooks(workspaceRoot, proxyUrl, '')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
