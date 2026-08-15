/**
 * `intutic enforce` — the L2 mandatory-egress firewall (LLD #63 §5).
 *
 * The proxy governs the traffic it sees, but an agent can bypass it by simply
 * not routing through it. This command closes that door: it default-denies host
 * egress to everything except the proxy, DNS, and operator-declared infra, so
 * the only path to the network is the governing proxy. That turns "please point
 * at the proxy" into "there is no other way out".
 *
 * The rule generation and application live in the `intutic-proxy` binary's
 * `enforce` subcommand (Rust, platform-aware: nftables/iptables on Linux, pf on
 * macOS). This command is a thin, discoverable wrapper that spawns it.
 *
 * - `generate` / `status` need no privilege.
 * - `apply` / `remove` change the host firewall and need root.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { log } from '../lib/logger.js'
import { resolveProxyBinary } from '../lib/proxyBinary.js'
import { writeEnforcementState } from '../lib/enforcementState.js'
import { reportDeviceState } from '../lib/deviceReport.js'
import { createRequire } from 'node:module'

const { version: cliVersion } = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface EnforceOptions {
  port?: string
  uid?: string
  allow?: string
  /** Commander maps `--no-dns` to `dns === false`; anything else leaves it true. */
  dns?: boolean
  platform?: string
}

/** Translate parsed options into the binary's `enforce` flags. */
export function enforceFlagArgs(opts: EnforceOptions): string[] {
  const args: string[] = []
  if (opts.port) args.push('--port', opts.port)
  if (opts.uid) args.push('--uid', opts.uid)
  if (opts.allow) args.push('--allow', opts.allow)
  if (opts.dns === false) args.push('--no-dns')
  if (opts.platform) args.push('--platform', opts.platform)
  return args
}

const VALID_ACTIONS = ['generate', 'apply', 'remove', 'status', 'report'] as const
type EnforceAction = (typeof VALID_ACTIONS)[number]

interface RustEnforceStatus {
  backend: string
  active: boolean
  detail: string
}

/**
 * Re-queries `enforce status` with captured stdout — `status` always prints
 * a single JSON line (`main.rs`'s `handle_enforce`), never a flag-gated
 * format, so no `--json` flag is needed. Returns `null` on any failure
 * (binary missing, unparseable output) rather than throwing — this is a
 * best-effort truthfulness step layered on top of an apply/remove that
 * already succeeded, not something that should fail the command.
 */
async function queryEnforceStatus(binary: string, flags: string[]): Promise<RustEnforceStatus | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['enforce', 'status', ...flags], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim()) as RustEnforceStatus)
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * After a successful privileged apply/remove, re-query status WHILE STILL
 * ELEVATED (this is what makes the recorded state truthful on macOS, where
 * an unprivileged `pfctl` query can't see the real rule set — see
 * enforcementState.ts's module doc), record it locally, then attempt a
 * best-effort report to the control plane. Never throws: the firewall
 * change itself already succeeded, which is what matters for this
 * command's own exit code.
 */
async function recordAndReportFirewallState(binary: string, flags: string[]): Promise<void> {
  const status = await queryEnforceStatus(binary, flags)
  if (!status) {
    log.warn('Could not re-query enforce status to record local state — the firewall change itself still applied.')
    return
  }

  await writeEnforcementState(
    {
      firewall: {
        active: status.active,
        backend: status.backend,
        detail: status.detail,
        reportedAt: new Date().toISOString(),
      },
    },
    cliVersion,
  )

  const report = await reportDeviceState()
  if (!report.reported) {
    log.dim(`  (device report not sent: ${report.reason})`)
  }
}

export async function runEnforce(action: EnforceAction, opts: EnforceOptions): Promise<void> {
  if (action === 'report') {
    const result = await reportDeviceState()
    if (result.reported) {
      log.success('Device enforcement state reported.')
    } else {
      log.warn(`Device report not sent: ${result.reason}`)
    }
    return
  }

  if (!VALID_ACTIONS.includes(action)) {
    log.error(`Unknown enforce action '${action}'. Use: ${VALID_ACTIONS.join(' | ')}`)
    process.exit(1)
  }

  const flags = enforceFlagArgs(opts)

  // apply/remove are privileged. Warn before spawning so a permission failure
  // reads as expected rather than a mystery — but still attempt, because the
  // Rust side emits the precise OS error if privilege really is missing, and
  // because inside an already-root context (a container, a root shell) there is
  // nothing to escalate.
  const isPrivileged = action === 'apply' || action === 'remove'
  if (isPrivileged && typeof process.getuid === 'function' && process.getuid() !== 0) {
    log.warn(`'intutic enforce ${action}' changes the host firewall and needs root.`)
    log.info(`If it fails with a permission error, re-run with sudo:`)
    log.info(`  sudo intutic enforce ${action}${flags.length ? ' ' + flags.join(' ') : ''}`)
  }

  const binary = resolveProxyBinary()
  await new Promise<void>((resolve) => {
    const child = spawn(binary, ['enforce', action, ...flags], { stdio: 'inherit' })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        log.error('Could not find the intutic-proxy binary.')
        log.info('Install it with: npm install -g @intutic/proxy')
      } else {
        log.error(`enforce failed: ${err.message}`)
      }
      process.exit(1)
    })
    child.on('exit', async (code) => {
      process.exitCode = code ?? 0
      // Awaited, not detached: a fully async fire-and-forget risks the
      // process exiting before the POST lands, since nothing else keeps the
      // event loop alive once this resolves. `recordAndReportFirewallState`
      // never throws, so this can't turn a successful firewall change into
      // a failed command — it can only add a brief, bounded delay.
      if (isPrivileged && code === 0) {
        await recordAndReportFirewallState(binary, flags)
      }
      resolve()
    })
  })
}
