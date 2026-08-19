/**
 * syncLoopWorktreePropagation.test.ts — syncLoop.ts step 3d: a project-tier
 * write that today only ever reaches `workspaceRoot` must ALSO reach every
 * `git worktree` of that same repo.
 *
 * Sibling to `syncLoopMcpWrap.test.ts` (same `runSyncIteration` +
 * faked-fetch harness, same reason: proving the WIRING, not re-testing
 * `injectMcpServer`'s own logic) — but against a REAL git repo with a REAL
 * `git worktree add`-created checkout, built fresh inside this test's own
 * isolated temp directory (never this session's own worktree).
 *
 * @module
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runSyncIteration } from '../src/syncLoop.js'

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  }
  return result
}

describe('sync loop propagates project-tier writes into git worktrees', () => {
  let home: string
  let base: string
  let mainRoot: string
  let worktreeRoot: string
  let prevHome: string | undefined
  let prevUserProfile: string | undefined
  let originalFetch: typeof fetch

  afterEach(() => {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevUserProfile
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  })

  it('writes `.cursor/mcp.json` (proxy-wrapped intutic entry) into BOTH the main checkout and an added worktree, in one cycle', async () => {
    home = mkdtempSync(join(tmpdir(), 'intutic-syncloop-wt-home-'))
    base = mkdtempSync(join(tmpdir(), 'intutic-syncloop-wt-repo-'))
    prevHome = process.env.HOME
    prevUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home

    // A REAL repo with a REAL worktree, built fresh in an isolated temp dir.
    mainRoot = join(base, 'main')
    git(base, 'init', '-q', 'main')
    git(mainRoot, 'config', 'user.email', 't@t.local')
    git(mainRoot, 'config', 'user.name', 't')
    writeFileSync(join(mainRoot, 'f.txt'), 'hello\n')
    git(mainRoot, 'add', 'f.txt')
    git(mainRoot, 'commit', '-q', '-m', 'init')

    worktreeRoot = join(base, 'wt-session-1')
    git(mainRoot, 'worktree', 'add', '-q', worktreeRoot, '-b', 'xirp-session-1')

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/v1/sync/config')) {
        return new Response(JSON.stringify({
          workspaceId: 'ws_test',
          configVersion: 1,
          sops: [],
          proxyUrl: 'http://127.0.0.1:4000',
          settings: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    const result = await runSyncIteration({
      controlPlaneUrl: 'http://fake-control-plane.test',
      apiKey: 'test-key',
      workspaceId: 'ws_test',
      workspaceRoot: mainRoot,
    })
    expect(result.configVersion).toBe(1)

    // The main checkout got its own .cursor/mcp.json (pre-existing behavior).
    const mainMcpPath = join(mainRoot, '.cursor', 'mcp.json')
    expect(existsSync(mainMcpPath)).toBe(true)
    const mainMcp = JSON.parse(readFileSync(mainMcpPath, 'utf-8'))
    expect(mainMcp.mcpServers.intutic).toBeDefined()

    // The NEW behavior: the worktree got its own .cursor/mcp.json too, even
    // though nothing ever pointed the daemon at it directly — it was
    // discovered via `git worktree list` off the main checkout.
    const wtMcpPath = join(worktreeRoot, '.cursor', 'mcp.json')
    expect(existsSync(wtMcpPath)).toBe(true)
    const wtMcp = JSON.parse(readFileSync(wtMcpPath, 'utf-8'))
    expect(wtMcp.mcpServers.intutic).toBeDefined()

    // Not a blind copy: each entry embeds ITS OWN workspaceRoot-derived
    // proxy-binary path, proving these are two independently-computed
    // writes, not the main checkout's file duplicated verbatim.
    expect(mainMcp.mcpServers.intutic.args[0]).toContain(mainRoot)
    expect(wtMcp.mcpServers.intutic.args[0]).toContain(worktreeRoot)
    expect(wtMcp.mcpServers.intutic.args[0]).not.toBe(mainMcp.mcpServers.intutic.args[0])
  }, 20_000)

  it('does not write into a worktree that was removed before the cycle ran', async () => {
    home = mkdtempSync(join(tmpdir(), 'intutic-syncloop-wt-home-'))
    base = mkdtempSync(join(tmpdir(), 'intutic-syncloop-wt-repo-'))
    prevHome = process.env.HOME
    prevUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home

    mainRoot = join(base, 'main')
    git(base, 'init', '-q', 'main')
    git(mainRoot, 'config', 'user.email', 't@t.local')
    git(mainRoot, 'config', 'user.name', 't')
    writeFileSync(join(mainRoot, 'f.txt'), 'hello\n')
    git(mainRoot, 'add', 'f.txt')
    git(mainRoot, 'commit', '-q', '-m', 'init')

    worktreeRoot = join(base, 'wt-session-1')
    git(mainRoot, 'worktree', 'add', '-q', worktreeRoot, '-b', 'xirp-session-1')
    git(mainRoot, 'worktree', 'remove', worktreeRoot)

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/v1/sync/config')) {
        return new Response(JSON.stringify({
          workspaceId: 'ws_test',
          configVersion: 1,
          sops: [],
          proxyUrl: 'http://127.0.0.1:4000',
          settings: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    await runSyncIteration({
      controlPlaneUrl: 'http://fake-control-plane.test',
      apiKey: 'test-key',
      workspaceId: 'ws_test',
      workspaceRoot: mainRoot,
    })

    // The removed worktree's directory is gone entirely — nothing should
    // have recreated it.
    expect(existsSync(worktreeRoot)).toBe(false)
  }, 20_000)
})
