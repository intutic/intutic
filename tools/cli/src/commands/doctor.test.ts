import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type AddressInfo } from 'node:net'
import { describePolicySnapshot, checkCiscoScanner, checkControlPlane, checkValkey, linuxCaTrustInstalled, runDoctor } from './doctor.js'
import { loadConfig, loadCredentials } from '../config/store.js'
import { writeLocalPolicySnapshot } from '@intutic/sync-daemon'

vi.mock('../config/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/store.js')>()),
  loadCredentials: vi.fn(),
  loadConfig: vi.fn(),
}))
import type { PolicySnapshotHealth, SnapshotState } from '../lib/policySnapshot.js'
import { CISCO_SCANNER_BINARY } from '../lib/ciscoScanner.js'

function health(over: Partial<PolicySnapshotHealth> = {}): PolicySnapshotHealth {
  return {
    state: 'ok',
    digest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    workspaceId: 'wk_alpha',
    generatedAt: new Date().toISOString(),
    ageDays: 0,
    ruleCount: 9,
    droppedRules: 0,
    formatVersion: 1,
    decideRules: 0,
    path: '/home/dev/.intutic/hooks/policy-snapshot.rules',
    ...over,
  }
}

describe('describePolicySnapshot', () => {
  it('passes only on ok, and reports the digest and count', () => {
    const result = describePolicySnapshot(health())
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('9 rule(s)')
    expect(result.detail).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(result.remediation).toBeUndefined()
  })

  // Absent, invalid and empty are three different causes of one outcome: the
  // gates enforce the compiled floor and the workspace's own policy applies
  // nowhere. Each has to be told apart, because each has a different fix.
  const failing: SnapshotState[] = ['absent', 'invalid', 'empty', 'stale']
  it.each(failing)('fails and offers a remediation for %s', (state) => {
    const result = describePolicySnapshot(health({ state }))
    expect(result.passed).toBe(false)
    expect(result.remediation).toBeTruthy()
  })

  it('gives each failing state a distinct detail line', () => {
    const details = failing.map((state) => describePolicySnapshot(health({ state })).detail)
    expect(new Set(details).size).toBe(failing.length)
  })

  it('names the path when the snapshot is absent', () => {
    const result = describePolicySnapshot(health({ state: 'absent', ruleCount: 0 }))
    expect(result.detail).toContain('/home/dev/.intutic/hooks/policy-snapshot.rules')
    expect(result.remediation).toContain('intutic policy snapshot')
  })

  it('points an open-core machine at `intutic gates install` for every failing state', () => {
    for (const state of failing) {
      const result = describePolicySnapshot(health({ state, ruleCount: 0 }), { local: true })
      expect(result.remediation, state).toContain('intutic gates install')
      expect(result.remediation, state).not.toMatch(/intutic (policy snapshot|connect|daemon status)/)
    }
  })

  it('says the dynamic rules were dropped when the snapshot is invalid', () => {
    const result = describePolicySnapshot(health({ state: 'invalid', ruleCount: 0 }))
    expect(result.detail).toContain('DROPPED')
    expect(result.detail).toContain('digest or workspace')
  })

  it('blames only the digest when an invalid snapshot carries no workspace id', () => {
    // Nothing compared a workspace id, so naming it as a possible cause would
    // send the reader looking for a mismatch that was never tested.
    const result = describePolicySnapshot(health({ state: 'invalid', workspaceId: '', ruleCount: 0 }))
    expect(result.detail).toContain('Failed its digest check')
    expect(result.detail).not.toContain('digest or workspace')
  })

  it('reports a stale snapshot as still enforcing, with its age', () => {
    const result = describePolicySnapshot(health({ state: 'stale', ageDays: 31 }))
    expect(result.detail).toContain('31 days old')
    expect(result.detail).toContain('still enforced')
    expect(result.detail).toContain('9 rule(s)')
  })

  it('counts decide rules on their own, since their fallback lines are not in the rule count', () => {
    expect(describePolicySnapshot(health({ ruleCount: 8, decideRules: 1 })).detail).toContain('8 rule(s) and 1 decide rule(s),')
    expect(describePolicySnapshot(health({ state: 'stale', ageDays: 31, ruleCount: 8, decideRules: 2 })).detail).toContain('(8 rule(s) and 2 decide rule(s))')
    expect(describePolicySnapshot(health()).detail).not.toContain('decide')
  })

  it('surfaces uncompilable rules alongside an otherwise healthy snapshot', () => {
    const result = describePolicySnapshot(health({ droppedRules: 2 }))
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('2 rule(s) dropped as uncompilable')
  })

  it('does not mention dropped rules when there are none', () => {
    expect(describePolicySnapshot(health()).detail).not.toContain('dropped')
  })
})

describe('checkCiscoScanner', () => {
  let binDir: string
  let originalPath: string | undefined

  beforeEach(async () => {
    binDir = await fs.mkdtemp(join(tmpdir(), 'intutic-cisco-doctor-'))
    const script = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('skill-scanner-fixture, version 0.3.3-test\\n')
  process.exit(0)
}
process.exit(1)
`
    await fs.writeFile(join(binDir, CISCO_SCANNER_BINARY), script, { mode: 0o755 })
    originalPath = process.env.PATH
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    await fs.rm(binDir, { recursive: true, force: true })
  })

  // Unlike every other doctor check, absence here must still be `passed:
  // true` — this is an optional external tool, not a workspace-health
  // requirement. The remediation is populated anyway, purely informational.
  it('passes with an informational remediation when the binary is absent', async () => {
    process.env.PATH = '/usr/bin:/bin'
    const result = await checkCiscoScanner()
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('not installed')
    expect(result.remediation).toBe('pipx install cisco-ai-skill-scanner')
  })

  it('passes and reports the version when the binary is present', async () => {
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    const result = await checkCiscoScanner()
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('0.3.3-test')
    expect(result.remediation).toBeUndefined()
  })
})

describe('checkValkey', () => {
  // The proxy's /health carries no Valkey field, so the check must stand on
  // the TCP probe alone and never consult the proxy.
  it('passes on a listening port without asking the proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const result = await checkValkey(port)
      expect(result.passed).toBe(true)
      expect(result.detail).toContain(`127.0.0.1:${port}`)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('fails with a remediation when nothing is listening', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const result = await checkValkey(port)
    expect(result.passed).toBe(false)
    expect(result.detail).toBe(`Not reachable on port ${port}`)
    expect(result.remediation).toBeTruthy()
  })
})

describe('checkControlPlane', () => {
  const creds = {
    apiKey: 'vk_test',
    workspaceId: 'wk_alpha',
    controlPlaneUrl: 'https://cp.example',
    email: 'dev@example.com',
    storedAt: new Date().toISOString(),
  }

  // The check asks whichever control plane the CLI resolves, as every other
  // command would; pin it through the environment.
  const savedUrl = process.env.INTUTIC_CONTROL_PLANE_URL
  beforeEach(() => {
    process.env.INTUTIC_CONTROL_PLANE_URL = 'https://cp.example'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (savedUrl === undefined) delete process.env.INTUTIC_CONTROL_PLANE_URL
    else process.env.INTUTIC_CONTROL_PLANE_URL = savedUrl
  })

  it('validates the key against /api/v1/auth/me and reports it authenticated', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(creds)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const result = await checkControlPlane()
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://cp.example/api/v1/auth/me')
    expect(result.passed).toBe(true)
    expect(result.detail).toBe('Authenticated at https://cp.example')
  })

  it('fails on a rejected key', async () => {
    vi.mocked(loadCredentials).mockResolvedValue(creds)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    const result = await checkControlPlane()
    expect(result.passed).toBe(false)
    expect(result.remediation).toContain('intutic login')
  })
})

describe('runDoctor on an open-core install', () => {
  let dir: string
  const savedRules = process.env.INTUTIC_SNAPSHOT_RULES

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'intutic-doctor-oc-'))
    // The snapshot the gates would read; written by the tests that want one.
    process.env.INTUTIC_SNAPSHOT_RULES = join(dir, 'hooks', 'policy-snapshot.rules')
    vi.mocked(loadCredentials).mockResolvedValue(null)
    vi.mocked(loadConfig).mockReturnValue({ workspaceRoot: dir, harnesses: ['cursor', 'aider'], configVersion: 0, devMode: false } as never)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (savedRules === undefined) delete process.env.INTUTIC_SNAPSHOT_RULES
    else process.env.INTUTIC_SNAPSHOT_RULES = savedRules
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function doctorLines(): Promise<string[]> {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    await runDoctor()
    return lines
  }
  const lineFor = (lines: string[], name: string) => lines.find((l) => l.includes(name)) ?? ''

  it('skips the control-plane checks instead of pointing at hidden commands', async () => {
    const out = (await doctorLines()).join('\n')
    expect(out).toContain('skipped: open core, no control plane connected')
    expect(out).toContain('intutic start')
    expect(out).not.toMatch(/intutic (login|connect|policy snapshot)/)
    expect(out).not.toContain('Control Plane Auth')
  }, 30_000) // runs every local probe (proxy, Valkey, CA trust, snapshot, scanner)

  it('says no gates are installed, and names `intutic gates install`, when there are none', async () => {
    const lines = await doctorLines()
    expect(lineFor(lines, 'Policy Snapshot')).toContain('✗')
    expect(lineFor(lines, 'Local Gates')).toContain('None installed for cursor')
    // aider has no tool-call gate to install, so it is not counted missing.
    expect(lineFor(lines, 'Local Gates')).not.toContain('aider')
    expect(lines.join('\n')).toContain('intutic gates install')
  }, 30_000)

  it('passes the snapshot and gate checks once local gates are installed', async () => {
    await writeLocalPolicySnapshot({ snapshotDir: join(dir, 'hooks'), localHoldTokens: ['Write'] })
    await fs.mkdir(join(dir, '.intutic', 'hooks'), { recursive: true })
    await fs.writeFile(join(dir, '.intutic', 'hooks', 'cursor-check.js'), '// gate\n')
    const lines = await doctorLines()
    expect(lineFor(lines, 'Policy Snapshot')).toContain('✓')
    expect(lineFor(lines, 'Local Gates')).toContain('✓')
    expect(lineFor(lines, 'Local Gates')).toContain('1 gate(s) installed: cursor')
  }, 30_000)
})

describe('linuxCaTrustInstalled', () => {
  const readerFor = (present: string) => (path: string) => {
    if (path === present) return '-----BEGIN CERTIFICATE-----'
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }

  it("finds `intutic connect`'s copy, not only enterprise install's", () => {
    expect(linuxCaTrustInstalled(readerFor('/usr/local/share/ca-certificates/intutic-connect-ca.crt'))).toBe(true)
    expect(linuxCaTrustInstalled(readerFor('/etc/pki/ca-trust/source/anchors/intutic-connect-ca.crt'))).toBe(true)
  })

  it("finds enterprise install's copy and a manual Arch anchor", () => {
    expect(linuxCaTrustInstalled(readerFor('/usr/local/share/ca-certificates/intutic-ca.crt'))).toBe(true)
    expect(linuxCaTrustInstalled(readerFor('/etc/ca-certificates/trust-source/anchors/intutic-ca.crt'))).toBe(true)
  })

  it('is false when no copy is installed', () => {
    expect(linuxCaTrustInstalled(readerFor('/nowhere/intutic-ca.crt'))).toBe(false)
  })
})
