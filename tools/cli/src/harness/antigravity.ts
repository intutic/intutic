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
 * - rules: a marked section of the workspace's `GEMINI.md`, the context file
 *   both products load as persistent instructions (see rulesSection.ts).
 *   Gemini CLI reads `GEMINI.md` from the workspace up to the git root (its
 *   `context.fileName` setting can rename it); Antigravity reads `GEMINI.md`
 *   and `AGENTS.md` in every directory from the file it works on up to the
 *   workspace root. Neither reads a `customInstructions` key in
 *   `.gemini/settings.json`, where earlier versions put the rules;
 *   `intutic disconnect` removes that key.
 *
 * A hooks file that is not a plain JSON object is left alone and reported.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { join } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashString } from '../lib/hash.js'
import { loadCredentials } from '../config/store.js'
import { buildSopSections } from './base.js'
import { rulesSectionOf, writeRulesSection, writeAntigravityCliHooks, writeAntigravityHooks } from '@intutic/sync-daemon'

const CONFIG_FILE = 'GEMINI.md'

/**
 * The section's text. No sync time in it: the same rule sets give the same
 * bytes, so a sync with nothing new leaves the user's file alone.
 */
function buildRulesBody(sops: SyncSopEntry[], proxyUrl: string): string {
  return [
    '# Intutic Governance Rules (auto-generated)',
    '# DO NOT EDIT this section — managed by intutic sync daemon; edit outside the INTUTIC:RULES markers',
    '',
    `> **Proxy URL:** \`${proxyUrl}\``,
    '',
    buildSopSections(sops),
  ].join('\n')
}

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
    await writeRulesSection(filePath, workspaceRoot, buildRulesBody(sops, proxyUrl))
    return filePath
  },

  /** The section only: the user's own edits elsewhere in `GEMINI.md` are not drift. */
  async readCurrentHash(workspaceRoot: string): Promise<string | null> {
    let content: string
    try {
      content = await readFile(join(workspaceRoot, CONFIG_FILE), 'utf-8')
    } catch {
      return null
    }
    const section = rulesSectionOf(content)
    return section === null ? null : hashString(section)
  },
}
