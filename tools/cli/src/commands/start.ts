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
 * Gates. With no login, and the local gates installed (`intutic gates
 * install`), the gates, rules files and policy snapshot are refreshed before
 * the proxy starts, and again whenever `.intutic/sops` changes while it runs.
 * The refresh never writes routing: whether the harnesses go through the
 * proxy is decided by `gates install --route`, not by starting it. With the
 * gates not installed, one line names the recorded harnesses that have none.
 * `--no-gates` skips both.
 *
 * Decide. When the policy snapshot carries decide rules and a decide engine
 * is configured, start warms the engine's model (Ollama's `keep_alive`) and
 * runs the known-answer canary, storing its result where the gates read it.
 * Both run beside the proxy's start-up: each result is reported, and none
 * stops or delays the proxy.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { watch } from 'chokidar'
import { gateKindForHarness, type HarnessType } from '@intutic/shared-types'
import { findGateFile, pruneDecideLogs } from '@intutic/sync-daemon'
import { log } from '../lib/logger.js'
import { loadConfig, loadCredentials } from '../config/store.js'
import { installLocalGates, localGatesInstalled } from '../lib/localGates.js'
import { ensureValkey, valkeyRemediation } from '../lib/ensureValkey.js'
import { localProxyBinary, sandboxBindEnv } from '../lib/proxyBinary.js'
import { localProxyPort } from '../lib/localProxy.js'

/** How long `.intutic/sops` must be quiet before the gates are refreshed. */
const SOPS_DEBOUNCE_MS = 500

/**
 * Refreshes the local gates, or says which recorded harnesses have none.
 * Returns a stop function for the `.intutic/sops` watcher, or null when there
 * is nothing to watch: a login (connect owns the gates), no `intutic init`,
 * or local gates not installed.
 */
async function prepareLocalGates(): Promise<(() => Promise<void>) | null> {
  if ((await loadCredentials()) !== null) return null
  const config = loadConfig()
  if (!config) return null
  const root = config.workspaceRoot
  const disconnected = new Set<string>(config.disconnectedHarnesses ?? [])
  const harnesses = config.harnesses.filter((h) => !disconnected.has(h))

  if (!(await localGatesInstalled())) {
    const ungated: string[] = []
    for (const h of harnesses) {
      if (gateKindForHarness(h as HarnessType) === 'hook' && (await findGateFile(h, root, homedir())) === null) ungated.push(h)
    }
    if (ungated.length > 0) log.info(`No tool-call gate for ${ungated.join(', ')}: install them with \`intutic gates install\`.`)
    return null
  }

  const refresh = async (why: string): Promise<void> => {
    try {
      const result = await installLocalGates({ workspaceRoot: root, harnesses, routing: false, warn: (line) => log.warn(line) })
      log.info(`Local gates ${why} (${result.snapshot.ruleCount} snapshot rules, ${result.gates.length} harness(es)).`)
      // Decide logs past their 30 days go with each refresh; never throws.
      await pruneDecideLogs()
    } catch (err) {
      log.warn(`Could not refresh the local gates: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await refresh('refreshed')

  let timer: NodeJS.Timeout | null = null
  let running: Promise<void> = Promise.resolve()
  const watcher = watch(join(root, '.intutic', 'sops'), { ignoreInitial: true })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      running = running.then(() => refresh('refreshed after an .intutic/sops change'))
    }, SOPS_DEBOUNCE_MS)
  })
  watcher.on('error', (err) => log.warn(`Stopped watching .intutic/sops: ${err instanceof Error ? err.message : String(err)}`))
  return async () => {
    if (timer) clearTimeout(timer)
    await watcher.close()
  }
}

/**
 * Warms the decide engine and runs its canary in the background
 * (`decideStartChecks`), reporting each line. Never throws, never waited on.
 */
function startDecideEngine(): void {
  void (async () => {
    try {
      const { decideStartChecks } = await import('./decide.js')
      for (const c of await decideStartChecks()) {
        if (c.passed) log.info(`${c.name}: ${c.detail}`)
        else log.warn(`${c.name}: ${c.detail}${c.remediation ? ` ${c.remediation}` : ''}`)
      }
    } catch (err) {
      log.warn(`Could not check the decide engine: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

export async function runStart(opts: {
  port?: string
  valkeyPort?: string
  upstreamUrl?: string
  /** False with `--no-gates`. */
  gates?: boolean
}): Promise<void> {
  // The port every other command probes (`localProxyPort`), unless --port
  // says otherwise; never the shell's PORT, which usually belongs to some
  // other dev server.
  const proxyPort = opts.port ?? String(localProxyPort())
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

  const stopWatching = opts.gates === false ? null : await prepareLocalGates()
  // After the gates' refresh, so it reads the snapshot they now enforce.
  startDecideEngine()

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
      ...sandboxBindEnv(),
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

  child.on('exit', (code) => {
    void (stopWatching?.() ?? Promise.resolve()).finally(() => process.exit(code ?? 0))
  })
}
