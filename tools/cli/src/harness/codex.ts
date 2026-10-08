/**
 * codex.ts — Codex adapter.
 *
 * Writes three things:
 * - `.env.intutic` in the workspace, with the proxy base URLs for shells and
 *   scripts that source it;
 * - `openai_base_url` in Codex's user config (`$CODEX_HOME/config.toml`,
 *   `~/.codex/config.toml` by default), merged into the user's file, so Codex
 *   routes LLM calls through the proxy without sourcing anything — see
 *   codexConfigMerger.ts;
 * - the PreToolUse gate, registered in `~/.codex/hooks.json` and the
 *   project's `.codex/hooks.json` — see codexHooks.ts.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType, anthropicBaseUrl, openaiBaseUrl, proxyHost } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { newIso } from '@intutic/id'
import { writeCodexHooks, mergeCodexConfig, writeOwnedFile } from '@intutic/sync-daemon'

const CONFIG_FILE = '.env.intutic'

/** Codex's user config directory, resolved at call time so CODEX_HOME and
 *  HOME changes (and tests that move them) are honoured. */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

export const codexAdapter: IHarnessAdapter = {
  type: HarnessType.CODEX,
  configFileName: CONFIG_FILE,

  async detect(_workspaceRoot: string): Promise<boolean> {
    if (process.env.CODEX_HOME) return true
    const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    try {
      const { accessSync } = await import('node:fs')
      for (const dir of pathDirs) {
        try { accessSync(join(dir, 'codex')); return true } catch { /* not here */ }
      }
    } catch { /* ignore */ }
    return false
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    // Codex user config — persists proxy routing across sessions without env
    // sourcing. Merged; a config.toml that does not parse is left alone.
    await mergeCodexConfig(join(codexHome(), 'config.toml'), openaiBaseUrl(proxyUrl))

    // The PreToolUse gate. The routing above governs LLM egress only; the
    // gate is what refuses tool calls.
    const creds = await loadCredentials()
    await writeCodexHooks(workspaceRoot, proxyUrl, creds?.workspaceId || 'local')
  },

  /** Workspace .env.intutic. */
  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const envContent = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '# Source this file: source .env.intutic',
      '',
      `export ANTHROPIC_BASE_URL="${anthropicBaseUrl(proxyUrl)}"`,
      `export OPENAI_BASE_URL="${openaiBaseUrl(proxyUrl)}"`,
      `export INTUTIC_PROXY_URL="${proxyHost(proxyUrl)}"`,
      `export INTUTIC_SOP_COUNT=${sops.length}`,
      '',
    ].join('\n')

    await writeOwnedFile(filePath, workspaceRoot, envContent)
    return filePath
  },

  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    try {
      return await hashFile(join(workspaceRoot, CONFIG_FILE))
    } catch {
      return null
    }
  },
}
