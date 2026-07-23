/**
 * hashReporter.ts — SHA-256 hash computation + integrity comparison.
 *
 * Computes SHA-256 hashes of local harness config files and compares
 * them against canonical hashes from the control plane. This enables
 * SOP drift detection: if a developer manually edits a governed file,
 * the daemon flags it as drifted in the next sync report.
 *
 * HLD §3.14 — SOP Integrity Verification
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

import { createHash } from 'node:crypto'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import type { HarnessType, SopFileHash } from '@intutic/shared-types'
import { HARNESS_FILES } from './configWriter.js'

/**
 * Compute SHA-256 hashes for all harness config files and compare
 * against canonical hashes from the control plane.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param harnesses - Harness types detected in the workspace.
 * @param canonicalHashes - Expected hashes from last sync (filePath → SHA-256).
 * @returns Array of SopFileHash entries with drift detection flags.
 */
export async function computeFileHashes(
  workspaceRoot: string,
  harnesses: HarnessType[],
  canonicalHashes: Record<string, string>,
): Promise<SopFileHash[]> {
  const results: SopFileHash[] = []

  for (const harness of harnesses) {
    const filename = HARNESS_FILES[harness]
    if (!filename) continue // Phase 2 deferred

    const configPath = node_path.join(workspaceRoot, filename)
    const relativePath = filename

    try {
      const localHash = await hashFile(configPath)
      const canonical = canonicalHashes[relativePath] ?? ''
      const drifted = canonical !== '' && localHash !== canonical

      results.push({
        filePath: relativePath,
        localHash,
        canonicalHash: canonical,
        drifted,
      })
    } catch (err) {
      // File doesn't exist or isn't readable — report empty hash, not drifted
      results.push({
        filePath: relativePath,
        localHash: '',
        canonicalHash: canonicalHashes[relativePath] ?? '',
        drifted: false,
      })
    }
  }

  return results
}

/**
 * Compute the SHA-256 hex digest of a file's contents.
 *
 * @param filePath - Absolute path to the file.
 * @returns 64-character lowercase hex SHA-256 hash.
 * @throws If the file does not exist or is not readable.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await node_fs.readFile(filePath, 'utf-8')
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
