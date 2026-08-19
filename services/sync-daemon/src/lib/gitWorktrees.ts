/**
 * gitWorktrees.ts — discovers every `git worktree` checkout of a repo the
 * sync daemon is watching, so project-tier governance files can be written
 * into each one, not just the main checkout.
 *
 * # The gap this closes
 *
 * `git worktree add <path>` creates a second, fully independent WORKING
 * TREE that shares the main checkout's `.git` object store (via a `.git`
 * FILE pointing back at `<main>/.git/worktrees/<name>`) but has its own
 * untracked files. Every project-tier governance file this product writes
 * — `.claude/settings.json`, `.cursor/hooks.json`, `.intutic/hooks/*`,
 * `AGENTS.md`'s sibling hook registrations, the wrapped `.mcp.json` entries,
 * etc. — is untracked by convention (SOP content is workspace-specific and
 * synced from the control plane, not committed). That means none of it
 * exists in a worktree's working tree by default: `writeConfigFiles`/
 * `injectMcpServer` running against only the main checkout's `workspaceRoot`
 * leaves every OTHER worktree of that same repo completely ungoverned,
 * regardless of what the main checkout has configured.
 *
 * This was already true for any hand-rolled `git worktree` workflow before
 * this module existed — Xirp (an orchestrator that spawns CLI agents each
 * inside its own tmux session + git worktree, see `tools/cli/src/harness/
 * xirp.ts`) is what surfaced it, but the fix here is general: it benefits
 * ANY worktree-based workflow, Xirp-managed or not. See TD-390.
 *
 * # Verifying the mechanics for real
 *
 * Confirmed against a real throwaway repo during this module's development
 * (not asserted from memory of git's docs): an untracked file written into
 * a main checkout is NOT visible from a `git worktree add`-created sibling
 * checkout's directory. `git worktree list --porcelain`'s block format,
 * including `locked`/`prunable`/`bare`/`detached` fields, was captured from
 * a real `git worktree list --porcelain` run (this module's own test suite
 * builds the same kind of fixture, in an isolated temp directory, rather
 * than relying on this description alone).
 *
 * @module
 */

import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(_execFile)

/** One block of `git worktree list --porcelain` output, parsed. */
export interface WorktreeInfo {
  /** Absolute path to this worktree's working directory. */
  path: string
  /** Commit the worktree's HEAD points at, or null if not reported (bare). */
  head: string | null
  /** Branch ref this worktree has checked out (e.g. `refs/heads/main`), or
   *  null when detached or bare. */
  branch: string | null
  /** True if this worktree's HEAD is detached (no branch checked out). */
  detached: boolean
  /** True for the bare-repository worktree entry — the repo root itself
   *  when it has no working tree of its own files (only ever the first
   *  entry, and only for a bare repo). */
  bare: boolean
  /** True if this worktree is locked (`git worktree lock`) — git will not
   *  prune it even if its directory looks gone. Locking does not restrict
   *  reading or writing ordinary files in it, so this does not by itself
   *  change whether `discoverWorktrees` includes the path. */
  locked: boolean
  /** Reason string passed to `git worktree lock --reason`, if any. */
  lockedReason: string | null
  /** True if git has flagged this worktree's directory as missing/invalid
   *  and a candidate for `git worktree prune`. */
  prunable: boolean
  /** Reason string git reports for why this worktree is prunable, if any. */
  prunableReason: string | null
}

/**
 * Parses `git worktree list --porcelain` output.
 *
 * Real format (verified against a live `git worktree list --porcelain` run,
 * git 2.x): one block per worktree, separated by a blank line, each line a
 * bare keyword or `<keyword> <value>`:
 *
 * ```
 * worktree /path/to/main
 * HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5
 * branch refs/heads/master
 *
 * worktree /path/to/locked-wt
 * HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5
 * branch refs/heads/feature2
 * locked testing lock
 *
 * worktree /path/to/detached-wt
 * HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5
 * detached
 * ```
 *
 * Deliberately implemented with plain string methods (`startsWith`/`slice`)
 * rather than a line-matching regex — this parses `git`-controlled, not
 * attacker-controlled, input, but a sibling Wave 1 phase shipped a
 * CodeQL-flagged polynomial-regex bug from exactly this kind of "just trim
 * a path" text handling, so the same class of construct is avoided here on
 * principle even though the input source differs.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeInfo[] {
  const blocks = output.split('\n\n')
  const worktrees: WorktreeInfo[] = []

  for (const block of blocks) {
    const trimmedBlock = block.trim()
    if (!trimmedBlock) continue

    let path = ''
    let head: string | null = null
    let branch: string | null = null
    let detached = false
    let bare = false
    let locked = false
    let lockedReason: string | null = null
    let prunable = false
    let prunableReason: string | null = null

    for (const rawLine of trimmedBlock.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue

      if (line === 'bare') {
        bare = true
      } else if (line === 'detached') {
        detached = true
      } else if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim()
      } else if (line === 'locked') {
        locked = true
      } else if (line.startsWith('locked ')) {
        locked = true
        lockedReason = line.slice('locked '.length).trim() || null
      } else if (line === 'prunable') {
        prunable = true
      } else if (line.startsWith('prunable ')) {
        prunable = true
        prunableReason = line.slice('prunable '.length).trim() || null
      }
      // Any other line is a porcelain field this parser does not know about
      // yet (git has added a few over the years) — ignored rather than
      // treated as an error, so a future git version adding a new field
      // degrades gracefully instead of breaking discovery entirely.
    }

    if (path) {
      worktrees.push({ path, head, branch, detached, bare, locked, lockedReason, prunable, prunableReason })
    }
  }

  return worktrees
}

/**
 * Discovers every worktree of the git repository containing `repoRoot`,
 * returning the absolute paths that should be treated as additional
 * project-tier workspace roots.
 *
 * Filtering decisions, made explicit rather than left implicit:
 *
 * - **The main checkout is included.** `git worktree list` always lists it
 *   first (confirmed against a live run) — it needs no special-casing by
 *   callers; a caller that already writes to `repoRoot` directly can simply
 *   skip a returned path equal to `repoRoot` if it wants to avoid a
 *   redundant duplicate write, but the list is uniformly correct either way.
 * - **Locked worktrees are included.** `git worktree lock` only prevents
 *   git's own pruning of a worktree it cannot otherwise verify still
 *   exists (e.g. on removable storage) — it says nothing about whether the
 *   directory is currently present and writable, which it normally is.
 *   Excluding locked worktrees would silently under-cover a workflow (like
 *   Xirp's) that locks worktrees deliberately to protect them from being
 *   pruned out from under a long-running session — exactly the worktrees
 *   most worth covering.
 * - **Prunable worktrees are EXCLUDED.** `prunable` means git itself has
 *   flagged the worktree's directory as missing or otherwise administratively
 *   invalid. Writing into that path would either fail or (via this
 *   codebase's `mkdir(dir, { recursive: true })` write convention) silently
 *   RECREATE a directory git considers gone — resurrecting a deleted
 *   worktree's folder with governance files nobody asked for. Skipping it
 *   is what "don't write into a directory git says isn't really there"
 *   means in practice.
 * - **Bare-repository entries are EXCLUDED.** A bare repo's own `worktree`
 *   porcelain entry names its root path but has no working tree of ordinary
 *   files to write project-tier config into.
 *
 * Best-effort by design: returns `[]` (never throws) if `repoRoot` is not
 * inside a git repository, if `git` is not on `PATH`, or on any other
 * failure — this is additive coverage on top of the existing single-root
 * write path, so a git failure here must not break the sync cycle that
 * already succeeds for the main `workspaceRoot`. This also means a
 * non-worktree, single-checkout project (the common case) is a harmless
 * no-extra-work path: `git worktree list` still runs, still succeeds, and
 * returns exactly one entry (the main checkout itself).
 */
export async function discoverWorktrees(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5000,
    })
    return parseWorktreeListPorcelain(stdout)
      .filter((wt) => !wt.bare && !wt.prunable)
      .map((wt) => wt.path)
  } catch {
    // Not a git repo, git not installed, or a transient failure — additive
    // coverage, so this degrades to "no extra worktrees found", not a
    // thrown error the caller must handle.
    return []
  }
}
