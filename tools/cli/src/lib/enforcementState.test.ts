import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  enforcementStatePath,
  computeFingerprint,
  writeEnforcementState,
  readEnforcementState,
  containmentExpected,
} from './enforcementState.js'

describe('enforcementStatePath', () => {
  it('resolves to the macOS machine-wide app-support location', () => {
    expect(enforcementStatePath('darwin')).toBe('/Library/Application Support/Intutic/enforcement-state.json')
  })

  it('resolves to /var/lib/intutic on Linux', () => {
    expect(enforcementStatePath('linux')).toBe('/var/lib/intutic/enforcement-state.json')
  })

  it('resolves under ProgramData on Windows', () => {
    expect(enforcementStatePath('win32')).toContain('Intutic\\enforcement-state.json')
  })
})

describe('computeFingerprint', () => {
  it('is stable across repeated calls on the same machine', async () => {
    const first = await computeFingerprint()
    const second = await computeFingerprint()
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
  })

  it('differs between platforms given the same real machine', async () => {
    const linux = await computeFingerprint('linux')
    const darwin = await computeFingerprint('darwin')
    expect(linux).not.toBe(darwin)
  })
})

describe('writeEnforcementState / readEnforcementState', () => {
  let path: string

  afterEach(async () => {
    if (path) await rm(path, { force: true })
  })

  it('reading a nonexistent file returns null rather than throwing', async () => {
    path = join(tmpdir(), `intutic-enforcement-state-${randomUUID()}.json`)
    expect(await readEnforcementState(path, `${path}.user`)).toBeNull()
  })

  it('writing one leg does not blank out a previously-written leg', async () => {
    path = join(tmpdir(), `intutic-enforcement-state-${randomUUID()}.json`)

    await writeEnforcementState(
      { firewall: { active: true, backend: 'nftables', reportedAt: '2026-08-15T00:00:00.000Z' } },
      '1.7.0',
      path,
    )
    const afterFirewall = await readEnforcementState(path, `${path}.user`)
    expect(afterFirewall?.firewall?.active).toBe(true)
    expect(afterFirewall?.caTrust).toBeUndefined()

    await writeEnforcementState(
      { caTrust: { installed: true, scope: 'system', mechanism: 'update-ca-certificates', reportedAt: '2026-08-15T00:05:00.000Z' } },
      '1.7.0',
      path,
    )
    const afterCaTrust = await readEnforcementState(path, `${path}.user`)
    // The firewall leg from the first write must survive, untouched.
    expect(afterCaTrust?.firewall?.active).toBe(true)
    expect(afterCaTrust?.firewall?.backend).toBe('nftables')
    expect(afterCaTrust?.caTrust?.installed).toBe(true)
  })

  it('preserves the fingerprint minted on first write across later writes', async () => {
    path = join(tmpdir(), `intutic-enforcement-state-${randomUUID()}.json`)

    const first = await writeEnforcementState(
      { firewall: { active: true, reportedAt: '2026-08-15T00:00:00.000Z' } },
      '1.7.0',
      path,
    )
    const second = await writeEnforcementState(
      { systemHooks: { installed: true, path: '/etc/cursor/hooks.json', reportedAt: '2026-08-15T00:10:00.000Z' } },
      '1.7.0',
      path,
    )
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('replacing a leg overwrites that leg entirely, not merges within it', async () => {
    path = join(tmpdir(), `intutic-enforcement-state-${randomUUID()}.json`)

    await writeEnforcementState(
      { firewall: { active: true, backend: 'nftables', detail: 'applied', reportedAt: '2026-08-15T00:00:00.000Z' } },
      '1.7.0',
      path,
    )
    await writeEnforcementState(
      { firewall: { active: false, reportedAt: '2026-08-15T00:20:00.000Z' } },
      '1.7.0',
      path,
    )
    const state = await readEnforcementState(path, `${path}.user`)
    expect(state?.firewall?.active).toBe(false)
    expect(state?.firewall?.backend).toBeUndefined()
  })
})

// The connect loop probed every machine on every sync and filed a CRITICAL
// DATA_EXFILTRATION incident wherever a provider was reachable directly, which
// is every machine without `intutic enforce`.
describe('containmentExpected', () => {
  const state = (active: boolean) => ({
    fingerprint: 'f', hostname: 'h', platform: 'darwin', cliVersion: '1',
    firewall: { active, reportedAt: '2026-10-13T00:00:00Z' },
  })
  it('is false for a machine with no firewall in a workspace that does not enforce egress', () => {
    expect(containmentExpected(undefined, null)).toBe(false)
    expect(containmentExpected('monitor', state(false))).toBe(false)
  })
  it('is true when the workspace enforces egress, or this machine applied enforce', () => {
    expect(containmentExpected('enforce', null)).toBe(true)
    expect(containmentExpected('off', state(true))).toBe(true)
  })
})

describe('an unprivileged user', () => {
  const root = join(tmpdir(), `intutic-enforcement-${randomUUID()}`)
  const caTrust = { installed: true, scope: 'user' as const, reportedAt: '2026-11-05T00:00:00.000Z' }
  const machine = join(root, 'machine', 'state.json')
  const user = join(root, 'user', 'state.json')

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function denyMachineDir(): Promise<string> {
    await mkdir(root, { recursive: true })
    await mkdir(join(root, 'locked'), { mode: 0o500 })
    return join(root, 'locked', 'sub', 'state.json')
  }

  it('records the CA-trust leg in the user file, and it can be read back', async () => {
    const locked = await denyMachineDir()
    await writeEnforcementState({ caTrust }, '1.0.0', locked, user)
    expect((await readEnforcementState(locked, user))?.caTrust).toEqual(caTrust)
  })

  it('still fails on a leg that takes the privilege it lacks', async () => {
    const locked = await denyMachineDir()
    const firewall = { active: true, backend: 'pf', reportedAt: caTrust.reportedAt }
    await expect(writeEnforcementState({ firewall }, '1.0.0', locked, user)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('never takes a firewall or hook claim from the user file', async () => {
    const firewall = { active: true, backend: 'pf', reportedAt: caTrust.reportedAt }
    await writeEnforcementState({ firewall, caTrust }, '1.0.0', user, `${user}.unused`)
    const alone = await readEnforcementState(machine, user)
    expect(alone?.firewall).toBeUndefined()
    expect(alone?.caTrust).toEqual(caTrust)

    await writeEnforcementState({ firewall: { ...firewall, active: false } }, '1.0.0', machine, `${machine}.unused`)
    expect((await readEnforcementState(machine, user))?.firewall?.active).toBe(false)
  })

  it('keeps the newer CA-trust leg of the two files', async () => {
    const older = { ...caTrust, installed: false, reportedAt: '2026-01-01T00:00:00.000Z' }
    await writeEnforcementState({ caTrust: older }, '1.0.0', machine, `${machine}.unused`)
    await mkdir(join(root, 'user'), { recursive: true })
    await writeFile(user, JSON.stringify({ caTrust }))
    expect((await readEnforcementState(machine, user))?.caTrust).toEqual(caTrust)
  })
})
