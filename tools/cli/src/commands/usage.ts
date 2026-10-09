/**
 * `intutic usage` — LLM spend across the fleet for the day or the month: per
 * member, per team (SCIM group), per repository branch, per commit.
 *
 * Subcommands:
 *   - `intutic usage members|teams|branches|commits [--period daily|monthly] [--json]`
 *
 * Server side: `GET /api/v1/usage/{members,teams,branches,commits}`
 * (services/control-plane/src/routes/usage.ts). OWNER, ADMIN and EM see the
 * whole workspace; anyone else sees their own calls only (`scope: self`), and
 * `teams` is refused below EM.
 *
 * @module
 */

import type {
  BranchUsageResponse,
  CommitUsageResponse,
  MemberUsageResponse,
  TeamUsageResponse,
} from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

const PERIODS = ['daily', 'monthly'] as const

interface UsageOpts extends ApiCommandOpts {
  period?: string
}

interface Totals {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  traceCount: number
}

function totals(t: Totals): string {
  return `$${t.totalCostUsd.toFixed(4)}  ${t.traceCount} calls  ${t.totalInputTokens} in / ${t.totalOutputTokens} out tokens`
}

function row(label: string, t: Totals, extra = ''): void {
  console.log(`  ${label}`)
  console.log(`    ${totals(t)}${extra}`)
}

async function runUsage<T extends object>(
  view: 'members' | 'teams' | 'branches' | 'commits',
  opts: UsageOpts,
  render: (res: T) => void,
): Promise<void> {
  const period = opts.period ?? 'monthly'
  if (!(PERIODS as readonly string[]).includes(period)) fail(`--period must be daily or monthly, got "${period}"`)
  await runApiCommand(
    opts,
    `Failed to read usage by ${view}`,
    (client) => client.get<T>(`/api/v1/usage/${view}?period=${period}`),
    (res) => {
      log.header(`Intutic — Usage by ${view} (${period === 'daily' ? 'today' : 'this month'})`)
      if ('scope' in res && res.scope === 'self') log.dim('  Your own calls only: the workspace view needs OWNER, ADMIN or EM.')
      render(res)
    },
  )
}

function none(rows: unknown[]): boolean {
  if (rows.length === 0) log.dim('  No usage in this period.')
  return rows.length === 0
}

/** `intutic usage members` */
export async function runUsageMembers(opts: UsageOpts): Promise<void> {
  await runUsage<MemberUsageResponse>('members', opts, (res) => {
    if (none(res.members)) return
    for (const m of res.members) {
      const who = m.memberId === null ? 'Unattributed' : (m.displayName ?? m.email ?? m.memberId)
      row(who, m, `  ${m.activeDays} active days`)
    }
  })
}

/** `intutic usage teams` */
export async function runUsageTeams(opts: UsageOpts): Promise<void> {
  await runUsage<TeamUsageResponse>('teams', opts, (res) => {
    if (!res.scimGroups) {
      log.dim('  The workspace has no SCIM groups, so there are no teams; `intutic usage members` is the finest grouping.')
      return
    }
    if (none(res.teams)) return
    for (const t of res.teams) row(t.displayName, t, `  ${t.activeMembers}/${t.memberCount} members active`)
  })
}

/** `intutic usage branches` */
export async function runUsageBranches(opts: UsageOpts): Promise<void> {
  await runUsage<BranchUsageResponse>('branches', opts, (res) => {
    if (none(res.branches)) return
    for (const b of res.branches) {
      const where = b.repo === null ? 'No git context' : `${b.repo} ${b.branch ?? '(detached)'}`
      row(where, b, `  ${b.commitCount} commits`)
    }
  })
}

/** `intutic usage commits` */
export async function runUsageCommits(opts: UsageOpts): Promise<void> {
  await runUsage<CommitUsageResponse>('commits', opts, (res) => {
    if (none(res.commits)) return
    for (const c of res.commits) {
      const where = c.commit === null ? 'No git context' : `${c.repo ?? '?'} ${c.branch ?? '(detached)'} ${c.commit.slice(0, 12)}`
      row(where, c)
    }
  })
}
