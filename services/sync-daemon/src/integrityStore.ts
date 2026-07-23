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

/**
 * Load the local context integrity store from `.intutic/context_integrity.json`.
 */
export async function loadContextIntegrity(
  workspaceRoot: string,
): Promise<IntegrityStore | null> {
  const filePath = node_path.join(workspaceRoot, INTUTIC_DIR, 'context_integrity.json')

  try {
    const raw = await node_fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as IntegrityStore
    if (typeof parsed.files !== 'object') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Save the context integrity store to `.intutic/context_integrity.json`.
 */
export async function saveContextIntegrity(
  workspaceRoot: string,
  store: IntegrityStore,
): Promise<void> {
  const dir = node_path.join(workspaceRoot, INTUTIC_DIR)
  await node_fs.mkdir(dir, { recursive: true })

  const filePath = node_path.join(dir, 'context_integrity.json')
  const tmpPath = `${filePath}.tmp`
  const content = JSON.stringify(store, null, 2) + '\n'

  await node_fs.writeFile(tmpPath, content, 'utf-8')
  await node_fs.rename(tmpPath, filePath)
}

