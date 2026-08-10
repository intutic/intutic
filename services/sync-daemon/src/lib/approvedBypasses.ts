/**
 * approvedBypasses.ts — ships approved `review_before` bypasses *to* the
 * machine, mirroring how `policySnapshot.ts` ships policy.
 *
 * # Why a separate file from policySnapshot.ts
 *
 * A bypass entry is not a rule: it is a one-time, per-call approval keyed on
 * (workspace, SOP rule id, normalised tool name, hashed command/target), with
 * its own TTL, and it is additive in the *opposite* direction from a policy
 * rule — a policy snapshot can only turn an allow into a block, this cache can
 * only turn one already-held call into an allow, for the one caller who
 * already approved it. Folding the two into one artifact would make either
 * "what does this line do" or "is this additive in the safe direction"
 * dependent on which column you are looking at.
 *
 * # The contract with the gate
 *
 * `.intutic/hooks/approved-bypasses.jsonl` — same directory as the policy
 * snapshot, and for the same reason: `.intutic/hooks` is already in
 * `UNIVERSAL_PROTECTED_PATHS`, so every gate already refuses an agent's own
 * attempt to write here. Two header lines carry integrity, exactly like the
 * `.rules` projection: `#digest` (sha256 of the JSONL body, first 32 hex
 * chars) and `#workspace` (refused if it does not match the gate's own
 * workspace id). Unlike the policy snapshot there is no `#generated` age
 * check — each line carries its own `expiresAt`, and the gate compares that
 * against wall-clock time on every read. A stale FILE degrades to "fewer
 * valid bypasses" (fail closed toward the hold); it can never resurrect an
 * entry whose own TTL has passed.
 *
 * Only `review_before` gates read this today (claudeCodeHooks.ts's
 * `_intuticApprovedBypass`) — see that module's docstring for why the other
 * harness writers are not wired to it: none of them implement `review_before`
 * holds at all, so there is nothing for a bypass to apply to there yet.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-approved-bypasses')

export const DEFAULT_BYPASS_CACHE_DIR = path.join(os.homedir(), '.intutic', 'hooks')
export const APPROVED_BYPASSES_FILE = 'approved-bypasses.jsonl'

/** One approved bypass, as `GET /api/v1/decisions/approved-bypasses` returns it. */
export interface ApprovedBypassEntry {
  workspaceId: string
  sopRuleId: string
  toolNameNormalized: string
  targetHash: string
  holdId: string
  decidedBy: string
  decidedAt: string
  expiresAt: string
}

export interface ApprovedBypassOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** Override the directory (tests). */
  cacheDir?: string
}

/**
 * Trims trailing `/` characters without a regex.
 *
 * `controlPlaneUrl` is operator-configured, not remotely attacker-controlled
 * — but CodeQL's static analysis flags `/\/+$/` as a polynomial-time pattern
 * on external input regardless of practical exploitability here, and the
 * identical pattern already existed unflagged in `onboarding.ts` and
 * `exec.ts` (fixed alongside this one). A loop is O(n), cannot be
 * mis-classified as a ReDoS shape by any static analyzer, and needs no
 * exemption to justify.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/** Fetches the workspace's currently-approved bypasses. Returns null on any
 *  failure — the caller keeps the previous cache file rather than replacing
 *  it with nothing, same rule `fetchResolvedPolicy` follows. */
export async function fetchApprovedBypasses(
  opts: ApprovedBypassOptions,
): Promise<ApprovedBypassEntry[] | null> {
  const url =
    `${trimTrailingSlashes(opts.controlPlaneUrl)}/api/v1/decisions/approved-bypasses` +
    `?workspaceId=${encodeURIComponent(opts.workspaceId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn({ action: 'bypass_fetch_failed', status: res.status }, 'approved-bypasses returned non-OK')
      return null
    }
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null) return null
    const rec = body as Record<string, unknown>
    const rows = Array.isArray(rec.bypasses) ? rec.bypasses : []
    return rows.filter((r): r is ApprovedBypassEntry => {
      if (typeof r !== 'object' || r === null) return false
      const x = r as Record<string, unknown>
      return (
        typeof x.workspaceId === 'string' &&
        typeof x.sopRuleId === 'string' &&
        typeof x.toolNameNormalized === 'string' &&
        typeof x.targetHash === 'string' &&
        typeof x.holdId === 'string' &&
        typeof x.decidedBy === 'string' &&
        typeof x.decidedAt === 'string' &&
        typeof x.expiresAt === 'string'
      )
    })
  } catch (err) {
    log.warn({ action: 'bypass_fetch_failed', err }, 'approved-bypasses unreachable')
    return null
  }
}

/** Writes the cache file atomically, digest and workspace header included —
 *  same convention as `writePolicySnapshot`. Exported so a test can assert
 *  the on-disk shape directly. */
export async function writeApprovedBypasses(
  entries: ApprovedBypassEntry[],
  workspaceId: string,
  cacheDir: string = DEFAULT_BYPASS_CACHE_DIR,
): Promise<{ digest: string; count: number }> {
  const lines = entries.map((e) => JSON.stringify(e))
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32)
  const text =
    `# Intutic approved review_before bypasses — auto-generated. DO NOT EDIT.\n` +
    `#digest ${digest}\n` +
    `#workspace ${workspaceId}\n` +
    `#generated ${new Date().toISOString()}\n` +
    (lines.length > 0 ? lines.join('\n') + '\n' : '')

  await fs.mkdir(cacheDir, { recursive: true })
  const target = path.join(cacheDir, APPROVED_BYPASSES_FILE)
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, text, { encoding: 'utf-8' })
  // Same read-only-by-rename posture as the policy snapshot: the daemon
  // never needs write access to the file itself after this, only to replace
  // it wholesale on the next cycle.
  await fs.chmod(tmp, 0o444)
  await fs.rename(tmp, target)

  log.debug({ action: 'approved_bypasses_written', digest, count: entries.length, dir: cacheDir }, 'Approved-bypass cache refreshed')
  return { digest, count: entries.length }
}

/** Fetch and write in one call. Safe to run on every sync cycle. Never
 *  throws — a failed poll must not take down the sync loop, and leaves the
 *  previous cache in place (stale bypasses still expire on their own TTL,
 *  which is what makes that safe). */
export async function refreshApprovedBypasses(
  opts: ApprovedBypassOptions,
): Promise<{ digest: string; count: number } | null> {
  const entries = await fetchApprovedBypasses(opts)
  if (entries === null) return null
  try {
    return await writeApprovedBypasses(entries, opts.workspaceId, opts.cacheDir ?? DEFAULT_BYPASS_CACHE_DIR)
  } catch (err) {
    log.warn({ action: 'approved_bypasses_write_failed', err }, 'Could not write approved-bypasses cache')
    return null
  }
}
