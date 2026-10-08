/**
 * continue.ts — Continue adapter.
 *
 * Detects the Continue AI coding assistant and:
 * - sets `apiBase` on each OpenAI/Anthropic model in `~/.continue/config.yaml`
 *   so its LLM calls reach the proxy (merged; see continueConfigMerger.ts);
 * - installs the Continue CLI (`cn`) PreToolUse gate in
 *   `~/.continue/settings.json` and `<repo>/.continue/settings.json` (see
 *   continueHooks.ts). The IDE extension has no hook system, so for it proxy
 *   routing is the only mechanism.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType, openaiBaseUrl } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { mergeContinueConfig, writeContinueHooks } from '@intutic/sync-daemon'

/** `~/.continue/<name>`, resolved at call time so HOME changes (and tests
 *  that move HOME) are honoured. */
function continuePath(name: string): string {
  return join(homedir(), '.continue', name)
}

export const continueAdapter: IHarnessAdapter = {
  type: HarnessType.CONTINUE,
  configFileName: continuePath('config.yaml'),

  async detect(_workspaceRoot: string): Promise<boolean> {
    for (const p of [continuePath('config.yaml'), continuePath('config.json')]) {
      try { await access(p); return true } catch { /* fall through */ }
    }
    try {
      const entries = await readdir(join(homedir(), '.vscode', 'extensions'))
      return entries.some((e) => e.startsWith('continue.continue-'))
    } catch {
      return false
    }
  },

  async writeConfig(workspaceRoot: string, _sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const configYaml = continuePath('config.yaml')
    const routed = await mergeContinueConfig(configYaml, openaiBaseUrl(proxyUrl))

    const creds = await loadCredentials()
    await writeContinueHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')

    return routed > 0 ? configYaml : null
  },

  async readCurrentHash(_workspaceRoot: string): Promise<string | null> {
    try { return await hashFile(continuePath('config.yaml')) } catch { return null }
  },
}
