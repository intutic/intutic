/**
 * syncContext.ts — CLI command to sync Git context (branch, commit) to daemon.
 *
 * Saves current Git status details locally to `.intutic/git-context.json`
 * which is picked up by the sync daemon and reported to the control plane.
 *
 * LLD #14 — gitHooks.ts & syncContext.ts
 * HLD §3.14 — Real-Time State Mirroring (Git hooks context integration)
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { log } from '../lib/logger.js'
import { newIso } from '@intutic/id'

export interface SyncContextOpts {
  git?: boolean
  branch?: string
  commit?: string
}

export async function runSyncContext(opts: SyncContextOpts): Promise<void> {
  const workspaceRoot = process.cwd()
  const intuticDir = node_path.join(workspaceRoot, '.intutic')

  try {
    await node_fs.mkdir(intuticDir, { recursive: true })
    const contextPath = node_path.join(intuticDir, 'git-context.json')

    const contextData = {
      git: {
        branch: opts.branch || '',
        commit: opts.commit || '',
      },
      updatedAt: newIso(),
    }

    await node_fs.writeFile(contextPath, JSON.stringify(contextData, null, 2) + '\n', 'utf-8')
    log.dim(`Saved Git context to .intutic/git-context.json: branch=${opts.branch}, commit=${opts.commit}`)
  } catch (err) {
    log.error(`Failed to write Git context: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
