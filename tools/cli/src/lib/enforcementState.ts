/**
 * Local, unprivileged-readable record of a machine's enforcement posture —
 * firewall, CA trust, system hooks. Solves two problems together:
 *
 * 1. `intutic enforce status` needs root to query the underlying firewall
 *    tool (e.g. `pfctl`) on macOS, so an unprivileged run can't truthfully
 *    answer "is enforcement actually on?".
 * 2. A `sudo`-elevated process can't read the real user's stored API
 *    credentials (Keychain-backed on macOS), so it can't itself report
 *    posture to the control plane.
 *
 * So: the privileged action (`enforce apply/remove`, `enterprise install`)
 * records the truth here, locally, as it happens; a separate, unprivileged
 * step (`enforce report`, `connect.ts`'s periodic loop — see A7) reads this
 * file and ships it.
 *
 * World-readable, no secrets in it — device posture only.
 *
 * @module
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getIntuticDir } from '../config/paths.js'
import { hostname } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execFileAsync = promisify(execFile)

export interface FirewallLeg {
  active: boolean
  backend?: string
  detail?: string
  reportedAt: string
}

export interface CaTrustLeg {
  installed: boolean
  scope: 'user' | 'system'
  mechanism?: string
  reportedAt: string
}

export interface SystemHooksLeg {
  installed: boolean
  path?: string
  reportedAt: string
}

export interface EnforcementState {
  fingerprint: string
  hostname: string
  platform: string
  cliVersion: string
  firewall?: FirewallLeg
  caTrust?: CaTrustLeg
  systemHooks?: SystemHooksLeg
}

/** The legs a single write can update. Omitted legs are preserved from the existing file, not blanked. */
export type EnforcementStateLegs = Pick<EnforcementState, 'firewall' | 'caTrust' | 'systemHooks'>

/** Machine-wide (not per-user) system-config location, per platform convention. */
export function enforcementStatePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/Intutic/enforcement-state.json'
  if (platform === 'win32') {
    return `${process.env.ProgramData ?? 'C:\\ProgramData'}\\Intutic\\enforcement-state.json`
  }
  return '/var/lib/intutic/enforcement-state.json'
}

async function readMachineId(platform: NodeJS.Platform): Promise<string | null> {
  try {
    if (platform === 'linux') {
      const id = (await readFile('/etc/machine-id', 'utf-8')).trim()
      return id || null
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      return match?.[1] ?? null
    }
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('reg', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
        '/v',
        'MachineGuid',
      ])
      const match = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
      return match?.[1] ?? null
    }
  } catch {
    return null
  }
  return null
}

/**
 * Stable per-machine fingerprint: sha256 of hostname + platform + a
 * platform machine-id source, truncated to 32 hex chars. Falls back to
 * hostname + platform alone when the machine-id source is unavailable
 * (sandboxed CI, no `ioreg`/`reg`, missing `/etc/machine-id`) — still
 * stable across calls on the same box, just weaker at distinguishing two
 * machines that happen to share a hostname.
 */
export async function computeFingerprint(platform: NodeJS.Platform = process.platform): Promise<string> {
  const machineId = await readMachineId(platform)
  const material = machineId ? `${hostname()}:${platform}:${machineId}` : `${hostname()}:${platform}`
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

async function readState(path: string): Promise<EnforcementState | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as EnforcementState
  } catch {
    return null
  }
}

/**
 * Where `intutic connect` records its CA-trust leg: it runs as the real user,
 * who cannot write the machine-wide file unless a privileged install made it so.
 */
export function userEnforcementStatePath(): string {
  return join(getIntuticDir(), 'enforcement-state.json')
}

function newestLeg(a?: CaTrustLeg, b?: CaTrustLeg): CaTrustLeg | undefined {
  if (!a || !b) return a ?? b
  return b.reportedAt > a.reportedAt ? b : a
}

/**
 * Reads the local enforcement state, if any. The user file only ever adds the
 * CA-trust leg: firewall and system hooks stand for privileged actions, so a
 * file the user can write says nothing about them.
 */
export async function readEnforcementState(
  path: string = enforcementStatePath(),
  userPath: string = userEnforcementStatePath(),
): Promise<EnforcementState | null> {
  const machine = await readState(path)
  const user = await readState(userPath)
  if (!user) return machine
  if (!machine) return { ...user, firewall: undefined, systemHooks: undefined }
  return { ...machine, caTrust: newestLeg(machine.caTrust, user.caTrust) }
}

async function mergeWrite(legs: EnforcementStateLegs, cliVersion: string, path: string): Promise<EnforcementState> {
  const existing = await readState(path)
  const fingerprint = existing?.fingerprint ?? (await computeFingerprint())

  const next: EnforcementState = {
    fingerprint,
    hostname: hostname(),
    platform: process.platform,
    cliVersion,
    firewall: legs.firewall ?? existing?.firewall,
    caTrust: legs.caTrust ?? existing?.caTrust,
    systemHooks: legs.systemHooks ?? existing?.systemHooks,
  }

  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.intutic-tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o644 })
  await rename(tmp, path)

  return next
}

/**
 * Merge-writes one or more legs into the local enforcement state file.
 * Never overwrites a leg the caller didn't pass — a firewall-only write
 * (from `enforce apply`) must not blank out a previously-recorded
 * CA-trust leg (from `enterprise install`), and vice versa.
 *
 * Without permission on the machine-wide file, a CA-trust-only write goes to
 * the user file. Anything else still fails: it needs the privilege it lacks.
 */
export async function writeEnforcementState(
  legs: EnforcementStateLegs,
  cliVersion: string,
  path: string = enforcementStatePath(),
  userPath: string = userEnforcementStatePath(),
): Promise<EnforcementState> {
  try {
    return await mergeWrite(legs, cliVersion, path)
  } catch (err) {
    const denied = ['EACCES', 'EPERM', 'EROFS'].includes((err as NodeJS.ErrnoException).code ?? '')
    if (!denied || !legs.caTrust || legs.firewall || legs.systemHooks) throw err
    return mergeWrite(legs, cliVersion, userPath)
  }
}

/**
 * Whether this machine is expected to be contained, and so whether a direct
 * connection to an AI provider is a bypass worth reporting: the workspace
 * enforces egress, or this machine applied `intutic enforce` (the firewall leg).
 * Anywhere else a direct connection is the normal state.
 */
export function containmentExpected(egressMode: string | undefined, state: EnforcementState | null): boolean {
  return egressMode === 'enforce' || state?.firewall?.active === true
}
