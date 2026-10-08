/**
 * budget.ts — MCP call budgets, enforced before a call leaves the machine.
 *
 * The workspace's `mcpBudgets` setting (shared-types `mcpBudgets.ts`) limits
 * how many tool calls go to a server, a tool, or come from a member, per hour
 * or per day. Every proxy pointed at the same Valkey counts against the same
 * counters, so a member's daily allowance is one allowance however many
 * harness sessions and servers they run; proxies on different Valkeys count
 * separately.
 *
 * One round trip per call that any budget covers, none for a call no budget
 * covers. A Lua script checks every counter the call draws on and, only if
 * none is used up, increments them all — atomically, so two proxies racing
 * for the last call cannot both get it, and a refused call never consumes
 * allowance. The same script claims the once-per-period alert flags (SET NX
 * with the counter's lifetime, the dedup the LLM budget alerts use), so the
 * warning and the exceeded notification go out once per budget per period
 * whichever proxy crosses the line.
 *
 * Periods are fixed UTC windows (`budgetWindow`); the window start is part of
 * every key, so a new hour or day starts from zero and old counters expire on
 * their own. Each proxy reads its own clock: proxies whose clocks disagree by
 * a few seconds disagree about the window for those seconds.
 *
 * When Valkey cannot answer — no URL configured, not connected, slower than
 * the guard's timeout, or an error — the check is `unavailable`, and the
 * interceptor applies the proxy's fail setting: fail-open lets the call
 * through uncounted, fail-closed refuses it.
 *
 * @module
 */

import {
  budgetWarnAt,
  budgetWindow,
  budgetsForCall,
  describeMcpBudget,
  type McpBudget,
  type McpBudgetPolicy,
} from '@intutic/shared-types'
import type { GuardedValkey } from './guardedValkey.js'

/**
 * Counter keys. The workspace id is a hash tag (`{…}`), so every key one call
 * touches lives in the same slot and the script stays valid on a cluster.
 */
export function budgetCounterKey(workspaceId: string, budgetId: string, windowStartMs: number, subject: string): string {
  return `v2:mcpbudget:{${workspaceId}}:${budgetId}:${windowStartMs}:${encodeURIComponent(subject)}`
}

/** Extra seconds a counter outlives its window, so a slow clock never reads a fresh zero mid-window. */
const COUNTER_TTL_SLACK_SECS = 60

/**
 * KEYS, per counter i (1-based, three each): the count, the warned flag, the
 * exhausted flag. ARGV, per counter: limit, warn-at count, TTL in seconds.
 * Returns `{0, i, used, exhaustedClaimed}` when counter i is used up (nothing
 * incremented), else `{1, used_1, warnClaimed_1, used_2, warnClaimed_2, …}`.
 */
const CHECK_AND_COUNT = `
local n = #KEYS / 3
for i = 1, n do
  local used = tonumber(redis.call('GET', KEYS[3 * i - 2]) or '0')
  if used >= tonumber(ARGV[3 * i - 2]) then
    local claimed = redis.call('SET', KEYS[3 * i], '1', 'NX', 'EX', ARGV[3 * i]) and 1 or 0
    return {0, i, used, claimed}
  end
end
local out = {1}
for i = 1, n do
  local used = redis.call('INCR', KEYS[3 * i - 2])
  if used == 1 then redis.call('EXPIRE', KEYS[3 * i - 2], ARGV[3 * i]) end
  local claimed = 0
  if used >= tonumber(ARGV[3 * i - 1]) then
    if redis.call('SET', KEYS[3 * i - 1], '1', 'NX', 'EX', ARGV[3 * i]) then claimed = 1 end
  end
  out[#out + 1] = used
  out[#out + 1] = claimed
end
return out
`

export interface BudgetCounter {
  key: string
  limit: number
  warnAt: number
  ttlSecs: number
}

export type CountOutcome =
  | { allowed: true; used: number[]; warnClaimed: boolean[] }
  | { allowed: false; index: number; used: number; exhaustedClaimed: boolean }

export interface BudgetStore {
  /** Checks and counts one call against every counter; `undefined` when Valkey cannot answer. */
  count(counters: readonly BudgetCounter[]): Promise<CountOutcome | undefined>
}

export class ValkeyBudgetStore implements BudgetStore {
  constructor(private readonly valkey: GuardedValkey) {}

  async count(counters: readonly BudgetCounter[]): Promise<CountOutcome | undefined> {
    const keys = counters.flatMap((c) => [`${c.key}:count`, `${c.key}:warned`, `${c.key}:exhausted`])
    const args = counters.flatMap((c) => [String(c.limit), String(c.warnAt), String(c.ttlSecs)])
    const reply = await this.valkey.run(
      (client) => client.eval(CHECK_AND_COUNT, keys.length, ...keys, ...args) as Promise<unknown>,
      { awaitConnect: true },
    )
    if (!Array.isArray(reply) || reply.length === 0) return undefined
    const n = reply.map(Number)
    if (n[0] === 0) return { allowed: false, index: n[1]! - 1, used: n[2]!, exhaustedClaimed: n[3] === 1 }
    const used: number[] = []
    const warnClaimed: boolean[] = []
    for (let i = 1; i < n.length; i += 2) {
      used.push(n[i]!)
      warnClaimed.push(n[i + 1] === 1)
    }
    return { allowed: true, used, warnClaimed }
  }
}

/** A budget at a moment in its period: which allowance, how much of it is used, and when it resets. */
export interface BudgetStanding {
  budget: McpBudget
  /** The member (or fallback caller) a per-member budget counted; empty for any other budget. */
  subject: string
  used: number
  resetAt: Date
}

export type BudgetVerdict =
  /** No budget covers this call. */
  | { kind: 'unlimited' }
  /** Counted. `warnings`: budgets this call took to their warning threshold first this period. */
  | { kind: 'allowed'; warnings: BudgetStanding[] }
  /** Refused: a budget is used up. `notify` is true for the first refusal of the period. */
  | { kind: 'exceeded'; standing: BudgetStanding; notify: boolean }
  /** Budgets cover this call, but Valkey could not answer. */
  | { kind: 'unavailable'; budgets: McpBudget[] }

export class McpBudgetEnforcer {
  constructor(
    /** `undefined` when the proxy has no Valkey configured: every covered call is then `unavailable`. */
    private readonly store: BudgetStore | undefined,
    private readonly workspaceId: string,
    private readonly serverName: string,
    /** Who a per-member budget counts when the control plane has not named a member (identity.ts). */
    private readonly fallbackCaller: string,
    private readonly now: () => number = Date.now,
  ) {}

  async check(policy: McpBudgetPolicy, toolName: string, memberId: string | null): Promise<BudgetVerdict> {
    const charges = budgetsForCall(policy, {
      server: this.serverName,
      tool: toolName,
      memberId,
      fallbackCaller: this.fallbackCaller,
    })
    if (charges.length === 0) return { kind: 'unlimited' }
    if (!this.store) return { kind: 'unavailable', budgets: charges.map((c) => c.budget) }

    const nowMs = this.now()
    const windows = charges.map((c) => budgetWindow(c.budget.period, nowMs))
    const counters = charges.map((c, i) => ({
      key: budgetCounterKey(this.workspaceId, c.budget.id, windows[i]!.startMs, c.subject),
      limit: c.budget.limit,
      warnAt: budgetWarnAt(c.budget.limit, policy.warnAtPct),
      ttlSecs: Math.ceil((windows[i]!.resetAtMs - nowMs) / 1000) + COUNTER_TTL_SLACK_SECS,
    }))
    const outcome = await this.store.count(counters)
    if (!outcome) return { kind: 'unavailable', budgets: charges.map((c) => c.budget) }

    const standing = (i: number, used: number): BudgetStanding => ({
      budget: charges[i]!.budget,
      subject: charges[i]!.subject,
      used,
      resetAt: new Date(windows[i]!.resetAtMs),
    })
    if (!outcome.allowed) {
      return { kind: 'exceeded', standing: standing(outcome.index, outcome.used), notify: outcome.exhaustedClaimed }
    }
    return {
      kind: 'allowed',
      warnings: outcome.used.flatMap((used, i) => (outcome.warnClaimed[i] ? [standing(i, used)] : [])),
    }
  }
}

function untilReset(resetAt: Date, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((resetAt.getTime() - nowMs) / 60_000))
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

/** The refusal an agent reads: which budget, how much of it is used, and when it resets. */
export function exceededReason(s: BudgetStanding, nowMs: number = Date.now()): string {
  return (
    `MCP call budget "${s.budget.id}" is used up (${describeMcpBudget(s.budget)}): ${s.used} of ${s.budget.limit} ` +
    `calls made this ${s.budget.period}. It resets at ${s.resetAt.toISOString()} (in ${untilReset(s.resetAt, nowMs)}). ` +
    `An owner or admin can change MCP budgets on the MCP Servers page.`
  )
}

export function warningReason(s: BudgetStanding, warnAtPct: number): string {
  return (
    `MCP call budget "${s.budget.id}" reached its ${warnAtPct}% warning (${describeMcpBudget(s.budget)}): ` +
    `${s.used} of ${s.budget.limit} calls made this ${s.budget.period}. It resets at ${s.resetAt.toISOString()}.`
  )
}

export function unavailableReason(budgets: readonly McpBudget[]): string {
  return (
    `MCP call budget${budgets.length === 1 ? '' : 's'} ${budgets.map((b) => `"${b.id}"`).join(', ')} cover this call, ` +
    `but the call count could not be checked (no Valkey configured for this proxy with INTUTIC_VALKEY_URL, ` +
    `or Valkey unreachable). Tool call blocked by workspace policy (fail-closed mode). Contact your ` +
    `administrator or update mcpProxyFailBehavior to open.`
  )
}

/** What a budget event tells the control plane, for its notification and finding. */
export interface BudgetEventDetail {
  budgetId: string
  scope: McpBudget['scope']
  server?: string
  tool?: string
  memberId?: string
  period: McpBudget['period']
  limit: number
  used: number
  resetAt: string
}

export function budgetEventDetail(s: BudgetStanding): BudgetEventDetail {
  const { budget } = s
  return {
    budgetId: budget.id,
    scope: budget.scope,
    ...(budget.server !== undefined ? { server: budget.server } : {}),
    ...(budget.tool !== undefined ? { tool: budget.tool } : {}),
    ...(budget.memberId !== undefined ? { memberId: budget.memberId } : {}),
    period: budget.period,
    limit: budget.limit,
    used: s.used,
    resetAt: s.resetAt.toISOString(),
  }
}
