import { describe, it, expect } from 'vitest'
import { enforceFlagArgs, invalidAllowEntries } from './enforce.js'

describe('enforceFlagArgs', () => {
  it('passes through port, uid, allow and platform', () => {
    expect(
      enforceFlagArgs({ port: '4000', uid: '1000', allow: '10.0.0.0/8,192.168.0.0/16', platform: 'linux' }),
    ).toEqual([
      '--port', '4000',
      '--uid', '1000',
      '--allow', '10.0.0.0/8,192.168.0.0/16',
      '--platform', 'linux',
    ])
  })

  it('emits nothing for an empty option set', () => {
    expect(enforceFlagArgs({})).toEqual([])
  })

  it('only emits --no-dns when dns is explicitly false (commander --no-dns)', () => {
    // default (dns omitted / true) → DNS stays allowed, no flag
    expect(enforceFlagArgs({ dns: true })).toEqual([])
    expect(enforceFlagArgs({})).toEqual([])
    // --no-dns passed → dns === false → deny DNS
    expect(enforceFlagArgs({ dns: false })).toEqual(['--no-dns'])
  })
})

describe('invalidAllowEntries', () => {
  it('accepts IPv4 and IPv6 addresses and CIDR blocks', () => {
    expect(invalidAllowEntries('10.0.0.0/8, 192.168.1.10,fd00::/8,2001:db8::1,0.0.0.0/0')).toEqual([])
  })

  it('names a hostname, which the firewall cannot hold', () => {
    expect(invalidAllowEntries('10.0.0.0/8,registry.internal.corp')).toEqual(['registry.internal.corp'])
  })

  it('rejects out-of-range or malformed prefixes', () => {
    expect(invalidAllowEntries('10.0.0.0/33,fd00::/129,10.0.0.0/x,10.0.0.0/8/9')).toEqual([
      '10.0.0.0/33',
      'fd00::/129',
      '10.0.0.0/x',
      '10.0.0.0/8/9',
    ])
  })

  it('ignores empty entries, as the binary does', () => {
    expect(invalidAllowEntries('10.0.0.0/8,,')).toEqual([])
  })
})
