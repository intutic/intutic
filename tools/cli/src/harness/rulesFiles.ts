/**
 * rulesFiles.ts — the two ways a rule set reaches a harness's instructions.
 *
 * Which file each harness reads is `HARNESS_RULES_FILES` in
 * `@intutic/shared-types`, with the product documentation that says so. The
 * adapters write through these helpers, and `rulesFiles.test.ts` checks every
 * adapter writes where the map says and nowhere else.
 *
 * - {@link writeRulesSectionFile}: a file the user also writes (`CLAUDE.md`,
 *   `AGENTS.md`, `GEMINI.md`, `.goosehints`, ...). The rule sets go between
 *   the INTUTIC:RULES markers and the rest of the file is the user's.
 * - {@link writeOwnRulesFile}: a file of Intutic's own in a directory the
 *   product reads every file of (`.cursor/rules/`, `.continue/rules/`, ...).
 *
 * Neither carries a sync time: the same rule sets give the same bytes, so a
 * sync with nothing new leaves the file alone.
 *
 * @module
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { SyncSopEntry } from '@intutic/shared-types'
import { retireRulesFile, rulesSectionOf, writeOwnedFile, writeRulesSection } from '@intutic/sync-daemon'
import { hashFile, hashString } from '../lib/hash.js'

/**
 * One markdown section per SOP. Each SOP the control plane synced ends with
 * its `sop://` pointer comment, which maps the rules in the file back to the
 * SOP that produced them.
 */
export function buildSopSections(sops: SyncSopEntry[]): string {
  return sops
    .map((sop) => `## ${sop.title}\n\n${sop.content}${sop.sopRef ? `\n${sop.sopRef}` : ''}`)
    .join('\n\n---\n\n')
}

/**
 * The rule sets as markdown: the generated header (which `intutic disconnect`
 * recognises), the proxy URL, one section per SOP.
 */
export function buildRulesBody(sops: SyncSopEntry[], proxyUrl: string, shape: 'section' | 'file'): string {
  return [
    '# Intutic Governance Rules (auto-generated)',
    shape === 'section'
      ? '# DO NOT EDIT this section — managed by intutic sync daemon; edit outside the INTUTIC:RULES markers'
      : '# DO NOT EDIT — managed by intutic sync daemon; put rules of your own in another file',
    '',
    `> **Proxy URL:** \`${proxyUrl}\``,
    '',
    buildSopSections(sops),
  ].join('\n')
}

/**
 * Writes the rule sets as the marked section of `relPath`. Nothing is written
 * without a rule set. Returns the absolute path, or null.
 */
export async function writeRulesSectionFile(
  workspaceRoot: string,
  relPath: string,
  sops: SyncSopEntry[],
  proxyUrl: string,
): Promise<string | null> {
  if (sops.length === 0) return null
  const filePath = join(workspaceRoot, relPath)
  await writeRulesSection(filePath, workspaceRoot, buildRulesBody(sops, proxyUrl, 'section'))
  return filePath
}

/** The section's hash: the user's own edits elsewhere in the file are not drift. */
export async function rulesSectionHash(workspaceRoot: string, relPath: string): Promise<string | null> {
  let content: string
  try {
    content = await readFile(join(workspaceRoot, relPath), 'utf-8')
  } catch {
    return null
  }
  const section = rulesSectionOf(content)
  return section === null ? null : hashString(section)
}

/**
 * Writes the rule sets as Intutic's own file `relPath`, after `frontMatter`
 * (the product's own keys, e.g. `alwaysApply: true`) when given. Nothing is
 * written without a rule set. Returns the absolute path, or null.
 */
export async function writeOwnRulesFile(
  workspaceRoot: string,
  relPath: string,
  sops: SyncSopEntry[],
  proxyUrl: string,
  frontMatter?: string,
): Promise<string | null> {
  if (sops.length === 0) return null
  const filePath = join(workspaceRoot, relPath)
  const body = `${buildRulesBody(sops, proxyUrl, 'file')}\n`
  await writeOwnedFile(filePath, workspaceRoot, frontMatter ? `---\n${frontMatter.trimEnd()}\n---\n\n${body}` : body)
  return filePath
}

/** The hash of a whole file Intutic owns; null when it does not exist. */
export async function ownRulesFileHash(workspaceRoot: string, relPath: string): Promise<string | null> {
  try {
    return await hashFile(join(workspaceRoot, relPath))
  } catch {
    return null
  }
}

/**
 * Takes back the whole rules file earlier versions wrote at `relPath`, a path
 * the product has stopped reading or reads only as a legacy fallback: the
 * user's original comes back, or the file goes when Intutic created it.
 */
export function retireLegacyRulesFile(workspaceRoot: string, relPath: string): Promise<void> {
  return retireRulesFile(join(workspaceRoot, relPath), workspaceRoot)
}
