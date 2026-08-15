/**
 * OS trust-store injection for the Intutic proxy CA certificate.
 *
 * Two trust scopes:
 * - `'user'` — per-user, non-elevated. Already shipping today via
 *   `commands/connect.ts` (macOS login keychain, Windows `certutil`), run
 *   silently on every `intutic connect`.
 * - `'system'` — machine-wide, requires root/admin. New here — this is the
 *   half `enterprise install` (`commands/enterprise.ts`) needs and the
 *   deleted `enterprise-install.ts` (commit `8481b5d9`) used to provide.
 *
 * `caTrustCommandFor` is exported specifically so `doctor.ts`'s remediation
 * strings can be generated from the same source as what actually runs here,
 * rather than hand-duplicated — which is exactly how they already drifted
 * once (the check there looks in three Linux cert-anchor directories; the
 * remediation only ever names one).
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export type TrustScope = 'user' | 'system'

export interface CaTrustCommand {
  /** A short label for what this step does, used in logs. */
  step: string
  cmd: string
  args: string[]
}

export interface CaTrustResult {
  installed: boolean
  scope: TrustScope
  /** e.g. 'security', 'update-ca-certificates', 'update-ca-trust', 'certutil'. */
  mechanism: string
  detail: string
}

const LINUX_DEBIAN_DEST = '/usr/local/share/ca-certificates/intutic-ca.crt'
const LINUX_RHEL_DEST = '/etc/pki/ca-trust/source/anchors/intutic-ca.crt'

/**
 * The command(s) that trust `caCertPath` at the given scope, for the given
 * platform. Pure — no I/O — so it doubles as the source of truth for
 * `doctor.ts`'s remediation text.
 *
 * Linux `'user'` scope returns `null`: there is no single per-user NSS/OS
 * trust-store equivalent worth building (each browser/runtime keeps its
 * own), unlike macOS (login keychain) and Windows (`certutil`, which is
 * elevation-agnostic — the same command works either way).
 *
 * Linux returns TWO commands (copy, then update) rather than one, since
 * `execFile` can't run a shell pipeline — callers must run both in order.
 */
export function caTrustCommandFor(
  platform: NodeJS.Platform,
  scope: TrustScope,
  caCertPath: string,
): CaTrustCommand[] | null {
  if (platform === 'darwin') {
    const keychain = scope === 'system' ? '/Library/Keychains/System.keychain' : '~/Library/Keychains/login.keychain-db'
    return [{
      step: `Trust the CA cert in the macOS ${scope === 'system' ? 'System' : 'login'} keychain`,
      cmd: 'security',
      args: ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, caCertPath],
    }]
  }

  if (platform === 'win32') {
    return [{
      step: 'Trust the CA cert in the Windows Root certificate store',
      cmd: 'certutil',
      args: ['-addstore', 'Root', caCertPath],
    }]
  }

  if (platform === 'linux') {
    if (scope === 'user') return null
    // Debian/Ubuntu style is tried first by installCaTrust (most common);
    // this function returns both possibilities so a caller (or doctor.ts)
    // can describe either without probing which tool is actually present.
    return [
      { step: 'Copy the CA cert into the system trust anchor directory (Debian/Ubuntu)', cmd: 'cp', args: [caCertPath, LINUX_DEBIAN_DEST] },
      { step: 'Rebuild the system CA bundle', cmd: 'update-ca-certificates', args: [] },
    ]
  }

  return null
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd])
    return true
  } catch {
    return false
  }
}

async function installLinuxSystemCaTrust(caCertPath: string): Promise<CaTrustResult> {
  // Debian/Ubuntu is tried first (more common in practice); RHEL/Fedora's
  // update-ca-trust is the fallback. Neither present -> fail loudly rather
  // than silently doing nothing, matching this function's contract that a
  // false `installed` always carries the real reason in `detail`.
  if (await commandExists('update-ca-certificates')) {
    await copyFile(caCertPath, LINUX_DEBIAN_DEST)
    await execFileAsync('update-ca-certificates', [])
    return { installed: true, scope: 'system', mechanism: 'update-ca-certificates', detail: `Installed to ${LINUX_DEBIAN_DEST}` }
  }
  if (await commandExists('update-ca-trust')) {
    await copyFile(caCertPath, LINUX_RHEL_DEST)
    await execFileAsync('update-ca-trust', ['extract'])
    return { installed: true, scope: 'system', mechanism: 'update-ca-trust', detail: `Installed to ${LINUX_RHEL_DEST}` }
  }
  return {
    installed: false,
    scope: 'system',
    mechanism: 'none',
    detail: 'Neither update-ca-certificates (Debian/Ubuntu) nor update-ca-trust (RHEL/Fedora) is available on this system.',
  }
}

/**
 * Installs `caCertPath` into the OS trust store at `scope`.
 *
 * Uses `execFile` with array arguments throughout — never `execSync` with
 * string interpolation, which `connect.ts`'s existing per-user calls use and
 * which is unsafe if a path ever contained a shell metacharacter. Does not
 * throw on a failed underlying command; surfaces it as `installed: false`
 * with the OS error text in `detail`, so a caller (e.g. `enterprise install`)
 * can report it and continue rather than crashing the whole run over one
 * platform-specific step.
 */
export async function installCaTrust(caCertPath: string, scope: TrustScope): Promise<CaTrustResult> {
  const platform = process.platform

  if (platform === 'linux' && scope === 'system') {
    try {
      return await installLinuxSystemCaTrust(caCertPath)
    } catch (err) {
      return { installed: false, scope, mechanism: 'linux', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  const commands = caTrustCommandFor(platform, scope, caCertPath)
  if (!commands) {
    return {
      installed: false,
      scope,
      mechanism: 'none',
      detail: `No ${scope}-scope CA trust mechanism is implemented for ${platform}.`,
    }
  }

  try {
    for (const c of commands) {
      await execFileAsync(c.cmd, c.args)
    }
    const mechanism = platform === 'darwin' ? 'security' : platform === 'win32' ? 'certutil' : commands[commands.length - 1].cmd
    return { installed: true, scope, mechanism, detail: `Trusted via ${mechanism}` }
  } catch (err) {
    return { installed: false, scope, mechanism: platform, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Best-effort check for whether `caCertPath` is already trusted — read-only,
 * never installs anything. Used to skip a redundant (and log-noisy)
 * re-install. Only implemented where a cheap, real check exists (macOS
 * `security verify-cert`); returns `false` elsewhere rather than guessing,
 * so a caller falls through to attempting installation, which is itself
 * idempotent.
 */
export async function verifyCaTrust(caCertPath: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('security', ['verify-cert', '-c', caCertPath])
      return true
    } catch {
      return false
    }
  }
  if (process.platform === 'linux') {
    try {
      const installed = await readFile(LINUX_DEBIAN_DEST, 'utf-8').catch(() => readFile(LINUX_RHEL_DEST, 'utf-8'))
      return installed.length > 0
    } catch {
      return false
    }
  }
  return false
}
