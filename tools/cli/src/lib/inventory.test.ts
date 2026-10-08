/**
 * The CLI half of the AI inventory: harness detection with cheap versions,
 * the device identity it is reported under, and a send that never throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../harness/detector.js', () => ({
  ALL_ADAPTERS: [
    { type: 'cursor', detect: vi.fn(async () => true) },
    { type: 'cline', detect: vi.fn(async () => true) },
    { type: 'aider', detect: vi.fn(async () => false) },
    { type: 'n8n', detect: vi.fn(async () => { throw new Error('probe failed') }) },
  ],
}))

vi.mock('./enforcementState.js', () => ({
  readEnforcementState: vi.fn(),
  computeFingerprint: vi.fn(async () => 'c'.repeat(32)),
}))

vi.mock('@intutic/sync-daemon', () => ({
  collectDeviceInventory: vi.fn(async () => ({ schemaVersion: 1, harnesses: [] })),
  reportDeviceInventory: vi.fn(async () => true),
}))

import {
  INVENTORY_EVERY_N_POLLS,
  shouldReportInventoryThisIteration,
  vscodeExtensionVersions,
  detectInstalledHarnesses,
  inventoryDeviceIdentity,
  reportMachineInventory,
} from './inventory.js'
import { readEnforcementState } from './enforcementState.js'
import { collectDeviceInventory, reportDeviceInventory } from '@intutic/sync-daemon'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'intutic-cli-inventory-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.mocked(readEnforcementState).mockReset()
})

describe('shouldReportInventoryThisIteration', () => {
  it('reports on the first poll and then every Nth', () => {
    expect(shouldReportInventoryThisIteration(0)).toBe(true)
    expect(shouldReportInventoryThisIteration(1)).toBe(false)
    expect(shouldReportInventoryThisIteration(INVENTORY_EVERY_N_POLLS)).toBe(true)
  })
})

describe('vscodeExtensionVersions', () => {
  it('reads the newest installed version from extension directory names', async () => {
    for (const dir of ['saoudrizwan.claude-dev-3.9.0', 'saoudrizwan.claude-dev-3.10.2', 'continue.continue-1.2.0-darwin-arm64', 'other.ext-9.9.9']) {
      mkdirSync(join(home, '.vscode', 'extensions', dir), { recursive: true })
    }
    expect(Object.fromEntries(await vscodeExtensionVersions(home))).toEqual({ cline: '3.10.2', continue: '1.2.0' })
  })

  it('is empty without a VS Code extensions directory', async () => {
    expect((await vscodeExtensionVersions(home)).size).toBe(0)
  })
})

describe('detectInstalledHarnesses', () => {
  it('lists every adapter whose rule matches, with a version where one is cheap, and skips a rule that throws', async () => {
    mkdirSync(join(home, '.vscode', 'extensions', 'saoudrizwan.claude-dev-3.2.1'), { recursive: true })
    expect(await detectInstalledHarnesses('/ws', home)).toEqual([{ type: 'cursor' }, { type: 'cline', version: '3.2.1' }])
  })
})

describe('inventoryDeviceIdentity', () => {
  it('uses the enforcement-state fingerprint so both device views agree', async () => {
    vi.mocked(readEnforcementState).mockResolvedValueOnce({
      fingerprint: 'a'.repeat(32), hostname: 'laptop', platform: 'darwin', cliVersion: '2.1.0',
    })
    expect(await inventoryDeviceIdentity('2.2.0')).toEqual({ fingerprint: 'a'.repeat(32), hostname: 'laptop', platform: 'darwin', cliVersion: '2.2.0' })
  })

  it('computes the same fingerprint when no enforcement state exists yet', async () => {
    vi.mocked(readEnforcementState).mockResolvedValueOnce(null)
    const id = await inventoryDeviceIdentity('2.2.0')
    expect(id.fingerprint).toBe('c'.repeat(32))
    expect(id.platform).toBe(process.platform)
  })
})

describe('reportMachineInventory', () => {
  it('collects for the configured harnesses and sends with the device identity', async () => {
    vi.mocked(readEnforcementState).mockResolvedValueOnce(null)
    const result = await reportMachineInventory({
      controlPlaneUrl: 'http://cp.test', apiKey: 'vk_test', workspaceRoot: '/ws', configured: ['claude-code'], cliVersion: '2.2.0',
    })
    expect(result).toEqual({ reported: true })
    expect(vi.mocked(collectDeviceInventory)).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: '/ws', configured: ['claude-code'] }))
    expect(vi.mocked(reportDeviceInventory)).toHaveBeenCalledWith(
      'http://cp.test', 'vk_test', expect.objectContaining({ fingerprint: 'c'.repeat(32) }), expect.objectContaining({ schemaVersion: 1 }),
    )
  })

  it('returns the reason instead of throwing', async () => {
    vi.mocked(collectDeviceInventory).mockRejectedValueOnce(new Error('disk gone'))
    expect(await reportMachineInventory({
      controlPlaneUrl: 'http://cp.test', apiKey: 'vk_test', workspaceRoot: '/ws', configured: [], cliVersion: '2.2.0',
    })).toEqual({ reported: false, reason: 'disk gone' })
    vi.mocked(reportDeviceInventory).mockResolvedValueOnce(false)
    expect((await reportMachineInventory({
      controlPlaneUrl: 'http://cp.test', apiKey: 'vk_test', workspaceRoot: '/ws', configured: [], cliVersion: '2.2.0',
    })).reported).toBe(false)
  })
})
