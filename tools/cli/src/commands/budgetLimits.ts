/**
 * `intutic budget set|keys|key|members|member` — the workspace caps, and the
 * spend budgets and rate limits on virtual keys and members.
 *
 * Subcommands:
 *   - `intutic budget set [--daily <usd>] [--monthly <usd>] [--threshold <pct>]
 *      [--daily-enforcement hard|soft] [--monthly-enforcement hard|soft]`
 *   - `intutic budget keys [--json]`
 *   - `intutic budget key <keyId> [--daily <usd|none>] [--monthly <usd|none>]
 *      [--daily-enforcement hard|soft] [--monthly-enforcement hard|soft]
 *      [--rpm <n|none>] [--tpm <n|none>]`
 *   - `intutic budget members [--json]`
 *   - `intutic budget member <memberId|default> [--daily <usd|none>]
 *      [--monthly <usd|none>] [--daily-enforcement hard|soft]
 *      [--monthly-enforcement hard|soft]`
 *
 * Server side (services/control-plane/src/routes/budget.ts, routes/keys.ts):
 * `PUT /api/v1/budget`, `GET /api/v1/budget/keys`, `PATCH /api/v1/keys/:id`,
 * `GET /api/v1/budget/members`, `PUT /api/v1/budget/members/:memberId`. The
 * writes need OWNER or ADMIN, and member budgets a plan with them; the
 * server's refusal is printed as it says it.
 *
 * Every write here changes only what its flags name: the others are read
 * first and sent back unchanged, because the routes replace a subject's
 * budgets whole.
 *
 * @module
 */

import type { KeyRateLimit, SpendBudget, SpendBudgetEnforcement, SpendBudgetPeriod } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

interface BudgetFlags extends ApiCommandOpts {
  daily?: string
  monthly?: string
  dailyEnforcement?: string
  monthlyEnforcement?: string
}

interface KeyFlags extends BudgetFlags {
  rpm?: string
  tpm?: string
}

interface SetFlags extends ApiCommandOpts {
  daily?: string
  monthly?: string
  threshold?: string
  dailyEnforcement?: string
  monthlyEnforcement?: string
}

interface KeyRow {
  keyId: string
  keyPrefix: string
  label: string
  memberId: string
  memberEmail: string
  budgets: SpendBudget[]
  rateLimit: KeyRateLimit
  spendTodayUsd: number
  spendThisMonthUsd: number
}

interface KeysResponse {
  keys: KeyRow[]
  dayResetsAt: string
  monthResetsAt: string
}

interface MemberRow {
  memberId: string
  email: string
  budgets: SpendBudget[]
  effectiveBudgets: SpendBudget[]
  spendTodayUsd: number
  spendThisMonthUsd: number
}

interface MembersResponse {
  defaultBudgets: SpendBudget[]
  members: MemberRow[]
  dayResetsAt: string
  monthResetsAt: string
}

interface WorkspaceBudget {
  daily_budget_usd: number
  monthly_budget_usd: number
  alert_threshold_pct: number
  daily_enforcement: SpendBudgetEnforcement
  monthly_enforcement: SpendBudgetEnforcement
}

const usd = (n: number) => `$${n.toFixed(2)}`

/** A dollar amount, or `none` (returned as `null`), or fails naming the flag. */
function amountOrNone(value: string, flag: string): number | null {
  if (value.trim().toLowerCase() === 'none') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a dollar amount above 0, or "none", got "${value}"`)
  return n
}

/** A whole number, or `none` (returned as `null`), or fails naming the flag. */
function countOrNone(value: string, flag: string): number | null {
  if (value.trim().toLowerCase() === 'none') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive whole number, or "none", got "${value}"`)
  return n
}

function enforcement(value: string | undefined, flag: string): SpendBudgetEnforcement | undefined {
  if (value === undefined) return undefined
  if (value !== 'hard' && value !== 'soft') fail(`${flag} must be hard or soft, got "${value}"`)
  return value
}

/**
 * `current` with the periods the flags name changed: `--daily none` removes
 * the day budget, `--daily 5` sets it (keeping its enforcement unless
 * `--daily-enforcement` says otherwise, hard for a new one), and an
 * enforcement flag alone changes an existing budget's.
 */
export function applyBudgetFlags(current: readonly SpendBudget[], flags: BudgetFlags): SpendBudget[] {
  const out = new Map<SpendBudgetPeriod, SpendBudget>(current.map((b) => [b.period, { ...b }]))
  for (const [period, amount, mode, flag] of [
    ['day', flags.daily, flags.dailyEnforcement, '--daily'],
    ['month', flags.monthly, flags.monthlyEnforcement, '--monthly'],
  ] as const) {
    const how = enforcement(mode, `${flag}-enforcement`)
    if (amount !== undefined) {
      const limitUsd = amountOrNone(amount, flag)
      if (limitUsd === null) out.delete(period)
      else out.set(period, { period, limitUsd, enforcement: how ?? out.get(period)?.enforcement ?? 'hard' })
    } else if (how) {
      const existing = out.get(period)
      if (!existing) fail(`${flag}-enforcement needs a ${period} budget: set one with ${flag} <usd>`)
      existing.enforcement = how
    }
  }
  return [...out.values()].sort((a, b) => (a.period === b.period ? 0 : a.period === 'day' ? -1 : 1))
}

/** One budget list in words: `$5.00/day hard, $50.00/month soft`, or `none`. */
export function describeBudgets(budgets: readonly SpendBudget[]): string {
  if (budgets.length === 0) return 'none'
  return budgets.map((b) => `${usd(b.limitUsd)}/${b.period} ${b.enforcement}`).join(', ')
}

function describeRateLimit(r: KeyRateLimit): string {
  const parts = [r.rpm ? `${r.rpm} requests/min` : '', r.tpm ? `${r.tpm} tokens/min` : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : 'none'
}

function hasBudgetFlags(flags: BudgetFlags): boolean {
  return [flags.daily, flags.monthly, flags.dailyEnforcement, flags.monthlyEnforcement].some((v) => v !== undefined)
}

export async function runBudgetSet(opts: SetFlags): Promise<void> {
  if ([opts.daily, opts.monthly, opts.threshold, opts.dailyEnforcement, opts.monthlyEnforcement].every((v) => v === undefined)) {
    fail('Nothing to change: pass --daily, --monthly, --threshold, --daily-enforcement or --monthly-enforcement')
  }
  const daily = opts.daily === undefined ? undefined : Number(opts.daily)
  const monthly = opts.monthly === undefined ? undefined : Number(opts.monthly)
  const threshold = opts.threshold === undefined ? undefined : Number(opts.threshold)
  if (daily !== undefined && !(daily >= 0)) fail(`--daily must be a dollar amount, 0 for no daily cap, got "${opts.daily}"`)
  if (monthly !== undefined && !(monthly >= 0)) fail(`--monthly must be a dollar amount, 0 for no monthly cap, got "${opts.monthly}"`)
  if (threshold !== undefined && !(Number.isInteger(threshold) && threshold >= 1 && threshold <= 100)) {
    fail(`--threshold must be a whole percentage from 1 to 100, got "${opts.threshold}"`)
  }
  const dailyEnforcement = enforcement(opts.dailyEnforcement, '--daily-enforcement')
  const monthlyEnforcement = enforcement(opts.monthlyEnforcement, '--monthly-enforcement')

  await runApiCommand(
    opts,
    'Failed to update the workspace budget',
    async (client) => {
      const now = await client.get<WorkspaceBudget>('/api/v1/budget')
      const body = {
        daily_budget_usd: daily ?? now.daily_budget_usd,
        monthly_budget_usd: monthly ?? now.monthly_budget_usd,
        alert_threshold_pct: threshold ?? now.alert_threshold_pct,
        ...(dailyEnforcement ? { daily_enforcement: dailyEnforcement } : {}),
        ...(monthlyEnforcement ? { monthly_enforcement: monthlyEnforcement } : {}),
      }
      await client.put('/api/v1/budget', body)
      return client.get<WorkspaceBudget>('/api/v1/budget')
    },
    (b) => {
      log.success('Workspace budget updated')
      log.field('Daily cap', `${usd(b.daily_budget_usd)} (${b.daily_enforcement})`)
      log.field('Monthly cap', `${usd(b.monthly_budget_usd)} (${b.monthly_enforcement})`)
      log.field('Alert at', `${b.alert_threshold_pct}%`)
    },
  )
}

export async function runBudgetKeys(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list key budgets',
    (client) => client.get<KeysResponse>('/api/v1/budget/keys'),
    (res) => {
      log.header('Virtual key budgets')
      if (res.keys.length === 0) console.log('  No live keys.')
      for (const k of res.keys) {
        console.log(`  ${k.keyPrefix}…  ${k.label}  (${k.keyId}, ${k.memberEmail})`)
        console.log(`    Spent today ${usd(k.spendTodayUsd)}, this month ${usd(k.spendThisMonthUsd)}`)
        console.log(`    Budgets: ${describeBudgets(k.budgets)}   Rate limit: ${describeRateLimit(k.rateLimit)}`)
      }
      console.log(`  Days reset at ${res.dayResetsAt}; months at ${res.monthResetsAt} (UTC).`)
    },
  )
}

export async function runBudgetKey(keyId: string, opts: KeyFlags): Promise<void> {
  const budgetsChange = hasBudgetFlags(opts)
  if (!budgetsChange && opts.rpm === undefined && opts.tpm === undefined) {
    fail('Nothing to change: pass --daily, --monthly, an enforcement flag, --rpm or --tpm')
  }
  const rateLimit: Partial<KeyRateLimit> = {}
  if (opts.rpm !== undefined) rateLimit.rpm = countOrNone(opts.rpm, '--rpm')
  if (opts.tpm !== undefined) rateLimit.tpm = countOrNone(opts.tpm, '--tpm')

  await runApiCommand(
    opts,
    `Failed to update key ${keyId}`,
    async (client) => {
      let budgets: SpendBudget[] | undefined
      if (budgetsChange) {
        const listed = await client.get<KeysResponse>('/api/v1/budget/keys')
        const current = listed.keys.find((k) => k.keyId === keyId)
        if (!current) throw new Error(`no live key ${keyId} in this workspace`)
        budgets = applyBudgetFlags(current.budgets, opts)
      }
      return client.patch<{ keyId: string; budgets: SpendBudget[]; rateLimit: KeyRateLimit }>(`/api/v1/keys/${keyId}`, {
        ...(budgets ? { budgets } : {}),
        ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
      })
    },
    (k) => {
      log.success(`Key ${k.keyId} updated`)
      log.field('Budgets', describeBudgets(k.budgets))
      log.field('Rate limit', describeRateLimit(k.rateLimit))
    },
  )
}

export async function runBudgetMembers(opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    'Failed to list member budgets',
    (client) => client.get<MembersResponse>('/api/v1/budget/members'),
    (res) => {
      log.header('Member budgets')
      log.field('Default (every member without their own)', describeBudgets(res.defaultBudgets))
      for (const m of res.members) {
        console.log(`  ${m.email}  (${m.memberId})`)
        console.log(`    Spent today ${usd(m.spendTodayUsd)}, this month ${usd(m.spendThisMonthUsd)}`)
        console.log(`    Own: ${describeBudgets(m.budgets)}   Applies: ${describeBudgets(m.effectiveBudgets)}`)
      }
      console.log(`  Days reset at ${res.dayResetsAt}; months at ${res.monthResetsAt} (UTC).`)
    },
  )
}

export async function runBudgetMember(memberId: string, opts: BudgetFlags): Promise<void> {
  if (!hasBudgetFlags(opts)) fail('Nothing to change: pass --daily, --monthly or an enforcement flag')
  await runApiCommand(
    opts,
    `Failed to update the budgets of ${memberId}`,
    async (client) => {
      const listed = await client.get<MembersResponse>('/api/v1/budget/members')
      const current = memberId === 'default' ? listed.defaultBudgets : listed.members.find((m) => m.memberId === memberId)?.budgets
      if (!current) throw new Error(`no active member ${memberId} in this workspace`)
      return client.put<{ memberId: string; budgets: SpendBudget[] }>(`/api/v1/budget/members/${encodeURIComponent(memberId)}`, {
        budgets: applyBudgetFlags(current, opts),
      })
    },
    (m) => {
      log.success(m.memberId === 'default' ? 'Default member budget updated' : `Budgets of ${m.memberId} updated`)
      log.field('Budgets', describeBudgets(m.budgets))
    },
  )
}
