import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildFirecrackerConfig, prefixToNetmask, FirecrackerBackend } from './firecracker.js'
import type { FirecrackerOptions } from './firecracker.js'

function opts(over: Partial<FirecrackerOptions> = {}): FirecrackerOptions {
  return {
    kernelPath: '/img/vmlinux.bin',
    rootfsPath: '/img/rootfs.ext4',
    tapDevice: 'tap-intutic',
    guestIp: '172.16.0.2',
    hostIp: '172.16.0.1',
    prefixLen: 30,
    vcpus: 1,
    memMib: 512,
    ...over,
  }
}

describe('prefixToNetmask', () => {
  it('renders IPv4 prefixes', () => {
    expect(prefixToNetmask(30)).toBe('255.255.255.252')
    expect(prefixToNetmask(24)).toBe('255.255.255.0')
    expect(prefixToNetmask(0)).toBe('0.0.0.0')
    expect(prefixToNetmask(32)).toBe('255.255.255.255')
  })
})

describe('buildFirecrackerConfig', () => {
  it('produces the boot config proven to boot a guest kernel on KVM', () => {
    const c = buildFirecrackerConfig(opts())
    expect(c['boot-source'].kernel_image_path).toBe('/img/vmlinux.bin')
    // The load-bearing boot args: root device + guest network on the tap link.
    expect(c['boot-source'].boot_args).toContain('root=/dev/vda rw')
    expect(c['boot-source'].boot_args).toContain('ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off')
    // rootfs is the root virtio-blk device, writable
    expect(c.drives).toEqual([
      { drive_id: 'rootfs', path_on_host: '/img/rootfs.ext4', is_root_device: true, is_read_only: false },
    ])
    // one tap-backed interface
    expect(c['network-interfaces']).toEqual([{ iface_id: 'eth0', host_dev_name: 'tap-intutic' }])
    expect(c['machine-config']).toEqual({ vcpu_count: 1, mem_size_mib: 512 })
  })
})

describe('FirecrackerBackend.health', () => {
  it('refuses (never simulates) when KVM is absent — the honesty rule', async () => {
    // On a machine without /dev/kvm (CI, macOS dev), health must report
    // unavailable so the caller stops rather than downgrade.
    const be = new FirecrackerBackend(opts(), {})
    const h = await be.health()
    if (!existsSync('/dev/kvm')) {
      expect(h.available).toBe(false)
      expect(h.detail).toMatch(/kvm|kernel|rootfs|firecracker/i)
    }
  })
})

describe('firecracker-launch.sh', () => {
  const script = resolve(__dirname, '../../../resources/sandbox/firecracker-launch.sh')

  /** Runs the script with a `sudo` that records its calls instead of running them. */
  // Async spawn, not spawnSync: a blocking child starves Vitest's worker RPC.
  async function launch(env: Record<string, string>): Promise<{ status: number | null; stderr: string; sudoCalls: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'intutic-fc-launch-'))
    try {
      const log = join(dir, 'sudo.log')
      writeFileSync(log, '')
      writeFileSync(join(dir, 'sudo'), `#!/bin/sh\necho "$*" >> "${log}"\n`)
      chmodSync(join(dir, 'sudo'), 0o755)
      const child = spawn('bash', [script, '--kernel', '/img/vmlinux', '--rootfs', '/img/rootfs.ext4', '--', 'true'], {
        env: { PATH: `${dir}:${process.env.PATH}`, ...env },
      })
      let stderr = ''
      child.stderr.on('data', (d) => (stderr += String(d)))
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      const status = await new Promise<number | null>((done) => child.on('close', (code) => done(code)))
      clearTimeout(timer)
      return { status, stderr, sudoCalls: readFileSync(log, 'utf-8') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('fails, before touching the host, when INTUTIC_FC_GUEST_KEY is unset', async () => {
    const res = await launch({})
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('INTUTIC_FC_GUEST_KEY is not set')
    expect(res.sudoCalls).toBe('')
  })

  it('fails when INTUTIC_FC_GUEST_KEY names no readable file', async () => {
    const res = await launch({ INTUTIC_FC_GUEST_KEY: '/nonexistent/guest-key' })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('not a readable file')
    expect(res.sudoCalls).toBe('')
  })
})
