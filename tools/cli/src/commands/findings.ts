/**
 * `intutic findings` — List and adjudicate detector findings.
 *
 * `services/control-plane/src/routes/findings.ts` has carried a complete
 * TP/FP adjudication API since it landed, with zero consumers: no CLI
 * command, no dashboard page. Without a way to actually rule on a finding,
 * `false_positive_rate` in `/stats` and the response-echo report can only
 * ever return null — the labelling rate was structurally zero. This is that
 * missing writer.
 *
 * Subcommands:
 *   - `intutic findings list [--unadjudicated] [--detector <id>] [--limit N] [--json]`
 *   - `intutic findings adjudicate <findingId> (--true-positive|--false-positive) [--note <text>]`
 *   - `intutic findings stats [--json]`
 *   - `intutic findings echo-report [--since <date>] [--until <date>] [--json]`
 *
 * The adjudicator identity is never a flag here — the server derives it from
 * the authenticated session (`c.get('auth')`), the same reasoning
 * `intutic decision approve|reject` documents: a client-supplied name makes
 * the audit trail forgeable.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient, type ApiClient } from '../lib/api.js'
import pc from 'picocolors'

// ─── Types (mirror routes/findings.ts's response shapes) ─────────────

type Outcome = 'TRUE_POSITIVE' | 'FALSE_POSITIVE'

interface FindingRow {
  finding_id: string
  trace_id: string | null
  session_id: string | null
  loop_run_id: string | null
  detector_id: string
  anomaly_kind: string | null
  severity: string | null
  disposition: string | null
  confidence: number
  reason: string | null
  harness: string | null
  shadowed: boolean
  outcome: Outcome | null
  outcome_by: string | null
  outcome_at: string | null
  outcome_note: string | null
  created_at: string
}

interface FindingsListResponse {
  findings: FindingRow[]
}

interface AdjudicateResponse {
  finding_id: string
  outcome: Outcome
}

interface DetectorStatsRow {
  detector_id: string
  anomaly_kind: string | null
  shadowed: boolean
  total_findings: number
  adjudicated: number
  false_positives: number
  /** null when nothing has been ruled on — never invented as 0. */
  false_positive_rate: number | null
}

interface FindingsStatsResponse {
  detectors: DetectorStatsRow[]
  caveats: string[]
}

/** Mirrors `ResponseEchoPatternReport` in responseInjectionCorpusService.ts. */
interface ResponseEchoPatternReport {
  pattern: string
  findings: number
  adjudicated: number
  truePositives: number
  falsePositives: number
  falsePositiveRate: number | null
  refusal: string | null
}

/** Mirrors `ResponseEchoReport` in responseInjectionCorpusService.ts. */
interface ResponseEchoReport {
  window: { since: string; until: string }
  tracesIngested: number
  refusal: string | null
  patterns: ResponseEchoPatternReport[]
}

// ─── Shared opts ───────────────────────────────────────────────────────

interface FindingsCliOpts {
  dev?: boolean
}

async function getClient(opts: FindingsCliOpts): Promise<ApiClient> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

// ─── Formatting helpers (mirroring traces.ts's conventions) ───────────

/** Truncate a finding ID for table display. */
function truncateId(id: string): string {
  if (id.length <= 14) return id
  return id.slice(0, 11) + '...'
}

/** Format ISO timestamp for compact table display. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function truncateText(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + '…' : text
}

/** Color (or dim) a finding's outcome. `null` is rendered as "unruled", dimmed. */
function colorOutcome(outcome: Outcome | null): string {
  if (outcome === null) return pc.dim('unruled')
  if (outcome === 'TRUE_POSITIVE') return pc.green(outcome)
  return pc.yellow(outcome)
}

/**
 * A null rate is rendered as "no measured rate" — NEVER as "0" or "0%". A
 * detector or pattern nobody has adjudicated has no measured rate; printing
 * a number there would be an invention the route itself explicitly refuses
 * to make (see `false_positive_rate`'s doc comment in routes/findings.ts).
 */
function formatRate(rate: number | null): string {
  if (rate === null) return pc.dim('no measured rate')
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * ANSI escapes are zero-width. Measuring and slicing raw string length counts
 * them, so a coloured cell is both mis-padded and cut mid-escape — e.g.
 * `pc.dim('no measured rate')` is more characters than its 17 visible ones,
 * and a naive `str.slice(0, width)` against a narrower column truncates
 * inside the escape sequence, corrupting the visible text (see the same
 * fix and its full writeup in `integrity.ts`'s `padCell`).
 */
// eslint-disable-next-line no-control-regex -- ESC () opens every SGR colour sequence; matching it is this pattern's whole purpose.
const ANSI = /\[[0-9;]*m/g

function visibleLength(str: string): number {
  return str.replace(ANSI, '').length
}

/** Cut to `width` VISIBLE characters, keeping escapes and closing any left open. */
function truncateVisible(str: string, width: number): string {
  let out = ''
  let seen = 0
  let i = 0
  let coloured = false
  while (i < str.length && seen < width) {
    ANSI.lastIndex = i
    const m = ANSI.exec(str)
    if (m && m.index === i) {
      out += m[0]
      coloured = m[0] !== '[39m' && m[0] !== '[0m'
      i += m[0].length
      continue
    }
    out += str[i]
    seen += 1
    i += 1
  }
  // Never leave a colour open — it would tint the border and every later row.
  return coloured ? out + '[0m' : out
}

/** Pad a string to a fixed VISIBLE width (right-pad with spaces). */
export function pad(str: string, width: number): string {
  const visible = visibleLength(str)
  if (visible >= width) return truncateVisible(str, width)
  return str + ' '.repeat(width - visible)
}

/** Render a simple table with borders. */
function renderTable(headers: string[], widths: number[], rows: string[][]): void {
  const top = '┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐'
  const mid = '├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤'
  const bot = '└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘'

  const fmtRow = (cells: string[]) => '│ ' + cells.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │'

  console.log(top)
  console.log(fmtRow(headers))
  console.log(mid)
  for (const row of rows) {
    console.log(fmtRow(row))
  }
  console.log(bot)
}

// ─── Commands ───────────────────────────────────────────────────────

/**
 * `intutic findings list` — List detector findings for the workspace.
 *
 * `--unadjudicated` matches the route's own default behaviour: omitted, the
 * route returns every finding (adjudicated or not); passed, it adds
 * `unadjudicated=true` and returns only the working queue. The CLI does not
 * invent a different default than the route it calls.
 */
export async function runFindingsList(
  opts: FindingsCliOpts & { unadjudicated?: boolean; detector?: string; limit?: string; json?: boolean },
): Promise<void> {
  const client = await getClient(opts)

  const params = new URLSearchParams()
  if (opts.unadjudicated) params.set('unadjudicated', 'true')
  if (opts.detector) params.set('detector_id', opts.detector)
  if (opts.limit) params.set('limit', opts.limit)

  try {
    const data = await client.get<FindingsListResponse>(`/api/v1/findings?${params.toString()}`)

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    log.header('Intutic — Detector Findings')

    if (data.findings.length === 0) {
      log.dim('  No findings match your filters.')
      return
    }

    // `reason` is what makes a request-path finding triageable from the
    // terminal at all (e.g. "Runaway recursion: graph depth 12 exceeds the
    // maximum of 8") — Detector is trimmed from 28 to 20 (still enough for
    // the longest `response_injection:*` id once truncated) to make room for
    // it without the table ballooning further.
    const headers = ['Finding ID', 'Created', 'Detector', 'Reason', 'Disposition', 'Outcome']
    const widths = [14, 19, 20, 26, 12, 14]

    const rows = data.findings.map((f) => [
      truncateId(f.finding_id),
      formatTimestamp(f.created_at),
      truncateText(f.detector_id, 20),
      truncateText(f.reason ?? '—', 26),
      f.disposition ?? '—',
      colorOutcome(f.outcome),
    ])

    renderTable(headers, widths, rows)

    console.log(
      pc.dim(
        `Showing ${data.findings.length} finding(s)${opts.unadjudicated ? ' (unadjudicated only)' : ''}${
          opts.detector ? ` for detector ${opts.detector}` : ''
        }`,
      ),
    )

    // Keyed off `detector_id` prefix — already visible in the table above,
    // zero new API surface needed — rather than a precise "has a live
    // snippet" boolean, which the list route deliberately doesn't carry (see
    // routes/findings.ts's own comment on why). "May have" is honest given
    // retention (14 days, independent of adjudication) could already have
    // expired it by the time anyone reads this. The dashboard, not this CLI,
    // is the only surface that ever displays the excerpt content itself —
    // a terminal has no way to "hide again" once printed (scrollback, shell
    // history, and terminal recordings all retain it indefinitely), so this
    // deliberately stops at a pointer.
    const withSnippetCandidate = data.findings.filter((f) => f.detector_id.startsWith('response_injection:')).length
    if (withSnippetCandidate > 0) {
      console.log(
        pc.dim(
          `${withSnippetCandidate} finding(s) may have a scrubbed response snippet available — view in the dashboard (Findings queue) to review it before adjudicating.`,
        ),
      )
    }
  } catch (err) {
    log.error(`Failed to list findings: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic findings adjudicate <findingId>` — Record a human ruling on one finding.
 *
 * Exactly one of `--true-positive` / `--false-positive` is required, checked
 * client-side before any request is made — the same discipline
 * `runGatewayAssign`'s `--gateway`/`--clear` pair and `runGatewayConfigSet`
 * use for their own mutually-exclusive flags.
 */
export async function runFindingsAdjudicate(
  findingId: string,
  opts: FindingsCliOpts & { truePositive?: boolean; falsePositive?: boolean; note?: string; json?: boolean },
): Promise<void> {
  if (opts.truePositive && opts.falsePositive) {
    log.error('Specify exactly one of --true-positive or --false-positive, not both.')
    process.exit(1)
  }
  if (!opts.truePositive && !opts.falsePositive) {
    log.error('Specify exactly one of --true-positive or --false-positive.')
    process.exit(1)
  }

  const outcome: Outcome = opts.truePositive ? 'TRUE_POSITIVE' : 'FALSE_POSITIVE'
  const client = await getClient(opts)

  try {
    const res = await client.post<AdjudicateResponse>(
      `/api/v1/findings/${encodeURIComponent(findingId)}/adjudicate`,
      { outcome, note: opts.note },
    )

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    log.success(`Finding ${res.finding_id} adjudicated as ${res.outcome}.`)
  } catch (err) {
    log.error(`Failed to adjudicate finding: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic findings stats` — Per-detector false-positive rate, over
 * adjudicated findings only.
 *
 * The `caveats` array exists specifically to be read alongside the numbers
 * it qualifies — this prints it verbatim, never summarized or suppressed.
 */
export async function runFindingsStats(opts: FindingsCliOpts & { json?: boolean }): Promise<void> {
  const client = await getClient(opts)

  try {
    const data = await client.get<FindingsStatsResponse>('/api/v1/findings/stats')

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    log.header('Intutic — Findings Stats (per detector)')

    if (data.detectors.length === 0) {
      log.dim('  No findings recorded yet.')
    } else {
      const headers = ['Detector', 'Shadowed', 'Total', 'Adjudicated', 'FP Rate']
      const widths = [28, 9, 7, 12, 18]

      const rows = data.detectors.map((d) => [
        truncateText(d.detector_id, 28),
        d.shadowed ? 'yes' : 'no',
        String(d.total_findings),
        String(d.adjudicated),
        formatRate(d.false_positive_rate),
      ])

      renderTable(headers, widths, rows)
    }

    console.log('')
    log.header('Caveats')
    for (const caveat of data.caveats) {
      log.dim(`  - ${caveat}`)
    }
  } catch (err) {
    log.error(`Failed to fetch findings stats: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

/**
 * `intutic findings echo-report` — The response-injection echo measurement
 * report: precision per pattern, over the `response_injection:*` rows
 * `persistFindings` synthesizes from a trace's echo scan.
 *
 * `tracesIngested` is the anti-vacuity denominator and is always printed
 * prominently, even when zero. A top-level `refusal` (zero traffic in the
 * window) is printed as a warning, never suppressed — same for a
 * per-pattern `refusal` (below the adjudicated-count threshold), which
 * replaces that row's rate cell instead of a null percentage.
 */
export async function runFindingsEchoReport(
  opts: FindingsCliOpts & { since?: string; until?: string; json?: boolean },
): Promise<void> {
  const client = await getClient(opts)

  const params = new URLSearchParams()
  if (opts.since) params.set('since', opts.since)
  if (opts.until) params.set('until', opts.until)

  try {
    const data = await client.get<ResponseEchoReport>(`/api/v1/findings/response-echo/report?${params.toString()}`)

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    log.header('Intutic — Response-Echo Report')
    log.field('Window', `${data.window.since} → ${data.window.until}`)
    log.field('Traces ingested', String(data.tracesIngested))

    if (data.refusal) {
      console.log('')
      log.warn(data.refusal)
    }

    console.log('')

    // The table column is deliberately short ("withheld — see below") rather
    // than the refusal text itself: renderTable's fixed-width cells truncate
    // anything longer than the column, and a truncated refusal is a
    // suppressed refusal wearing an ellipsis. The full text always follows,
    // in full, below the table.
    const headers = ['Pattern', 'Findings', 'Adjudicated', 'FP Rate']
    const widths = [28, 9, 12, 20]

    const rows = data.patterns.map((p) => [
      p.pattern,
      String(p.findings),
      String(p.adjudicated),
      p.refusal ? 'withheld — see below' : formatRate(p.falsePositiveRate),
    ])

    renderTable(headers, widths, rows)

    const patternRefusals = data.patterns.filter((p) => p.refusal)
    if (patternRefusals.length > 0) {
      console.log('')
      for (const p of patternRefusals) {
        log.dim(`  ${p.pattern}: ${p.refusal}`)
      }
    }
  } catch (err) {
    log.error(`Failed to fetch response-echo report: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
