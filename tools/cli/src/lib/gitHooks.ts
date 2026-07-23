/**
 * gitHooks.ts — Install and manage Git context hooks.
 *
 * Installs post-commit and post-checkout hooks into the workspace's
 * `.git/hooks/` directory to trigger real-time branch/commit tracking.
 *
 * LLD #14 — gitHooks.ts
 * HLD §3.14 — Real-Time State Mirroring (Git hooks context integration)
 *
 * @module
 */

import * as node_fs from 'node:fs/promises'
import * as node_path from 'node:path'
import { log } from './logger.js'

const HOOK_CONTENT = `
#!/bin/sh
# Intutic Git Context Sync Hook
if command -v intutic >/dev/null 2>&1; then
  intutic sync-context --git --branch "$(git branch --show-current)" --commit "$(git rev-parse HEAD)" >/dev/null 2>&1 &
fi
`.trim()

/**
 * Installs post-commit and post-checkout hooks into `.git/hooks/`.
 *
 * @param workspaceRoot - Workspace root directory.
 * @returns Promise<boolean> - True if successfully installed, false otherwise.
 */
export async function installGitHooks(workspaceRoot: string): Promise<boolean> {
  const gitDir = node_path.join(workspaceRoot, '.git')

  try {
    const stat = await node_fs.stat(gitDir)
    if (!stat.isDirectory()) {
      return false
    }
  } catch {
    // Not a Git repository, skip hook installation
    return false
  }

  const hooksDir = node_path.join(gitDir, 'hooks')
  try {
    await node_fs.mkdir(hooksDir, { recursive: true })

    const postCommitPath = node_path.join(hooksDir, 'post-commit')
    const postCheckoutPath = node_path.join(hooksDir, 'post-checkout')

    await node_fs.writeFile(postCommitPath, HOOK_CONTENT + '\n', { encoding: 'utf-8', mode: 0o755 })
    await node_fs.writeFile(postCheckoutPath, HOOK_CONTENT + '\n', { encoding: 'utf-8', mode: 0o755 })

    // Double check execute permissions
    await node_fs.chmod(postCommitPath, 0o755)
    await node_fs.chmod(postCheckoutPath, 0o755)

    log.info('Successfully installed Git sync hooks (post-commit, post-checkout)')
    return true
  } catch (err) {
    log.warn(`Failed to write Git hooks: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
