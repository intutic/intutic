/**
 * gitWorktrees.test.ts — `parseWorktreeListPorcelain` against real captured
 * `git worktree list --porcelain` output, and `discoverWorktrees` against a
 * REAL git repo + real `git worktree add`/`remove` in an isolated temp
 * directory (never this session's own worktree — see the module doc on why
 * that distinction matters for a phase that is itself about worktree
 * handling).
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { discoverWorktrees, parseWorktreeListPorcelain } from '../../src/lib/gitWorktrees.js'

describe('parseWorktreeListPorcelain', () => {
  it('parses a main checkout + a plain worktree + a detached worktree — real captured format', () => {
    // Captured verbatim from a live `git worktree list --porcelain` run
    // (git 2.x) against a real 3-worktree repo, not hand-assembled.
    const output =
      'worktree /tmp/repo/main\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'branch refs/heads/master\n' +
      '\n' +
      'worktree /tmp/repo/wt1\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'branch refs/heads/feature1\n' +
      '\n' +
      'worktree /tmp/repo/wt3\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'detached\n' +
      '\n'

    const parsed = parseWorktreeListPorcelain(output)
    expect(parsed).toHaveLength(3)

    expect(parsed[0]).toMatchObject({
      path: '/tmp/repo/main',
      head: '56bdba0a04f83da4e821a0a3e7a6208d43fcaec5',
      branch: 'refs/heads/master',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    })
    expect(parsed[1]).toMatchObject({ path: '/tmp/repo/wt1', branch: 'refs/heads/feature1', detached: false })
    expect(parsed[2]).toMatchObject({ path: '/tmp/repo/wt3', branch: null, detached: true })
  })

  it('parses a locked worktree, with and without a reason', () => {
    const withReason =
      'worktree /tmp/repo/wt2\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'branch refs/heads/feature2\n' +
      'locked testing lock\n' +
      '\n'
    expect(parseWorktreeListPorcelain(withReason)[0]).toMatchObject({
      locked: true,
      lockedReason: 'testing lock',
    })

    const withoutReason =
      'worktree /tmp/repo/wt2\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'branch refs/heads/feature2\n' +
      'locked\n' +
      '\n'
    expect(parseWorktreeListPorcelain(withoutReason)[0]).toMatchObject({
      locked: true,
      lockedReason: null,
    })
  })

  it('parses a prunable worktree', () => {
    const output =
      'worktree /tmp/repo/wt-gone\n' +
      'HEAD 56bdba0a04f83da4e821a0a3e7a6208d43fcaec5\n' +
      'branch refs/heads/feature3\n' +
      'prunable gitdir file points to non-existent location\n' +
      '\n'
    expect(parseWorktreeListPorcelain(output)[0]).toMatchObject({
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    })
  })

  it('parses a bare repository entry (no HEAD/branch, just "bare")', () => {
    const output = 'worktree /tmp/repo/bare.git\nbare\n\n'
    expect(parseWorktreeListPorcelain(output)[0]).toMatchObject({
      path: '/tmp/repo/bare.git',
      bare: true,
      head: null,
      branch: null,
      detached: false,
    })
  })

  it('returns [] for empty input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([])
  })

  it('ignores an unrecognised porcelain line rather than erroring', () => {
    // Forward-compatibility with a future git version adding a new field.
    const output = 'worktree /tmp/repo/main\nHEAD abc123\nbranch refs/heads/master\nsome-future-field value\n\n'
    const parsed = parseWorktreeListPorcelain(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].path).toBe('/tmp/repo/main')
  })
})

// ─── Real git fixtures ──────────────────────────────────────────────────────

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  }
  return result
}

describe('discoverWorktrees — real git repo + real worktree add/remove', () => {
  let base: string
  let main: string

  beforeEach(() => {
    // An isolated temp dir, not this session's own worktree — a real repo is
    // `git init`ed inside it fresh for every test.
    //
    // realpathSync immediately after mkdtemp: on macOS, `tmpdir()` returns a
    // `/var/...` path that is itself a symlink to `/private/var/...`, and
    // `git` reports the RESOLVED path in `worktree list --porcelain`. Without
    // resolving here too, every string-equality assertion below would fail
    // on a symlink difference that has nothing to do with worktree discovery
    // being correct or not — confirmed by hitting exactly that false failure
    // while writing this test against a real macOS temp dir.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'intutic-gitworktrees-')))
    main = join(base, 'main')
    git(base, 'init', '-q', 'main')
    git(main, 'config', 'user.email', 't@t.local')
    git(main, 'config', 'user.name', 't')
    writeFileSync(join(main, 'f.txt'), 'hello\n')
    git(main, 'add', 'f.txt')
    git(main, 'commit', '-q', '-m', 'init')
  }, 15_000)

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('finds only the main checkout when no worktrees have been added', async () => {
    const found = await discoverWorktrees(main)
    expect(found).toEqual([main])
  })

  it('finds the main checkout AND an added worktree', async () => {
    const wt1 = join(base, 'wt1')
    git(main, 'worktree', 'add', '-q', wt1, '-b', 'feature1')

    const found = await discoverWorktrees(main)
    expect(found).toContain(main)
    expect(found).toContain(wt1)
    expect(found).toHaveLength(2)
  }, 15_000)

  it('an untracked file in the main checkout is NOT visible from the worktree — the bug this phase fixes', () => {
    // Not discoverWorktrees's job to prove this (it only finds paths) — but
    // it is the load-bearing fact the whole phase rests on, so it gets its
    // own assertion here rather than being taken on faith.
    const wt1 = join(base, 'wt1')
    git(main, 'worktree', 'add', '-q', wt1, '-b', 'feature1')
    writeFileSync(join(main, '.env.untracked'), 'secret\n')

    expect(existsSync(join(main, '.env.untracked'))).toBe(true)
    expect(existsSync(join(wt1, '.env.untracked'))).toBe(false)
  })

  it('discovers a LOCKED worktree (governance files should still reach it)', async () => {
    const wt2 = join(base, 'wt2')
    git(main, 'worktree', 'add', '-q', wt2, '-b', 'feature2')
    git(main, 'worktree', 'lock', wt2, '--reason', 'testing lock')

    const found = await discoverWorktrees(main)
    expect(found).toContain(wt2)
  }, 15_000)

  it('excludes a worktree whose directory was removed out from under git (prunable)', async () => {
    const wt3 = join(base, 'wt3')
    git(main, 'worktree', 'add', '-q', '--detach', wt3)
    // Delete the directory by hand — git worktree list --porcelain flags
    // this as `prunable` rather than silently dropping it.
    rmSync(wt3, { recursive: true, force: true })

    const found = await discoverWorktrees(main)
    expect(found).not.toContain(wt3)
    expect(found).toEqual([main]) // the missing worktree is excluded, not just deprioritized
  }, 15_000)

  it('stops returning a worktree once it has been removed — no stale-entry caching', async () => {
    const wt1 = join(base, 'wt1')
    git(main, 'worktree', 'add', '-q', wt1, '-b', 'feature1')
    expect(await discoverWorktrees(main)).toContain(wt1)

    git(main, 'worktree', 'remove', wt1)
    const after = await discoverWorktrees(main)
    expect(after).not.toContain(wt1)
    expect(after).toEqual([main])
  }, 15_000)

  it('returns [] for a directory that is not a git repository at all — best-effort, never throws', async () => {
    const notARepo = join(base, 'not-a-repo')
    mkdirSync(notARepo, { recursive: true })
    await expect(discoverWorktrees(notARepo)).resolves.toEqual([])
  })
})
