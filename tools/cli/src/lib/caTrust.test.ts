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
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      unlink: vi.fn(),
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
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      unlink: vi.fn(),
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
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      unlink: vi.fn(),
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
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      unlink: vi.fn(),
      copyFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
    }))

    const { installCaTrust: install } = await import('./caTrust.js')
    await expect(install('/tmp/ca.crt', 'system')).resolves.toMatchObject({ installed: false })
  })
})

// `intutic connect` trusted the CA on macOS and Windows only. On Linux the
// system store is the shared one and needs root: install as root, otherwise
// print the exact commands.
describe('ensureLinuxCaTrust', () => {
  const execFileMock = vi.fn()
  const copyFileMock = vi.fn()
  const unlinkMock = vi.fn()
  const originalPlatform = process.platform
  const CA = '-----BEGIN CERTIFICATE-----\nintutic\n-----END CERTIFICATE-----\n'

  function mockSystem(opts: { tools: string[]; installed?: Record<string, string> }) {
    vi.doMock('node:child_process', () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null, res?: unknown) => void) => {
        execFileMock(cmd, args)
        if (cmd === 'which') return opts.tools.includes(args[0]) ? cb(null, { stdout: `/usr/sbin/${args[0]}` }) : cb(new Error('not found'))
        cb(null, { stdout: '' })
      },
    }))
    vi.doMock('node:fs/promises', () => ({
      access: vi.fn(async (p: string) => {
        if (opts.installed?.[p] === undefined) throw new Error('ENOENT')
      }),
      unlink: unlinkMock.mockResolvedValue(undefined),
      copyFile: copyFileMock.mockResolvedValue(undefined),
      readFile: vi.fn(async (p: string) => {
        if (p === '/home/dev/.intutic/ca.crt') return CA
        const installed = opts.installed?.[p]
        if (installed === undefined) throw new Error('ENOENT')
        return installed
      }),
    }))
  }

  beforeEach(() => {
    execFileMock.mockReset()
    copyFileMock.mockReset()
    unlinkMock.mockReset()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.resetModules()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  it('not root: installs nothing and gives the exact Debian/Ubuntu commands', async () => {
    mockSystem({ tools: ['update-ca-certificates'] })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    const out = await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', false)
    expect(out.state).toBe('needs-root')
    expect(out.commands).toEqual([
      'sudo cp /home/dev/.intutic/ca.crt /usr/local/share/ca-certificates/intutic-connect-ca.crt',
      'sudo update-ca-certificates',
    ])
    expect(copyFileMock).not.toHaveBeenCalled()
    expect(execFileMock.mock.calls.map((c) => c[0])).not.toContain('update-ca-certificates')
  })

  it('not root: gives the RHEL/Fedora commands where only update-ca-trust exists', async () => {
    mockSystem({ tools: ['update-ca-trust'] })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    const out = await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', false)
    expect(out.commands).toEqual([
      'sudo cp /home/dev/.intutic/ca.crt /etc/pki/ca-trust/source/anchors/intutic-connect-ca.crt',
      'sudo update-ca-trust extract',
    ])
  })

  it('root: installs into the system store under connect\'s own name, beside the machine-wide copy', async () => {
    mockSystem({ tools: ['update-ca-certificates'] })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    const out = await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', true)
    expect(out.state).toBe('installed')
    expect(copyFileMock).toHaveBeenCalledWith('/home/dev/.intutic/ca.crt', '/usr/local/share/ca-certificates/intutic-connect-ca.crt')
    expect(execFileMock.mock.calls.map((c) => c[0])).toContain('update-ca-certificates')
  })

  it('already trusted: does nothing', async () => {
    mockSystem({ tools: ['update-ca-certificates'], installed: { '/usr/local/share/ca-certificates/intutic-ca.crt': CA } })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    const out = await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', false)
    expect(out.state).toBe('trusted')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('an installed copy of a different CA does not count as trusted', async () => {
    mockSystem({ tools: ['update-ca-certificates'], installed: { '/usr/local/share/ca-certificates/intutic-ca.crt': 'an older CA' } })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    expect((await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', false)).state).toBe('needs-root')
  })

  it('enterprise install still writes the machine-wide name, which disconnect leaves alone', async () => {
    mockSystem({ tools: ['update-ca-certificates'] })
    const { installCaTrust } = await import('./caTrust.js')
    await installCaTrust('/home/dev/.intutic/ca.crt', 'system')
    expect(copyFileMock).toHaveBeenCalledWith('/home/dev/.intutic/ca.crt', '/usr/local/share/ca-certificates/intutic-ca.crt')
  })

  it('a copy connect installed counts as trusted', async () => {
    mockSystem({ tools: ['update-ca-certificates'], installed: { '/usr/local/share/ca-certificates/intutic-connect-ca.crt': CA } })
    const { ensureLinuxCaTrust } = await import('./caTrust.js')
    expect((await ensureLinuxCaTrust('/home/dev/.intutic/ca.crt', false)).state).toBe('trusted')
  })

  it('quotes a path that needs it', async () => {
    mockSystem({ tools: ['update-ca-certificates'] })
    const { linuxSystemTrustShellCommands } = await import('./caTrust.js')
    expect(linuxSystemTrustShellCommands('update-ca-certificates', "/home/o'neil dev/ca.crt")[0]).toBe(
      "sudo cp '/home/o'\\''neil dev/ca.crt' /usr/local/share/ca-certificates/intutic-connect-ca.crt",
    )
  })
})

// `intutic disconnect` takes out the copy connect installed, and only that one.
describe('linuxConnectCaRemoval / removeLinuxConnectCaTrust', () => {
  const execFileMock = vi.fn()
  const unlinkMock = vi.fn()

  function mockFiles(present: string[]) {
    vi.doMock('node:child_process', () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null, res?: unknown) => void) => {
        execFileMock(cmd, args)
        cb(null, { stdout: '' })
      },
    }))
    vi.doMock('node:fs/promises', () => ({
      access: vi.fn(async (p: string) => {
        if (!present.includes(p)) throw new Error('ENOENT')
      }),
      unlink: unlinkMock.mockResolvedValue(undefined),
      copyFile: vi.fn(),
      readFile: vi.fn(),
    }))
  }

  beforeEach(() => {
    execFileMock.mockReset()
    unlinkMock.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  it('finds nothing when only the machine-wide copy is there', async () => {
    mockFiles(['/usr/local/share/ca-certificates/intutic-ca.crt'])
    const { linuxConnectCaRemoval } = await import('./caTrust.js')
    expect(await linuxConnectCaRemoval()).toBeNull()
  })

  it('Debian/Ubuntu: names connect\'s copy and the exact sudo commands', async () => {
    mockFiles(['/usr/local/share/ca-certificates/intutic-connect-ca.crt'])
    const { linuxConnectCaRemoval } = await import('./caTrust.js')
    const removal = await linuxConnectCaRemoval()
    expect(removal?.dest).toBe('/usr/local/share/ca-certificates/intutic-connect-ca.crt')
    expect(removal?.commands).toEqual([
      'sudo rm /usr/local/share/ca-certificates/intutic-connect-ca.crt',
      'sudo update-ca-certificates --fresh',
    ])
  })

  it('RHEL/Fedora: names connect\'s copy and update-ca-trust extract', async () => {
    mockFiles(['/etc/pki/ca-trust/source/anchors/intutic-connect-ca.crt'])
    const { linuxConnectCaRemoval } = await import('./caTrust.js')
    expect((await linuxConnectCaRemoval())?.commands).toEqual([
      'sudo rm /etc/pki/ca-trust/source/anchors/intutic-connect-ca.crt',
      'sudo update-ca-trust extract',
    ])
  })

  it('removes the file, then rebuilds the bundle', async () => {
    mockFiles(['/usr/local/share/ca-certificates/intutic-connect-ca.crt'])
    const { linuxConnectCaRemoval, removeLinuxConnectCaTrust } = await import('./caTrust.js')
    await removeLinuxConnectCaTrust((await linuxConnectCaRemoval())!)
    expect(unlinkMock).toHaveBeenCalledWith('/usr/local/share/ca-certificates/intutic-connect-ca.crt')
    expect(execFileMock).toHaveBeenCalledWith('update-ca-certificates', ['--fresh'])
  })
})
