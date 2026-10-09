import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeGitRemote, resolveGitContext } from '../src/git-context'

/** The vectors shared-types' normalizeGitRemote and the Python SDK's copy are held to. */
const VECTORS = JSON.parse(
  readFileSync(join(__dirname, '../../shared-types/fixtures/git-remote-vectors.json'), 'utf-8'),
).vectors as Array<{ remote: string; normalized: string | null }>

describe('normalizeGitRemote', () => {
  it.each(VECTORS)('%j', ({ remote, normalized }) => {
    expect(normalizeGitRemote(remote)).toBe(normalized)
  })
})

describe('resolveGitContext', () => {
  const headRef = process.env.GITHUB_HEAD_REF
  afterEach(() => {
    if (headRef === undefined) delete process.env.GITHUB_HEAD_REF
    else process.env.GITHUB_HEAD_REF = headRef
  })

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'clawde-git-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q', '-b', 'feature/attribution')
    git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '--allow-empty', '-m', 'first')
    // A CI checkout's remote carries a token; it must not leave the machine.
    git('remote', 'add', 'origin', 'https://x-access-token:not-a-secret@github.com/acme/widgets.git')
    return dir
  }

  it('reads the repository, branch and commit, and drops the remote\'s credentials', async () => {
    const dir = repo()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    expect(await resolveGitContext(dir)).toEqual({
      repoUrl: 'github.com/acme/widgets',
      branchName: 'feature/attribution',
      commitHash: commit,
    })
  })

  it('takes the branch from GITHUB_HEAD_REF on a detached HEAD, as CI checks out a pull request', async () => {
    const dir = repo()
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir })
    process.env.GITHUB_HEAD_REF = 'feature/from-ci'
    expect((await resolveGitContext(dir, 'fallback')).branchName).toBe('feature/from-ci')
    delete process.env.GITHUB_HEAD_REF
    expect((await resolveGitContext(dir, 'fallback')).branchName).toBe('fallback')
  })

  it('is empty outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawde-nogit-'))
    writeFileSync(join(dir, 'file.txt'), 'x')
    delete process.env.GITHUB_HEAD_REF
    expect(await resolveGitContext(dir)).toEqual({})
  })
})
