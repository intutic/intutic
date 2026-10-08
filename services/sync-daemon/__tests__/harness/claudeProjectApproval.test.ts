/**
 * claudeProjectApproval.ts — Claude Code's project-server approval rules,
 * including the sources the mcpAutoWrite end-to-end tests cannot reach
 * (managed settings, MDM, worktrees).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { projectServerApproval } from '../../src/harness/claudeProjectApproval.js'

describe('projectServerApproval', () => {
  let home: string
  let root: string
  let managed: string
  let prevHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'intutic-approval-home-'))
    root = mkdtempSync(join(tmpdir(), 'intutic-approval-root-'))
    managed = mkdtempSync(join(tmpdir(), 'intutic-approval-managed-'))
    prevHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = prevHome
    for (const d of [home, root, managed]) rmSync(d, { recursive: true, force: true })
  })

  const env = () => ({ managedDir: managed, mdmProfiles: [] as string[], platform: 'linux' as NodeJS.Platform })

  it('treats a folder with no trust record as untrusted', async () => {
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    const approval = await projectServerApproval(root, { projects: {} }, env())
    expect(approval.approved('anything')).toBe(false)
  })

  it('applies managed approvals in an untrusted folder, and a managed disable everywhere', async () => {
    writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a', 'b'] }))
    mkdirSync(join(managed, 'managed-settings.d'))
    writeFileSync(join(managed, 'managed-settings.d', '10-security.json'), JSON.stringify({ disabledMcpjsonServers: ['b'] }))
    const approval = await projectServerApproval(root, { projects: { [root]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['b'] } } }, env())
    expect(approval.approved('a')).toBe(true)
    expect(approval.approved('b')).toBe(false)
  })

  it('approves nothing where managed policy may come from MDM or the registry, and says why', async () => {
    const profile = join(managed, 'com.anthropic.claudecode.plist')
    writeFileSync(profile, '<plist/>')
    const state = { projects: { [root]: { enableAllProjectMcpServers: true } } }
    const mdm = await projectServerApproval(root, state, { ...env(), mdmProfiles: [profile] })
    expect(mdm.approved('a')).toBe(false)
    expect(mdm.blockedReason).toMatch(/MDM or the registry/)
    const windows = await projectServerApproval(root, state, { ...env(), platform: 'win32' })
    expect(windows.approved('a')).toBe(false)
  })

  it("keys trust on the main checkout's root for a git worktree", async () => {
    const run = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    run(['init', '-q'], root)
    run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], root)
    const worktree = join(home, 'wt')
    run(['worktree', 'add', '-q', worktree], root)
    mkdirSync(join(worktree, '.claude'))
    writeFileSync(join(worktree, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'] }))

    const untrusted = await projectServerApproval(worktree, { projects: {} }, env())
    expect(untrusted.approved('a')).toBe(false)
    const trusted = await projectServerApproval(worktree, { projects: { [realpathSync(root)]: { hasTrustDialogAccepted: true } } }, env())
    expect(trusted.approved('a')).toBe(true)
  })
})
