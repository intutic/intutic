import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type AddressInfo } from 'node:net'
import { describePolicySnapshot, checkCiscoScanner, checkControlPlane, checkValkey } from './doctor.js'
import { loadCredentials } from '../config/store.js'

vi.mock('../config/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/store.js')>()),
  loadCredentials: vi.fn(),
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
