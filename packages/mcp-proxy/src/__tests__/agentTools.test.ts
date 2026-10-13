/**
 * agentTools.test.ts — what the `intutic` MCP server's hold, registry and
 * budget tools tell an agent. The budget counters themselves are read in
 * budget.test.ts, against Valkey.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  LIST_INCIDENTS_ARGS,
  budgetRemaining,
  describeFailure,
  governanceStatus,
  holdStatus,
  incidentListPath,
  registryStatus,
  sopListPath,
} from '../agentTools.js'

const HOLD = 'hold_abc_0a1b2c3d'
const future = new Date(Date.now() + 60_000).toISOString()

describe('intutic_hold_status', () => {
  it('says to wait, and not retry, while the hold is pending', () => {
    const s = holdStatus(HOLD, { status: 'PENDING_REVIEW' }, null)
    expect(s.retry).toBe('wait')
    expect(s.message).toContain(`intutic decision approve ${HOLD}`)
  })

  it('says a retry passes only while an approval bypass covers it', () => {
    const bypasses = { bypasses: [{ holdId: HOLD, expiresAt: future }] }
    expect(holdStatus(HOLD, { status: 'APPROVED' }, bypasses)).toMatchObject({ retry: 'passes', bypassExpiresAt: future })
  })

  it('says an approval with no bypass will be held again', () => {
    const expired = { bypasses: [{ holdId: HOLD, expiresAt: new Date(Date.now() - 1000).toISOString() }] }
    for (const bypasses of [{ bypasses: [] }, expired, { bypasses: [{ holdId: 'hold_other', expiresAt: future }] }, null]) {
      const s = holdStatus(HOLD, { status: 'APPROVED' }, bypasses)
      expect(s.retry).toBe('held_again')
      expect(s.message).toContain('reviewHoldBypassEnabled')
    }
  })

  it('says not to retry a rejected hold', () => {
    expect(holdStatus(HOLD, { status: 'REJECTED' }, null).retry).toBe('do_not_retry')
  })
})

describe('intutic_mcp_registry_status', () => {
  const data = {
    defaultPolicy: 'deny',
    servers: [
      { serverName: 'github', status: 'approved', heldForReview: false, disabledTools: ['delete_repo'] },
      { serverName: 'jira', status: 'approved', heldForReview: true, disabledTools: [] },
      { serverName: 'shell', status: 'blocked', heldForReview: false, disabledTools: [] },
      { serverName: 'notion', status: 'candidate', heldForReview: false, disabledTools: [] },
    ],
  }

  it('says, server by server, whether calls run and which tools are off', () => {
    expect(registryStatus(data)).toEqual({
      defaultPolicy: 'deny',
      servers: [
        { server: 'github', status: 'approved', calls: 'allowed', disabledTools: ['delete_repo'] },
        { server: 'jira', status: 'approved', calls: expect.stringMatching(/^refused \(SERVER_HELD\)/), disabledTools: [] },
        { server: 'shell', status: 'blocked', calls: 'refused (SERVER_BLOCKED)', disabledTools: [] },
        { server: 'notion', status: 'candidate', calls: expect.stringMatching(/^refused \(SERVER_NOT_APPROVED\)/), disabledTools: [] },
      ],
    })
  })

  it('answers for a server the registry has not seen, under either default', () => {
    expect(registryStatus(data, 'slack').note).toContain('SERVER_NOT_APPROVED')
    expect(registryStatus({ ...data, defaultPolicy: 'allow' }, 'slack').note).toContain('allowed under the default policy')
    expect(registryStatus({ ...data, defaultPolicy: 'allow' }, 'notion').servers).toEqual([
      { server: 'notion', status: 'candidate', calls: 'allowed', disabledTools: [] },
    ])
  })
})

describe('intutic_mcp_budget_remaining', () => {
  it('reports limits with unknown use when the counters cannot be read', async () => {
    const report = await budgetRemaining(
      { budgets: [{ id: 'gh', scope: 'server', server: 'github', period: 'hour', limit: 10 }], warnAtPct: 80 },
      'ws_1',
      { memberId: 'mem_1', fallback: 'key:vk_x' },
      async () => undefined,
      Date.parse('2026-10-08T14:37:12Z'),
    )
    expect(report).toEqual([
      { budgetId: 'gh', counts: 'calls to github: 10 per hour', period: 'hour', limit: 10, used: null, remaining: null, resetAt: '2026-10-08T15:00:00.000Z' },
    ])
  })
})

describe('intutic_list_incidents', () => {
  const args = z.object(LIST_INCIDENTS_ARGS)

  it('takes a type the control plane knows, system incident types included', () => {
    expect(args.parse({ type: 'SYSTEM_ANOMALY' })).toEqual({ limit: 10, type: 'SYSTEM_ANOMALY' })
    expect(args.parse({ type: 'WASM_RULE_REFUSED', limit: 5 })).toEqual({ limit: 5, type: 'WASM_RULE_REFUSED' })
    expect(args.parse({})).toEqual({ limit: 10 })
  })

  it('refuses a type the control plane would refuse, naming the valid ones', () => {
    const r = args.safeParse({ type: 'NOT_A_TYPE' })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('SCOPE_VIOLATION')
  })

  it('sends the type to the incidents route only when given', () => {
    expect(incidentListPath('ws_1', { limit: 10 })).toBe('/api/v1/incidents?workspaceId=ws_1&limit=10')
    expect(incidentListPath('ws_1', { limit: 5, type: 'SYSTEM_ANOMALY' })).toBe('/api/v1/incidents?workspaceId=ws_1&limit=5&type=SYSTEM_ANOMALY')
  })
})

describe('intutic_governance_status', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const CP = 'http://cp.test'

  it('asks an authenticated route, so the API key is really checked', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workspaceId: 'ws_1', role: 'DEVELOPER' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const status = await governanceStatus(CP, 'key', 'ws_1')
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${CP}/api/v1/auth/key-context`)
    expect(status).toMatchObject({ connected: true, apiKeyValid: true, keyWorkspaceId: 'ws_1', role: 'DEVELOPER' })
  })

  it('says the key was rejected on a 401, not that the control plane is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    expect(await governanceStatus(CP, 'bad', 'ws_1')).toMatchObject({
      connected: false,
      error: 'Control plane rejected this API key',
    })
  })

  it('says unreachable when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await governanceStatus(CP, 'key', 'ws_1')).toMatchObject({ connected: false, error: 'Control plane unreachable' })
  })

  it('names a rejected key in every other tool too', () => {
    expect(describeFailure({ reason: 'unauthorized' }, 'list SOPs')).toContain('rejected this API key')
  })
})

describe('intutic_list_sops', () => {
  it('asks for the VALIDATED SOPs only — the ones in force', () => {
    const url = new URL(sopListPath('ws_1', 10), 'http://cp.test')
    expect(url.pathname).toBe('/api/v1/sops')
    expect(url.searchParams.get('lifecycle_state')).toBe('VALIDATED')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('workspaceId')).toBe('ws_1')
  })
})
