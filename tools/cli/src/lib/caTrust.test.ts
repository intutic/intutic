import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { caTrustCommandFor } from './caTrust.js'

describe('caTrustCommandFor', () => {
  it('macOS system scope trusts into the System keychain', () => {
    const cmds = caTrustCommandFor('darwin', 'system', '/tmp/ca.crt')
    expect(cmds).toHaveLength(1)
    expect(cmds![0].cmd).toBe('security')
    expect(cmds![0].args).toEqual(['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', '/tmp/ca.crt'])
  })

  it('macOS user scope trusts into the login keychain', () => {
    const cmds = caTrustCommandFor('darwin', 'user', '/tmp/ca.crt')
    expect(cmds).toHaveLength(1)
    expect(cmds![0].args).toContain('~/Library/Keychains/login.keychain-db')
  })

  it('macOS system and user scopes target different keychains', () => {
    const system = caTrustCommandFor('darwin', 'system', '/tmp/ca.crt')!
    const user = caTrustCommandFor('darwin', 'user', '/tmp/ca.crt')!
    expect(system[0].args).not.toEqual(user[0].args)
  })

  it('Windows scope (either) uses certutil -addstore Root', () => {
    for (const scope of ['system', 'user'] as const) {
      const cmds = caTrustCommandFor('win32', scope, '/tmp/ca.crt')
      expect(cmds).toHaveLength(1)
      expect(cmds![0].cmd).toBe('certutil')
      expect(cmds![0].args).toEqual(['-addstore', 'Root', '/tmp/ca.crt'])
    }
  })

  it('Linux system scope copies the cert then rebuilds the CA bundle, in that order', () => {
    const cmds = caTrustCommandFor('linux', 'system', '/tmp/ca.crt')
    expect(cmds).toHaveLength(2)
    expect(cmds![0].cmd).toBe('cp')
    expect(cmds![0].args).toEqual(['/tmp/ca.crt', '/usr/local/share/ca-certificates/intutic-ca.crt'])
    expect(cmds![1].cmd).toBe('update-ca-certificates')
  })

  it('Linux user scope returns null — no per-user mechanism exists', () => {
    expect(caTrustCommandFor('linux', 'user', '/tmp/ca.crt')).toBeNull()
  })

  it('an unrecognized platform returns null', () => {
    expect(caTrustCommandFor('aix', 'system', '/tmp/ca.crt')).toBeNull()
  })
})

describe('installCaTrust', () => {
  const execFileMock = vi.fn()
  const originalPlatform = process.platform

  beforeEach(() => {
    execFileMock.mockReset()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    // The top-level `import { caTrustCommandFor }` above already loaded and
    // cached this module before any test ran, unmocked. Without resetting
    // first, `vi.doMock` below wouldn't affect the cached instance.
    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  it('Linux: tries update-ca-certificates first, copies then updates, in order', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null, res?: unknown) => void) => {
        execFileMock(cmd, args)
        if (cmd === 'which' && args[0] === 'update-ca-certificates') return cb(null, { stdout: '/usr/sbin/update-ca-certificates' })
        cb(null, { stdout: '' })
      },
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    }))

    const { installCaTrust: install } = await import('./caTrust.js')
    const result = await install('/tmp/ca.crt', 'system')

    expect(result.installed).toBe(true)
    expect(result.mechanism).toBe('update-ca-certificates')

    const calledCmds = execFileMock.mock.calls.map((c) => c[0])
    expect(calledCmds).toContain('update-ca-certificates')
    // The rebuild command must run, and must run after the which-probe.
    expect(calledCmds.indexOf('update-ca-certificates')).toBeGreaterThan(calledCmds.indexOf('which'))
  })

  it('Linux: falls back to update-ca-trust when update-ca-certificates is absent', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null, res?: unknown) => void) => {
        execFileMock(cmd, args)
        if (cmd === 'which' && args[0] === 'update-ca-certificates') return cb(new Error('not found'))
        if (cmd === 'which' && args[0] === 'update-ca-trust') return cb(null, { stdout: '/usr/bin/update-ca-trust' })
        cb(null, { stdout: '' })
      },
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    }))

    const { installCaTrust: install } = await import('./caTrust.js')
    const result = await install('/tmp/ca.crt', 'system')

    expect(result.installed).toBe(true)
    expect(result.mechanism).toBe('update-ca-trust')
  })

  it('Linux: reports installed:false with a real reason when neither tool exists, rather than silently succeeding', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: (_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(new Error('not found')),
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn(),
      readFile: vi.fn(),
    }))

    const { installCaTrust: install } = await import('./caTrust.js')
    const result = await install('/tmp/ca.crt', 'system')

    expect(result.installed).toBe(false)
    expect(result.detail).toContain('update-ca-certificates')
    expect(result.detail).toContain('update-ca-trust')
  })

  it('surfaces a failed underlying command as installed:false rather than throwing', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null) => void) => {
        if (cmd === 'which') return cb(null)
        cb(new Error('Operation not permitted'))
      },
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    }))

    const { installCaTrust: install } = await import('./caTrust.js')
    await expect(install('/tmp/ca.crt', 'system')).resolves.toMatchObject({ installed: false })
  })
})
