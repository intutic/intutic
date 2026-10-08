/**
 * jsonMergeTarget.ts — read a user-owned JSON config before merging into it.
 *
 * Every writer that adds Intutic keys to a file the user also edits (a
 * harness's settings.json or hooks.json) used to treat a parse failure like a
 * missing file and "start fresh" — so a single comment, trailing comma or
 * half-saved edit made the next sync replace the user's whole file with the
 * few keys Intutic owns. This helper separates the two cases: a missing file
 * is an empty object, and a file that is present but not a plain JSON object
 * is reported and left alone.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-json-merge')

/**
 * Read `filePath` as a JSON object to merge into.
 *
 * @returns the parsed object, `{}` when the file does not exist, or `null`
 *          when the file exists but is not a JSON object. On `null` the
 *          caller must skip its write; a warning naming the file has already
 *          been logged.
 */
export async function readJsonObjectForMerge(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    log.warn({ action: 'config_merge_skipped', path: filePath, error: String(err) }, `Could not read ${filePath} — left untouched`)
    return null
  }
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Reported below with the not-an-object case.
  }
  log.warn(
    { action: 'config_merge_skipped', path: filePath },
    `${filePath} is not a plain JSON object (comments, a trailing comma or a syntax error?) — left untouched; fix it and the next sync will add the Intutic entries`,
  )
  return null
}
