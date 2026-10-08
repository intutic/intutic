/**
 * Base adapter — shared logic for file-write harnesses.
 *
 * Cursor, Claude Code, Windsurf, and Aider all follow the same
 * pattern: detect by file existence, write markdown/text, hash file.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { join } from 'node:path'
import { access } from 'node:fs/promises'
import type { HarnessType, SyncSopEntry } from '@intutic/shared-types'
import type { IHarnessAdapter } from './types.js'
import { hashFile } from '../lib/hash.js'
import { newIso } from '@intutic/id'
import { writeOwnedFile } from '@intutic/sync-daemon'

/** Header prepended to all governance config files. */
function buildHeader(): string {
  return [
    '# Intutic Governance Rules (auto-generated)',
    '# DO NOT EDIT — managed by intutic sync daemon',
    `# Last sync: ${newIso()}`,
    '',
    '',
  ].join('\n')
}

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

/** Build markdown content from SOPs (Cursor, Claude Code, Windsurf). */
export function buildMarkdownContent(sops: SyncSopEntry[], proxyUrl: string): string {
  const header = buildHeader()
  const proxySection = `> **Proxy URL:** \`${proxyUrl}\`\n\n`
  return header + proxySection + buildSopSections(sops) + '\n'
}

/**
 * Create a file-based harness adapter for markdown-style config files.
 *
 * Used by: Cursor (.cursorrules), Claude Code (CLAUDE.md), Windsurf (.windsurfrules)
 */
export function createMarkdownAdapter(
  type: HarnessType,
  configFileName: string,
): IHarnessAdapter {
  return {
    type,
    configFileName,

    async detect(workspaceRoot: string): Promise<boolean> {
      try {
        await access(join(workspaceRoot, configFileName))
        return true
      } catch {
        return false
      }
    },

    async writeConfig(workspaceRoot: string, sops: SyncSopEntry[], proxyUrl: string): Promise<string | null> {
      if (sops.length === 0) return null
      const filePath = join(workspaceRoot, configFileName)
      const content = buildMarkdownContent(sops, proxyUrl)
      await writeOwnedFile(filePath, workspaceRoot, content)
      return filePath
    },

    async readCurrentHash(workspaceRoot: string): Promise<string | null> {
      try {
        return await hashFile(join(workspaceRoot, configFileName))
      } catch {
        return null
      }
    },
  }
}
