/**
 * Intutic CLI — Decision review commands.
 *
 * The real front door for a `review_before` hold. Before this, the ONLY
 * printed remediation for a held call was `intutic loop review <holdId>
 * --approve` — a command that posts to `/api/v1/loops/:loopRunId/review`, a
 * Loop Run id space architecturally separate from review_before holds. It
 * 404s on every holdId a developer was ever told to give it, and Slack was
 * the only working approve/reject surface. `intutic decision approve|reject`
 * calls the route that actually exists for this: `POST
 * /api/v1/decisions/:id/review`.
 *
 * @module
 */

import { log } from '../lib/logger.js'
import { getClient } from './skill.js'

/**
 * Approves or rejects a decision — most often a `review_before` hold — via
 * the API, mirroring `runLoopReview`'s shape but against the decision id
 * space instead of the loop-run one.
 *
 * Whether approving also lets the retried call through the local gate depends
 * on a workspace setting (`reviewHoldBypassEnabled`) this command has no
 * visibility into and does not need to: the response's `bypassWritten` field
 * says so, and the CLI just reports it.
 */
export async function runDecisionReview(
  holdId: string,
  action: 'approve' | 'reject',
  opts: { reason?: string; dev?: boolean },
): Promise<void> {
  const client = await getClient(opts.dev)
  try {
    const res = await client.post<{ ok: boolean; status: string; bypassWritten?: boolean }>(
      `/api/v1/decisions/${holdId}/review`,
      { action, reason: opts.reason },
    )
    if (!res.ok) {
      log.error(`Decision ${holdId} could not be resolved.`)
      process.exit(1)
    }
    if (action === 'approve') {
      log.success(`Decision ${holdId} approved (status: ${res.status}).`)
      if (res.bypassWritten) {
        log.info('A short-lived bypass was written for the exact retried call — try it again.')
      }
    } else {
      log.success(`Decision ${holdId} rejected (status: ${res.status}).`)
    }
  } catch (err) {
    log.error(`Failed to resolve decision: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

export async function runDecisionApprove(
  holdId: string,
  opts: { reason?: string; dev?: boolean },
): Promise<void> {
  await runDecisionReview(holdId, 'approve', opts)
}

export async function runDecisionReject(
  holdId: string,
  opts: { reason?: string; dev?: boolean },
): Promise<void> {
  await runDecisionReview(holdId, 'reject', opts)
}
