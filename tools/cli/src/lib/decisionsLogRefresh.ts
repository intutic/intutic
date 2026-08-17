/**
 * decisionsLogRefresh.ts — best-effort, one-shot refresh of the governed
 * decisions log, triggered by the optional post-merge git hook
 * (`gitHooks.ts`'s `POST_MERGE_CONTENT`) so a developer sees fresh decisions
 * right after a merge rather than waiting for the daemon's next ~30s poll.
 * Never throws — a backgrounded hook must not surface a failure to the shell,
 * same posture as `deviceReport.ts`'s "best-effort phone-home".
 *
 * Reuses `@intutic/sync-daemon`'s `refreshDecisionsDigest` directly rather
 * than re-implementing the fetch/render/write.
 *
 * @module
 */

import { loadCredentials } from '../config/store.js'
import { createApiClient } from './api.js'
import { refreshDecisionsDigest } from '@intutic/sync-daemon'
import { HarnessType } from '@intutic/shared-types'

export interface DecisionsLogRefreshResult {
  refreshed: boolean
  reason?: string
}

/**
 * Checks `WorkspaceSettings.decisionsLogEnabled` before writing anything.
 *
 * This is a manually-triggered, one-shot refresh, not the daemon's own gated
 * poll-cycle call — it has to re-check the opt-in itself rather than
 * inheriting the daemon's own gate, or a developer merging a branch would
 * cause files to be written into a workspace that never turned this feature
 * on.
 */
export async function refreshDecisionsLog(workspaceRoot: string): Promise<DecisionsLogRefreshResult> {
  try {
    const creds = await loadCredentials()
    if (!creds) return { refreshed: false, reason: 'not authenticated' }

    const client = createApiClient(creds.controlPlaneUrl, creds.apiKey)
    const { settings } = await client.get<{ settings?: { decisionsLogEnabled?: boolean } }>(
      '/api/v1/workspace/settings',
    )
    if (!settings?.decisionsLogEnabled) {
      return { refreshed: false, reason: 'decisionsLogEnabled is off' }
    }

    // The claude-code harness is the sole injection target (see
    // decisionsDigest.ts's own doc comment) — passed unconditionally here
    // since this one-shot trigger has no live harness-detection cycle to
    // draw from the way the daemon's sync loop does.
    const result = await refreshDecisionsDigest({
      controlPlaneUrl: creds.controlPlaneUrl,
      apiKey: creds.apiKey,
      workspaceId: creds.workspaceId,
      workspaceRoot,
      harnesses: [HarnessType.CLAUDE_CODE],
    })
    return result ? { refreshed: true } : { refreshed: false, reason: 'digest fetch failed' }
  } catch (err) {
    return { refreshed: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
