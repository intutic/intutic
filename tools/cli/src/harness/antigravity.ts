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
 * The two gates report under their own gate ids, `antigravity` and
 * `gemini-cli` (gateIdentity.ts in @intutic/shared-types), so the control
 * plane can tell the products apart; the harness stays one.
 *
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */

import { HarnessType } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { loadCredentials } from '../config/store.js'
import { antigravityGateIdentities, writeAntigravityCliHooks, writeAntigravityHooks } from '@intutic/sync-daemon'
import { rulesSectionHash, writeRulesSectionFile } from './rulesFiles.js'

const CONFIG_FILE = 'GEMINI.md'

export const antigravityAdapter: IHarnessAdapter = {
  type: HarnessType.ANTIGRAVITY,
  configFileName: CONFIG_FILE,

  /**
   * Either product, found the way the sync daemon finds it for the agent
   * report and the AI inventory (antigravityProducts.ts): Antigravity's
   * app-data directories or a project `.agents/hooks.json`; Gemini CLI's
   * `gemini` on PATH, a project `.gemini` directory or its own
   * `~/.gemini/settings.json`. A plain Gemini CLI install with no `.gemini`
   * in the workspace is found by the binary and the settings file.
   */
  async detect(workspaceRoot: string): Promise<boolean> {
    return (await antigravityGateIdentities(workspaceRoot)).length > 0
  },

  async installGate(workspaceRoot: string, proxyUrl: string): Promise<void> {
    const workspaceId = (await loadCredentials())?.workspaceId || 'local'
    await writeAntigravityCliHooks(workspaceRoot, proxyUrl, workspaceId)
    await writeAntigravityHooks(workspaceRoot, proxyUrl, workspaceId)
  },

  writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
    return writeRulesSectionFile(workspaceRoot, CONFIG_FILE, sops, proxyUrl)
  },

  /** The section only: the user's own edits elsewhere in `GEMINI.md` are not drift. */
  readCurrentHash(workspaceRoot: string): Promise<string | null> {
    return rulesSectionHash(workspaceRoot, CONFIG_FILE)
  },
}
