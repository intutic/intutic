/**
 * `intutic traces` — List and inspect execution traces.
 *
 * Subcommands:
 *   - `intutic traces list [--limit N] [--since 24h] [--action TYPE] [--model NAME] [--json]`
 *   - `intutic traces inspect <trace_id>`
 *
 * LLD #9 — PLG Self-Serve (Appendix: CLI Traces Commands)
 * TD-059
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'
import type { TraceSummary, TraceListResult, TraceDetail } from '@intutic/shared-types'

// ─── Types ──────────────────────────────────────────────────────────

interface TraceListCliOpts {
  limit?: string
  since?: string
  action?: string
  model?: string
  json?: boolean
  dev?: boolean
}

// ─── Duration Parser ────────────────────────────────────────────────

/**
 * Parses a human-friendly duration string (e.g. "24h", "7d", "30m")
 * into an ISO timestamp for the `since` query parameter.
 */
function parseSince(since: string): string {
  const match = since.match(/^(\d+)(m|h|d)$/i)
  if (!match) {
    // Treat as raw ISO timestamp if not a duration
    return since
  }

  const value = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const now = Date.now()

  let ms: number
  switch (unit) {
    case 'm':
      ms = value * 60 * 1000
      break
    case 'h':
      ms = value * 60 * 60 * 1000
      break
    case 'd':
      ms = value * 24 * 60 * 60 * 1000
      break
    default:
      ms = 24 * 60 * 60 * 1000
  }

  return new Date(now - ms).toISOString()
}

// ─── Formatting Helpers ─────────────────────────────────────────────

/** Truncate a trace ID for table display (e.g. "tr_abc123..." → 14 chars). */
function truncateId(id: string): string {
  if (id.length <= 14) return id
  return id.slice(0, 11) + '...'
}

/** Format ISO timestamp for compact table display. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Color enforcement action based on severity. */
function colorAction(action: string): string {
  switch (action) {
    case 'BYPASS':
      return pc.green(action)
    case 'ENHANCE':
      return pc.cyan(action)
    case 'HIJACK':
      return pc.yellow(action)
    case 'KILL':
      return pc.red(action)
    default:
      return action
  }
}

/** Color compliance score (green ≥0.8, yellow ≥0.5, red <0.5). */
function colorScore(score: number): string {
  const s = score.toFixed(2)
  if (score >= 0.8) return pc.green(s)
  if (score >= 0.5) return pc.yellow(s)
  return pc.red(s)
}

/** Format cost as USD with dollar sign. */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

/** Pad a string to a fixed width (right-pad with spaces). */
function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width)
  return str + ' '.repeat(width - str.length)
}

/** Render a simple table with borders. */
function renderTable(
  headers: string[],
  widths: number[],
  rows: string[][],
): void {
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐'
  const mid = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤'
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘'

  const fmtRow = (cells: string[]) =>
    '│ ' + cells.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │'

  console.log(top)
  console.log(fmtRow(headers))
  console.log(mid)
  for (const row of rows) {
    console.log(fmtRow(row))
  }
  console.log(bot)
}

// ─── Friendly duration label (for footer) ───────────────────────────

function friendlyDuration(since: string): string {
  const match = since.match(/^(\d+)(m|h|d)$/i)
  if (!match) return since
  const val = match[1]
  const unit = match[2].toLowerCase()
  const labels: Record<string, string> = { m: 'minute', h: 'hour', d: 'day' }
  const label = labels[unit] ?? unit
  return `${val} ${label}${Number(val) !== 1 ? 's' : ''}`
}

// ─── Commands ───────────────────────────────────────────────────────

/**
 * `intutic traces list` — List execution traces for the authenticated workspace.
 */
export async function runTracesList(opts: TraceListCliOpts): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  // Build query params
  const params = new URLSearchParams()
  if (opts.limit) params.set('limit', opts.limit)
  if (opts.since) params.set('since', parseSince(opts.since))
  if (opts.action) params.set('enforcement', opts.action)
  if (opts.model) params.set('model', opts.model)

  try {
    const data = await client.get<TraceListResult>(
      `/api/v1/traces?${params.toString()}`,
    )

    // ── JSON output mode ──
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    // ── Table output mode ──
    log.header('Intutic — Execution Traces')

    if (data.traces.length === 0) {
      log.dim('  No traces found matching your filters.')
      return
    }

    const headers = ['Trace ID', 'Timestamp', 'Model', 'Action', 'Score', 'Cost']
    const widths = [14, 19, 16, 8, 5, 9]

    const rows = data.traces.map((t) => [
      truncateId(t.traceId),
      formatTimestamp(t.timestamp),
      t.requestedModel.length > 16
        ? t.requestedModel.slice(0, 15) + '…'
        : t.requestedModel,
      colorAction(t.enforcementAction),
      colorScore(t.complianceScore),
      formatCost(t.actualCostUsd),
    ])

    renderTable(headers, widths, rows)

    const sinceLabel = opts.since ?? '24h'
    console.log(
      pc.dim(
        `Showing ${data.traces.length} of ${data.total} traces (last ${friendlyDuration(sinceLabel)})`,
      ),
    )
  } catch (err) {
    log.error(
      `Failed to list traces: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

/**
 * `intutic traces inspect <trace_id>` — Show full detail of a single trace.
 */
export async function runTracesInspect(
  traceId: string,
  opts: { dev?: boolean },
): Promise<void> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error('Not authenticated. Run `intutic login` first.')
    process.exit(1)
  }

  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  const client = createApiClient(controlPlaneUrl, creds.apiKey)

  try {
    const data = await client.get<TraceDetail>(
      `/api/v1/traces/${encodeURIComponent(traceId)}`,
    )

    log.header(`Intutic — Trace Detail`)
    log.field('Trace ID', String(data.traceId))
    console.log('')

    // Syntax-highlighted JSON output
    const json = JSON.stringify(data, null, 2)
    const highlighted = json
      .replace(/"([^"]+)":/g, (_, key: string) => `${pc.cyan(`"${key}"`)}:`)
      .replace(/: "([^"]+)"/g, (_, val: string) => `: ${pc.green(`"${val}"`)}`)
      .replace(/: (\d+\.?\d*)/g, (_, num: string) => `: ${pc.yellow(num)}`)
      .replace(/: (true|false)/g, (_, b: string) => `: ${pc.magenta(b)}`)
      .replace(/: (null)/g, (_, n: string) => `: ${pc.dim(n)}`)

    console.log(highlighted)
  } catch (err) {
    log.error(
      `Failed to inspect trace: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}


