/**
 * `intutic routing` — Read-only reports for the routing subsystem.
 *
 * Subcommands:
 *   - `intutic routing adoption-report --candidate-model <model> [--json]`
 *
 * `adoption-report` reads `GET /api/v1/routing/mirror-adoption-report`
 * (`services/control-plane/src/routes/routing.ts`), Phase 7b's aggregation
 * of Phase 7a's mirror-tested comparison pairs
 * (`packages/proxy/src/routing/mirror.rs`, `mirrorAdoptionService.ts`). This
 * is a REPORTED signal for a human to read before deciding whether to adopt
 * a candidate model — see docs/TECH_DEBT.md TD-352: it supersedes, not
 * fulfills, the older C6/C7 automatic-enforcement design. Nothing this
 * command prints changes routing.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { NOT_AUTHENTICATED } from '../lib/authMessages.js'
import { loadCredentials } from '../config/store.js'
import { resolveControlPlaneUrl } from '../config/paths.js'
import { createApiClient, type ApiClient } from '../lib/api.js'
import pc from 'picocolors'

// ─── Types (mirror mirrorAdoptionService.ts's response shapes) ────────

export interface MirrorAdoptionReport {
  candidateModel: string
  sufficientData: true
  sampleCount: number
  candidateBetter: number
  originalBetter: number
  tie: number
  unjudged: number
  /** Candidate fault rate minus original fault rate. Negative = candidate faults less. Null when no row has both RIS scores. */
  faultRateDelta: number | null
  /** Null whenever no row has both sides populated — every row, as of Phase 7b (see TD-352). */
  averageCostDeltaUsd: number | null
  averageLatencyDeltaMs: number | null
}

export interface MirrorAdoptionInsufficientData {
  candidateModel: string
  sufficientData: false
  sampleCount: number
  minimumRequired: number
  reason: string
}

export type MirrorAdoptionReportResponse = MirrorAdoptionReport | MirrorAdoptionInsufficientData

// ─── Shared opts ───────────────────────────────────────────────────────

interface RoutingCliOpts {
  dev?: boolean
}

async function getClient(opts: RoutingCliOpts): Promise<ApiClient> {
  const creds = await loadCredentials()
  if (!creds) {
    log.error(NOT_AUTHENTICATED)
    process.exit(1)
  }
  const controlPlaneUrl = resolveControlPlaneUrl(opts.dev)
  return createApiClient(controlPlaneUrl, creds.apiKey)
}

// ─── Formatting helpers ────────────────────────────────────────────────

/**
 * A null rate/delta is rendered as an explicit "not measured"/"not enough
 * data" phrase — NEVER as "0" or "0.00". Matches `findings.ts`'s
 * `formatRate`: a delta nobody has enough data to compute is not the same
 * fact as a delta of zero, and printing a number there would be an
 * invention the route itself explicitly declines to make.
 */
function formatFaultRateDelta(delta: number | null): string {
  if (delta === null) return pc.dim('not enough scored pairs')
  const pts = delta * 100
  const sign = pts > 0 ? '+' : pts < 0 ? '' : '±'
  const text = `${sign}${pts.toFixed(1)} pts`
  if (pts < 0) return pc.green(`${text} (candidate faults less)`)
  if (pts > 0) return pc.red(`${text} (candidate faults more)`)
  return pc.dim(`${text} (no difference)`)
}

function formatCostDelta(delta: number | null): string {
  if (delta === null) return pc.dim('not measured — served-side cost is not yet on the wire event (TD-352)')
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  return `${sign}${delta.toFixed(4)} USD/request`
}

function formatLatencyDelta(delta: number | null): string {
  if (delta === null) return pc.dim('not measured — served-side latency is not yet on the wire event (TD-352)')
  const sign = delta > 0 ? '+' : delta < 0 ? '' : '±'
  return `${sign}${delta.toFixed(0)} ms`
}

// ─── Commands ───────────────────────────────────────────────────────

/**
 * `intutic routing adoption-report --candidate-model <model>` — Win/loss/
 * tie, fault-rate delta, cost delta and latency delta for one mirror
 * candidate.
 *
 * `--candidate-model` is required client-side before any request is made —
 * the route itself 400s without it, and there is no sensible CLI-side
 * default to substitute (unlike `findings list`'s optional filters, a
 * candidate model is the entire subject of this report).
 *
 * The insufficient-data response is rendered as its own distinct block,
 * never as a report with invented zeroes — same discipline as
 * `runFindingsEchoReport`'s per-pattern `refusal` handling.
 */
export async function runRoutingAdoptionReport(
  opts: RoutingCliOpts & { candidateModel?: string; json?: boolean },
): Promise<void> {
  if (!opts.candidateModel || opts.candidateModel.trim().length === 0) {
    log.error('--candidate-model is required (e.g. --candidate-model gpt-4o-mini).')
    process.exit(1)
  }
  const candidateModel = opts.candidateModel.trim()

  const client = await getClient(opts)

  try {
    const data = await client.get<MirrorAdoptionReportResponse>(
      `/api/v1/routing/mirror-adoption-report?candidateModel=${encodeURIComponent(candidateModel)}`,
    )

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    log.header('Intutic — Mirror-Test Adoption Report')
    log.field('Candidate model', data.candidateModel)

    if (!data.sufficientData) {
      console.log('')
      log.warn('Insufficient data — this is not a result, it is too early to say anything.')
      log.field('Sample count', `${data.sampleCount} of ${data.minimumRequired} required`)
      console.log('')
      console.log(pc.dim(`  ${data.reason}`))
      return
    }

    log.field('Sample count', String(data.sampleCount))
    console.log('')
    log.field('Candidate better', pc.green(String(data.candidateBetter)))
    log.field('Original better', pc.red(String(data.originalBetter)))
    log.field('Tie', String(data.tie))
    log.field('Unjudged', pc.dim(String(data.unjudged)))
    console.log('')
    log.field('Fault-rate delta', formatFaultRateDelta(data.faultRateDelta))
    log.field('Avg. cost delta', formatCostDelta(data.averageCostDeltaUsd))
    log.field('Avg. latency delta', formatLatencyDelta(data.averageLatencyDeltaMs))
    console.log('')
    console.log(
      pc.dim(
        '  This is a reported signal for human review, not an automatic gate — nothing here changes routing.',
      ),
    )
  } catch (err) {
    log.error(`Failed to fetch mirror-adoption report: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
