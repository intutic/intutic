/**
 * FirecrackerBackend — VM-grade isolation via a Firecracker microVM (LLD #63 §6,
 * Increment 4). Same `SandboxBackend` interface as the container backend; the
 * difference is the boundary: a separate guest kernel over KVM rather than
 * shared-kernel namespaces.
 *
 * The egress model is identical in spirit — the microVM's only route out is the
 * governing proxy — but enforced on the *host* side, by a default-deny firewall
 * on the guest's tap interface (the L2 rule shape, scoped to the guest's
 * source address). That keeps the enforcement outside the guest, where the
 * agent cannot touch it, which is stronger than the in-container firewall.
 *
 * Honesty status (see LLD #63 §7 + TECH_DEBT): the microVM *boots on real KVM*
 * — validated on a GCE nested-virt host, where Firecracker loaded and ran the
 * guest kernel through this exact config + API sequence (the launch script this
 * backend invokes). What is NOT yet validated end-to-end is an agent running to
 * completion *inside* a fully-booted guest: that needs a matched
 * kernel+rootfs pair the operator supplies (as an OCI sandbox needs an image
 * containing the agent). `health()` therefore gates on KVM + the firecracker
 * binary + the operator-supplied kernel/rootfs, and refuses rather than
 * pretend — it never falls back to a weaker backend.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { log } from '../logger.js'
import type { SandboxBackend, SandboxHealth, SandboxSpec } from './types.js'

/** Firecracker-specific inputs, beyond the generic SandboxSpec. */
export interface FirecrackerOptions {
  /** Guest kernel image (vmlinux). Operator-supplied. */
  kernelPath: string
  /** Root filesystem image (ext4). Operator-supplied, must contain the agent. */
  rootfsPath: string
  /** Host tap device name. */
  tapDevice: string
  /** Guest IP on the point-to-point tap link. */
  guestIp: string
  /** Host IP on the tap link — the address the guest reaches the proxy at. */
  hostIp: string
  /** Netmask (prefix length) for the tap link. */
  prefixLen: number
  vcpus: number
  memMib: number
}

/** The Firecracker VM configuration, as `firecracker --config-file` consumes. */
export interface FirecrackerConfig {
  'boot-source': { kernel_image_path: string; boot_args: string }
  drives: Array<{
    drive_id: string
    path_on_host: string
    is_root_device: boolean
    is_read_only: boolean
  }>
  'network-interfaces': Array<{ iface_id: string; host_dev_name: string }>
  'machine-config': { vcpu_count: number; mem_size_mib: number }
}

/**
 * Build the Firecracker VM config. Pure and exported so the exact boot config
 * — the one proven to boot a guest kernel on KVM — is asserted without a VM.
 *
 * The boot args are load-bearing: `root=/dev/vda rw` (the rootfs is the first
 * virtio-blk device) and the kernel `ip=` directive that configures the guest's
 * eth0 on the point-to-point tap link so its only reachable peer is the host.
 */
export function buildFirecrackerConfig(opts: FirecrackerOptions): FirecrackerConfig {
  const netmask = prefixToNetmask(opts.prefixLen)
  const bootArgs =
    'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ' +
    `ip=${opts.guestIp}::${opts.hostIp}:${netmask}::eth0:off`
  return {
    'boot-source': { kernel_image_path: opts.kernelPath, boot_args: bootArgs },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: opts.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    ],
    'network-interfaces': [{ iface_id: 'eth0', host_dev_name: opts.tapDevice }],
    'machine-config': { vcpu_count: opts.vcpus, mem_size_mib: opts.memMib },
  }
}

/** Dotted-quad netmask for a prefix length (IPv4). */
export function prefixToNetmask(prefix: number): string {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return [24, 16, 8, 0].map((s) => (mask >>> s) & 0xff).join('.')
}

/** Path to the validated launch script shipped with the CLI. */
function launchScriptPath(): string {
  // dist layout: dist/lib/sandbox/firecracker.js → ../../../resources/…
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../resources/sandbox/firecracker-launch.sh')
}

export class FirecrackerBackend implements SandboxBackend {
  readonly name = 'firecracker'
  private readonly opts: FirecrackerOptions
  private readonly env: Record<string, string>

  constructor(opts: FirecrackerOptions, env: Record<string, string>) {
    this.opts = opts
    this.env = env
  }

  /**
   * Available only where a microVM can actually run: KVM present, the
   * firecracker binary on PATH, and the operator's kernel + rootfs readable.
   * Any of these missing → unavailable, and the caller refuses rather than
   * downgrade (the honesty rule).
   */
  async health(): Promise<SandboxHealth> {
    if (!existsSync('/dev/kvm')) {
      return { available: false, detail: 'no /dev/kvm (needs a KVM host; nested-virt on Intel)' }
    }
    if (!existsSync(this.opts.kernelPath)) {
      return { available: false, detail: `guest kernel not found: ${this.opts.kernelPath}` }
    }
    if (!existsSync(this.opts.rootfsPath)) {
      return { available: false, detail: `guest rootfs not found: ${this.opts.rootfsPath}` }
    }
    const hasBinary = await binaryOnPath('firecracker')
    if (!hasBinary) {
      return { available: false, detail: 'firecracker binary not on PATH' }
    }
    return { available: true, detail: 'kvm + firecracker + kernel + rootfs present' }
  }

  async run(spec: SandboxSpec): Promise<number> {
    // The launch script is the artifact validated on real KVM: it sets up the
    // tap, installs the host-side default-deny egress firewall for the guest,
    // boots the microVM with the config above, runs the agent command in the
    // guest, and tears everything down. run() is a thin, faithful invoker of it
    // so the shipped boot path is exactly the proven one.
    const script = launchScriptPath()
    if (!existsSync(script)) {
      log.error(`firecracker launch script missing: ${script}`)
      return 1
    }
    const args = [
      script,
      '--kernel', this.opts.kernelPath,
      '--rootfs', this.opts.rootfsPath,
      '--tap', this.opts.tapDevice,
      '--guest-ip', this.opts.guestIp,
      '--host-ip', this.opts.hostIp,
      '--prefix', String(this.opts.prefixLen),
      '--vcpus', String(this.opts.vcpus),
      '--mem', String(this.opts.memMib),
      '--allow', spec.allowCidrs.join(','),
      '--', ...spec.command,
    ]
    return new Promise((resolve) => {
      const child = spawn('bash', args, {
        stdio: 'inherit',
        env: { ...process.env, ...this.env },
      })
      child.on('error', (err) => {
        log.error(`firecracker launch failed: ${err.message}`)
        resolve(127)
      })
      child.on('exit', (code, signal) => resolve(signal ? 128 : (code ?? 0)))
    })
  }
}

function binaryOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}
