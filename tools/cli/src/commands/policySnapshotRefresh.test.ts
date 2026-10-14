/**
 * `intutic policy snapshot` when the refresh fails: it must say what happened
 * to the snapshot on disk. A refused key rewrites it (the member's SSO groups
 * become unknown), so "untouched" was only true for the other failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const { dir, refreshMock } = vi.hoisted(() => ({
  dir: { path: '' },
  refreshMock: vi.fn(),
}))

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => null),
}))
vi.mock('../config/paths.js', () => ({ resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid') }))
vi.mock('../lib/policySnapshot.js', () => ({
  SNAPSHOT_RULES_FILE: 'policy-snapshot.rules',
  resolveSnapshotRulesPath: () => path.join(dir.path, 'policy-snapshot.rules'),
}))
vi.mock('@intutic/sync-daemon', () => ({ refreshPolicySnapshot: refreshMock }))

import { runPolicySnapshot } from './policy.js'

describe('runPolicySnapshot on a failed refresh', () => {
  let printed: string[]

  beforeEach(async () => {
    dir.path = await fs.mkdtemp(path.join(os.tmpdir(), 'intutic-snapshot-'))
    await fs.writeFile(path.join(dir.path, 'policy-snapshot.rules'), 'rules v1\n')
    printed = []
    const push = (...args: unknown[]) => printed.push(args.map(String).join(' '))
    vi.spyOn(console, 'log').mockImplementation(push)
    vi.spyOn(console, 'error').mockImplementation(push)
    vi.spyOn(console, 'warn').mockImplementation(push)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    refreshMock.mockReset()
    await fs.rm(dir.path, { recursive: true, force: true })
  })

  it('says the snapshot is untouched when it is', async () => {
    refreshMock.mockResolvedValue(null)
    await expect(runPolicySnapshot({})).rejects.toThrow('process.exit(1)')
    const out = printed.join('\n')
    expect(out).toContain('untouched')
    expect(out).not.toContain('rewritten')
  })

  it('says the snapshot was rewritten when the refused key rewrote it', async () => {
    refreshMock.mockImplementation(async () => {
      await fs.writeFile(path.join(dir.path, 'policy-snapshot.rules'), 'rules v1, member forgotten\n')
      return null
    })
    await expect(runPolicySnapshot({})).rejects.toThrow('process.exit(1)')
    const out = printed.join('\n')
    expect(out).toContain('rewritten')
    expect(out).not.toContain('untouched')
  })
})
