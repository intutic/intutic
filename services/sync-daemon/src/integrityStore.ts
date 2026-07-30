/**
 * integrityStore.ts — Local .intutic/integrity.json manager.
 *
 * Maintains a per-workspace integrity store that tracks the last sync
 * timestamp, config version, and canonical file hashes. This allows
 * the daemon to skip redundant syncs when the config version hasn't
 * changed and to detect local drift between sync cycles.
 *
 * HLD §3.14 — Real-Time State Mirroring
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import type { IntegrityStore } from '@intutic/shared-types'

/** Filename for the integrity store within the `.intutic/` directory. */
const INTEGRITY_FILE = 'integrity.json'

/** Directory name for Intutic local state. */
const INTUTIC_DIR = '.intutic'

/**
 * Load the local integrity store from `.intutic/integrity.json`.
 *
 * Returns `null` if the file doesn't exist (first sync) or is
 * corrupted (will be overwritten on next save).
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @returns The parsed IntegrityStore, or null if not found.
 */
export async function loadIntegrity(
  workspaceRoot: string,
): Promise<IntegrityStore | null> {
  const filePath = node_path.join(workspaceRoot, INTUTIC_DIR, INTEGRITY_FILE)

  try {
    const raw = await node_fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as IntegrityStore

    // Basic shape validation
    if (
      typeof parsed.lastSyncAt !== 'string' ||
      typeof parsed.configVersion !== 'number' ||
      typeof parsed.files !== 'object'
    ) {
      return null
    }

    return parsed
  } catch {
    // File doesn't exist or is corrupted
    return null
  }
}

/**
 * Save the integrity store to `.intutic/integrity.json`.
 *
 * Creates the `.intutic/` directory if it doesn't exist.
 * Uses atomic write (tmp → rename) to prevent corruption.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param store - The IntegrityStore to persist.
 */
export async function saveIntegrity(
  workspaceRoot: string,
  store: IntegrityStore,
): Promise<void> {
  const dir = node_path.join(workspaceRoot, INTUTIC_DIR)
  await node_fs.mkdir(dir, { recursive: true })

  const filePath = node_path.join(dir, INTEGRITY_FILE)
  const tmpPath = `${filePath}.tmp`
  const content = JSON.stringify(store, null, 2) + '\n'

  await node_fs.writeFile(tmpPath, content, 'utf-8')
  await node_fs.rename(tmpPath, filePath)
}


// `loadContextIntegrity` / `saveContextIntegrity` were removed on 2026-07-30. They
// had no callers in either repo — not even tests — while
// `.intutic/context_integrity.json` sat in three harness hook denylists as a
// protected path. The file was never created, so those hooks guarded nothing. The
// config integrity store above already hashes every governed file `syncLoop` writes,
// which is what the second store would have duplicated.

