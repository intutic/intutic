/**
 * `intutic disconnect` on Linux takes out the CA copy `intutic connect`
 * installed in the system store: itself when it runs as root, as connect
 * installed it, and otherwise by printing the exact sudo commands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DisconnectPlan } from '@intutic/sync-daemon'

const { removalMock, removeMock } = vi.hoisted(() => ({ removalMock: vi.fn(), removeMock: vi.fn() }))
vi.mock('../lib/caTrust.js', () => ({
  linuxConnectCaRemoval: removalMock,
  removeLinuxConnectCaTrust: removeMock,
}))

import { planCaTrust } from './disconnect.js'

const REMOVAL = {
  dest: '/usr/local/share/ca-certificates/intutic-connect-ca.crt',
  update: { step: 'Rebuild the system CA bundle (Debian/Ubuntu)', cmd: 'update-ca-certificates', args: ['--fresh'] },
  commands: ['sudo rm /usr/local/share/ca-certificates/intutic-connect-ca.crt', 'sudo update-ca-certificates --fresh'],
}

describe('disconnect: the CA connect trusted on Linux', () => {
  const originalPlatform = process.platform
  const originalGetuid = process.getuid

  beforeEach(() => {
    removalMock.mockReset()
    removeMock.mockReset()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    process.getuid = originalGetuid
  })

  it('as root: removes connect\'s copy and rebuilds the bundle', async () => {
    removalMock.mockResolvedValue(REMOVAL)
    process.getuid = () => 0
    const plan = new DisconnectPlan()
    await planCaTrust(plan)
    expect(plan.changes.map((c) => c.path)).toEqual([REMOVAL.dest])
    expect(plan.notes).toEqual([])
    await plan.changes[0].apply()
    expect(removeMock).toHaveBeenCalledWith(REMOVAL)
  })

  it('without root: changes nothing and prints the exact sudo commands', async () => {
    removalMock.mockResolvedValue(REMOVAL)
    process.getuid = () => 1000
    const plan = new DisconnectPlan()
    await planCaTrust(plan)
    expect(plan.changes).toEqual([])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].message).toContain(
      'sudo rm /usr/local/share/ca-certificates/intutic-connect-ca.crt && sudo update-ca-certificates --fresh',
    )
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('no copy of connect\'s: nothing to do', async () => {
    removalMock.mockResolvedValue(null)
    process.getuid = () => 0
    const plan = new DisconnectPlan()
    await planCaTrust(plan)
    expect(plan.changes).toEqual([])
    expect(plan.notes).toEqual([])
  })
})
