/**
 * The machine's AI inventory, as `intutic connect` reports it every few
 * minutes: every harness the detection rules find (connected or not), plus
 * what the sync daemon reads about each (`collectDeviceInventory`), sent with
 * the same device fingerprint `intutic enforce` reports under.
 *
 * Detection lives here because the rules are the CLI's harness adapters
 * (`../harness/detector.ts`); the daemon package does not depend on the CLI.
 *
 * @module
 */

import { readdir } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { InventoryDeviceIdentity } from '@intutic/shared-types'
import { collectDeviceInventory, reportDeviceInventory, type DetectedHarness } from '@intutic/sync-daemon'
import { ALL_ADAPTERS } from '../harness/detector.js'
import { computeFingerprint, readEnforcementState } from './enforcementState.js'

/** At the default 30-second poll, every five minutes, starting with the first poll. */
export const INVENTORY_EVERY_N_POLLS = 10

export function shouldReportInventoryThisIteration(pollIteration: number): boolean {
  return pollIteration % INVENTORY_EVERY_N_POLLS === 0
}

/**
 * VS Code extensions whose installed directory name carries the version
 * (`<publisher>.<name>-<version>`), the one version source cheap enough to
 * read on every inventory cycle.
 */
const VSCODE_EXTENSION_PREFIX: Readonly<Record<string, string>> = {
  'cline': 'saoudrizwan.claude-dev-',
  'roo-code': 'rooveterinaryinc.roo-cline-',
  'continue': 'continue.continue-',
}

/** The newest installed version of each extension-based harness, from directory names alone. */
export async function vscodeExtensionVersions(home: string = homedir()): Promise<Map<string, string>> {
  let entries: string[]
  try {
    entries = await readdir(join(home, '.vscode', 'extensions'))
  } catch {
    return new Map()
  }
  const out = new Map<string, string>()
  for (const [harness, prefix] of Object.entries(VSCODE_EXTENSION_PREFIX)) {
    const versions = entries
      .filter((e) => e.startsWith(prefix))
      .map((e) => /^\d+\.\d+\.\d+/.exec(e.slice(prefix.length))?.[0])
      .filter((v): v is string => v !== undefined)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (versions[0]) out.set(harness, versions[0])
  }
  return out
}

/**
 * Every harness whose detection rule matches this machine and workspace. A
 * rule that throws counts as not detected: one broken probe must not hide
 * the rest.
 */
export async function detectInstalledHarnesses(workspaceRoot: string, home: string = homedir()): Promise<DetectedHarness[]> {
  const versions = await vscodeExtensionVersions(home)
  const found: DetectedHarness[] = []
  for (const adapter of ALL_ADAPTERS) {
    const detected = await adapter.detect(workspaceRoot).catch(() => false)
    if (!detected) continue
    const version = versions.get(adapter.type)
    found.push(version ? { type: adapter.type, version } : { type: adapter.type })
  }
  return found
}

/**
 * This machine as `/api/v1/devices` knows it: the fingerprint in the local
 * enforcement state when `intutic enforce` or `connect` has written one, so
 * both views name the same device; otherwise the same fingerprint computed now.
 */
export async function inventoryDeviceIdentity(cliVersion: string): Promise<InventoryDeviceIdentity> {
  const state = await readEnforcementState()
  if (state) {
    return { fingerprint: state.fingerprint, hostname: state.hostname, platform: state.platform, cliVersion }
  }
  return { fingerprint: await computeFingerprint(), hostname: hostname(), platform: process.platform, cliVersion }
}

/**
 * Detects, collects and sends the inventory. Never throws: the sync loop must
 * not stop over a report the next cycle repeats anyway.
 */
export async function reportMachineInventory(opts: {
  controlPlaneUrl: string
  apiKey: string
  workspaceRoot: string
  configured: readonly string[]
  cliVersion: string
}): Promise<{ reported: boolean; reason?: string }> {
  try {
    const [detected, device] = await Promise.all([
      detectInstalledHarnesses(opts.workspaceRoot),
      inventoryDeviceIdentity(opts.cliVersion),
    ])
    const inventory = await collectDeviceInventory({
      workspaceRoot: opts.workspaceRoot,
      detected,
      configured: opts.configured,
    })
    const reported = await reportDeviceInventory(opts.controlPlaneUrl, opts.apiKey, device, inventory)
    return reported ? { reported } : { reported, reason: 'the control plane did not accept it' }
  } catch (err) {
    return { reported: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
