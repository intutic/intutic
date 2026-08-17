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
import { secretPatternAlternation } from '@intutic/shared-types'
import { log } from './logger.js'

const HOOK_CONTENT = `
#!/bin/sh
# Intutic Git Context Sync Hook
if command -v intutic >/dev/null 2>&1; then
  intutic sync-context --git --branch "$(git branch --show-current)" --commit "$(git rev-parse HEAD)" >/dev/null 2>&1 &
fi
`.trim()

/** Marker line identifying a pre-commit hook as ours — the overwrite guard. */
const PRE_COMMIT_MARKER = '# Intutic Pre-Commit Secret Scan'

/** Marker line identifying a post-merge hook as ours — same overwrite guard as pre-commit. */
const POST_MERGE_MARKER = '# Intutic Post-Merge Decisions Log Refresh'

/**
 * Optional post-merge hook: refreshes the governed decisions log
 * (`.intutic/DECISIONS.md` + the bounded section in the `claude-code`
 * harness config) right after a merge, rather than leaving a developer
 * waiting for the daemon's next ~30s poll. `decisions-log-refresh` itself
 * no-ops (and never errors the shell) when `decisionsLogEnabled` is off or
 * the developer isn't authenticated — see `decisionsLogRefresh.ts`.
 *
 * Backgrounded and output-suppressed, same shape as `HOOK_CONTENT` above —
 * a governance context refresh must never add latency to `git merge`.
 */
function postMergeContent(): string {
  return `
#!/bin/sh
${POST_MERGE_MARKER}
if command -v intutic >/dev/null 2>&1; then
  intutic decisions-log-refresh >/dev/null 2>&1 &
fi
`.trim() + '\n'
}

/**
 * The last line before a secret enters git history.
 *
 * The hook gate refuses a Write whose content carries a credential value, and
 * the proxy's DLP covers the LLM traffic — but a secret can reach the working
 * tree by other roads (a human paste, an unproxied tool, a generator script).
 * Until now the repo's history had no gate at all: the CLI installed
 * post-commit and post-checkout tracking hooks only, so the commit — the step
 * GitGuardian's 28M-leaked-secrets figure is measured at — was uninspected.
 *
 * Scans only ADDED lines of the staged diff, with the same
 * `SECRET_VALUE_PATTERNS` the hook gate enforces (one source, in
 * shared-types — two hand-kept copies of "what is a credential" is how the
 * gate and the hook would drift). Refuses with the offending file:line and
 * names the escape hatch: `git commit --no-verify` is deliberate, auditable
 * in shell history, and better than teaching people to delete the hook.
 */
function preCommitContent(): string {
  return `
#!/bin/sh
${PRE_COMMIT_MARKER}
# Refuses a commit whose STAGED ADDITIONS carry a credential-shaped value.
# Same patterns the Intutic hook gate enforces (see @intutic/shared-types
# secretPatterns.ts — the single source both consumers compile).
findings="$(git diff --cached -U0 --no-color | grep -E '^\\+' | grep -vE '^\\+\\+\\+' | grep -nE '${secretPatternAlternation()}' || true)"
if [ -n "$findings" ]; then
  echo "[Intutic] Commit refused: staged changes add credential-shaped content:" >&2
  echo "$findings" | head -10 >&2
  echo "" >&2
  echo "Remove the secret and reference it from the environment instead." >&2
  echo "If this is a false positive, commit with: git commit --no-verify" >&2
  exit 1
fi
`.trimStart()
}

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

    // Pre-commit secret scan. Unlike the two tracking hooks above, this one
    // must NOT clobber blindly: pre-commit is where husky/lint-staged and
    // hand-written hooks live, and silently replacing a team's hook to
    // install ours is the exact overreach that gets governance tooling
    // uninstalled. Ours is only written over an absent hook or a prior copy
    // of itself (identified by marker); anything else is left standing and
    // said so.
    const preCommitPath = node_path.join(hooksDir, 'pre-commit')
    let existing: string | null = null
    try {
      existing = await node_fs.readFile(preCommitPath, 'utf-8')
    } catch {
      existing = null
    }
    if (existing === null || existing.includes(PRE_COMMIT_MARKER)) {
      await node_fs.writeFile(preCommitPath, preCommitContent(), { encoding: 'utf-8', mode: 0o755 })
      await node_fs.chmod(preCommitPath, 0o755)
      log.info('Successfully installed Git hooks (post-commit, post-checkout, pre-commit secret scan)')
    } else {
      log.warn(
        'A pre-commit hook already exists and is not Intutic\'s — left untouched. ' +
          'The staged-diff secret scan is NOT installed; add it to your existing hook ' +
          'if you want commit-time scanning.',
      )
      log.info('Successfully installed Git sync hooks (post-commit, post-checkout)')
    }

    // Optional post-merge hook (governed decisions log refresh). Marker-
    // disciplined the SAME way pre-commit is above — never clobber a
    // post-merge hook that isn't ours. Deliberately following that pattern
    // here even though post-commit/post-checkout above do NOT (they
    // unconditionally overwrite whatever is already at those paths): those
    // two are a pre-existing, latent overreach — installing tracking hooks
    // over a team's own post-commit/post-checkout scripts without checking
    // for one first — noted as TD-351 rather than fixed as part of this
    // change (out of scope: fixing it would change behavior for every
    // existing install, not just this new hook). This new hook does not
    // repeat that gap.
    const postMergePath = node_path.join(hooksDir, 'post-merge')
    let existingPostMerge: string | null = null
    try {
      existingPostMerge = await node_fs.readFile(postMergePath, 'utf-8')
    } catch {
      existingPostMerge = null
    }
    if (existingPostMerge === null || existingPostMerge.includes(POST_MERGE_MARKER)) {
      await node_fs.writeFile(postMergePath, postMergeContent(), { encoding: 'utf-8', mode: 0o755 })
      await node_fs.chmod(postMergePath, 0o755)
    } else {
      log.warn(
        'A post-merge hook already exists and is not Intutic\'s — left untouched. ' +
          'The governed decisions log will still refresh on the daemon\'s normal poll cycle.',
      )
    }

    return true
  } catch (err) {
    log.warn(`Failed to write Git hooks: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
