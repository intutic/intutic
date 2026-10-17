/**
 * The harness writer `intutic connect` and `intutic gates install` share:
 * each configured harness's gate, and its rules file.
 *
 * @module
 */

import { HarnessType, rulesFileOf } from '@intutic/shared-types'
import type { SyncSopEntry } from '@intutic/shared-types'
import { claudeCodeReadsAgentsMd } from '@intutic/sync-daemon'
import { getAdapter } from './detector.js'
import type { HarnessWriteOptions } from './types.js'

export interface WriteHarnessConfigsOptions extends HarnessWriteOptions {
  /** Called with each rules file an adapter wrote. */
  onRulesFile?: (path: string) => void
}

/**
 * Applies a synced configuration to each configured harness.
 *
 * The gate is installed whatever rule sets the workspace has: it enforces the
 * built-in protections, the destructive-command tier, group rules and holds,
 * none of which need a rule set. Gating it on rule sets left a workspace with
 * none, or with none targeting a harness, with that harness ungoverned. The
 * rules file is written only when a rule set targets the harness, or on a
 * forced sync.
 *
 * Harnesses that read the same file (Codex, Grok Build, OpenCode, Muse Code
 * and others all read `AGENTS.md`) each get every rule set aimed at any of
 * them that is configured here: one section, the same for every writer, so
 * the last writer no longer replaces the others' rules.
 *
 * Claude Code reads its own `.claude/rules/` file at every launch, and also
 * the workspace's `AGENTS.md` when there is no `CLAUDE.md` on the path (or
 * the user chose `claude-md-and-agents-md`; see claudeAgentsMd.ts). When it
 * does, a rule set aimed at both Claude Code and an `AGENTS.md` reader
 * reaches it through `AGENTS.md`, so its own file leaves that rule set out
 * rather than load it twice.
 *
 * `opts.routing` (default true) also points each harness's LLM traffic at
 * `proxyUrl`; false writes gates and rules only.
 *
 * @returns how many rule sets were written into rules files.
 */
export async function writeHarnessConfigs(
  harnesses: readonly string[],
  workspaceRoot: string,
  sops: readonly SyncSopEntry[],
  proxyUrl: string,
  force: boolean,
  opts: WriteHarnessConfigsOptions = {},
): Promise<number> {
  const writeOpts: HarnessWriteOptions = { routing: opts.routing !== false }
  let written = 0
  const writtenFiles = new Set<string>()
  const agentsMdReaders = harnesses.filter((h) => rulesFileOf(h as HarnessType) === 'AGENTS.md')
  const claudeFromAgentsMd =
    harnesses.includes(HarnessType.CLAUDE_CODE) && agentsMdReaders.length > 0 && (await claudeCodeReadsAgentsMd(workspaceRoot))
  for (const harnessType of harnesses) {
    const adapter = getAdapter(harnessType)
    if (!adapter) continue

    await adapter.installGate?.(workspaceRoot, proxyUrl, writeOpts)

    const file = rulesFileOf(harnessType as HarnessType)
    const readers = file === null ? [harnessType] : harnesses.filter((h) => rulesFileOf(h as HarnessType) === file)
    const aimed = sops.filter((sop) => sop.harnessTargets.some((t) => readers.includes(t)))
    const viaAgentsMd = harnessType === HarnessType.CLAUDE_CODE && claudeFromAgentsMd
    const targetSops = viaAgentsMd ? aimed.filter((sop) => !sop.harnessTargets.some((t) => agentsMdReaders.includes(t))) : aimed
    // Claude Code's own file is rewritten even when every rule set aimed at
    // it now comes through AGENTS.md, so it stops carrying them.
    if (aimed.length === 0 && !force) continue
    const path = await adapter.writeConfig(workspaceRoot, targetSops, proxyUrl, writeOpts)
    if (!path) continue
    opts.onRulesFile?.(path)
    // A shared file counts once, however many of its readers wrote it.
    if (file === null || !writtenFiles.has(file)) written += targetSops.length
    if (file !== null) writtenFiles.add(file)
  }
  return written
}
