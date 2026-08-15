/**
 * Privilege + invoking-user-home resolution, shared by `enterprise install`
 * (`commands/enterprise.ts`) and `enforce`'s reporting leg (`commands/enforce.ts`).
 *
 * Two bugs in the deleted `enterprise-install.ts` motivate this module rather
 * than a copy of what it did:
 *
 * 1. Its Windows elevation check was `process.env.USERNAME === 'Administrator'
 *    || process.env.IS_ADMIN === '1'` — wrong on essentially every real
 *    machine (the built-in Administrator account is disabled by default, and
 *    `IS_ADMIN` is not a variable Windows or any installer sets). It would
 *    have reported "not elevated" for every real admin session.
 * 2. It read `~/.intutic/ca.crt` via `os.homedir()`. Under `sudo`,
 *    `os.homedir()` resolves to `/var/root` (macOS) or `/root` (Linux) — the
 *    invoking user's home, not root's — so that read always threw ENOENT and
 *    the command silently skipped CA installation. Confirmed: zero
 *    `SUDO_USER`/`SUDO_UID` references exist anywhere else in this tree.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { getIntuticDirFor } from '../config/paths.js'

const execFileAsync = promisify(execFile)

/**
 * `'unknown'` on platforms/paths where no reliable synchronous check exists
 * (Windows) — callers should attempt-and-report on `'unknown'`, matching
 * `enforce.ts`'s existing "warn, but still try; the OS gives the precise
 * error if privilege really is missing" discipline, rather than pre-blocking
 * on a guess.
 */
export type Elevation = 'elevated' | 'unelevated' | 'unknown'

/** Synchronous, POSIX-only (real euid check). Always `'unknown'` on Windows. */
export function isElevatedSync(): Elevation {
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0 ? 'elevated' : 'unelevated'
  }
  return 'unknown'
}

/**
 * Resolves `'unknown'` into a real answer on Windows by probing `net
 * session`, which only an elevated process can run (it fails with "Access is
 * denied" otherwise). No dependency on environment variables an installer or
 * shell may or may not set.
 */
export async function isElevatedAsync(): Promise<Elevation> {
  const sync = isElevatedSync()
  if (sync !== 'unknown') return sync

  if (process.platform === 'win32') {
    try {
      await execFileAsync('net', ['session'], { timeout: 3000 })
      return 'elevated'
    } catch {
      return 'unelevated'
    }
  }
  return 'unknown'
}

/**
 * The real invoking user's home directory, even when running as root under
 * `sudo`. `os.homedir()` under `sudo` resolves to root's home
 * (`/var/root`/`/root`), not the real user's — the deleted `enterprise-install.ts`
 * never handled this and its CA-cert read (`~/.intutic/ca.crt`) always threw
 * ENOENT when actually run elevated.
 *
 * Node's `os.userInfo()` cannot look up an arbitrary user by uid — despite
 * accepting a `uid` option at the type level in some environments, it always
 * returns the CALLING process's own identity regardless of what's passed
 * (verified: `userInfo({ uid: 0 })` as a non-root user still returns that
 * user's own info, not root's). So the only real option without shelling out
 * to `dscl`/`getent` is the path convention every real deployment follows:
 * `/Users/$SUDO_USER` on macOS, `/home/$SUDO_USER` on Linux. This is a
 * correctness improvement over the status quo (silently resolving to root's
 * home) even though it is a convention, not a guaranteed-correct lookup.
 */
export function invokingUserHome(): string {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const sudoUser = process.env.SUDO_USER
  if (!isRoot || !sudoUser) {
    return homedir()
  }

  return process.platform === 'darwin' ? `/Users/${sudoUser}` : `/home/${sudoUser}`
}

/** The invoking user's `~/.intutic` (or platform equivalent), sudo-aware. */
export function invokingUserIntuticDir(): string {
  return getIntuticDirFor(invokingUserHome())
}
