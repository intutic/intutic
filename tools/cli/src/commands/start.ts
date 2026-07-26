/**
 * `intutic start` — run the proxy standalone.
 *
 * The open-core path: ensure Valkey is up, then run the proxy in the
 * foreground. No account, no control plane, no configuration file.
 *
 * This exists because `intutic connect` — which the docs presented as the way
 * to start Intutic — runs the sync daemon and therefore requires a control
 * plane. Open core ships none, so users following the install were asked to
 * authenticate against an account they had no way to create, and the Valkey
 * auto-provisioning sat behind that same check where they could never reach it
 * (issue #1).
 *
 * `connect` is unchanged and still correct for Cloud and self-hosted control
 * planes.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import * as node_path from 'node:path'
import * as node_fs from 'node:fs'
import { log } from '../lib/logger.js'
import { ensureValkey, valkeyRemediation } from '../lib/ensureValkey.js'
import { getIntuticDir } from '../config/paths.js'

/** Where the proxy launcher installs the native binary. */
function localProxyBinary(): string | null {
  const name = process.platform === 'win32' ? 'intutic-proxy.exe' : 'intutic-proxy'
  const candidate = node_path.join(getIntuticDir(), 'bin', name)
  return node_fs.existsSync(candidate) ? candidate : null
}

export async function runStart(opts: {
  port?: string
  valkeyPort?: string
  upstreamUrl?: string
}): Promise<void> {
  const proxyPort = opts.port ?? process.env.PORT ?? '4000'
  const valkeyPort = parseInt(opts.valkeyPort ?? '6379', 10)

  const valkey = await ensureValkey(valkeyPort)
  if (!valkey.running) {
    log.error('Could not start Valkey, and the proxy cannot run without one.')
    log.info('')
    for (const line of valkeyRemediation(valkeyPort).split('\n')) log.info(line)
    process.exit(1)
  }

  // Prefer the binary the proxy launcher already downloaded; fall back to the
  // `intutic-proxy` shim on PATH, which downloads on first run.
  const binary = localProxyBinary() ?? 'intutic-proxy'

  log.info(`Starting proxy on port ${proxyPort}…`)
  const child = spawn(binary, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: proxyPort,
      VALKEY_URL: process.env.VALKEY_URL ?? `redis://127.0.0.1:${valkeyPort}`,
      ...(opts.upstreamUrl ? { UPSTREAM_URL: opts.upstreamUrl } : {}),
    },
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      log.error('Could not find the intutic-proxy binary.')
      log.info('Install it with: npm install -g @intutic/proxy')
    } else {
      log.error(`Failed to start the proxy: ${err.message}`)
    }
    process.exit(1)
  })

  // Forward signals so Ctrl-C stops the proxy rather than orphaning it.
  const stop = () => {
    child.kill('SIGTERM')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  child.on('exit', (code) => process.exit(code ?? 0))
}
