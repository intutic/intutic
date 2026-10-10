/**
 * `intutic budget set|keys|key|members|member` against a mocked control
 * plane: each write changes only what its flags name (reading the rest first,
 * because the routes replace a subject's budgets whole), bad flags fail before
 * any request, and a refusal prints the server's message and exits 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../config/store.js', () => ({
  loadCredentials: vi.fn(async () => ({ apiKey: 'vk_test_key', workspaceId: 'ws_test' })),
  loadConfig: vi.fn(() => ({ devMode: false })),
}))

vi.mock('../config/paths.js', () => ({
  resolveControlPlaneUrl: vi.fn(() => 'https://api.test.invalid'),
}))

import {
  applyBudgetFlags,
  budgetSetBody,
  describeBudgets,
  runBudgetKey,
  runBudgetKeys,
  runBudgetMember,
  runBudgetMembers,
  runBudgetSet,
} from './budgetLimits.js'

const BASE = 'https://api.test.invalid'

function reply(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text })
}

let fetchMock: ReturnType<typeof vi.fn>
let logSpy: MockInstance<typeof console.log>
let errSpy: MockInstance<typeof console.error>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
const printedError = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
const sent = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n]
  return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined }
}

const KEYS = {
  keys: [
    {
      keyId: 'key_1',
      keyPrefix: 'vk_0a1b2c3d4',
      label: 'ci',
      memberId: 'mem_1',
      memberEmail: 'dev@example.com',
      budgets: [{ period: 'month', limitUsd: 50, enforcement: 'soft' }],
      rateLimit: { rpm: 60, tpm: null },
      spendTodayUsd: 1.25,
      spendThisMonthUsd: 12.5,
    },
  ],
  dayResetsAt: '2026-10-10T00:00:00.000Z',
  monthResetsAt: '2026-11-01T00:00:00.000Z',
}

describe('applyBudgetFlags', () => {
  const current = [{ period: 'month' as const, limitUsd: 50, enforcement: 'soft' as const }]

  it('adds a period as hard, keeps the other, and keeps an existing budget\'s enforcement when only its amount changes', () => {
    expect(applyBudgetFlags(current, { daily: '5' })).toEqual([
      { period: 'day', limitUsd: 5, enforcement: 'hard' },
      { period: 'month', limitUsd: 50, enforcement: 'soft' },
    ])
    expect(applyBudgetFlags(current, { monthly: '80' })).toEqual([{ period: 'month', limitUsd: 80, enforcement: 'soft' }])
  })

  it('removes a period with none, and changes enforcement alone', () => {
    expect(applyBudgetFlags(current, { monthly: 'none' })).toEqual([])
    expect(applyBudgetFlags(current, { monthlyEnforcement: 'hard' })).toEqual([{ period: 'month', limitUsd: 50, enforcement: 'hard' }])
  })

  it('refuses a bad amount, a bad mode, or a mode for a budget that does not exist', () => {
    expect(() => applyBudgetFlags(current, { daily: '-1' })).toThrow('process.exit(1)')
    expect(() => applyBudgetFlags(current, { monthlyEnforcement: 'block' })).toThrow('process.exit(1)')
    expect(() => applyBudgetFlags(current, { dailyEnforcement: 'soft' })).toThrow('process.exit(1)')
    expect(printedError()).toContain('--daily-enforcement needs a day budget')
  })

  it('describes budgets in a line', () => {
    expect(describeBudgets([])).toBe('none')
    expect(describeBudgets(applyBudgetFlags(current, { daily: '5' }))).toBe('$5.00/day hard, $50.00/month soft')
  })
})

describe('intutic budget key', () => {
  it('reads the key\'s budgets, then PATCHes them whole with the rate limit it was given', async () => {
    fetchMock
      .mockReturnValueOnce(reply(200, KEYS))
      .mockReturnValueOnce(reply(200, { keyId: 'key_1', budgets: [], rateLimit: { rpm: 60, tpm: 100000 } }))
    await runBudgetKey('key_1', { daily: '5', tpm: '100000' })
    expect(sent(0)).toMatchObject({ url: `${BASE}/api/v1/budget/keys`, method: 'GET' })
    expect(sent(1)).toEqual({
      url: `${BASE}/api/v1/keys/key_1`,
      method: 'PATCH',
      body: {
        budgets: [
          { period: 'day', limitUsd: 5, enforcement: 'hard' },
          { period: 'month', limitUsd: 50, enforcement: 'soft' },
        ],
        rateLimit: { tpm: 100000 },
      },
    })
  })

  it('sends only the rate limit when no budget flag is given, and none clears a limit', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { keyId: 'key_1', budgets: [], rateLimit: { rpm: null, tpm: null } }))
    await runBudgetKey('key_1', { rpm: 'none' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent(0).body).toEqual({ rateLimit: { rpm: null } })
    expect(printed()).toContain('none')
  })

  it('fails before any request with nothing to change or a bad count', async () => {
    await expect(runBudgetKey('key_1', {})).rejects.toThrow('process.exit(1)')
    await expect(runBudgetKey('key_1', { rpm: '1.5' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints the server\'s refusal', async () => {
    fetchMock.mockReturnValueOnce(reply(403, { error: 'Forbidden', detail: 'Requires the OWNER or ADMIN role' }))
    await expect(runBudgetKey('key_1', { rpm: '10' })).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('Failed to update key key_1')
  })
})

describe('intutic budget keys / members', () => {
  it('lists each key with its spend, budgets and rate limit', async () => {
    fetchMock.mockReturnValueOnce(reply(200, KEYS))
    await runBudgetKeys({})
    expect(printed()).toContain('vk_0a1b2c3d4…  ci')
    expect(printed()).toContain('Spent today $1.25, this month $12.50')
    expect(printed()).toContain('Budgets: $50.00/month soft   Rate limit: 60 requests/min')
  })

  it('prints the plan refusal for member budgets as the server says it', async () => {
    fetchMock.mockReturnValueOnce(reply(403, { error: 'Upgrade required — member budgets require a Biz Org plan or higher' }))
    await expect(runBudgetMembers({})).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('member budgets require a Biz Org plan')
  })
})

describe('intutic budget member', () => {
  const MEMBERS = {
    defaultBudgets: [{ period: 'day', limitUsd: 20, enforcement: 'hard' }],
    members: [{ memberId: 'mem_1', email: 'dev@example.com', budgets: [], effectiveBudgets: [], spendTodayUsd: 0, spendThisMonthUsd: 0 }],
    dayResetsAt: '',
    monthResetsAt: '',
  }

  it('sets the default member budget, keeping the period it was not given', async () => {
    fetchMock
      .mockReturnValueOnce(reply(200, MEMBERS))
      .mockReturnValueOnce(reply(200, { memberId: 'default', budgets: [] }))
    await runBudgetMember('default', { monthly: '300', monthlyEnforcement: 'soft' })
    expect(sent(1)).toEqual({
      url: `${BASE}/api/v1/budget/members/default`,
      method: 'PUT',
      body: {
        budgets: [
          { period: 'day', limitUsd: 20, enforcement: 'hard' },
          { period: 'month', limitUsd: 300, enforcement: 'soft' },
        ],
      },
    })
  })

  it('refuses a member the workspace does not have', async () => {
    fetchMock.mockReturnValueOnce(reply(200, MEMBERS))
    await expect(runBudgetMember('mem_gone', { daily: '1' })).rejects.toThrow('process.exit(1)')
    expect(printedError()).toContain('no active member mem_gone')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('intutic budget set', () => {
  it('sends only the flags given, so a daily cap nobody named stays on its default', async () => {
    const after = { daily_budget_usd: 100, daily_budget_is_default: true, monthly_budget_usd: 800, alert_threshold_pct: 80, daily_enforcement: 'hard', monthly_enforcement: 'hard' }
    fetchMock.mockReturnValueOnce(reply(200, { updated: true })).mockReturnValueOnce(reply(200, after))
    await runBudgetSet({ monthly: '800', monthlyEnforcement: 'hard' })
    expect(sent(0)).toEqual({ url: `${BASE}/api/v1/budget`, method: 'PUT', body: { monthly_budget_usd: 800, monthly_enforcement: 'hard' } })
    expect(printed()).toContain('$100.00 (hard), the default')
    expect(printed()).toContain('$800.00 (hard)')
  })

  it('sends null for default, which returns a saved cap to the default', () => {
    expect(budgetSetBody({ daily: 'default' })).toEqual({ daily_budget_usd: null })
    expect(budgetSetBody({ daily: '0', threshold: '75' })).toEqual({ daily_budget_usd: 0, alert_threshold_pct: 75 })
  })

  it('fails before any request with nothing to change, a bad amount or a bad threshold', async () => {
    await expect(runBudgetSet({})).rejects.toThrow('process.exit(1)')
    await expect(runBudgetSet({ daily: 'lots' })).rejects.toThrow('process.exit(1)')
    await expect(runBudgetSet({ threshold: '120' })).rejects.toThrow('process.exit(1)')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
