/**
 * sessionReporter.ts — turn harness detection into real control-plane
 * sessions.
 *
 * The full-fidelity session path (POST /api/v1/sessions — branch/commit
 * capture and the Jira/Linear/GitHub task-context cascade) had no production
 * caller: sessions only ever existed as synthetic `ssp_` rows minted
 * server-side. The daemon knows everything the route wants — workspace root,
 * harness, git branch and commit — so it opens one session per harness per
 * daemon run when the harness is first detected, and ends them all on
 * shutdown (PATCH /api/v1/sessions/:id/end).
 *
 * Dedupe lives here (module state keyed workspace+harness), so callers —
 * `startSyncLoop`'s iteration as well as the CLI's inline connect loop — can
 * call `startHarnessSession` every iteration and only the first one POSTs.
 * Everything is best-effort: a dead control plane costs a warning, never the
 * sync loop.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { newIso } from '@intutic/id'
import type { HarnessType } from '@intutic/shared-types'

const execFileP = promisify(execFile)

/** sessionIds opened this daemon run, keyed `${workspaceId}:${harness}`. */
const openSessions = new Map<string, string>()
/** Keys with a POST in flight or already attempted (success or not) — one try per run. */
const attempted = new Set<string>()

export interface GitInfo {
  branchName?: string
  commitHash?: string
  commitMessage?: string
}

/** Best-effort git context from the workspace root. */
export async function readGitInfo(workspaceRoot: string): Promise<GitInfo> {
  const git = async (...args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileP('git', args, { cwd: workspaceRoot, timeout: 3_000 })
      const out = stdout.trim()
      return out.length > 0 ? out : undefined
    } catch {
      return undefined
    }
  }
  const [branchName, commitHash, commitMessage] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('rev-parse', 'HEAD'),
    git('log', '-1', '--format=%s'),
  ])
  return { branchName, commitHash, commitMessage }
}

/**
 * Open a session for a harness if this run has not already done so.
 * Returns the sessionId when one is open (new or previously created).
 */
export async function startHarnessSession(opts: {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  harnessType: HarnessType
  workspaceRoot: string
  agentRole?: string
}): Promise<string | null> {
  const key = `${opts.workspaceId}:${opts.harnessType}`
  const existing = openSessions.get(key)
  if (existing) return existing
  if (attempted.has(key)) return null
  attempted.add(key)

  try {
    const git = await readGitInfo(opts.workspaceRoot)
    const res = await fetch(`${opts.controlPlaneUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        harnessType: opts.harnessType,
        ...(opts.agentRole ? { agentRole: opts.agentRole } : {}),
        ...git,
        reportedAt: newIso(),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[sync-daemon] startHarnessSession failed for ${opts.harnessType}: ${res.status}`)
      return null
    }
    const body = (await res.json()) as { sessionId?: string }
    if (body.sessionId) {
      openSessions.set(key, body.sessionId)
      return body.sessionId
    }
    return null
  } catch (err) {
    console.warn(
      `[sync-daemon] startHarnessSession error for ${opts.harnessType}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** End every session this run opened. Called from shutdown paths. */
export async function endAllOpenSessions(controlPlaneUrl: string, apiKey: string): Promise<void> {
  const entries = [...openSessions.entries()]
  openSessions.clear()
  attempted.clear()
  await Promise.allSettled(
    entries.map(async ([, sessionId]) => {
      try {
        await fetch(`${controlPlaneUrl}/api/v1/sessions/${sessionId}/end`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        // shutdown is not the time to retry
      }
    }),
  )
}
