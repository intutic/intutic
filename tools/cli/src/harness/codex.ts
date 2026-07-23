/**
 * codex.ts — Codex adapter (updated: also writes ~/.codex/config.toml).
 *
 * In addition to the workspace .env.intutic file, writes
 * ~/.codex/config.toml with model_providers.litellm.base_url so Codex
 * routes LLM calls through the Intutic proxy even without env var sourcing.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join, dirname } from 'node:path'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'

const CONFIG_FILE = '.env.intutic'
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')

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

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    // 1. Workspace .env.intutic
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const envContent = [
      '# Intutic Governance Rules (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '# Source this file: source .env.intutic',
      '',
      `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
      `export OPENAI_BASE_URL="${proxyUrl}"`,
      `export INTUTIC_PROXY_URL="${proxyUrl}"`,
      `export INTUTIC_SOP_COUNT=${sops.length}`,
      '',
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    const tmpEnv = filePath + '.intutic-tmp'
    await writeFile(tmpEnv, envContent, 'utf-8')
    await rename(tmpEnv, filePath)

    // 2. ~/.codex/config.toml — persists proxy across sessions without env sourcing
    const codexToml = [
      '# Intutic proxy config (auto-generated)',
      '# DO NOT EDIT — managed by intutic sync daemon',
      `# Last sync: ${newIso()}`,
      '',
      '[model_providers.litellm]',
      `base_url = "${proxyUrl}"`,
      '',
      '[model_providers.openai]',
      `base_url = "${proxyUrl}"`,
      '',
    ].join('\n')

    await mkdir(dirname(CODEX_CONFIG), { recursive: true })
    const tmpToml = CODEX_CONFIG + '.intutic-tmp'
    await writeFile(tmpToml, codexToml, 'utf-8')
    await rename(tmpToml, CODEX_CONFIG)

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
