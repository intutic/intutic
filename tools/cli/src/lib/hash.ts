/**
 * SHA-256 hashing utilities.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Compute SHA-256 hash of a file's contents. Returns hex string. */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/** Compute SHA-256 hash of a string. Returns hex string. */
export function hashString(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
