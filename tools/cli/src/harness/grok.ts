/**
 * grok.ts — xAI Grok Build adapter (binary `grok`, GA 2026-05, open-sourced
 * 2026-07-15).
 *
 * Detects the Grok Build CLI, writes AGENTS.md governance text (the same
 * cross-tool rules-file convention Codex/Amp read), and injects the Intutic
 * governance hook (`grokHooks.ts` — PreToolUse, no matcher, confirmed
 * `{"decision":"deny","reason":"..."}` stdout contract) plus the
 * `config.toml` `[model.*]` `base_url` merge.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { buildMarkdownContent } from './base.js'
import { writeGrokHooks } from '@intutic/sync-daemon/harness/grokHooks'

const CONFIG_FILE = 'AGENTS.md'

export const grokAdapter: IHarnessAdapter = {
  type: HarnessType.GROK,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    // Workspace-local `.grok/` (project config/hooks dir) or AGENTS.md.
    for (const marker of ['.grok', CONFIG_FILE]) {
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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. AGENTS.md — governance rules text, same markdown formatter every
    //    other `---`-separated rules file in this codebase shares.
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const content = buildMarkdownContent(sops, proxyUrl)
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = filePath + '.intutic-tmp'
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)

    // 2. PreToolUse gate (project + user level) + config.toml model base_url
    //    merge (project + user level).
    await writeGrokHooks(workspaceRoot, proxyUrl, '')

    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(join(workspaceRoot, CONFIG_FILE)) } catch { return null }
  },
}
