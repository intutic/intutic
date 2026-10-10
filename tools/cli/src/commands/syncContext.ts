/**
 * syncContext.ts — CLI command to sync Git context (branch, commit) to daemon.
 *
 * Saves current Git status details locally to `.intutic/git-context.json`
 * which is picked up by the sync daemon and reported to the control plane.
 *
 * HLD §3.14 — Real-Time State Mirroring (Git hooks context integration)
 *
 * @module
 */

import { execFile } from 'node:child_process'
import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { log } from '../lib/logger.js'
import { newIso } from '@intutic/id'

export interface SyncContextOpts {
  git?: boolean
  branch?: string
  commit?: string
}

/** One line of `git` output, or '' when git is missing or the call fails. */
function gitValue(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout.trim()))
  })
}

export async function runSyncContext(opts: SyncContextOpts): Promise<void> {
  const workspaceRoot = process.cwd()
  const intuticDir = node_path.join(workspaceRoot, '.intutic')

  // `--git` reads whatever --branch / --commit did not supply from the
  // repository itself, so `intutic sync-context --git` alone is a complete
  // manual refresh. The flag used to be accepted and ignored, which left the
  // advice "run `intutic sync-context` manually" recording empty values.
  const branch = opts.branch || (opts.git ? await gitValue(workspaceRoot, ['branch', '--show-current']) : '')
  const commit = opts.commit || (opts.git ? await gitValue(workspaceRoot, ['rev-parse', 'HEAD']) : '')

  try {
    await node_fs.mkdir(intuticDir, { recursive: true })
    const contextPath = node_path.join(intuticDir, 'git-context.json')

    const contextData = {
      git: { branch, commit },
      updatedAt: newIso(),
    }

    await node_fs.writeFile(contextPath, JSON.stringify(contextData, null, 2) + '\n', 'utf-8')
    log.dim(`Saved Git context to .intutic/git-context.json: branch=${branch}, commit=${commit}`)
  } catch (err) {
    log.error(`Failed to write Git context: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
