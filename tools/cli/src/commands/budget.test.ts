/**
 * `intutic budget` — the new pieces from the "live terminal cost" phase:
 * fetching the proxy's `/intutic/spend` endpoint, and a single tick of
 * `--watch`. Doesn't re-test `resolveLocalDailyBudget` — that's
 * `budgetCompatibility.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  fetchLocalSpend,
  printWatchTick,
  type LocalSpendResponse,
} from './budget.js'
import type { BudgetStatusResponse } from './budget.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let logSpy: any

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const printed = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

const workspaceBudget: BudgetStatusResponse = {
  workspace_id: 'ws_test',
  monthly_budget_usd: 100,
  monthly_spend_usd: 12,
  daily_budget_usd: 5,
  daily_spend_usd: 1.25,
  pct_monthly_used: 12,
  pct_daily_used: 25,
  alert_threshold_pct: 80,
  alert_triggered: false,
  budget_remaining_usd: 3.75,
}

const localSpend: LocalSpendResponse = {
  local_spend_usd_today: 2.5,
  local_cap_usd: 10,
  enforced: true,
}

describe('fetchLocalSpend', () => {
  it('hits GET http://127.0.0.1:4000/intutic/spend and returns the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => localSpend })

    const result = await fetchLocalSpend(fetchMock)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/intutic/spend',
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(result).toEqual(localSpend)
  })

  it('returns null when the proxy responds with a non-2xx status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await fetchLocalSpend(fetchMock)).toBeNull()
  })

  it('returns null rather than throwing when the local proxy is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await fetchLocalSpend(fetchMock)).toBeNull()
  })
})

describe('printWatchTick', () => {
  it('prints a single line carrying both the "machine-local" and "workspace" labels', async () => {
    const fetchLocalSpendFn = vi.fn().mockResolvedValue(localSpend)
    const fetchWorkspaceBudgetFn = vi.fn().mockResolvedValue(workspaceBudget)

    await printWatchTick(fetchLocalSpendFn, fetchWorkspaceBudgetFn, true, null)

    const line = printed()
    expect(line).toContain('machine-local')
    expect(line).toContain('workspace')
    // The two numbers must actually be the ones each source returned, not
    // conflated with each other — $2.5000 is the machine-local figure and
    // $1.2500 is the workspace one, and swapping them would still pass a
    // looser "contains both labels" assertion.
    expect(line).toContain('$2.5000')
    expect(line).toContain('$1.2500')
  })

  it('does not fetch a fresh workspace figure on a tick that skips it, and reuses the last one', async () => {
    const fetchLocalSpendFn = vi.fn().mockResolvedValue(localSpend)
    const fetchWorkspaceBudgetFn = vi.fn().mockResolvedValue(workspaceBudget)

    const returned = await printWatchTick(fetchLocalSpendFn, fetchWorkspaceBudgetFn, false, workspaceBudget)

    expect(fetchWorkspaceBudgetFn).not.toHaveBeenCalled()
    expect(returned).toBe(workspaceBudget)
    expect(printed()).toContain('workspace: $1.2500 / $5.00')
  })

  it('prints a dash for machine-local when the local proxy is not running, without dropping the workspace line', async () => {
    const fetchLocalSpendFn = vi.fn().mockResolvedValue(null)
    const fetchWorkspaceBudgetFn = vi.fn().mockResolvedValue(workspaceBudget)

    await printWatchTick(fetchLocalSpendFn, fetchWorkspaceBudgetFn, true, null)

    const line = printed()
    expect(line).toContain('machine-local: — (local proxy not running)')
    expect(line).toContain('workspace')
  })

  it('prints a dash for workspace when there is no workspace connection', async () => {
    const fetchLocalSpendFn = vi.fn().mockResolvedValue(localSpend)
    const fetchWorkspaceBudgetFn = vi.fn().mockResolvedValue(null)

    await printWatchTick(fetchLocalSpendFn, fetchWorkspaceBudgetFn, true, null)

    const line = printed()
    expect(line).toContain('machine-local')
    expect(line).toContain('workspace: — (not connected)')
  })
})
