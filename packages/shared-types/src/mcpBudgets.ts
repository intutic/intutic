/**
 * MCP call budgets — how many MCP tool calls a workspace allows per hour or
 * per day, per server, per member, per tool, or per member on one server.
 *
 * An MCP tool call has no price of its own: the protocol's `tools/call` result
 * carries content, structured content, an error flag and `_meta`, and nothing
 * that reports cost (the only cost-shaped field in the specification,
 * `costPriority`, is a client's model preference for sampling). So a budget
 * counts calls.
 *
 * The workspace setting `mcpBudgets` holds the budgets. The control plane
 * validates it with {@link McpBudgetSettingsSchema} when an owner or admin
 * writes it, delivers it to every MCP proxy with the rest of the MCP policy,
 * and the proxy reads it with {@link parseMcpBudgetPolicy} and enforces it
 * against counters in Valkey before each call
 * (`packages/mcp-proxy/src/budget.ts`).
 *
 * @module
 */

import { z } from 'zod'

/**
 * What a budget counts:
 * - `server`        every call to one server;
 * - `tool`          every call to one tool on one server;
 * - `member`        each member's calls across every server;
 * - `member_server` each member's calls to one server.
 *
 * A `member` or `member_server` budget names one member, or none to give
 * every member their own allowance of the same size.
 */
export type McpBudgetScope = 'server' | 'tool' | 'member' | 'member_server'

/** A budget's period. Periods are fixed UTC windows: an hour starts on the hour, a day at 00:00 UTC. */
export type McpBudgetPeriod = 'hour' | 'day'

export interface McpBudget {
  /** Stable id, so a counter survives an edit to the limit. Named in refusals and alerts. */
  id: string
  scope: McpBudgetScope
  /** The server, for `server`, `tool` and `member_server`. */
  server?: string
  /** The tool, for `tool`. */
  tool?: string
  /** One member, for `member` and `member_server`; absent means each member separately. */
  memberId?: string
  period: McpBudgetPeriod
  /** Calls allowed per period. */
  limit: number
}

export interface McpBudgetPolicy {
  budgets: McpBudget[]
  /** A budget warns once per period when its calls reach this percentage of the limit. */
  warnAtPct: number
}

/** The LLM budget alert's default threshold, used here too so both kinds of budget warn alike. */
export const MCP_BUDGET_DEFAULT_WARN_PCT = 80
export const MAX_MCP_BUDGETS = 200
export const MAX_MCP_BUDGET_LIMIT = 1_000_000

export const MCP_BUDGET_SCOPES: readonly McpBudgetScope[] = ['server', 'tool', 'member', 'member_server']
export const MCP_BUDGET_PERIODS: readonly McpBudgetPeriod[] = ['hour', 'day']

const PERIOD_MS: Record<McpBudgetPeriod, number> = { hour: 3_600_000, day: 86_400_000 }

const BudgetSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, - and _, at most 40'),
    scope: z.enum(['server', 'tool', 'member', 'member_server']),
    server: z.string().min(1).max(256).optional(),
    tool: z.string().min(1).max(256).optional(),
    memberId: z.string().min(1).max(64).optional(),
    period: z.enum(['hour', 'day']),
    limit: z.number().int().min(1).max(MAX_MCP_BUDGET_LIMIT),
  })
  .strict()
  .superRefine((b, ctx) => {
    const needsServer = b.scope !== 'member'
    if (needsServer && !b.server) ctx.addIssue({ code: 'custom', path: ['server'], message: `a ${b.scope} budget names a server` })
    if (!needsServer && b.server) ctx.addIssue({ code: 'custom', path: ['server'], message: 'a member budget covers every server' })
    if (b.scope === 'tool' && !b.tool) ctx.addIssue({ code: 'custom', path: ['tool'], message: 'a tool budget names a tool' })
    if (b.scope !== 'tool' && b.tool) ctx.addIssue({ code: 'custom', path: ['tool'], message: 'only a tool budget names a tool' })
    const perMember = b.scope === 'member' || b.scope === 'member_server'
    if (!perMember && b.memberId) ctx.addIssue({ code: 'custom', path: ['memberId'], message: 'only a member budget names a member' })
  })

/**
 * The `mcpBudgets` workspace setting as an owner or admin writes it. Budget
 * ids are unique within a workspace: the id is part of the counter's key.
 */
export const McpBudgetSettingsSchema = z
  .object({
    budgets: z.array(BudgetSchema).max(MAX_MCP_BUDGETS),
    warnAtPct: z.number().int().min(1).max(99).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>()
    s.budgets.forEach((b, i) => {
      if (seen.has(b.id)) ctx.addIssue({ code: 'custom', path: ['budgets', i, 'id'], message: `duplicate budget id "${b.id}"` })
      seen.add(b.id)
    })
  })

export type McpBudgetSettings = z.infer<typeof McpBudgetSettingsSchema>

/**
 * Reads `mcpBudgets` as the control plane delivered it. Every budget is
 * checked on its own and a malformed one is dropped, so one bad entry never
 * lifts the others; anything that is not a settings object reads as no
 * budgets at all.
 */
export function parseMcpBudgetPolicy(value: unknown): McpBudgetPolicy {
  const empty: McpBudgetPolicy = { budgets: [], warnAtPct: MCP_BUDGET_DEFAULT_WARN_PCT }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty
  const raw = value as Record<string, unknown>
  const budgets: McpBudget[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw['budgets']) ? raw['budgets'] : []) {
    const parsed = BudgetSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    budgets.push(parsed.data)
  }
  const pct = raw['warnAtPct']
  const warnAtPct = typeof pct === 'number' && Number.isInteger(pct) && pct >= 1 && pct <= 99 ? pct : MCP_BUDGET_DEFAULT_WARN_PCT
  return { budgets, warnAtPct }
}

/** One tool call, as far as budgets are concerned. */
export interface McpBudgetCall {
  server: string
  tool: string
  /** The member the proxy's API key resolves to, when the control plane said. */
  memberId: string | null
  /**
   * Who to count a per-member budget against when no member is known — the
   * API key's prefix, say. Callers nobody can identify share one allowance.
   */
  fallbackCaller: string
}

/** A budget that applies to a call, and whose allowance the call draws on. */
export interface McpBudgetCharge {
  budget: McpBudget
  /** Distinguishes allowances within one budget: the member, for an each-member budget. */
  subject: string
}

/**
 * The budgets a call counts against, in the order they were configured. A
 * call draws on every one of them, and is refused when any is used up.
 */
export function budgetsForCall(policy: McpBudgetPolicy, call: McpBudgetCall): McpBudgetCharge[] {
  const caller = call.memberId ?? call.fallbackCaller
  const charges: McpBudgetCharge[] = []
  for (const budget of policy.budgets) {
    if (budget.server !== undefined && budget.server !== call.server) continue
    if (budget.tool !== undefined && budget.tool !== call.tool) continue
    if (budget.memberId !== undefined && budget.memberId !== call.memberId) continue
    const perMember = budget.scope === 'member' || budget.scope === 'member_server'
    charges.push({ budget, subject: perMember ? caller : '' })
  }
  return charges
}

/** The fixed window a moment falls in: when it began and when it resets. */
export function budgetWindow(period: McpBudgetPeriod, nowMs: number): { startMs: number; resetAtMs: number } {
  const size = PERIOD_MS[period]
  const startMs = Math.floor(nowMs / size) * size
  return { startMs, resetAtMs: startMs + size }
}

/** The call count at which a budget warns: `warnAtPct` of the limit, rounded up, at least one call. */
export function budgetWarnAt(limit: number, warnAtPct: number): number {
  return Math.max(1, Math.ceil((limit * warnAtPct) / 100))
}

/** A budget in words, for refusals, alerts and the dashboard: what it counts, and how many per period. */
export function describeMcpBudget(budget: McpBudget, memberLabel?: string): string {
  const who = budget.memberId ? (memberLabel ?? `member ${budget.memberId}`) : 'each member'
  const what =
    budget.scope === 'server'
      ? `calls to ${budget.server}`
      : budget.scope === 'tool'
        ? `calls to ${budget.server} › ${budget.tool}`
        : budget.scope === 'member'
          ? `MCP calls by ${who}`
          : `calls to ${budget.server} by ${who}`
  return `${what}: ${budget.limit} per ${budget.period}`
}
