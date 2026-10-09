/**
 * Spend budgets and key rate limits — how much LLM spend a workspace, one
 * virtual key or one member may run up per day or per month, and how many
 * requests and tokens a virtual key may send per minute.
 *
 * A budget is `hard` or `soft`. The LLM proxy refuses a request that a hard
 * budget's remainder does not cover (`BUDGET_EXCEEDED`, 429, before the
 * request leaves); a soft budget never refuses. Both raise the workspace's
 * budget alerts — once at the alert threshold and once at the limit, per
 * period — as `finops.budget.threshold` / `finops.budget.exceeded`.
 *
 * Periods are fixed UTC windows, like MCP call budgets (`mcpBudgets.ts`): a
 * day starts at 00:00 UTC, a month on the 1st at 00:00 UTC. The window id is
 * part of every per-key and per-member spend counter's Valkey key, so a new
 * day or month starts from zero and an old counter expires on its own.
 *
 * Spend is what the control plane records per completed call
 * (`finopsService.incrementSpend`), so a request's own cost lands after it
 * finishes: the proxy checks a hard budget against the spend recorded so far
 * plus the request's estimated cost, with the same 20% margin the workspace
 * cap has always used.
 *
 * @module
 */

import { z } from 'zod'

/** A budget's period: a UTC calendar day or a UTC calendar month. */
export type SpendBudgetPeriod = 'day' | 'month'

/** `hard` refuses requests the remainder does not cover; `soft` only alerts. */
export type SpendBudgetEnforcement = 'hard' | 'soft'

/**
 * Whose spend a budget limits:
 * - `workspace` every call in the workspace (Settings › Billing › Budget Limits);
 * - `key`       the calls one virtual key makes;
 * - `member`    the calls made with the virtual keys one member owns.
 */
export type SpendBudgetScope = 'workspace' | 'key' | 'member'

export interface SpendBudget {
  period: SpendBudgetPeriod
  limitUsd: number
  enforcement: SpendBudgetEnforcement
}

export const SPEND_BUDGET_PERIODS: readonly SpendBudgetPeriod[] = ['day', 'month']
export const SPEND_BUDGET_SCOPES: readonly SpendBudgetScope[] = ['workspace', 'key', 'member']
export const MAX_SPEND_BUDGET_USD = 1_000_000

/**
 * The member budget that applies to every member without one of their own,
 * period by period. A member's own day budget replaces the default day
 * budget; the default month budget still applies to them unless they have a
 * month budget too.
 */
export const MEMBER_BUDGET_DEFAULT = 'default'

export const SpendBudgetSchema = z
  .object({
    period: z.enum(['day', 'month']),
    limitUsd: z.number().positive().max(MAX_SPEND_BUDGET_USD),
    enforcement: z.enum(['hard', 'soft']).default('hard'),
  })
  .strict()

/** One budget per period at most: a key or member has a day budget, a month budget, both or neither. */
export const SpendBudgetListSchema = z
  .array(SpendBudgetSchema)
  .max(2)
  .superRefine((list, ctx) => {
    const seen = new Set<string>()
    list.forEach((b, i) => {
      if (seen.has(b.period)) ctx.addIssue({ code: 'custom', path: [i, 'period'], message: `two ${b.period} budgets` })
      seen.add(b.period)
    })
  })

/** Requests and tokens one virtual key may send per minute; `null` (or absent) means no limit. */
export interface KeyRateLimit {
  rpm: number | null
  tpm: number | null
}

export const MAX_KEY_RPM = 100_000
export const MAX_KEY_TPM = 100_000_000

export const KeyRateLimitSchema = z
  .object({
    rpm: z.number().int().min(1).max(MAX_KEY_RPM).nullable().optional(),
    tpm: z.number().int().min(1).max(MAX_KEY_TPM).nullable().optional(),
  })
  .strict()

/**
 * One hard budget as the proxy reads it from a virtual key's cached auth
 * entry (`hardBudgets`) and from `GET /api/v1/auth/key-context`. Soft budgets
 * are not sent: the proxy never refuses on one.
 */
export interface HardBudgetWire {
  scope: SpendBudgetScope
  period: SpendBudgetPeriod
  limitUsd: number
}

/** The UTC window a moment falls in: its id (part of the counter key), when it began and when it resets. */
export function spendBudgetWindow(
  period: SpendBudgetPeriod,
  nowMs: number,
): { id: string; startMs: number; resetAtMs: number } {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  if (period === 'day') {
    const startMs = Date.UTC(y, m, d.getUTCDate())
    return { id: new Date(startMs).toISOString().slice(0, 10), startMs, resetAtMs: startMs + 86_400_000 }
  }
  const startMs = Date.UTC(y, m, 1)
  return { id: new Date(startMs).toISOString().slice(0, 7), startMs, resetAtMs: Date.UTC(y, m + 1, 1) }
}

/** A budget in words, for alerts, refusals and the dashboard. */
export function describeSpendBudget(scope: SpendBudgetScope, budget: SpendBudget, subjectLabel?: string): string {
  const whose =
    scope === 'workspace'
      ? 'Workspace'
      : scope === 'key'
        ? `Key ${subjectLabel ?? ''}`.trim()
        : subjectLabel === MEMBER_BUDGET_DEFAULT || subjectLabel === undefined
          ? 'Member'
          : `Member ${subjectLabel}`
  const per = budget.period === 'day' ? 'day' : 'month'
  return `${whose} ${budget.enforcement} budget: $${budget.limitUsd.toFixed(2)} per ${per}`
}
