import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
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
