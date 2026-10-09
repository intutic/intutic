/**
 * agentsMd.ts — the one writer of `AGENTS.md`.
 *
 * `AGENTS.md` is the cross-tool instructions file (https://agents.md). Codex,
 * Grok Build, OpenCode, Muse Code and Pi all load the workspace's copy, and
 * it is often the team's own, so every one of them writes the same marked
 * section through this module instead of each writing the whole file: the
 * last writer used to replace the rules of the others, and the user's own
 * text with them.
 *
 * `intutic connect` hands each of them every rule set aimed at any
 * `AGENTS.md` reader configured in the workspace (`writeHarnessConfigs`), so
 * whichever writes, the section is the same. A rule set aimed at one of them
 * is therefore read by all of them: they share the file.
 *
 * @module
 */

import type { SyncSopEntry } from '@intutic/shared-types'
import { rulesSectionHash, writeRulesSectionFile } from './rulesFiles.js'

export const AGENTS_MD = 'AGENTS.md'

/** Writes the rule sets as the marked section of the workspace's `AGENTS.md`. */
export function writeAgentsMd(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
  return writeRulesSectionFile(workspaceRoot, AGENTS_MD, sops, proxyUrl)
}

/** The section's hash, for drift. */
export function agentsMdHash(workspaceRoot: string): Promise<string | null> {
  return rulesSectionHash(workspaceRoot, AGENTS_MD)
}
