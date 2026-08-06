/**
 * Valkey provisioning.
 *
 * The proxy needs a Valkey (or Redis) on 6379 — the WASM registry, telemetry,
 * metering, semantic cache and bandit router all hold a connection. Rather than
 * making that the user's problem, try in order:
 *
 *   1. Already listening      — use it
 *   2. Docker available       — run/start an `intutic-valkey` container
 *   3. Binary on PATH         — spawn `valkey-server`, else `redis-server`
 *   4. Otherwise              — report what was tried
 *
 * This logic previously lived inline in `runConnect`, *after* its credential
 * check — so it never ran for open-core users, who have no control plane to
 * authenticate against and were left to install Valkey by hand (issue #1).
 * Extracted here so the standalone path can use it too.
 *
 * @module
 */

import { execSync, spawn } from 'node:child_process'
import * as node_net from 'node:net'
import { log } from './logger.js'

/** TCP-probe the port. Cheap, and works regardless of how Valkey was started. */
export function isValkeyRunning(port = 6379, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new node_net.Socket()
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/** Poll until the port answers or the budget runs out. */
async function waitForValkey(port: number, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isValkeyRunning(port)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function commandExists(cmd: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface EnsureValkeyResult {
  running: boolean
  /** How it was satisfied, for logging and for tests to assert against. */
  via: 'existing' | 'docker' | 'native' | 'none'
}

/**
 * Make a Valkey available on `port`, or explain why not.
 *
 * Never throws: a caller that can degrade should be free to continue. The proxy
 * cannot, so it reports the failure itself with its own remediation text.
 */
export async function ensureValkey(port = 6379): Promise<EnsureValkeyResult> {
  if (await isValkeyRunning(port)) {
    return { running: true, via: 'existing' }
  }

  log.info(`No Valkey detected on port ${port}. Trying to start one…`)

  // ── Docker ────────────────────────────────────────────────────────────────
  // `docker info` rather than `docker --version`: the daemon has to be running,
  // not merely installed.
  if (commandExists('docker')) {
    let daemonUp = false
    try {
      execSync('docker info', { stdio: 'ignore' })
      daemonUp = true
    } catch {
      log.info('Docker is installed but its daemon is not running — skipping.')
    }

    if (daemonUp) {
      try {
        const existing = execSync(
          'docker ps -a --filter name=^/intutic-valkey$ --format "{{.Names}}"',
          { encoding: 'utf8' },
        ).trim()

        if (existing === 'intutic-valkey') {
          log.info('Starting existing intutic-valkey container…')
          execSync('docker start intutic-valkey', { stdio: 'ignore' })
        } else {
          log.info('Docker detected — starting a Valkey container (intutic-valkey)…')
          execSync(
            `docker run -d --name intutic-valkey -p ${port}:6379 valkey/valkey:8-alpine`,
            { stdio: 'ignore' },
          )
        }

        if (await waitForValkey(port)) {
          log.success(`Valkey running in Docker (intutic-valkey) on port ${port}.`)
          return { running: true, via: 'docker' }
        }
        log.warn('Started the container but nothing answered on the port.')
      } catch (err) {
        log.warn(
          `Could not start Valkey via Docker: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  // ── Native binary ─────────────────────────────────────────────────────────
  // Redis is wire-compatible for everything the proxy uses, so it is a fine
  // substitute and far more likely to already be installed.
  const nativeCmd = commandExists('valkey-server')
    ? 'valkey-server'
    : commandExists('redis-server')
      ? 'redis-server'
      : null

  if (nativeCmd) {
    log.info(`Found ${nativeCmd} on PATH — starting it in the background…`)
    try {
      // --daemonize is unavailable on Windows builds; detach instead.
      const args =
        process.platform === 'win32'
          ? ['--port', String(port)]
          : ['--port', String(port), '--daemonize', 'yes']
      const proc = spawn(nativeCmd, args, { stdio: 'ignore', detached: true })
      proc.unref()

      if (await waitForValkey(port)) {
        log.success(`Valkey running via ${nativeCmd} on port ${port}.`)
        return { running: true, via: 'native' }
      }
      log.warn(`Spawned ${nativeCmd} but nothing answered on the port.`)
    } catch (err) {
      log.warn(`Could not spawn ${nativeCmd}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { running: false, via: 'none' }
}

/** Remediation text shared by every caller, so the advice cannot drift. */
export function valkeyRemediation(port = 6379): string {
  return (
    `Intutic needs a Valkey (or Redis) on port ${port}.\n\n` +
    `  Docker:   docker run -d --name intutic-valkey -p ${port}:6379 valkey/valkey:8-alpine\n` +
    `  macOS:    brew install valkey && valkey-server --port ${port} --daemonize yes\n` +
    `  Debian:   sudo apt-get install -y redis-server && redis-server --port ${port} --daemonize yes\n\n` +
    `Already have one elsewhere? Point at it with VALKEY_URL=redis://host:port.`
  )
}
