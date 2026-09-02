/**
 * Cross-platform path resolution for Intutic CLI config.
 *
 * - macOS/Linux: ~/.intutic/
 * - Windows: %APPDATA%\intutic\
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

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

/**
 * Resolve the control plane URL.
 * If --dev flag or INTUTIC_DEV=1 env var, use localhost:3001.
 */
export function resolveControlPlaneUrl(devMode?: boolean): string {
  const isDev = devMode || process.env.INTUTIC_DEV === '1'
  return isDev
    ? 'http://localhost:3001'
    : 'https://api.intutic.ai'
}
