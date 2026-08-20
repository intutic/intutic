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

/** Marker line identifying a post-commit/post-checkout hook as ours — the overwrite guard. */
const GIT_CONTEXT_MARKER = '# Intutic Git Context Sync Hook'

/** Marker line identifying a pre-commit hook as ours — the overwrite guard. */
const PRE_COMMIT_MARKER = '# Intutic Pre-Commit Secret Scan'

/** Marker line identifying a post-merge hook as ours — same overwrite guard as pre-commit. */
const POST_MERGE_MARKER = '# Intutic Post-Merge Decisions Log Refresh'

/**
 * Git-context tracking hook content, shared by post-commit and post-checkout
 * (TD-351): both fire the same best-effort branch/commit sync, backgrounded
 * and output-suppressed so it never adds latency to the Git command that
 * triggered it.
 */
function gitContextSyncContent(): string {
  return `
#!/bin/sh
${GIT_CONTEXT_MARKER}
if command -v intutic >/dev/null 2>&1; then
  intutic sync-context --git --branch "$(git branch --show-current)" --commit "$(git rev-parse HEAD)" >/dev/null 2>&1 &
fi
`.trim() + '\n'
}

/**
 * Optional post-merge hook: refreshes the governed decisions log
 * (`.intutic/DECISIONS.md` + the bounded section in the `claude-code`
 * harness config) right after a merge, rather than leaving a developer
 * waiting for the daemon's next ~30s poll. `decisions-log-refresh` itself
 * no-ops (and never errors the shell) when `decisionsLogEnabled` is off or
 * the developer isn't authenticated — see `decisionsLogRefresh.ts`.
 *
 * Backgrounded and output-suppressed, same shape as `gitContextSyncContent`
 * above — a governance context refresh must never add latency to `git merge`.
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

# TD-358: warn-only skill-content scan of staged skill-surface additions
# (.agents/skills/**, .claude/skills/**). Advisory only — this NEVER
# refuses the commit, unlike the secret scan above. See skillScan.ts's
# module doc comment for why: the pattern table's false-positive rate
# against real, benign skill markdown has not been measured yet, so nothing
# here may borrow the secret scan's refusal authority until it has earned
# it the same way. If the secret scan above already refused, this line is
# never reached — that check's exit 1 is untouched.
if command -v intutic >/dev/null 2>&1; then
  intutic skill scan-staged || true
fi
exit 0
`.trimStart()
}

/**
 * Writes one hook file at `<hooksDir>/<name>` unless a foreign (non-Intutic)
 * hook already occupies that path — the shared never-clobber-a-foreign-hook,
 * marker-based-idempotent-rerun behavior every hook `installGitHooks` manages
 * now follows (TD-351; previously only pre-commit and post-merge had it).
 *
 * Reads the existing file first: absent, or already carrying `marker` (a
 * previous install of this same hook, safe to overwrite with the current
 * content — this is what makes a re-run idempotent), writes `content` and
 * marks it executable. Anything else is a hook this codebase did not write —
 * left standing untouched, with `warnMessage` logged so the operator knows
 * why the hook they expected is missing.
 *
 * @returns `true` if the hook was (re-)written, `false` if a foreign hook was
 *   left in place. Both are legitimate outcomes, not failures — the caller
 *   decides what "success" means for its own summary log line.
 */
async function writeHookIfOursOrAbsent(
  hooksDir: string,
  name: string,
  content: string,
  marker: string,
  warnMessage: string,
): Promise<boolean> {
  const hookPath = node_path.join(hooksDir, name)
  let existing: string | null
  try {
    existing = await node_fs.readFile(hookPath, 'utf-8')
  } catch {
    existing = null
  }
  if (existing === null || existing.includes(marker)) {
    await node_fs.writeFile(hookPath, content, { encoding: 'utf-8', mode: 0o755 })
    await node_fs.chmod(hookPath, 0o755)
    return true
  }
  log.warn(warnMessage)
  return false
}

/**
 * Installs post-commit, post-checkout, pre-commit, and post-merge hooks into
 * `.git/hooks/`.
 *
 * @param workspaceRoot - Workspace root directory.
 * @returns Promise<boolean> - True if installation ran without error, even
 *   when one or more individual hooks were left untouched because a foreign
 *   hook already occupied that path (see `writeHookIfOursOrAbsent`) — that is
 *   correct, deliberate behavior, not a failure. `false` only when this is
 *   not a Git repository or a filesystem error prevented writing.
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

    // Git-context tracking hooks (post-commit, post-checkout). Marker-
    // disciplined the same way pre-commit and post-merge are below (TD-351):
    // never clobber a hook that isn't ours. Until this fix these two
    // overwrote whatever was already at their paths unconditionally — a
    // team's own post-commit/post-checkout script (a notification hook, a
    // submodule sync script) was silently replaced on install. Now a foreign
    // hook is left standing, and the operator is told so.
    const postCommitInstalled = await writeHookIfOursOrAbsent(
      hooksDir,
      'post-commit',
      gitContextSyncContent(),
      GIT_CONTEXT_MARKER,
      "A post-commit hook already exists and is not Intutic's — left untouched. " +
        'Branch/commit context will not sync automatically on commit; run ' +
        '`intutic sync-context` manually as a workaround, or add Intutic\'s sync call to your own hook.',
    )
    const postCheckoutInstalled = await writeHookIfOursOrAbsent(
      hooksDir,
      'post-checkout',
      gitContextSyncContent(),
      GIT_CONTEXT_MARKER,
      "A post-checkout hook already exists and is not Intutic's — left untouched. " +
        'Branch/commit context will not sync automatically on checkout; run ' +
        '`intutic sync-context` manually as a workaround, or add Intutic\'s sync call to your own hook.',
    )

    // Pre-commit secret scan. Unlike the two tracking hooks above, this one
    // must NOT clobber blindly: pre-commit is where husky/lint-staged and
    // hand-written hooks live, and silently replacing a team's hook to
    // install ours is the exact overreach that gets governance tooling
    // uninstalled. Ours is only written over an absent hook or a prior copy
    // of itself (identified by marker); anything else is left standing and
    // said so.
    const preCommitInstalled = await writeHookIfOursOrAbsent(
      hooksDir,
      'pre-commit',
      preCommitContent(),
      PRE_COMMIT_MARKER,
      "A pre-commit hook already exists and is not Intutic's — left untouched. " +
        'The staged-diff secret scan is NOT installed; add it to your existing hook ' +
        'if you want commit-time scanning.',
    )

    // Optional post-merge hook (governed decisions log refresh). Marker-
    // disciplined the same way pre-commit is above — never clobber a
    // post-merge hook that isn't ours. Post-commit/post-checkout above now
    // follow this exact same pattern too (TD-351 — previously they did not:
    // they unconditionally overwrote whatever was already at those paths,
    // noted as a latent overreach rather than fixed alongside this hook's
    // original addition, since changing existing-install behavior needed its
    // own review).
    const postMergeInstalled = await writeHookIfOursOrAbsent(
      hooksDir,
      'post-merge',
      postMergeContent(),
      POST_MERGE_MARKER,
      "A post-merge hook already exists and is not Intutic's — left untouched. " +
        'The governed decisions log will still refresh on the daemon\'s normal poll cycle; run ' +
        '`intutic sync-context` manually as a workaround if you need it sooner.',
    )

    // Summary log line, kept honest: only name a hook as installed if it
    // actually was. A hook skipped because a foreign hook already exists at
    // that path already got its own `log.warn` above — this line must never
    // paper over that with a blanket "success".
    const installed: string[] = []
    if (postCommitInstalled) installed.push('post-commit')
    if (postCheckoutInstalled) installed.push('post-checkout')
    if (preCommitInstalled) installed.push('pre-commit secret scan')
    if (postMergeInstalled) installed.push('post-merge decisions log refresh')
    if (installed.length > 0) {
      log.info(`Successfully installed Git hooks (${installed.join(', ')})`)
    } else {
      log.info('No Git hooks installed — every target hook already exists and is not Intutic\'s')
    }

    return true
  } catch (err) {
    log.warn(`Failed to write Git hooks: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
