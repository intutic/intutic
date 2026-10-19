/**
 * approvedPlans.ts — ships the workspace's approved plans *to* the machine,
 * for `plan_approval:` at the hook gates, as
 * `approvedBypasses.ts` ships approved bypasses.
 *
 * # The contract with the gate
 *
 * `~/.intutic/hooks/approved-plans.jsonl` — the directory every gate already
 * refuses an agent's write to (`UNIVERSAL_PROTECTED_PATHS`). One JSON line
 * per APPROVED or EXECUTING plan updated in the last seven days, as
 * `GET /api/v1/plans/approved` returns it: `{sessionId, planId, state, tools,
 * updatedAt}`, where `tools` is the plan's steps flattened to tool names by
 * the control plane, so a gate compares names only. Header lines carry
 * integrity exactly as the bypass cache does: `#digest` (sha256 of the body,
 * first 32 hex chars) and `#workspace`. And `#expires`: three sync intervals
 * after the write. A plan that was approved and then rejected must stop
 * counting within a bounded time even if the daemon dies, so a gate reads a
 * cache past `#expires` — or missing, or failing either check — as "no plan
 * approved", which refuses. That is the opposite direction from the policy
 * snapshot, whose staleness only alerts: there, stale rules still refuse;
 * here, a stale cache could only allow.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createLogger } from '@intutic/logger'
import { writeFileAtomic } from './atomicWrite.js'
import { APPROVED_PLANS_FILE } from '../harness/gateBody.js'

const log = createLogger('sync-approved-plans')

export const DEFAULT_PLAN_CACHE_DIR = path.join(os.homedir(), '.intutic', 'hooks')
export { APPROVED_PLANS_FILE }

/** The daemon's default sync interval (`intutic connect --interval`). */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000

/** How many sync intervals a written cache counts for. */
export const APPROVED_PLANS_TTL_INTERVALS = 3

/** One approved plan, as `GET /api/v1/plans/approved` returns it. */
export interface ApprovedPlanEntry {
  sessionId: string
  planId: string
  state: 'APPROVED' | 'EXECUTING'
  tools: string[]
  updatedAt: string
}

export interface ApprovedPlanOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** Override the directory (tests). */
  cacheDir?: string
  /** The sync interval the cache must outlive; `#expires` is three of them. */
  syncIntervalMs?: number
}

function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/**
 * The workspace's approved plans, or null on any failure: the caller keeps
 * the previous cache, which expires on its own.
 */
export async function fetchApprovedPlans(opts: ApprovedPlanOptions): Promise<ApprovedPlanEntry[] | null> {
  const url = `${trimTrailingSlashes(opts.controlPlaneUrl)}/api/v1/plans/approved?workspaceId=${encodeURIComponent(opts.workspaceId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn({ action: 'approved_plans_fetch_failed', status: res.status }, 'plans/approved returned non-OK')
      return null
    }
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null) return null
    const rows = (body as { plans?: unknown }).plans
    if (!Array.isArray(rows)) return null
    return rows
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .filter(
        (r) =>
          typeof r.sessionId === 'string' &&
          r.sessionId !== '' &&
          typeof r.planId === 'string' &&
          (r.state === 'APPROVED' || r.state === 'EXECUTING') &&
          Array.isArray(r.tools) &&
          typeof r.updatedAt === 'string',
      )
      .map((r) => ({
        sessionId: r.sessionId as string,
        planId: r.planId as string,
        state: r.state as ApprovedPlanEntry['state'],
        tools: (r.tools as unknown[]).filter((t): t is string => typeof t === 'string'),
        updatedAt: r.updatedAt as string,
      }))
  } catch (err) {
    log.warn({ action: 'approved_plans_fetch_failed', err }, 'plans/approved unreachable')
    return null
  }
}

/** Writes the cache atomically, read-only, with its digest, workspace and expiry headers. */
export async function writeApprovedPlans(
  entries: ApprovedPlanEntry[],
  workspaceId: string,
  cacheDir: string = DEFAULT_PLAN_CACHE_DIR,
  opts: { now?: Date; syncIntervalMs?: number } = {},
): Promise<{ digest: string; count: number; expiresAt: string }> {
  const now = opts.now ?? new Date()
  const interval = opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  const expiresAt = new Date(now.getTime() + APPROVED_PLANS_TTL_INTERVALS * interval).toISOString()
  const lines = entries.map((e) => JSON.stringify(e))
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  const text =
    `# Intutic approved plans (plan_approval:) — auto-generated. DO NOT EDIT.\n` +
    `#digest ${digest}\n` +
    `#workspace ${workspaceId}\n` +
    `#generated ${now.toISOString()}\n` +
    `#expires ${expiresAt}\n` +
    (lines.length > 0 ? lines.join('\n') + '\n' : '')
  await fs.mkdir(cacheDir, { recursive: true })
  await writeFileAtomic(path.join(cacheDir, APPROVED_PLANS_FILE), text, { mode: 0o444 })
  log.debug({ action: 'approved_plans_written', digest, count: entries.length, dir: cacheDir }, 'Approved-plans cache refreshed')
  return { digest, count: entries.length, expiresAt }
}

/**
 * Fetch and write in one call, on every sync cycle. Never throws; a failed
 * poll leaves the previous cache, which a gate stops trusting at its
 * `#expires`.
 */
export async function refreshApprovedPlans(
  opts: ApprovedPlanOptions,
): Promise<{ digest: string; count: number; expiresAt: string } | null> {
  const entries = await fetchApprovedPlans(opts)
  if (entries === null) return null
  try {
    return await writeApprovedPlans(entries, opts.workspaceId, opts.cacheDir ?? DEFAULT_PLAN_CACHE_DIR, {
      syncIntervalMs: opts.syncIntervalMs,
    })
  } catch (err) {
    log.warn({ action: 'approved_plans_write_failed', err }, 'Could not write the approved-plans cache')
    return null
  }
}
