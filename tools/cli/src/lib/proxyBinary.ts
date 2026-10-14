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
import * as node_os from 'node:os'
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

/**
 * What to add to a spawned proxy's environment so an `intutic exec --sandbox`
 * container can reach it. The proxy listens on loopback unless
 * `INTUTIC_PROXY_BIND` says otherwise. A container reaches it as
 * `host.docker.internal`: Docker Desktop delivers that from the host's
 * loopback, but Docker on Linux delivers it on the `docker0` bridge. So on
 * Linux this adds the bridge's address, which this host's containers reach and
 * the network does not. An `INTUTIC_PROXY_BIND` already set is left alone.
 */
export function sandboxBindEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  interfaces: NodeJS.Dict<node_os.NetworkInterfaceInfo[]> = node_os.networkInterfaces(),
): Record<string, string> {
  if (env.INTUTIC_PROXY_BIND?.trim() || platform !== 'linux') return {}
  const bridge = interfaces.docker0?.find((a) => a.family === 'IPv4' && !a.internal)
  return bridge ? { INTUTIC_PROXY_BIND: `127.0.0.1,${bridge.address}` } : {}
}
