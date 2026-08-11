/**
 * Sandbox runtime abstraction (LLD #63 §6).
 *
 * A `SandboxBackend` launches an agent command inside an isolated runtime whose
 * *only* egress is the governing proxy — unifying "isolate the process" with
 * "force traffic through governance". The container backend ships today; the
 * Firecracker microVM backend implements the same interface (Increment 4).
 *
 * @module
 */

/** What to run, and the isolation envelope to run it in. */
export interface SandboxSpec {
  /** The agent command + args, e.g. ['claude'] or ['python', 'agent.py']. */
  command: string[]
  /** Host directory bind-mounted read-write at /work (the project). */
  workdir: string
  /** Container image. Must contain the agent + nftables + capsh. */
  image: string
  /**
   * Environment for the sandboxed process, by name. Values are read from the
   * launcher's own environment at spawn time and referenced by name on the
   * command line, so secrets (API keys) never appear in argv / `docker inspect`.
   */
  envKeys: string[]
  /** Hostname the sandbox reaches the proxy at (mapped to the host gateway). */
  proxyHostAlias: string
  /** Extra destination CIDRs the sandbox may reach, beyond the proxy + DNS. */
  allowCidrs: string[]
  /** Hard resource caps. */
  memory: string
  cpus: string
  pidsLimit: number
  /** Allocate a TTY (interactive agents). */
  tty: boolean
}

/** Health of a backend on this host. */
export interface SandboxHealth {
  available: boolean
  detail: string
}

export interface SandboxBackend {
  readonly name: string
  /** Whether this backend can run here (e.g. docker reachable, KVM present). */
  health(): Promise<SandboxHealth>
  /** Launch the spec; resolves with the process exit code. */
  run(spec: SandboxSpec): Promise<number>
}
