/**
 * driftWatcher.ts — Filesystem watcher for detecting config file drift.
 *
 * Uses chokidar to monitor active harness configuration files in real time.
 * When changes are detected, it notifies the daemon via a callback to trigger
 * validation against the integrity baseline.
 *
 * LLD #14 — driftWatcher.ts
 * HLD §3.14 — Real-Time State Mirroring (Filesystem integrity checks)
 *
 * @module
 */

import chokidar from 'chokidar'
import * as node_path from 'node:path'
import * as node_os from 'node:os'
import { HARNESS_FILES } from '../configWriter.js'
import type { HarnessType } from '@intutic/shared-types'
import { createLogger } from '@intutic/logger'
import { buildProtectedPaths } from './settingsGuard.js'

const log = createLogger('sync-drift-watcher')

/**
 * Initializes file watches on harness configurations.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param harnesses - Harness types to watch.
 * @param onChange - Callback triggered when a watched file is modified or deleted.
 * @returns An object with a `stop` function to close the watcher.
 */
export function startWatcher(
  workspaceRoot: string,
  harnesses: HarnessType[],
  onChange: (filePath: string) => Promise<void>
): { stop: () => void } {
  const filePaths = harnesses
    .map((h) => HARNESS_FILES[h])
    .filter((f) => !!f)
    .map((f) => node_path.join(workspaceRoot, f))

  // Also watch git-context.json for real-time Git metadata updates
  filePaths.push(node_path.join(workspaceRoot, '.intutic', 'git-context.json'))

  // Also watch session-context.json for real-time active sops/judging updates
  filePaths.push(node_path.join(workspaceRoot, '.intutic', 'session-context.json'))
  
  // Watch .intutic/sops directory itself (and child directories/files) for real-time rules updates
  filePaths.push(node_path.join(workspaceRoot, '.intutic', 'sops'))

  // Watch ALL governance config paths across all 18 supported harnesses.
  // Any change (edit or delete) triggers the settingsGuard pipeline which
  // validates and restores the file within one poll cycle.
  const protectedPaths = buildProtectedPaths(workspaceRoot)
  for (const p of protectedPaths) {
    if (!filePaths.includes(p)) filePaths.push(p)
  }

  log.info({ action: 'start_watcher', fileCount: filePaths.length }, `Starting filesystem watcher for ${filePaths.length} governed paths across all harnesses`)

  const watcher = chokidar.watch(filePaths, {
    persistent: true,
    ignoreInitial: true, // Only care about modifications post-start
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  })

  watcher.on('all', (event, path) => {
    if (event === 'change' || event === 'unlink') {
      log.debug({ action: 'watcher_change_detected', event, path }, 'Governed file change detected')
      onChange(path).catch((err) => {
        log.error({ action: 'watcher_on_change_error', err, path }, 'Error in watcher onChange handler')
      })
    }
  })

  return {
    stop: () => {
      log.info({ action: 'stop_watcher' }, 'Stopping filesystem watcher')
      watcher.close().catch((err) => {
        log.warn({ action: 'watcher_close_error', err }, 'Error closing filesystem watcher')
      })
    },
  }
}
