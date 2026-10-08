/**
 * sessionReporter.ts — turn harness detection into real control-plane
 * sessions.
 *
 * The full-fidelity session path (POST /api/v1/sessions — branch/commit
 * capture and the Jira/Linear/GitHub task-context cascade) had no production
 * caller: sessions only ever existed as synthetic `ssp_` rows minted
 * server-side. The daemon knows everything the route wants — workspace root,
 * harness, git repository, branch and commit — so it reports them when the
 * harness is first detected, and again whenever the repository, branch or
 * HEAD commit changes.
 *
 * WHICH row it reports them onto (TD-231, Wave 5.6): when a local proxy is
 * reachable, the caller passes that process's `proxyInstanceId` and the
 * control plane puts the context on the proxy's OWN row — the
 * `ssp_<ws>_<harness>_<instance>` session it derives for that process's
 * traces, so the branch, the task and the cost sit on one row (AI intensity
 * reads them together) and the hook gate's blocks resolve to the same row.
 * That row's lifecycle stays the control plane's 30-minute idle rule; the
 * daemon never ends it, because an externally started proxy keeps serving
 * after the daemon stops and an ended row would vanish from Active Sessions
 * and from the hook gate's resolver while traces still attach to it. A
 * respawned proxy has a new instance id, so it gets a new row on the next
 * iteration. Without an instance id (no local proxy, or a shared gateway —
 * `fetchLocalProxyInstanceId` refuses a `gw_` id) the daemon opens a `ses_`
 * STANDARD row as before and ends it on shutdown
 * (PATCH /api/v1/sessions/:id/end).
 *
 * Dedupe lives here (module state keyed workspace+harness+instance), so
 * callers (`reportHarnessAgents`, every `intutic connect` cycle) can call
 * `startHarnessSession` every iteration. Git is read on every call and the
 * session is POSTed again only when it changed: the control plane copies the
 * session's git context onto each trace as it records it, which is what makes
 * cost per branch and per commit possible, so a stale commit would file a
 * call under the wrong one. A re-POST updates the same row. Everything is
 * best-effort: a dead control plane costs a warning, never the sync loop.
 *
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { newIso } from '@intutic/id'
import { normalizeGitRemote, type HarnessType } from '@intutic/shared-types'

const execFileP = promisify(execFile)

/**
 * sessionIds this daemon run opened AND owns the lifecycle of — the `ses_`
 * rows `endAllOpenSessions` ends. Keyed `${workspaceId}:${harness}:`.
 */
const openSessions = new Map<string, string>()
/**
 * Proxy rows this run registered context onto, keyed
 * `${workspaceId}:${harness}:${proxyInstanceId}`. Dedupe only — never ended.
 */
const registeredProxyRows = new Map<string, string>()
/**
 * The git context last POSTed (or attempted, success or not) per key. One try
 * per key and git state per run: a failing control plane is not retried every
 * cycle, but a branch switch or a new commit is reported.
 */
const attempted = new Map<string, string>()

export interface GitInfo {
  /** The `origin` remote, normalised: host/path, never credentials. */
  repoUrl?: string
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
  const [remote, branchName, commitHash, commitMessage] = await Promise.all([
    git('remote', 'get-url', 'origin'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('rev-parse', 'HEAD'),
    git('log', '-1', '--format=%s'),
  ])
  // Normalised here, before it is held anywhere: a remote can embed a token.
  const repoUrl = remote ? (normalizeGitRemote(remote) ?? undefined) : undefined
  return { repoUrl, branchName, commitHash, commitMessage }
}

/**
 * Report a harness session — onto the local proxy's own row when
 * `proxyInstanceId` is given (see the module doc), else as a `ses_` row — and
 * report it again when its git context changes. Returns the sessionId when one
 * is known (new or previously created).
 */
export async function startHarnessSession(opts: {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  harnessType: HarnessType
  workspaceRoot: string
  agentRole?: string
  /**
   * The local proxy process's instance id (`fetchLocalProxyInstanceId`).
   * Present: the context is registered onto that process's proxy row, which
   * this module never ends. Absent: a `ses_` row, ended on shutdown.
   */
  proxyInstanceId?: string
}): Promise<string | null> {
  const key = `${opts.workspaceId}:${opts.harnessType}:${opts.proxyInstanceId ?? ''}`
  const existing = opts.proxyInstanceId ? registeredProxyRows.get(key) : openSessions.get(key)
  const git = await readGitInfo(opts.workspaceRoot)
  const gitState = JSON.stringify([git.repoUrl, git.branchName, git.commitHash])
  if (attempted.get(key) === gitState) return existing ?? null
  attempted.set(key, gitState)

  try {
    const res = await fetch(`${opts.controlPlaneUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        harnessType: opts.harnessType,
        ...(opts.agentRole ? { agentRole: opts.agentRole } : {}),
        ...(opts.proxyInstanceId ? { proxyInstanceId: opts.proxyInstanceId } : {}),
        // A `ses_` row this run already opened is updated, not opened again.
        ...(existing && !opts.proxyInstanceId ? { sessionId: existing } : {}),
        ...git,
        reportedAt: newIso(),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[sync-daemon] startHarnessSession failed for ${opts.harnessType}: ${res.status}`)
      return existing ?? null
    }
    const body = (await res.json()) as { sessionId?: string }
    if (body.sessionId) {
      ;(opts.proxyInstanceId ? registeredProxyRows : openSessions).set(key, body.sessionId)
      return body.sessionId
    }
    return existing ?? null
  } catch (err) {
    console.warn(
      `[sync-daemon] startHarnessSession error for ${opts.harnessType}:`,
      err instanceof Error ? err.message : err,
    )
    return existing ?? null
  }
}

/**
 * End every `ses_` session this run opened. Called from shutdown paths. Proxy
 * rows registered through `proxyInstanceId` are forgotten, not ended — the
 * module doc says why.
 */
export async function endAllOpenSessions(controlPlaneUrl: string, apiKey: string): Promise<void> {
  const entries = [...openSessions.entries()]
  openSessions.clear()
  registeredProxyRows.clear()
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
