/**
 * Local traces reader — Wave 5 of the audit-remediation plan.
 *
 * `intutic traces list`/`inspect` used to require a connected control plane
 * and exit(1) with no fallback, even though the proxy has been writing every
 * trace to `~/.intutic/logs/traces-YYYY-MM-DD.jsonl` all along (see
 * `packages/proxy/src/local_spend.rs`'s `log_offline_trace`). This is the
 * reader for that log — the only place a standalone user can see their own
 * traffic without a control plane.
 *
 * Deliberately its own narrow type (`LocalTraceRow`), not `TraceSummary`
 * (`@intutic/shared-types`): that type's `complianceScore` is a required,
 * non-optional field, and there is no compliance score locally — a
 * standalone proxy's `response_integrity` is documented as explicitly not a
 * quality or compliance measure. Reusing `TraceSummary` here would force
 * either a fabricated score or a type-level lie; a narrower type that
 * doesn't have the field at all is the honest option.
 *
 * The verdict vocabulary is also narrower than connected mode's
 * BYPASS/ENHANCE/HIJACK/KILL (a control-plane PCAS concept). Locally,
 * `ExecutionTrace.verdict` is exactly one of: allowed, killed,
 * upstream_error, reasked, hijacked — see LOCAL_VERDICTS below, kept in
 * sync with `telemetry.rs`'s construction sites by
 * `localTracesFieldParity.test.ts`.
 */
import { readdir, stat } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

/** The complete local verdict vocabulary — see this file's module doc. */
export const LOCAL_VERDICTS = ['allowed', 'killed', 'upstream_error', 'reasked', 'hijacked'] as const
export type LocalVerdict = (typeof LOCAL_VERDICTS)[number]

/**
 * A trace row read from the local JSONL log, narrowed to what the `list`
 * table and `--json` output actually use. Field names are camelCase here —
 * the on-disk JSONL is the proxy's own snake_case `ExecutionTrace` — this
 * module is the one place that translates between them.
 */
export interface LocalTraceRow {
  traceId: string
  timestamp: string
  requestedModel: string
  actualModelRouted: string
  verdict: string
  rawCostUsd: number
  actualCostUsd: number
  harnessType: string
  latencyMs: number
  cacheHit: boolean
  breakGlass: boolean
}

export interface LocalTracesResult {
  traces: LocalTraceRow[]
  /** Every trace found within the window, before `limit` truncation — not a fabricated estimate. */
  total: number
  /** Lines that failed to parse or were missing a required field — counted, not silenced. */
  malformedLines: number
  /**
   * Day-files that had already reached the proxy's 64MB write cap
   * (`MAX_TRACE_LOG_BYTES`, `local_spend.rs`) at read time. Writes past
   * that size are silently dropped by the proxy, so a capped day's trace
   * count is a floor, not a complete record — this is the only place a
   * user can learn that.
   */
  cappedFiles: string[]
}

/** Matches the proxy's own filename shape from `log_offline_trace`. */
const TRACE_FILE_RE = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/

/** `local_spend.rs`'s `MAX_TRACE_LOG_BYTES` — kept in sync by localTracesFieldParity.test.ts. */
const MAX_TRACE_LOG_BYTES = 64 * 1024 * 1024

function toLocalTraceRow(raw: Record<string, unknown>): LocalTraceRow | null {
  if (
    typeof raw.trace_id !== 'string' ||
    typeof raw.created_at !== 'string' ||
    typeof raw.requested_model !== 'string' ||
    typeof raw.actual_model_routed !== 'string' ||
    typeof raw.verdict !== 'string'
  ) {
    return null
  }
  return {
    traceId: raw.trace_id,
    timestamp: raw.created_at,
    requestedModel: raw.requested_model,
    actualModelRouted: raw.actual_model_routed,
    verdict: raw.verdict,
    rawCostUsd: typeof raw.raw_cost_usd === 'number' ? raw.raw_cost_usd : 0,
    actualCostUsd: typeof raw.actual_cost_usd === 'number' ? raw.actual_cost_usd : 0,
    harnessType: typeof raw.harness_type === 'string' ? raw.harness_type : 'unknown',
    latencyMs: typeof raw.latency_ms === 'number' ? raw.latency_ms : 0,
    cacheHit: raw.cache_hit === true,
    breakGlass: raw.break_glass === true,
  }
}

/** Day-shard filenames under `logsDir`, most recent day first. */
async function dayFilesDescending(logsDir: string): Promise<string[]> {
  if (!existsSync(logsDir)) return []
  const entries = await readdir(logsDir)
  return entries
    .filter((name) => TRACE_FILE_RE.test(name))
    .sort()
    .reverse()
}

/**
 * Reads every trace in `[since, now]` from the local daily-sharded log,
 * walking day-files newest-first and, within each file, lines newest-first
 * (append-only, so the last line of a day is that day's most recent trace).
 * Stops scanning a file (and every earlier file) as soon as a line's
 * timestamp falls before `since` — traces only get older from there.
 */
export async function readLocalTraces(opts: {
  logsDir: string
  since: Date
  limit: number
  /** Exact match against LocalTraceRow.verdict, applied before `limit`. */
  verdict?: string
  /** Exact match against LocalTraceRow.requestedModel, applied before `limit`. */
  model?: string
}): Promise<LocalTracesResult> {
  const { logsDir, since, limit, verdict, model } = opts
  const files = await dayFilesDescending(logsDir)

  const collected: LocalTraceRow[] = []
  let malformedLines = 0
  const cappedFiles: string[] = []

  for (const file of files) {
    const path = join(logsDir, file)

    try {
      const { size } = await stat(path)
      if (size >= MAX_TRACE_LOG_BYTES) cappedFiles.push(file)
    } catch {
      continue
    }

    const lines: string[] = []
    const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.trim().length > 0) lines.push(line)
    }

    let dayExhausted = false
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: unknown
      try {
        parsed = JSON.parse(lines[i])
      } catch {
        malformedLines++
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) {
        malformedLines++
        continue
      }
      const row = toLocalTraceRow(parsed as Record<string, unknown>)
      if (!row) {
        malformedLines++
        continue
      }
      const ts = new Date(row.timestamp)
      if (Number.isNaN(ts.getTime())) {
        malformedLines++
        continue
      }
      if (ts < since) {
        // Lines before this one in the file, and every earlier day-file,
        // are only older — nothing left in the window.
        dayExhausted = true
        break
      }
      if (verdict !== undefined && row.verdict !== verdict) continue
      if (model !== undefined && row.requestedModel !== model) continue
      collected.push(row)
    }

    if (dayExhausted) break
  }

  // Newest-first overall — collected is already in that order per file, and
  // files were walked newest-day-first, so no re-sort is needed.
  return {
    traces: collected.slice(0, limit),
    total: collected.length,
    malformedLines,
    cappedFiles,
  }
}

/**
 * Finds one trace by id across every local day-file, newest day first, and
 * returns its RAW parsed JSON (not narrowed to `LocalTraceRow`) — `inspect`
 * shows everything the proxy recorded, not just the list-table's columns.
 * Returns `null` if no day-file has a matching `trace_id`.
 */
export async function findLocalTraceById(
  logsDir: string,
  traceId: string,
): Promise<Record<string, unknown> | null> {
  const files = await dayFilesDescending(logsDir)
  for (const file of files) {
    const path = join(logsDir, file)
    const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.trace_id === traceId) {
          rl.close()
          return parsed
        }
      } catch {
        continue
      }
    }
  }
  return null
}
