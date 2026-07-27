/**
 * `intutic start` — run the proxy standalone.
 *
 * The open-core path: run the proxy in the foreground. No account, no control
 * plane, no configuration file — and, since the storage port, no Valkey either.
 *
 * This exists because `intutic connect` — which the docs presented as the way
 * to start Intutic — runs the sync daemon and therefore requires a control
 * plane. Open core ships none, so users following the install were asked to
 * authenticate against an account they had no way to create, and the Valkey
 * auto-provisioning sat behind that same check where they could never reach it
 * (issue #1).
 *
 * Valkey is now an optimisation rather than a prerequisite: we still try to
 * provision one, because it makes bandit state and the response cache shared
 * and durable, but failing to get one is no longer fatal. Docker missing, a
 * locked-down machine, or an image pull failure all still yield a working
 * proxy. That is the last place the documented install could dead-end.
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
import { createRequire } from 'node:module'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

/**
 * Where the proxy launcher installs the native binary.
 *
 * Version-specific: the cache used to be a single unversioned `intutic-proxy`
 * that nothing ever revalidated, so upgrading the CLI did not upgrade the
 * binary. Looking for a name that only this version writes means a stale entry
 * simply is not found, and the launcher downloads the right one.
 */
function localProxyBinary(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const candidate = node_path.join(getIntuticDir(), 'bin', `intutic-proxy-${version}${ext}`)
  return node_fs.existsSync(candidate) ? candidate : null
}

export async function runStart(opts: {
  port?: string
  valkeyPort?: string
  upstreamUrl?: string
}): Promise<void> {
  const proxyPort = opts.port ?? process.env.PORT ?? '4000'
  const valkeyPort = parseInt(opts.valkeyPort ?? '6379', 10)

  // Best-effort. A failure here downgrades what the proxy can do; it does not
  // stop it starting.
  const valkey = await ensureValkey(valkeyPort)
  if (!valkey.running) {
    log.warn('Could not start Valkey — running standalone.')
    log.info('Routing, policies, DLP and local spend caps all work.')
    log.info('Bandit learning persists to ~/.intutic; the response cache is per-process.')
    log.info('')
    log.info('To get a shared, durable cache later:')
    for (const line of valkeyRemediation(valkeyPort).split('\n')) log.info(line)
    log.info('')
  }

  // Prefer the binary the proxy launcher already downloaded; fall back to the
  // `intutic-proxy` shim on PATH, which downloads on first run.
  const binary = localProxyBinary() ?? 'intutic-proxy'

  log.info(
    valkey.running
      ? `Starting proxy on port ${proxyPort}…`
      : `Starting proxy on port ${proxyPort} (standalone)…`,
  )
  const child = spawn(binary, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: proxyPort,
      // Tell the proxy which mode it is in rather than pointing it at an
      // address we already know is dead — it skips a redundant connect and
      // logs the accurate reason.
      // CONTROL_PLANE_URL in the environment means this is a managed
      // deployment, where the proxy requires Valkey and refuses to degrade to
      // unauthenticated. Don't force standalone over the top of that — let the
      // proxy apply its own rule and say so.
      ...(valkey.running
        ? { VALKEY_URL: process.env.VALKEY_URL ?? `redis://127.0.0.1:${valkeyPort}` }
        : process.env.CONTROL_PLANE_URL
          ? {}
          : { INTUTIC_STANDALONE: '1' }),
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
