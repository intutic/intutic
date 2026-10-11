/**
 * agentTools.ts — what the `intutic` MCP server's own tools answer.
 *
 * The standalone `intutic` entry (proxy.ts `runStandalone`) gives an agent
 * tools to ask about governance instead of guessing from a refusal message:
 * whether a hold it was given has been decided and whether a retry will
 * pass, what the MCP server registry says about a server, and how much of
 * each MCP call budget is left. The answers are built here, from what the
 * control plane and Valkey return, so they can be tested without a server.
 *
 * @module
 */

import { INCIDENT_TYPES, budgetWindow, describeMcpBudget, type McpBudgetPolicy } from '@intutic/shared-types'
import { z } from 'zod'
import { budgetCounterKey } from './budget.js'

/**
 * `intutic_list_incidents`'s arguments. `type` is checked against the same
 * list `GET /api/v1/incidents` checks it against, so an agent is told the
 * valid types instead of receiving the control plane's 400.
 */
export const LIST_INCIDENTS_ARGS = {
  limit: z.number().int().min(1).max(50).default(10).describe('Number of incidents to return (1–50)'),
  type: z
    .enum(INCIDENT_TYPES)
    .optional()
    .describe('Only incidents of this type: an anomaly type such as SCOPE_VIOLATION, or WASM_RULE_REFUSED or SYSTEM_ANOMALY'),
}

/** The control-plane path `intutic_list_incidents` reads. */
export function incidentListPath(workspaceId: string, args: { limit: number; type?: string }): string {
  const q = new URLSearchParams({ workspaceId, limit: String(args.limit) })
  if (args.type) q.set('type', args.type)
  return `/api/v1/incidents?${q}`
}

/** One control-plane read, never thrown: a failure degrades a tool's answer, it does not crash the server. */
export type ControlPlaneResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'unreachable' }

export async function readControlPlane(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  path: string,
): Promise<ControlPlaneResult> {
  try {
    const res = await fetch(`${controlPlaneUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'x-workspace-id': workspaceId },
      signal: AbortSignal.timeout(5000),
    })
    // 403 and 404 are answers, not outages. Collapsing them into
    // "unreachable" sends someone debugging their network for an hour.
    if (res.status === 403) return { ok: false, reason: 'forbidden' }
    if (res.status === 404) return { ok: false, reason: 'not_found' }
    if (!res.ok) return { ok: false, reason: 'unreachable' }
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** Renders a failed read as text for the agent, naming the actual cause. */
export function describeFailure(result: { reason: 'forbidden' | 'not_found' | 'unreachable' }, what: string): string {
  if (result.reason === 'forbidden') {
    return `Your Intutic role is not permitted to ${what}. This needs the OWNER, ADMIN or EM role.`
  }
  if (result.reason === 'not_found') return `The Intutic control plane answered 404 when asked to ${what}.`
  return `Could not reach control plane to ${what}.`
}

export interface HoldStatus {
  holdId: string
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | string
  /** What the agent should do next. */
  retry: 'wait' | 'passes' | 'held_again' | 'do_not_retry'
  /** Until when a retry passes, when it does. */
  bypassExpiresAt?: string
  message: string
}

/**
 * Where a hold stands, from its decision row and the workspace's approved
 * bypasses. An approval lets the identical retry through only while a bypass
 * exists for it, which needs the workspace's review-hold bypass setting on.
 */
export function holdStatus(holdId: string, decision: { status?: unknown }, bypasses: unknown): HoldStatus {
  const status = typeof decision.status === 'string' ? decision.status : 'UNKNOWN'
  if (status === 'PENDING_REVIEW') {
    return {
      holdId,
      status,
      retry: 'wait',
      message:
        'Waiting for an owner, admin or engineering manager to approve or reject it ' +
        `(intutic decision approve ${holdId}, or the Slack card). Do not retry yet; tell the user the hold id.`,
    }
  }
  if (status === 'REJECTED') {
    return { holdId, status, retry: 'do_not_retry', message: 'Rejected. Do not retry this call; continue without it or ask the user.' }
  }
  if (status === 'APPROVED') {
    const list = (bypasses as { bypasses?: unknown } | null)?.bypasses
    const bypass = Array.isArray(list)
      ? (list as Array<Record<string, unknown>>).find(
          (b) => b.holdId === holdId && typeof b.expiresAt === 'string' && Date.parse(b.expiresAt) > Date.now(),
        )
      : undefined
    if (bypass) {
      return {
        holdId,
        status,
        retry: 'passes',
        bypassExpiresAt: bypass.expiresAt as string,
        message: `Approved. Retry the identical call (same tool, same arguments) before ${String(bypass.expiresAt)}; any other call is not covered.`,
      }
    }
    return {
      holdId,
      status,
      retry: 'held_again',
      message:
        "Approved, but a retry will be held again: the workspace's review-hold bypass " +
        '(reviewHoldBypassEnabled) is off, or the approval window has passed. Tell the user the call was approved ' +
        'and needs to be run another way, or ask an admin to turn the bypass on.',
    }
  }
  return { holdId, status, retry: 'do_not_retry', message: `The hold is ${status}. Do not retry this call.` }
}

interface RegistryServer {
  serverName?: unknown
  status?: unknown
  heldForReview?: unknown
  disabledTools?: unknown
}

/**
 * What the registry means for calls to each server: whether calls to it run,
 * and which of its tools are switched off. `server` narrows it to one.
 */
export function registryStatus(data: unknown, server?: string): Record<string, unknown> {
  const body = (data ?? {}) as { servers?: unknown; defaultPolicy?: unknown }
  const defaultPolicy = body.defaultPolicy === 'deny' ? 'deny' : 'allow'
  const servers = (Array.isArray(body.servers) ? (body.servers as RegistryServer[]) : [])
    .filter((s) => typeof s.serverName === 'string' && (!server || s.serverName === server))
    .map((s) => {
      const status = String(s.status)
      const held = s.heldForReview === true
      const calls = held
        ? 'refused (SERVER_HELD): a high-risk tool change is waiting for an owner or admin'
        : status === 'blocked'
          ? 'refused (SERVER_BLOCKED)'
          : status === 'approved' || defaultPolicy === 'allow'
            ? 'allowed'
            : 'refused (SERVER_NOT_APPROVED): waiting in the approval queue'
      return {
        server: s.serverName,
        status,
        calls,
        disabledTools: Array.isArray(s.disabledTools) ? s.disabledTools : [],
      }
    })
  return {
    defaultPolicy,
    servers,
    ...(server && servers.length === 0
      ? {
          note:
            defaultPolicy === 'deny'
              ? `"${server}" is not in the registry; calls to it are refused (SERVER_NOT_APPROVED) until an owner or admin approves it.`
              : `"${server}" is not in the registry yet; calls to it are allowed under the default policy.`,
        }
      : {}),
  }
}

export interface BudgetRemaining {
  budgetId: string
  counts: string
  period: string
  limit: number
  /** `null` when the count could not be read. */
  used: number | null
  remaining: number | null
  resetAt: string
}

/**
 * Every MCP call budget that can count this caller's calls, with what is
 * left of it this period. `readUsed` reads the counters the proxies keep
 * (budget.ts), returning `undefined` when it cannot.
 */
export async function budgetRemaining(
  policy: McpBudgetPolicy,
  workspaceId: string,
  caller: { memberId: string | null; fallback: string },
  readUsed: (keys: string[]) => Promise<number[] | undefined>,
  nowMs: number = Date.now(),
): Promise<BudgetRemaining[]> {
  const mine = policy.budgets.filter((b) => b.memberId === undefined || b.memberId === caller.memberId)
  const subject = caller.memberId ?? caller.fallback
  const windows = mine.map((b) => budgetWindow(b.period, nowMs))
  const keys = mine.map((b, i) =>
    budgetCounterKey(workspaceId, b.id, windows[i]!.startMs, b.scope === 'member' || b.scope === 'member_server' ? subject : ''),
  )
  const used = keys.length > 0 ? await readUsed(keys) : []
  return mine.map((b, i) => {
    const n = used?.[i]
    return {
      budgetId: b.id,
      counts: describeMcpBudget(b, b.memberId ? 'you' : undefined),
      period: b.period,
      limit: b.limit,
      used: n ?? null,
      remaining: n === undefined ? null : Math.max(0, b.limit - n),
      resetAt: new Date(windows[i]!.resetAtMs).toISOString(),
    }
  })
}
