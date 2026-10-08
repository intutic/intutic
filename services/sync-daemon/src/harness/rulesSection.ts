/**
 * rulesSection.ts — rule sets as a marked section of an instructions file the
 * user also writes.
 *
 * Most rules files are Intutic's whole (`.cursorrules`, `.clinerules/...`).
 * Some are not: Gemini CLI and Google Antigravity read the workspace's
 * `GEMINI.md`, where the user keeps their own instructions. There the rule
 * sets go between a marker pair, the same shape the decisions log uses in
 * `CLAUDE.md`, and nothing outside the markers is touched:
 *
 * - a file without the markers gets the section appended after a blank line;
 * - a file with them gets the text between them replaced, wherever the user
 *   moved the section to;
 * - writing the same rule sets again leaves the file as it is.
 *
 * The file before Intutic's first write is kept ({@link keepOriginal}), so
 * `intutic disconnect` puts back the exact bytes when nothing outside the
 * section changed, and otherwise removes only the section
 * ({@link removeRulesSection}).
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '@intutic/logger'
import { keepOriginal } from '../disconnect/originals.js'

const log = createLogger('sync-rules-section')

export const RULES_SECTION_START = '<!-- INTUTIC:RULES:START -->'
export const RULES_SECTION_END = '<!-- INTUTIC:RULES:END -->'

/** The section's offsets: the first end marker, and the last start marker before it. */
function locate(content: string): { start: number; end: number } | null {
  const endAt = content.indexOf(RULES_SECTION_END)
  if (endAt === -1) return null
  const start = content.lastIndexOf(RULES_SECTION_START, endAt)
  if (start === -1) return null
  return { start, end: endAt + RULES_SECTION_END.length }
}

function section(body: string): string {
  return `${RULES_SECTION_START}\n${body.trimEnd()}\n${RULES_SECTION_END}`
}

/** `content` with the section holding `body`: replaced in place, or appended. */
export function injectRulesSection(content: string, body: string): string {
  const at = locate(content)
  if (at) return content.slice(0, at.start) + section(body) + content.slice(at.end)
  if (content === '') return `${section(body)}\n`
  const sep = content.endsWith('\n') ? '\n' : '\n\n'
  return `${content}${sep}${section(body)}\n`
}

/** The text between the markers, markers included; null when there is no section. */
export function rulesSectionOf(content: string): string | null {
  const at = locate(content)
  return at ? content.slice(at.start, at.end) : null
}

/**
 * `content` without the section and the line break that followed it; at the
 * end of the file, without the blank lines before it either. Null when there
 * is no section.
 */
export function removeRulesSection(content: string): string | null {
  const at = locate(content)
  if (!at) return null
  const before = content.slice(0, at.start)
  const after = content.slice(at.end).replace(/^\r?\n/, '')
  if (after !== '') return before + after
  return before.trim() === '' ? '' : before.replace(/(\r?\n)+$/, '\n')
}

/**
 * Write `body` as the rules section of `filePath`, keeping the rest of the
 * file. An unreadable file is reported and left alone.
 */
export async function writeRulesSection(filePath: string, workspaceRoot: string, body: string): Promise<void> {
  let current = ''
  let mode: number | undefined
  try {
    current = await fs.readFile(filePath, 'utf-8')
    mode = (await fs.stat(filePath)).mode & 0o7777
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ action: 'rules_section_skipped', path: filePath, error: String(err) }, `Could not read ${filePath} — left untouched`)
      return
    }
  }
  const next = injectRulesSection(current, body)
  if (next === current) return

  await keepOriginal(filePath, workspaceRoot)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.intutic-tmp`
  await fs.writeFile(tmp, next, 'utf-8')
  if (mode !== undefined) await fs.chmod(tmp, mode)
  await fs.rename(tmp, filePath)
  log.info({ action: 'rules_section_written', path: filePath }, `Wrote the Intutic rules section of ${filePath}`)
}
