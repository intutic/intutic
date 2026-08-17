/**
 * The pre-commit secret scan, end to end: a real temp repo, the real hook the
 * installer writes, a real `git commit`. Not a unit test of the emitting
 * function — a hook that greps a shape the shell mangles in transit would
 * pass every string assertion and refuse nothing, which is the class of
 * looks-wired-does-nothing defect this repo keeps finding.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { installGitHooks } from './gitHooks.js'

/** Runtime-assembled per the repo convention: no contiguous credential-shaped literals. */
const fangedKey = () => `${'AKIA'}${'B2C3D4E5F6G7H2J3'}`

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf-8' })

describe('pre-commit secret scan', () => {
  let repo: string

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-precommit-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t.local')
    git(repo, 'config', 'user.name', 't')
    expect(await installGitHooks(repo)).toBe(true)
  })
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('refuses a commit whose staged additions carry a credential value', () => {
    fs.writeFileSync(path.join(repo, 'config.ts'), `const key = '${fangedKey()}'\n`)
    git(repo, 'add', '.')
    const r = git(repo, 'commit', '-m', 'x')
    expect(r.status, 'the commit should have been refused').not.toBe(0)
    expect(r.stderr).toContain('credential-shaped')
    expect(r.stderr).toContain('--no-verify')
  })

  it('lets a clean commit through', () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1\n')
    git(repo, 'add', '.')
    expect(git(repo, 'commit', '-m', 'x').status).toBe(0)
  })

  it('does not refuse over a secret that is already in history and merely nearby', () => {
    // Only ADDED lines are scanned. A file that already contains a key (from
    // before the hook existed) must not block every later edit to that file —
    // that failure mode teaches people to delete the hook.
    fs.writeFileSync(path.join(repo, 'legacy.ts'), `const old = '${fangedKey()}'\n`)
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'legacy', '--no-verify')
    fs.appendFileSync(path.join(repo, 'legacy.ts'), 'export const y = 2\n')
    git(repo, 'add', '.')
    expect(git(repo, 'commit', '-m', 'edit').status).toBe(0)
  })

  it('honours the documented escape hatch', () => {
    fs.writeFileSync(path.join(repo, 'fixture.ts'), `const k = '${fangedKey()}'\n`)
    git(repo, 'add', '.')
    expect(git(repo, 'commit', '-m', 'x', '--no-verify').status).toBe(0)
  })

  it('never clobbers a pre-commit hook it did not write', async () => {
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit')
    const theirs = '#!/bin/sh\n# husky\nexit 0\n'
    fs.writeFileSync(hookPath, theirs, { mode: 0o755 })
    expect(await installGitHooks(repo)).toBe(true)
    expect(fs.readFileSync(hookPath, 'utf-8'), 'a foreign pre-commit hook was overwritten').toBe(
      theirs,
    )
  })
})

describe('post-merge decisions-log-refresh hook — marker discipline', () => {
  let repo: string

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'intutic-postmerge-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t.local')
    git(repo, 'config', 'user.name', 't')
  })
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('installs a post-merge hook that triggers decisions-log-refresh', async () => {
    expect(await installGitHooks(repo)).toBe(true)
    const hookPath = path.join(repo, '.git', 'hooks', 'post-merge')
    const content = fs.readFileSync(hookPath, 'utf-8')
    expect(content).toContain('Intutic Post-Merge Decisions Log Refresh')
    expect(content).toContain('decisions-log-refresh')
    // Backgrounded and output-suppressed, same shape as the other tracking hooks.
    expect(content).toContain('>/dev/null 2>&1 &')
  })

  // Same overwrite guard as pre-commit — mirrored here, and load-bearing for
  // this new hook in a way it is NOT for post-commit/post-checkout above
  // (see TD-351): those two overwrite unconditionally.
  it('never clobbers a pre-existing post-merge hook it did not write', async () => {
    const hookPath = path.join(repo, '.git', 'hooks', 'post-merge')
    fs.mkdirSync(path.dirname(hookPath), { recursive: true })
    const theirs = '#!/bin/sh\n# some team script\nexit 0\n'
    fs.writeFileSync(hookPath, theirs, { mode: 0o755 })
    expect(await installGitHooks(repo)).toBe(true)
    expect(fs.readFileSync(hookPath, 'utf-8'), 'a foreign post-merge hook was overwritten').toBe(
      theirs,
    )
  })

  it('re-running install updates its own previously-installed post-merge hook (marker present)', async () => {
    expect(await installGitHooks(repo)).toBe(true)
    const hookPath = path.join(repo, '.git', 'hooks', 'post-merge')
    const first = fs.readFileSync(hookPath, 'utf-8')
    expect(await installGitHooks(repo)).toBe(true)
    const second = fs.readFileSync(hookPath, 'utf-8')
    expect(second).toBe(first)
    expect(second).toContain('Intutic Post-Merge Decisions Log Refresh')
  })
})
