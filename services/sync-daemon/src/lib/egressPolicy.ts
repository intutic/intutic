/**
 * egressPolicy.ts — ships the workspace's central egress policy *to* the
 * machine, so an admin sets `enforce`/`monitor` + an allow list once in the
 * control plane rather than in every developer's local proxy config
 * (LLD #63 §4). Mirrors `policySnapshot.ts` / `approvedBypasses.ts`: fetch from
 * the control plane, write a local artifact under `.intutic/hooks` with
 * integrity headers, and let the consumer (here the Rust proxy) read it.
 *
 * # The contract with the proxy
 *
 * `.intutic/hooks/egress-policy.json` — same directory as the policy snapshot
 * and for the same reason: `.intutic/hooks` is in `UNIVERSAL_PROTECTED_PATHS`,
 * so a gate already refuses an agent's own write there. The file carries its
 * own integrity: `digest` (sha256 of a canonical `mode\nallow…` string, first
 * 32 hex) and `workspace`. The proxy recomputes the digest and refuses a file
 * whose digest or workspace does not match, keeping its config-derived policy
 * instead — a corrupt or foreign file degrades to "local config", never to a
 * weaker enforcement than the operator configured.
 *
 * `mode: null` means "central management not configured": the proxy keeps its
 * local `intutic_settings.egress` / `INTUTIC_EGRESS_MODE`. A `mode` of
 * `off`/`monitor`/`enforce` is authoritative for the mode; the `allow` list is
 * UNIONed with the proxy's local allow entries so a developer's local infra
 * allowances are never dropped.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { createLogger } from '@intutic/logger'

const log = createLogger('sync-egress-policy')

export const DEFAULT_EGRESS_CACHE_DIR = path.join(os.homedir(), '.intutic', 'hooks')
export const EGRESS_POLICY_FILE = 'egress-policy.json'

export type EgressMode = 'off' | 'monitor' | 'enforce'

/** The workspace egress policy, as `GET /api/v1/workspace/egress-policy` returns it. */
export interface WorkspaceEgressPolicy {
  /** null → central management not configured; the proxy keeps local config. */
  mode: EgressMode | null
  allow: string[]
}

export interface EgressPolicyOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** Override the directory (tests). */
  cacheDir?: string
}

/**
 * Trims trailing `/` without a regex — see the identical helper in
 * `approvedBypasses.ts`: `/\/+$/` is flagged by CodeQL as a polynomial-time
 * pattern on external input, and a loop sidesteps the whole category.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/**
 * The canonical string the digest is computed over — identical on the daemon
 * (here) and the proxy (Rust `load_local_egress_file`), so both derive the same
 * digest. Mode (or empty) then each allow entry, newline-joined. Allow entries
 * are hosts/CIDRs and never contain newlines.
 */
export function egressDigestInput(mode: EgressMode | null, allow: string[]): string {
  return [mode ?? '', ...allow].join('\n')
}

/** Fetch this workspace's central egress policy. Returns null on any failure —
 *  the caller keeps the previous cache file rather than replacing it with
 *  nothing, the same rule the policy snapshot follows. */
export async function fetchWorkspaceEgressPolicy(
  opts: EgressPolicyOptions,
): Promise<WorkspaceEgressPolicy | null> {
  const url =
    `${trimTrailingSlashes(opts.controlPlaneUrl)}/api/v1/workspace/egress-policy` +
    `?workspaceId=${encodeURIComponent(opts.workspaceId)}`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'x-workspace-id': opts.workspaceId },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn({ action: 'egress_fetch_failed', status: res.status }, 'egress-policy returned non-OK')
      return null
    }
    const body = (await res.json()) as unknown
    if (typeof body !== 'object' || body === null) return null
    const rec = body as Record<string, unknown>
    const mode =
      rec.mode === 'off' || rec.mode === 'monitor' || rec.mode === 'enforce' ? rec.mode : null
    const allow = Array.isArray(rec.allow)
      ? rec.allow.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : []
    return { mode, allow }
  } catch (err) {
    log.warn({ action: 'egress_fetch_failed', err }, 'egress-policy unreachable')
    return null
  }
}

/** Write the cache file atomically, digest + workspace header included — same
 *  read-only-by-rename posture as the policy snapshot. Exported so a test can
 *  assert the on-disk shape directly. */
export async function writeEgressPolicy(
  policy: WorkspaceEgressPolicy,
  workspaceId: string,
  cacheDir: string = DEFAULT_EGRESS_CACHE_DIR,
): Promise<{ digest: string; mode: EgressMode | null }> {
  const digest = createHash('sha256')
    .update(egressDigestInput(policy.mode, policy.allow))
    .digest('hex')
    .slice(0, 32)
  const doc = {
    workspace: workspaceId,
    digest,
    generated: new Date().toISOString(),
    mode: policy.mode,
    allow: policy.allow,
  }
  const text = JSON.stringify(doc, null, 2) + '\n'

  await fs.mkdir(cacheDir, { recursive: true })
  const target = path.join(cacheDir, EGRESS_POLICY_FILE)
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, text, { encoding: 'utf-8' })
  await fs.chmod(tmp, 0o444)
  await fs.rename(tmp, target)

  log.debug({ action: 'egress_policy_written', digest, mode: policy.mode, count: policy.allow.length, dir: cacheDir }, 'Egress policy cache refreshed')
  return { digest, mode: policy.mode }
}

/** Fetch and write in one call. Safe to run on every sync cycle. Never throws —
 *  a failed poll must not take down the sync loop, and leaves the previous
 *  cache in place. */
export async function refreshEgressPolicy(
  opts: EgressPolicyOptions,
): Promise<{ digest: string; mode: EgressMode | null } | null> {
  const policy = await fetchWorkspaceEgressPolicy(opts)
  if (policy === null) return null
  try {
    return await writeEgressPolicy(policy, opts.workspaceId, opts.cacheDir ?? DEFAULT_EGRESS_CACHE_DIR)
  } catch (err) {
    log.warn({ action: 'egress_policy_write_failed', err }, 'Could not write egress-policy cache')
    return null
  }
}
