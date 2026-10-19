/**
 * `intutic loop verify` and the completion gate: the local
 * scope check stops a verify before anything is sent; a passing one posts the
 * diff, the changed files and the base; a 409 from complete is shown, never
 * swallowed. Every test runs in a temp git repo with an empty HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = mkdtempSync(join(tmpdir(), 'intutic-loop-verify-'))
const home = mkdtempSync(join(tmpdir(), 'intutic-loop-home-'))

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false, workspaceRoot: repo })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
  getIntuticDir: vi.fn(() => join(home, '.intutic')),
}))

import { verifyLoopRun, runLoopComplete } from './skill.js'

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } })
}

let base = ''
const responses: Array<{ status: number; body: unknown }> = []
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  rmSync(join(repo, '.git'), { recursive: true, force: true })
  git('init', '-q')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 'test')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, '.intutic', 'sops'), { recursive: true })
  writeFileSync(join(repo, '.intutic', 'sops', 'scope.md'), '---\nscope_paths: src/\n---\n# Stay in src\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  base = git('rev-parse', 'HEAD').trim()
  responses.length = 0
  fetchMock = vi.fn(async () => {
    const r = responses.shift() ?? { status: 500, body: { error: 'unexpected call' } }
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('verifyLoopRun', () => {
  it('stops on a change outside the local scope_paths, and sends nothing', async () => {
    writeFileSync(join(repo, 'README.md'), 'outside\n')
    git('add', '-A')
    expect(await verifyLoopRun('lr_1', { base })).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the diff, the changed files and the base, and passes on a verified answer', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
    responses.push({ status: 200, body: { ok: true, score: 1, findings: [], verificationId: 'lv_1', stage: 'judge', checks: [{ id: 'scope_paths', status: 'pass', findings: [] }] } })
    expect(await verifyLoopRun('lr_1', { base, task: 'bump a' })).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://api.test.invalid/api/v1/loops/lr_1/verify')
    const sent = JSON.parse(init.body)
    expect(sent.files).toEqual(['src/a.ts'])
    expect(sent.base).toBe(base)
    expect(sent.taskDescription).toBe('bump a')
    expect(sent.diff).toContain('+export const a = 2')
  })

  it('fails on a deterministic failure or an unverified answer', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3\n')
    responses.push({ status: 200, body: { ok: false, score: 0, findings: ['scope'], verificationId: 'lv_2', stage: 'deterministic', checks: [] } })
    expect(await verifyLoopRun('lr_1', { base })).toBe(false)
    responses.push({ status: 200, body: { ok: true, score: 0, findings: [], unverified: true, verificationId: 'lv_3', stage: 'judge', checks: [] } })
    expect(await verifyLoopRun('lr_1', { base })).toBe(false)
  })
})

describe('runLoopComplete: the completion gate', () => {
  for (const code of ['E_LOOP_NOT_VERIFIED', 'E_LOOP_UNVERIFIABLE', 'E_LOOP_VERIFY_STALE']) {
    it(`shows a 409 ${code} and exits 1`, async () => {
      responses.push({ status: 409, body: { error: 'Verify the run first', code, findings: ['README.md is outside scope_paths'] } })
      const errors = vi.mocked(console.error)
      await expect(runLoopComplete('lr_1', {})).rejects.toThrow('process.exit(1)')
      expect(errors.mock.calls.flat().join('\n')).toContain(code)
    })
  }

  it('shows a 503 GOVERNANCE_UNAVAILABLE and exits 1', async () => {
    responses.push({ status: 503, body: { error: 'The verification check could not run', code: 'GOVERNANCE_UNAVAILABLE' } })
    await expect(runLoopComplete('lr_1', {})).rejects.toThrow('process.exit(1)')
  })
})
