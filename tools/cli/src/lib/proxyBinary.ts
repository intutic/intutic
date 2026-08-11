/**
 * Resolve the `intutic-proxy` native binary path.
 *
 * The proxy launcher installs a version-pinned binary under
 * `~/.intutic/bin/intutic-proxy-<version>`; if that is absent we fall back to
 * `intutic-proxy` on PATH (the shim that downloads on first run). Shared by
 * `intutic start` and `intutic enforce`, both of which spawn the binary.
 *
 * @module
 */

import * as node_path from 'node:path'
import * as node_fs from 'node:fs'
import { createRequire } from 'node:module'
import { getIntuticDir } from '../config/paths.js'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

/**
 * The version-pinned binary if present, else null. Version-specific on purpose:
 * a stale unversioned binary from an older CLI simply is not found, so the
 * launcher downloads the right one.
 */
export function localProxyBinary(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const candidate = node_path.join(getIntuticDir(), 'bin', `intutic-proxy-${version}${ext}`)
  return node_fs.existsSync(candidate) ? candidate : null
}

/** The binary to spawn: the pinned one, or the PATH shim as a fallback. */
export function resolveProxyBinary(): string {
  return localProxyBinary() ?? 'intutic-proxy'
}
