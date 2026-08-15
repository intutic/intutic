import { describe, it, expect, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { isElevatedSync, invokingUserHome, invokingUserIntuticDir } from './elevation.js'

const ORIGINAL_GETUID = process.getuid?.bind(process)
const ENV_KEYS = ['SUDO_USER', 'SUDO_UID'] as const

afterEach(() => {
  if (ORIGINAL_GETUID) {
    process.getuid = ORIGINAL_GETUID
  }
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('isElevatedSync', () => {
  it('reports elevated when euid is 0', () => {
    process.getuid = () => 0
    expect(isElevatedSync()).toBe('elevated')
  })

  it('reports unelevated for a non-root euid', () => {
    process.getuid = () => 501
    expect(isElevatedSync()).toBe('unelevated')
  })

  it('reports unknown when there is no getuid at all (Windows)', () => {
    // `delete` rather than reassigning to undefined, matching how the
    // property is genuinely absent on win32 (Node never defines it there).
    delete process.getuid
    expect(isElevatedSync()).toBe('unknown')
  })
})

describe('invokingUserHome', () => {
  it('returns the real user\'s home when not running as root, regardless of SUDO_USER', () => {
    process.getuid = () => 501
    process.env.SUDO_USER = 'someone-else'
    expect(invokingUserHome()).toBe(homedir())
  })

  it('returns the real user\'s home when root but SUDO_USER is unset (e.g. a root shell, not sudo)', () => {
    process.getuid = () => 0
    expect(invokingUserHome()).toBe(homedir())
  })

  it('resolves to the platform home-path convention when root and SUDO_USER is set', () => {
    process.getuid = () => 0
    process.env.SUDO_USER = 'someuser'
    const expected = process.platform === 'darwin' ? '/Users/someuser' : '/home/someuser'
    expect(invokingUserHome()).toBe(expected)
  })

  it('ignores SUDO_UID entirely (os.userInfo cannot look up an arbitrary uid, only the path convention is used)', () => {
    process.getuid = () => 0
    process.env.SUDO_USER = 'someuser'
    process.env.SUDO_UID = '999999'
    const expected = process.platform === 'darwin' ? '/Users/someuser' : '/home/someuser'
    expect(invokingUserHome()).toBe(expected)
  })
})

describe('invokingUserIntuticDir', () => {
  it('is the .intutic dir under the resolved invoking-user home', () => {
    process.getuid = () => 501
    const dir = invokingUserIntuticDir()
    expect(dir.startsWith(homedir())).toBe(true)
    expect(dir.endsWith('.intutic')).toBe(process.platform !== 'win32')
  })
})
