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

const VALID_ACTIONS = ['generate', 'apply', 'remove', 'status'] as const
type EnforceAction = (typeof VALID_ACTIONS)[number]

export async function runEnforce(action: EnforceAction, opts: EnforceOptions): Promise<void> {
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
    child.on('exit', (code) => {
      process.exitCode = code ?? 0
      resolve()
    })
  })
}
