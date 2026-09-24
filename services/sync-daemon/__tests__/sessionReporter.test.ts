/**
 * `startHarnessSession` / `endAllOpenSessions` — which row a harness's git and
 * task context is reported onto, and whose lifecycle the daemon owns (TD-231,
 * Wave 5.6).
 *
 * With a local proxy's instance id the context goes onto that process's own
 * session row (the control plane derives it from `proxyInstanceId`; the
 * daemon never ends it). Without one, today's contract — a `ses_` row opened
 * once per run and ended on shutdown — which this file pins for the first
 * time. The module keeps dedupe state across calls, so every case ends with
 * `endAllOpenSessions`, which is also the reset.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarnessSession, endAllOpenSessions } from '../src/sessionReporter.js'

const CP = 'http://cp.test'
const KEY = 'k'
const WS = 'ws_reporter'

let root: string
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>

function stubControlPlane(idFor: (body: Record<string, unknown>) => string) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      calls.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}) })
      return { ok: true, json: async () => ({ sessionId: body ? idFor(body) : undefined }) }
    }) as unknown as typeof fetch,
  )
}

const proxyRowId = (body: Record<string, unknown>) =>
  body.proxyInstanceId ? `ssp_wsreporter_claudeco_${String(body.proxyInstanceId).replace(/[^a-z0-9]/gi, '')}` : `ses_${body.harnessType}`

beforeEach(() => {
  // Not a git repository, so `readGitInfo` yields nothing — the body shape is
  // what is under test, not git.
  root = mkdtempSync(join(tmpdir(), 'intutic-session-reporter-'))
})

afterEach(async () => {
  await endAllOpenSessions(CP, KEY)
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const base = { controlPlaneUrl: CP, apiKey: KEY, workspaceId: WS, workspaceRoot: '' }

describe('startHarnessSession with a local proxy instance id', () => {
  it('registers the context onto the proxy row and never ends it', async () => {
    stubControlPlane(proxyRowId)
    const id = await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'claude-code', proxyInstanceId: 'proxy_aaaa' })
    expect(id).toBe('ssp_wsreporter_claudeco_proxyaaaa')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${CP}/api/v1/sessions`)
    expect(calls[0].body).toMatchObject({ workspaceId: WS, harnessType: 'claude-code', proxyInstanceId: 'proxy_aaaa' })

    await endAllOpenSessions(CP, KEY)
    // No PATCH /end: the proxy row's lifecycle is the control plane's idle
    // rule, and an externally started proxy keeps serving after we stop.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('posts once per proxy process and again for a respawned one', async () => {
    stubControlPlane(proxyRowId)
    const first = await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'claude-code', proxyInstanceId: 'proxy_aaaa' })
    const again = await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'claude-code', proxyInstanceId: 'proxy_aaaa' })
    expect(again).toBe(first)
    expect(calls).toHaveLength(1)

    const respawned = await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'claude-code', proxyInstanceId: 'proxy_bbbb' })
    expect(respawned).toBe('ssp_wsreporter_claudeco_proxybbbb')
    expect(calls).toHaveLength(2)
  })
})

describe('startHarnessSession without a proxy instance id (no local proxy, or a shared gateway)', () => {
  it('opens a ses_ row once per run and ends it on shutdown — the contract before Wave 5.6', async () => {
    stubControlPlane(proxyRowId)
    const id = await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'cursor' })
    expect(id).toBe('ses_cursor')
    expect(calls[0].body).not.toHaveProperty('proxyInstanceId')
    expect(await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'cursor' })).toBe('ses_cursor')
    expect(calls).toHaveLength(1)

    await endAllOpenSessions(CP, KEY)
    const ends = calls.filter((c) => c.method === 'PATCH')
    expect(ends).toHaveLength(1)
    expect(ends[0].url).toBe(`${CP}/api/v1/sessions/ses_cursor/end`)
  })

  it('tries once per run on a failed POST, and a later run (after reset) tries again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'cursor' })).toBeNull()
    expect(await startHarnessSession({ ...base, workspaceRoot: root, harnessType: 'cursor' })).toBeNull()
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
