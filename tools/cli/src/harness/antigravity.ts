/**
 * Antigravity adapter — Google Antigravity and Gemini CLI.
 *
 * Google's terminal agent was Gemini CLI until Antigravity CLI replaced it
 * for individual users in 2026; enterprise and API-key users keep Gemini
 * CLI. Both live under `~/.gemini`, and this one harness governs both:
 *
 * - the Antigravity gate (app, IDE and CLI): a `PreToolUse` hook in
 *   `~/.gemini/config/hooks.json` (see antigravityCliHooks.ts);
 * - the Gemini CLI gate: a `BeforeTool` hook in `~/.gemini/settings.json`
 *   (see antigravityHooks.ts);
 * - rules: SOP content merged into the `customInstructions` field of the
 *   workspace's `.gemini/settings.json`.
 *
 * A settings or hooks file that is not a plain JSON object is left alone and
 * reported.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'
import { loadCredentials } from '../config/store.js'
import { keepOriginal, readJsonObjectForMerge, writeAntigravityCliHooks, writeAntigravityHooks } from '@intutic/sync-daemon'

const CONFIG_FILE = '.gemini/settings.json'

export const antigravityAdapter: IHarnessAdapter = {
  type: HarnessType.ANTIGRAVITY,
  configFileName: CONFIG_FILE,

  async detect(workspaceRoot: string): Promise<boolean> {
    const markers = [
      join(workspaceRoot, '.gemini'),
      join(workspaceRoot, '.agents', 'hooks.json'),
      // Antigravity's app-data directories: the 2.0 app, the CLI and the IDE.
      join(homedir(), '.gemini', 'antigravity'),
      join(homedir(), '.gemini', 'antigravity-cli'),
      join(homedir(), '.gemini', 'antigravity-ide'),
    ]
    for (const marker of markers) {
      try {
        await access(marker)
        return true
      } catch {
        // fall through
      }
    }
    return false
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const workspaceId = (await loadCredentials())?.workspaceId || 'local'
    await writeAntigravityCliHooks(workspaceRoot, proxyUrl, workspaceId)
    await writeAntigravityHooks(workspaceRoot, proxyUrl, workspaceId)
  },

  async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    if (sops.length === 0) return null
    const filePath = join(workspaceRoot, CONFIG_FILE)
    const tmpPath = filePath + '.intutic-tmp'

    await keepOriginal(filePath, workspaceRoot)
    const settings = await readJsonObjectForMerge(filePath)
    if (settings === null) return null

    // Merge governance instructions
    const instructions = sops
      .map((sop) => `## ${sop.title}\n\n${sop.content}`)
      .join('\n\n---\n\n')

    settings.customInstructions = [
      '# Intutic Governance Rules (auto-generated)',
      `# DO NOT EDIT — managed by intutic sync daemon`,
      `# Last sync: ${newIso()}`,
      `# Proxy URL: ${proxyUrl}`,
      '',
      instructions,
    ].join('\n')

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    await rename(tmpPath, filePath)
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
