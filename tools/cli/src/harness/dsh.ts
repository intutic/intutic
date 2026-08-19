/**
 * dsh.ts — DeepSeek "dsh" adapter (binary `dsh`, `@deepseek-ai/dsh`,
 * developer preview since 2026-08-13).
 *
 * dsh is plugin-first (Cordis) and has no workspace-relative rules file this
 * adapter could write governance text into (see `types.ts`'s
 * `HARNESS_CONFIG_FILES.dsh`). The governance-critical half — the
 * `tools/pre-execute` Cordis plugin registration (`cordis.patch.yml` per
 * profile), the profile's `@intutic/gate` dependency, and the `settings.yaml`
 * `llm-pi-ai` proxy route — is delegated entirely to
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
import { writeDshHooks, resolveDshHome, listDshProfileDirs } from '@intutic/sync-daemon/harness/dshHooks'

export const dshAdapter: IHarnessAdapter = {
  type: HarnessType.DEEPSEEK_HARNESS,
  // No canonical workspace-relative config file — see types.ts's comment on
  // this harness's HARNESS_CONFIG_FILES entry. detect/writeConfig/
  // readCurrentHash below resolve dsh's real, $DSH_HOME-anchored paths
  // directly, the same way goose.ts bypasses configFileName's
  // workspaceRoot-join for its own home-anchored config.
  configFileName: '',

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

  async writeConfig(workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // No rules/markdown file for dsh — `sops` are not consulted here (same
    // "no text-rules file" posture as goose.ts's own adapter). The plugin
    // registration + settings.yaml merge is the entirety of what this
    // harness gets, and it happens for every existing profile, not one file.
    await writeDshHooks(workspaceRoot, proxyUrl, '')

    const dshHome = resolveDshHome()
    const profiles = await listDshProfileDirs(dshHome)
    // Representative path for the connect-summary UI, matching the "return
    // the path written" contract every other adapter follows — the first
    // profile's patch file when one exists, otherwise the $DSH_HOME root
    // itself (nothing was written yet; the next sync cycle picks it up once
    // a profile exists, per dshHooks.ts's own module doc).
    return profiles.length > 0 ? join(profiles[0]!, 'cordis.patch.yml') : dshHome
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    // No single canonical file to hash — dsh may have zero, one, or several
    // profiles, each with its own cordis.patch.yml. Matching goose.ts/
    // cline.ts's own "no rules file" precedent, this reports no hash rather
    // than picking one arbitrary profile's file to represent all of them.
    return null
  },
}
