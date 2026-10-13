import { describe, it, expect } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { sandboxBindEnv } from './proxyBinary.js'

const docker0: NetworkInterfaceInfo[] = [
  { address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:00:00:00:00', internal: false, cidr: '172.17.0.1/16' },
]

describe('sandboxBindEnv', () => {
  it('adds the docker0 bridge on Linux, so a sandbox reaches a loopback proxy', () => {
    expect(sandboxBindEnv({}, 'linux', { docker0 })).toEqual({ INTUTIC_PROXY_BIND: '127.0.0.1,172.17.0.1' })
  })

  it('adds nothing on Linux without Docker', () => {
    expect(sandboxBindEnv({}, 'linux', { lo: [] })).toEqual({})
  })

  it('adds nothing where Docker Desktop delivers from loopback', () => {
    expect(sandboxBindEnv({}, 'darwin', { docker0 })).toEqual({})
    expect(sandboxBindEnv({}, 'win32', { docker0 })).toEqual({})
  })

  it('leaves a bind the operator set alone', () => {
    expect(sandboxBindEnv({ INTUTIC_PROXY_BIND: '0.0.0.0' }, 'linux', { docker0 })).toEqual({})
  })
})
