/**
 * agentTools.test.ts — what the `intutic` MCP server's hold, registry and
 * budget tools tell an agent. The budget counters themselves are read in
 * budget.test.ts, against Valkey.
 */
import { describe, it, expect } from 'vitest'
import { budgetRemaining, holdStatus, registryStatus } from '../agentTools.js'

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
