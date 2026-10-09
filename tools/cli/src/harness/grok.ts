/**
 * grok.ts — xAI Grok Build adapter (binary `grok`, GA 2026-05, open-sourced
 * 2026-07-15).
 *
 * Detects the Grok Build CLI, writes the rule sets into `AGENTS.md` through
 * the shared writer (agentsMd.ts), and injects the Intutic
 * governance hook (`grokHooks.ts` — PreToolUse, no matcher, confirmed
 * `{"decision":"deny","reason":"..."}` stdout contract) plus the
 * `config.toml` `[model.*]` `base_url` merge.
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
import { writeGrokHooks } from '@intutic/sync-daemon/harness/grokHooks'
import { AGENTS_MD, agentsMdHash, writeAgentsMd } from './agentsMd.js'

export const grokAdapter: IHarnessAdapter = {
  type: HarnessType.GROK,
  configFileName: AGENTS_MD,

  async detect(workspaceRoot: string): Promise<boolean> {
    // Workspace-local `.grok/` (project config/hooks dir) or AGENTS.md.
    for (const marker of ['.grok', AGENTS_MD]) {
      try { await access(join(workspaceRoot, marker)); return true } catch { /* fall through */ }
    }
    // `~/.grok` (user has Grok Build installed and has run it at least once).
    try { await access(join(homedir(), '.grok')); return true } catch { /* fall through */ }
    // `grok` on PATH — same PATH-scan convention codex.ts uses.
    const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    try {
      const { accessSync } = await import('node:fs')
      for (const dir of pathDirs) {
        try { accessSync(join(dir, 'grok')); return true } catch { /* not here */ }
      }
    } catch { /* ignore */ }
    return false
  },

  /** PreToolUse gate (project + user level) + config.toml model base_url
   *  merge (project + user level). */
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeGrokHooks(workspaceRoot, proxyUrl, '')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
