/**
 * OciBackend — a genuinely-isolating container sandbox (LLD #63 §6).
 *
 * The isolation envelope, and why each piece is here:
 *   --cap-drop=ALL                 start from zero capabilities
 *   --cap-add NET_ADMIN,NET_RAW    the entrypoint needs them to install nft…
 *   --cap-add SETPCAP,SETUID,SETGID …and to drop those + switch user, after
 *                                  which the agent runs with an EMPTY cap set
 *   --security-opt no-new-privileges  no setuid-root escalation
 *   --read-only + tmpfs            immutable rootfs; scratch space in tmpfs
 *   --pids-limit/--memory/--cpus   fork-bomb / resource-exhaustion bounds
 *   --add-host host.docker.internal:host-gateway  reach the proxy on the host
 *   -v <workdir>:/work             the project, the one writable mount
 *
 * The entrypoint (resources/sandbox/entrypoint.sh) then default-denies egress
 * to everything except the proxy + DNS and drops privilege, so the agent cannot
 * reach the network except through governance and cannot undo the firewall.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { log } from '../logger.js'
import type { SandboxBackend, SandboxHealth, SandboxSpec } from './types.js'

export type OciRuntime = 'docker' | 'podman'

/**
 * Build the container runtime argv for a spec. Pure and exported so the
 * envelope can be asserted without launching anything — the isolation flags are
 * security-load-bearing and must not silently drift.
 */
export function buildOciArgs(runtime: OciRuntime, spec: SandboxSpec): string[] {
  const args: string[] = ['run', '--rm']
  // -i always (pipe stdin); -t only when we have a real terminal.
  args.push(spec.tty ? '-it' : '-i')

  // Capability envelope: drop everything, add back only what the entrypoint
  // needs to install the firewall and drop privilege.
  args.push('--cap-drop=ALL')
  for (const cap of ['NET_ADMIN', 'NET_RAW', 'SETPCAP', 'SETUID', 'SETGID']) {
    args.push(`--cap-add=${cap}`)
  }
  args.push('--security-opt=no-new-privileges')

  // Immutable rootfs with writable scratch.
  args.push('--read-only')
  for (const t of ['/tmp', '/run', '/home/sandbox']) args.push('--tmpfs', t)

  // Resource bounds.
  args.push(`--pids-limit=${spec.pidsLimit}`)
  args.push(`--memory=${spec.memory}`)
  args.push(`--cpus=${spec.cpus}`)

  // Reach the proxy on the host.
  args.push(`--add-host=${spec.proxyHostAlias}:host-gateway`)

  // The project, read-write; nothing else from the host.
  args.push('-v', `${spec.workdir}:/work`, '-w', '/work')

  // Env by name — values come from the launcher's environment at spawn time, so
  // secrets never land in argv.
  for (const key of spec.envKeys) args.push('--env', key)

  args.push(spec.image)
  // The entrypoint consumes a leading `--` then execs the rest.
  args.push('--', ...spec.command)
  return args
}

export class OciBackend implements SandboxBackend {
  readonly name: string
  private readonly runtime: OciRuntime
  /** Env values to hand the runtime process (referenced by name in argv). */
  private readonly env: Record<string, string>

  constructor(runtime: OciRuntime, env: Record<string, string>) {
    this.runtime = runtime
    this.name = runtime
    this.env = env
  }

  async health(): Promise<SandboxHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.runtime, ['info', '--format', '{{.ServerVersion}}'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      child.on('error', () =>
        resolve({ available: false, detail: `${this.runtime} not found on PATH` }),
      )
      child.on('exit', (code) =>
        code === 0
          ? resolve({ available: true, detail: `${this.runtime} daemon reachable` })
          : resolve({ available: false, detail: `${this.runtime} daemon not reachable` }),
      )
    })
  }

  async run(spec: SandboxSpec): Promise<number> {
    const args = buildOciArgs(this.runtime, spec)
    log.dim(`sandbox: ${this.runtime} ${args.slice(0, 12).join(' ')} …`)
    return new Promise((resolve) => {
      const child = spawn(this.runtime, args, {
        stdio: 'inherit',
        // Values for the `--env NAME` references live here, not in argv.
        env: { ...process.env, ...this.env },
      })
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          log.error(`Sandbox runtime '${this.runtime}' not found. Install Docker or Podman.`)
        } else {
          log.error(`Sandbox failed to start: ${err.message}`)
        }
        resolve(127)
      })
      child.on('exit', (code, signal) => {
        if (signal) resolve(128)
        else resolve(code ?? 0)
      })
    })
  }
}
