import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  enforcementStatePath,
  computeFingerprint,
  writeEnforcementState,
  readEnforcementState,
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
    expect(await readEnforcementState(path)).toBeNull()
  })

  it('writing one leg does not blank out a previously-written leg', async () => {
    path = join(tmpdir(), `intutic-enforcement-state-${randomUUID()}.json`)

    await writeEnforcementState(
      { firewall: { active: true, backend: 'nftables', reportedAt: '2026-08-15T00:00:00.000Z' } },
      '1.7.0',
      path,
    )
    const afterFirewall = await readEnforcementState(path)
    expect(afterFirewall?.firewall?.active).toBe(true)
    expect(afterFirewall?.caTrust).toBeUndefined()

    await writeEnforcementState(
      { caTrust: { installed: true, scope: 'system', mechanism: 'update-ca-certificates', reportedAt: '2026-08-15T00:05:00.000Z' } },
      '1.7.0',
      path,
    )
    const afterCaTrust = await readEnforcementState(path)
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
    const state = await readEnforcementState(path)
    expect(state?.firewall?.active).toBe(false)
    expect(state?.firewall?.backend).toBeUndefined()
  })
})
