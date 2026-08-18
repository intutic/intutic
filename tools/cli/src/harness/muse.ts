/**
 * muse.ts — Meta "Muse Code" adapter (binary `muse`, model Muse Spark).
 *
 * Muse Code is a CLI harness, beta since 2026-08-05. Its rules/instructions
 * file is `AGENTS.md` (it falls back to `CLAUDE.md` when that is absent) —
 * this codebase has no dedicated "AGENTS.md content builder" of its own to
 * reuse; the shared markdown content path every text-rules harness already
 * uses (`buildMarkdownContent`, the same function Claude Code's `CLAUDE.md`
 * adapter calls) is what gets reused here, so Muse does not grow a second
 * rules format.
 *
 * The governance-critical half — the PreToolUse/PermissionRequest hook
 * registration and the MCP `mcp_servers` proxy-wrap — is delegated to
 * `@intutic/sync-daemon`'s `museHooks.ts`, the same split Goose's adapter
 * uses for its plugin installation.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { access, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { buildMarkdownContent } from './base.js'
import { writeMuseHooks } from '@intutic/sync-daemon/harness/museHooks'

/** Workspace-relative rules file. Muse reads this, falling back to CLAUDE.md. */
const CONFIG_FILE = 'AGENTS.md'

/** `~/.config/muse/settings.json` — carries `schema_version`, `mcp_servers`,
 *  and (once `museHooks.ts` has run) `managed_hooks_path`. */
const MUSE_SETTINGS = join(homedir(), '.config', 'muse', 'settings.json')

export const museAdapter: IHarnessAdapter = {
  type: HarnessType.MUSE_CODE,
  configFileName: CONFIG_FILE,

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const agentsPath = join(workspaceRoot, CONFIG_FILE)

    // 1. AGENTS.md rules file — same "skip when there is nothing to write"
    //    convention `createMarkdownAdapter` uses; unlike Goose, Muse DOES
    //    have a rules file, so sops are not ignored here.
    if (sops.length > 0) {
      const content = buildMarkdownContent(sops, proxyUrl)
      await mkdir(dirname(agentsPath), { recursive: true })
      const tmp = agentsPath + '.intutic-tmp'
      await writeFile(tmp, content, 'utf-8')
      await rename(tmp, agentsPath)
    }

    // 2. PreToolUse/PermissionRequest hooks (project .muse/hooks.json +
    //    managed_hooks_path merge into ~/.config/muse/settings.json).
    //    `intutic connect` has no workspace id in scope — same limitation
    //    `gooseAdapter` has — the sync daemon re-runs this with a real one
    //    on the next cycle.
    await writeMuseHooks(workspaceRoot, proxyUrl, '')

    return agentsPath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
