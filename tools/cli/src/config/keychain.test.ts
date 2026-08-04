/**
 * keychain.test.ts
 *
 * This file had no tests, which is how the Windows path shipped broken: the
 * write half used `cmdkey /generic:` (a Credential Manager generic credential)
 * and the read half used a WinRT `PasswordVault`, two stores that cannot see
 * each other. `storeToken` still returned true because cmdkey exited 0, so
 * `saveCredentials` persisted the sentinel `apiKey: 'keychain'` in place of the
 * token and `loadCredentials` handed the literal string "keychain" to the API
 * client forever after. Re-running `intutic login` rewrote the same sentinel.
 *
 * The fake below models the two vaults as genuinely separate, so a write and a
 * read that disagree about which one they address produce a miss — exactly as
 * they did on a real machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Which credential store a command addresses. Distinct ids never see each other. */
type VaultId = 'macos-keychain' | 'libsecret' | 'winrt-passwordvault' | 'windows-credman'

const vaults = new Map<string, string>()
const key = (vault: VaultId, target: string) => `${vault}::${target}`

/**
 * Classify a spawned command into the store it actually talks to, and whether
 * it is reading or writing. Deliberately keyed on the tool and verb rather than
 * on anything the source under test spells out, so the test cannot be satisfied
 * by a string that merely appears in keychain.ts.
 */
function classify(cmd: string, args: string[], input?: string): {
  vault: VaultId
  op: 'write' | 'read' | 'delete'
  target: string
  token?: string
} | null {
  const joined = args.join(' ')

  if (cmd === 'security') {
    const sIdx = args.indexOf('-s')
    const target = sIdx >= 0 ? args[sIdx + 1]! : ''
    if (args[0] === 'add-generic-password') {
      const wIdx = args.indexOf('-w')
      // `-w` with a value takes it from argv; `-w` last prompts twice on stdin.
      const token = wIdx === args.length - 1 ? input?.split('\n')[0] : args[wIdx + 1]
      return { vault: 'macos-keychain', op: 'write', target, token }
    }
    if (args[0] === 'find-generic-password') return { vault: 'macos-keychain', op: 'read', target }
    if (args[0] === 'delete-generic-password') return { vault: 'macos-keychain', op: 'delete', target }
  }

  if (cmd === 'secret-tool') {
    const target = args[args.indexOf('workspace') + 1] ?? ''
    if (args[0] === 'store') return { vault: 'libsecret', op: 'write', target, token: input }
    if (args[0] === 'lookup') return { vault: 'libsecret', op: 'read', target }
    if (args[0] === 'clear') return { vault: 'libsecret', op: 'delete', target }
  }

  // `cmdkey` writes into Windows Credential Manager. Nothing in WinRT reads it.
  if (cmd === 'cmdkey') {
    const generic = /\/generic:([^\s]+)/.exec(joined)
    const del = /\/delete:([^\s]+)/.exec(joined)
    if (generic) {
      const pass = /\/pass:(.*)$/.exec(joined)
      return { vault: 'windows-credman', op: 'write', target: generic[1]!, token: pass?.[1] }
    }
    if (del) return { vault: 'windows-credman', op: 'delete', target: del[1]! }
  }

  // PowerShell talking to the WinRT PasswordVault — a different store entirely.
  if (cmd === 'powershell') {
    const script = joined
    if (!/PasswordVault/.test(script)) return null
    const target = /["']([^"']*workspace[^"']*)["']/.exec(script)?.[1] ?? ''
    if (/\.Add\(/.test(script)) return { vault: 'winrt-passwordvault', op: 'write', target, token: input?.trim() }
    if (/\.Remove\(/.test(script)) return { vault: 'winrt-passwordvault', op: 'delete', target }
    if (/\.Retrieve\(/.test(script)) return { vault: 'winrt-passwordvault', op: 'read', target }
  }

  return null
}

/**
 * When set, writes exit 0 and store nothing — the shape of a write that lands
 * in a vault the read path cannot see. A flag rather than a swapped
 * implementation, because a failed assertion used to skip the restore and
 * poison every test that ran after it.
 */
let writesVanish = false

const execFileSyncMock = vi.fn((cmd: string, args: string[], opts?: { input?: string }) => {
  const call = classify(cmd, args, opts?.input)
  if (!call) throw new Error(`unrecognised command: ${cmd} ${args.join(' ')}`)

  if (call.op === 'write') {
    if (!call.token) throw new Error('write carried no token')
    if (writesVanish) return ''
    vaults.set(key(call.vault, call.target), call.token)
    return ''
  }
  if (call.op === 'delete') {
    vaults.delete(key(call.vault, call.target))
    return ''
  }
  const found = vaults.get(key(call.vault, call.target))
  // A real `security find-generic-password` / `secret-tool lookup` exits
  // non-zero when the item is absent.
  if (found === undefined) throw new Error('credential not found')
  return found + '\n'
})

// Indirected rather than passed straight through: `vi.mock` is hoisted above
// the `const` above, so naming it directly here is a TDZ error at load time.
vi.mock('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[], opts?: { input?: string }) =>
    execFileSyncMock(cmd, args, opts),
  execSync: vi.fn(),
}))

vi.mock('../lib/logger.js', () => ({
  log: { dim: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), field: vi.fn(), warn: vi.fn() },
}))

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('OS keychain storage', () => {
  beforeEach(() => {
    vaults.clear()
    writesVanish = false
    execFileSyncMock.mockClear()
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32']

  for (const platform of PLATFORMS) {
    it(`round-trips a token on ${platform}`, async () => {
      setPlatform(platform)
      const { storeToken, retrieveToken } = await import('./keychain.js')

      const stored = await storeToken('ws_round_trip', 'vk_secret_value')
      expect(stored, `${platform} reported its write as failed`).toBe(true)
      expect(await retrieveToken('ws_round_trip')).toBe('vk_secret_value')
    })

    it(`reports failure rather than success when ${platform} cannot read back what it wrote`, async () => {
      setPlatform(platform)
      const { storeToken } = await import('./keychain.js')

      // The write exits 0 and lands somewhere unreachable — precisely the
      // cmdkey-writes/PasswordVault-reads split.
      writesVanish = true

      const stored = await storeToken('ws_black_hole', 'vk_secret_value')
      expect(
        stored,
        'storeToken claimed success for a token that cannot be read back — ' +
          'saveCredentials will now persist the sentinel instead of the token',
      ).toBe(false)
    })
  }

  it('does not leave the token in argv where the process table can see it', async () => {
    // The Linux branch already passes the token on stdin for this reason. A
    // secret on the command line is readable by any local process for as long
    // as the child lives, and CLAUDE.md forbids echoing raw secrets.
    for (const platform of PLATFORMS) {
      setPlatform(platform)
      vaults.clear()
      execFileSyncMock.mockClear()
      const { storeToken } = await import('./keychain.js')
      await storeToken('ws_argv', 'vk_secret_value')

      for (const call of execFileSyncMock.mock.calls) {
        const argv = (call[1] as string[]).join(' ')
        expect(argv, `${platform} put the token in argv`).not.toContain('vk_secret_value')
      }
    }
  })

  it('deletes from the same store it wrote to', async () => {
    for (const platform of PLATFORMS) {
      setPlatform(platform)
      vaults.clear()
      const { storeToken, retrieveToken, deleteToken } = await import('./keychain.js')

      await storeToken('ws_delete', 'vk_secret_value')
      await deleteToken('ws_delete')
      expect(await retrieveToken('ws_delete'), `${platform} left the token behind`).toBeNull()
    }
  })
})
