/**
 * TD-488: the three gate-side caches (policy snapshot, approved review-hold
 * bypasses, central egress policy) refresh through ONE helper that both the
 * daemon loop and `intutic connect` call on every sync cycle. Pinned here
 * against a stubbed control plane: two calls with two different rule sets
 * must leave two different snapshot files behind — the exact thing a
 * once-at-startup refresh cannot do.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshGateCaches } from '../src/syncLoop.js'
import { DEFAULT_SNAPSHOT_DIR } from '../src/lib/policySnapshot.js'

function controlPlane(rules: Array<{ id: string; toolPattern: string; action: string; reason: string }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/api/v1/policy/resolve')) {
      return { ok: true, status: 200, json: async () => ({ workspaceId: 'ws_1', sopRules: rules, interventionMode: 'BLOCK', allowedServers: [] }) }
    }
    if (url.includes('/api/v1/decisions/approved-bypasses')) {
      return { ok: true, status: 200, json: async () => ({ bypasses: [] }) }
    }
    if (url.includes('/api/v1/workspace/egress-policy')) {
      return { ok: true, status: 200, json: async () => ({ mode: 'monitor', allow: [] }) }
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as unknown as typeof fetch
}

describe('refreshGateCaches', () => {
  let home: string
  const prevHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'intutic-gate-caches-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('rewrites the snapshot every time it is called, so a rule promoted mid-session lands on the next sync', async () => {
    const opts = { controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_1' }
    vi.stubGlobal('fetch', controlPlane([{ id: 'sop.first', toolPattern: 'Bash', action: 'block', reason: 'first rule' }]))
    const first = await refreshGateCaches(opts)
    expect(first.snapshot).toBe(true)
    const rulesFile = join(DEFAULT_SNAPSHOT_DIR, 'policy-snapshot.rules')
    expect(existsSync(rulesFile) || existsSync(join(home, '.intutic', 'hooks', 'policy-snapshot.rules'))).toBe(true)
    const path = existsSync(rulesFile) ? rulesFile : join(home, '.intutic', 'hooks', 'policy-snapshot.rules')
    expect(readFileSync(path, 'utf8')).toContain('sop.first')

    vi.stubGlobal('fetch', controlPlane([{ id: 'sop.second', toolPattern: 'Bash', action: 'block', reason: 'second rule' }]))
    const second = await refreshGateCaches(opts)
    expect(second.snapshot).toBe(true)
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('sop.second')
    expect(after).not.toContain('sop.first')
  })

  it('reports which caches landed and never throws when the control plane is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    await expect(refreshGateCaches({ controlPlaneUrl: 'https://cp.example', apiKey: 'k', workspaceId: 'ws_1' })).resolves.toEqual({ snapshot: false, bypasses: false, egress: false })
  })
})
