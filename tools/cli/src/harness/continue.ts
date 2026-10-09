/**
 * continue.ts — Continue adapter.
 *
 * Detects the Continue AI coding assistant and:
 * - sets `apiBase` on each OpenAI/Anthropic model in `~/.continue/config.yaml`
 *   so its LLM calls reach the proxy (merged; see continueConfigMerger.ts);
 * - installs the Continue CLI (`cn`) PreToolUse gate in
 *   `~/.continue/settings.json` and `<repo>/.continue/settings.json` (see
 *   continueHooks.ts). The IDE extension has no hook system, so for it proxy
 *   routing is the only mechanism;
 * - writes the rule sets to `.continue/rules/intutic-governance.md` with
 *   `alwaysApply: true`. The IDE extension reads the workspace root's
 *   `.continue/rules/`, and the CLI the one in the directory it runs in,
 *   which keeps only always-apply rules
 *   (https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/config/markdown/loadMarkdownRules.ts,
 *   https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/systemMessage.ts).
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType, rulesFrontMatterOf, openaiBaseUrl } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { mergeContinueConfig, writeContinueHooks } from '@intutic/sync-daemon'
import { ownRulesFileHash, writeOwnRulesFile } from './rulesFiles.js'

const RULES_FILE = '.continue/rules/intutic-governance.md'

/** `~/.continue/<name>`, resolved at call time so HOME changes (and tests
 *  that move HOME) are honoured. */
function continuePath(name: string): string {
  return join(homedir(), '.continue', name)
}

export const continueAdapter: IHarnessAdapter = {
  type: HarnessType.CONTINUE,
  configFileName: RULES_FILE,

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

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    await mergeContinueConfig(continuePath('config.yaml'), openaiBaseUrl(proxyUrl))
    const creds = await loadCredentials()
    await writeContinueHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeOwnRulesFile(workspaceRoot, RULES_FILE, sops, proxyUrl, rulesFrontMatterOf(HarnessType.CONTINUE, 'Intutic governance rules'))
  },

  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return ownRulesFileHash(workspaceRoot, RULES_FILE)
  },
}
