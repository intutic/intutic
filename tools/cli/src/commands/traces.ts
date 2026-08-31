/**
 * `intutic traces` — List and inspect execution traces.
 *
 * Subcommands:
 *   - `intutic traces list [--limit N] [--since 24h] [--action TYPE] [--verdict TYPE] [--model NAME] [--json]`
 *   - `intutic traces inspect <trace_id>`
 *
 * With no connected control plane, both fall back to reading the proxy's
 * own local trace log (`~/.intutic/logs/traces-*.jsonl`) — see
 * `../lib/localTraces.js`. `--action` (BYPASS/ENHANCE/HIJACK/KILL) is a
 * connected-mode-only concept with no local equivalent; local mode's
 * `--verdict` filters on the proxy's own, narrower vocabulary instead.
 *
 * LLD #9 — PLG Self-Serve (Appendix: CLI Traces Commands)
 * TD-059
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl, getTracesLogDir } from '../config/paths.js'
import { createApiClient } from '../lib/api.js'
import pc from 'picocolors'
import type { TraceListResult, TraceDetail } from '@intutic/shared-types'
import { readLocalTraces, findLocalTraceById, LOCAL_VERDICTS, type LocalVerdict } from '../lib/localTraces.js'

// ─── Types ──────────────────────────────────────────────────────────

interface TraceListCliOpts {
  limit?: string
  since?: string
  action?: string
  verdict?: string
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

/** Color a local trace's verdict (the proxy's own vocabulary — LOCAL_VERDICTS). */
function colorVerdict(verdict: string): string {
  switch (verdict) {
    case 'allowed':
      return pc.green(verdict)
    case 'reasked':
      return pc.cyan(verdict)
    case 'hijacked':
      return pc.yellow(verdict)
    case 'killed':
    case 'upstream_error':
      return pc.red(verdict)
    default:
      return verdict
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
    await runTracesListLocal(opts)
    return
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
 * `intutic traces list`'s fallback when no control plane is connected —
 * reads the proxy's own local trace log directly. No compliance Score
 * column (there is no local compliance score) and no BYPASS/ENHANCE/
 * HIJACK/KILL `--action` filter (that vocabulary doesn't exist locally) —
 * see this module's doc comment.
 */
async function runTracesListLocal(opts: TraceListCliOpts): Promise<void> {
  if (opts.action) {
    log.error(
      `--action filters on BYPASS/ENHANCE/HIJACK/KILL, a connected-mode-only concept — there is no control plane connected, so there is nothing for it to filter. Use --verdict instead: one of ${LOCAL_VERDICTS.join(', ')}.`,
    )
    process.exit(1)
  }
  if (opts.verdict && !(LOCAL_VERDICTS as readonly string[]).includes(opts.verdict)) {
    log.error(`Unknown --verdict "${opts.verdict}". Must be one of: ${LOCAL_VERDICTS.join(', ')}.`)
    process.exit(1)
  }

  const sinceLabel = opts.since ?? '24h'
  const since = new Date(parseSince(sinceLabel))
  const limit = opts.limit ? parseInt(opts.limit, 10) : 20

  const result = await readLocalTraces({
    logsDir: getTracesLogDir(),
    since,
    limit,
    verdict: opts.verdict as LocalVerdict | undefined,
    model: opts.model,
  })

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  log.header('Intutic — Execution Traces (local)')
  log.dim('  No control plane connected — reading directly from ~/.intutic/logs/. No compliance score locally.')

  if (result.cappedFiles.length > 0) {
    log.warn(
      `  ${result.cappedFiles.join(', ')} reached the proxy's 64MB/day write cap — events past that point were dropped, so this day's trace count is a floor, not a complete record.`,
    )
  }
  if (result.malformedLines > 0) {
    log.warn(`  Skipped ${result.malformedLines} malformed or unparseable log line(s).`)
  }

  if (result.traces.length === 0) {
    log.dim('  No traces found matching your filters.')
    return
  }

  // No Score column: there is no local compliance score to put in it, and a
  // placeholder here would be exactly the kind of fabricated field this
  // remediation programme exists to remove.
  const headers = ['Trace ID', 'Timestamp', 'Model', 'Verdict', 'Cost']
  const widths = [14, 19, 16, 14, 9]

  const rows = result.traces.map((t) => [
    truncateId(t.traceId),
    formatTimestamp(t.timestamp),
    t.requestedModel.length > 16 ? t.requestedModel.slice(0, 15) + '…' : t.requestedModel,
    colorVerdict(t.verdict),
    formatCost(t.actualCostUsd),
  ])

  renderTable(headers, widths, rows)

  console.log(
    pc.dim(`Showing ${result.traces.length} of ${result.total} traces (last ${friendlyDuration(sinceLabel)})`),
  )
}

/** Syntax-highlight a JSON blob for terminal output. Shared by both inspect paths. */
function highlightJson(data: unknown): string {
  const json = JSON.stringify(data, null, 2)
  return json
    .replace(/"([^"]+)":/g, (_, key: string) => `${pc.cyan(`"${key}"`)}:`)
    .replace(/: "([^"]+)"/g, (_, val: string) => `: ${pc.green(`"${val}"`)}`)
    .replace(/: (\d+\.?\d*)/g, (_, num: string) => `: ${pc.yellow(num)}`)
    .replace(/: (true|false)/g, (_, b: string) => `: ${pc.magenta(b)}`)
    .replace(/: (null)/g, (_, n: string) => `: ${pc.dim(n)}`)
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
    await runTracesInspectLocal(traceId)
    return
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
    console.log(highlightJson(data))
  } catch (err) {
    log.error(
      `Failed to inspect trace: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

/**
 * `intutic traces inspect`'s fallback when no control plane is connected —
 * searches the proxy's own local trace log for a matching trace_id and
 * prints the raw record. Unlike connected mode, there is no per-trace API
 * call — this is a linear scan of the day-files, newest first.
 */
async function runTracesInspectLocal(traceId: string): Promise<void> {
  const data = await findLocalTraceById(getTracesLogDir(), traceId)

  if (!data) {
    log.error(`No trace "${traceId}" found in the local trace log (~/.intutic/logs/). No control plane connected, so only locally-logged traces are searchable.`)
    process.exit(1)
  }

  log.header('Intutic — Trace Detail (local)')
  log.field('Trace ID', String(data.trace_id))
  console.log('')
  console.log(highlightJson(data))
}


