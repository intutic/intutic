import { describe, it, expect } from 'vitest'
import { enforceFlagArgs } from './enforce.js'

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
