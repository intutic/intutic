/**
 * `intutic incidents` — the workspace's governance incidents, as on the
 * dashboard's Findings › Incidents tab.
 *
 * Subcommands:
 *   - `intutic incidents list [--status] [--severity] [--type] [--page] [--limit] [--json]`
 *   - `intutic incidents show <incidentId> [--json]`
 *
 * Server side: `GET /api/v1/incidents` and `GET /api/v1/incidents/:id`
 * (services/control-plane/src/routes/incidents.ts), OWNER, ADMIN and EM only.
 * The list is ranked by review priority, not time, and bounded by a review
 * budget; the CLI says so when the budget withholds incidents, as the
 * dashboard does. `--severity` and `--type` are checked here before any
 * request, against the same lists the control plane checks.
 *
 * @module
 */

import pc from 'picocolors'
import { INCIDENT_TYPES, RiskLevel } from '@intutic/shared-types'
import { log } from '../lib/logger.js'
import { fail, positiveInt, runApiCommand, type ApiCommandOpts } from './apiCommand.js'

interface IncidentRow {
  incident_id: string
  trace_id: string | null
  session_id: string | null
  severity: string
  anomaly_type: string
  description: string
  resolution_status: string | null
  resolved_by: string | null
  resolved_at: string | null
  escalation_chain: Record<string, unknown> | null
  created_at: string | null
  review_priority?: number
}

interface IncidentList {
  data: IncidentRow[]
  meta: { total: number; page: number; limit: number; audit?: { budget: number; matched: number; withheld: number; overBudget: boolean } }
}

export interface IncidentListOpts extends ApiCommandOpts {
  status?: string
  severity?: string
  type?: string
  page?: string
  limit?: string
}

/** Most severe first, as the dashboard lists them. */
const SEVERITIES = (Object.values(RiskLevel) as string[]).reverse()

/** The route's query string for the given filters; fails on a severity or type the control plane would refuse. */
export function incidentQuery(opts: IncidentListOpts): string {
  const q = new URLSearchParams()
  if (opts.status) q.set('status', opts.status.toUpperCase())
  if (opts.severity) {
    const severity = opts.severity.toUpperCase()
    if (!SEVERITIES.includes(severity)) fail(`--severity must be one of ${SEVERITIES.join(', ')}, got "${opts.severity}"`)
    q.set('severity', severity)
  }
  if (opts.type) {
    const type = opts.type.toUpperCase()
    if (!(INCIDENT_TYPES as readonly string[]).includes(type)) fail(`--type must be one of ${INCIDENT_TYPES.join(', ')}, got "${opts.type}"`)
    q.set('type', type)
  }
  if (opts.page !== undefined) q.set('page', String(positiveInt(opts.page, '--page')))
  if (opts.limit !== undefined) {
    const limit = positiveInt(opts.limit, '--limit')
    if (limit > 100) fail(`--limit is at most 100, got ${limit}`)
    q.set('limit', String(limit))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

function severityLabel(severity: string): string {
  return severity === 'CRITICAL' || severity === 'HIGH' ? pc.red(severity) : severity === 'MEDIUM' ? pc.yellow(severity) : severity
}

/** `intutic incidents list` */
export async function runIncidentsList(opts: IncidentListOpts): Promise<void> {
  const path = `/api/v1/incidents${incidentQuery(opts)}`
  await runApiCommand(
    opts,
    'Failed to list incidents',
    (client) => client.get<IncidentList>(path),
    (res) => {
      log.header('Intutic — Incidents')
      if (res.data.length === 0) {
        log.dim('  No incidents match.')
        return
      }
      for (const i of res.data) {
        console.log(`  ${i.incident_id}  ${severityLabel(i.severity)}  ${i.anomaly_type}  ${i.resolution_status ?? 'OPEN'}  ${pc.dim(i.created_at ?? '')}`)
        log.dim(`    ${i.description}`)
      }
      const { total, page, limit, audit } = res.meta
      log.dim(`  Page ${page} of ${Math.max(1, Math.ceil(total / limit))}, ${total} matching, ranked by review priority.`)
      if (audit?.overBudget) {
        log.warn(`The review queue covers the ${audit.budget} most suspicious of ${audit.matched} matching incidents: ${audit.withheld} not shown.`)
      }
    },
  )
}

/** `intutic incidents show <incidentId>` */
export async function runIncidentsShow(incidentId: string, opts: ApiCommandOpts): Promise<void> {
  await runApiCommand(
    opts,
    `Failed to read incident ${incidentId}`,
    async (client) => (await client.get<{ data: IncidentRow }>(`/api/v1/incidents/${encodeURIComponent(incidentId)}`)).data,
    (i) => {
      log.header(`Intutic — Incident ${i.incident_id}`)
      log.field('Type', i.anomaly_type)
      log.field('Severity', severityLabel(i.severity))
      log.field('Status', i.resolution_status ?? 'OPEN')
      log.field('Created', i.created_at ?? '—')
      if (i.resolved_at) log.field('Resolved', `${i.resolved_at}${i.resolved_by ? ` by ${i.resolved_by}` : ''}`)
      if (i.session_id) log.field('Session', i.session_id)
      if (i.trace_id) log.field('Trace', i.trace_id)
      log.field('Description', i.description)
      if (i.escalation_chain) log.field('Details', JSON.stringify(i.escalation_chain))
    },
  )
}
