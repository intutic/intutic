/**
 * dsh.ts — DeepSeek "dsh" adapter (binary `dsh`, `@deepseek-ai/dsh`,
 * developer preview since 2026-08-13).
 *
 * Rule sets go into the workspace's `AGENTS.md` through the shared writer
 * (agentsMd.ts): dsh's default profile loads every `AGENTS.md` and
 * `CLAUDE.md` from the git root down to where it runs
 * (https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/context/agent-instructions/README.md).
 * The governance-critical half — the
 * `tools/pre-execute` Cordis plugin registration (`cordis.patch.yml` per
 * profile), the profile's `@intutic/gate` dependency, and the `llm-deepseek`
 * egress override in that same patch file — is delegated entirely to
 * `@intutic/sync-daemon`'s `dshHooks.ts`, the same split Goose/Muse Code's
 * adapters use for their own plugin installation.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { writeDshHooks, resolveDshHome } from '@intutic/sync-daemon/harness/dshHooks'
import { AGENTS_MD, agentsMdHash, writeAgentsMd } from './agentsMd.js'

export const dshAdapter: IHarnessAdapter = {
  type: HarnessType.DEEPSEEK_HARNESS,
  configFileName: AGENTS_MD,

  async detect(_workspaceRoot: string): Promise<boolean> {
    const dshHome = resolveDshHome()

    // 1. `$DSH_HOME`/`~/.dsh` exists at all (settings.yaml, .credentials.yaml,
    //    or profiles/ — any one of them means dsh has been run here before).
    for (const marker of ['settings.yaml', '.credentials.yaml', 'profiles']) {
      try {
        await access(join(dshHome, marker))
        return true
      } catch {
        /* not here */
      }
    }

    // 2. `@deepseek-ai/dsh` on PATH (npm/pnpm global bin) or a local npx
    //    cache entry — the same PATH-scan convention grok.ts/muse.ts use.
    const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    try {
      const { accessSync } = await import('node:fs')
      for (const dir of pathDirs) {
        try {
          accessSync(join(dir, 'dsh'))
          return true
        } catch {
          /* not here */
        }
      }
    } catch {
      /* ignore */
    }

    // 3. npx's package cache (`~/.npm/_npx/*/node_modules/@deepseek-ai/dsh`) —
    //    a developer who has only ever run `npx @deepseek-ai/dsh` without a
    //    global install still leaves this behind. Best-effort: npx caches by
    //    a content hash directory name this adapter cannot predict, so this
    //    only catches the common `~/.npm/_npx` root existing AND dsh already
    //    having created `$DSH_HOME` (marker 1 above already covers the
    //    "actually run at least once" case) — listed for completeness with
    //    the CLI adapters this mirrors, not as an independent signal.
    return false
  },

  // The plugin registration + egress row in each profile patch is the
  // entirety of what this harness gets, and it happens for every existing
  // profile, not one file.
  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await writeDshHooks(workspaceRoot, proxyUrl, '')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeAgentsMd(workspaceRoot, sops, proxyUrl)
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return agentsMdHash(workspaceRoot)
  },
}
