/**
 * Cross-platform path resolution for Intutic CLI config.
 *
 * - macOS/Linux: ~/.intutic/
 * - Windows: %APPDATA%\intutic\
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Returns the Intutic config directory path for a given home directory.
 *
 * Split out from {@link getIntuticDir} so an elevated (`sudo`) process can
 * resolve the REAL invoking user's config dir — via
 * `elevation.ts`'s `invokingUserHome()` — without a second, drifting copy of
 * this platform logic. `os.homedir()` under `sudo` resolves to root's home,
 * not the real user's, which is exactly the bug the deleted
 * `enterprise-install.ts` had (it read `~/.intutic/ca.crt` under `sudo` and
 * always got ENOENT).
 */
export function getIntuticDirFor(home: string): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return join(appData, 'intutic')
    // Fallback for Windows if APPDATA is not set
    return join(home, 'AppData', 'Roaming', 'intutic')
  }
  // macOS and Linux
  return join(home, '.intutic')
}

/**
 * Returns the Intutic config directory path.
 * - macOS/Linux: ~/.intutic/
 * - Windows: %APPDATA%\intutic\
 */
export function getIntuticDir(): string {
  return getIntuticDirFor(homedir())
}

/** Path to credentials file (~/.intutic/credentials.json). */
export function getCredentialsPath(): string {
  return join(getIntuticDir(), 'credentials.json')
}

/** Path to workspace config file (~/.intutic/config.json). */
export function getConfigPath(): string {
  return join(getIntuticDir(), 'config.json')
}

/**
 * Directory the proxy writes daily-sharded trace JSONL to
 * (`~/.intutic/logs/traces-YYYY-MM-DD.jsonl`) — see
 * `packages/proxy/src/local_spend.rs`'s `log_offline_trace`.
 *
 * On Windows, the proxy's `intutic_dir()` (`packages/proxy/src/paths.rs`)
 * and this file's `getIntuticDirFor` both resolve to `%APPDATA%\intutic` —
 * reconciled (they used to disagree: the proxy fell through to
 * `%USERPROFILE%\.intutic`, silently splitting trace logs, the local spend
 * ledger, the CA cert `caTrust.ts` installs, the egress policy snapshot, and
 * bandit state across two directories nothing else on either side could see
 * into). Keep the two definitions in sync — neither imports the other, so
 * nothing but code review catches drift between them again.
 */
export function getTracesLogDir(): string {
  return join(getIntuticDir(), 'logs')
}

/**
 * Path to local integrity store (per-workspace).
 * Located at <workspaceRoot>/.intutic/integrity.json
 */
export function getIntegrityPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.intutic', 'integrity.json')
}

const LOCAL_CONTROL_PLANE_URL = 'http://localhost:3001'
const HOSTED_CONTROL_PLANE_URL = 'https://api.intutic.ai'

/**
 * The control plane `intutic login` saved with the credentials, or undefined.
 *
 * Read straight from the credentials file rather than through
 * `loadCredentials()`: only the URL is needed, it is never a secret, and this
 * keeps resolution synchronous and free of keychain access.
 */
export function storedControlPlaneUrl(): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(getCredentialsPath(), 'utf-8')) as { controlPlaneUrl?: unknown }
    return typeof creds.controlPlaneUrl === 'string' && creds.controlPlaneUrl ? creds.controlPlaneUrl : undefined
  } catch {
    return undefined
  }
}

/** Trims trailing `/` without a regex (see `commands/exec.ts` for why). */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/**
 * Resolve the control plane URL, first match wins:
 *
 * 1. a flag: `--control-plane-url` (`flagUrl`), or `--dev` (`devMode`, which
 *    some callers also set from a workspace initialised with `--dev`)
 * 2. the environment: `INTUTIC_CONTROL_PLANE_URL`, or `INTUTIC_DEV=1`
 * 3. the URL `intutic login` saved with the credentials (`useStored: false`
 *    skips it, for credentials supplied on the command line instead)
 * 4. the hosted control plane
 *
 * Every command resolves through here, so a self-hosted control plane named
 * once — at login, or in the environment — is the one every later command
 * talks to. Before, only localhost or the hosted URL were reachable, and the
 * saved URL was ignored.
 */
export function resolveControlPlaneUrl(
  devMode?: boolean,
  opts: { flagUrl?: string; useStored?: boolean } = {},
): string {
  const url =
    opts.flagUrl ||
    (devMode ? LOCAL_CONTROL_PLANE_URL : undefined) ||
    process.env.INTUTIC_CONTROL_PLANE_URL ||
    (process.env.INTUTIC_DEV === '1' ? LOCAL_CONTROL_PLANE_URL : undefined) ||
    (opts.useStored === false ? undefined : storedControlPlaneUrl()) ||
    HOSTED_CONTROL_PLANE_URL
  return trimTrailingSlashes(url)
}
