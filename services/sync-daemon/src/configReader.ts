/**
 * configReader.ts — Capture harness config files for the config history.
 *
 * `intutic connect` reads each recorded harness's rules file (`HARNESS_FILES`,
 * the one list of what is captured) and POSTs it to the control plane. By
 * default a capture is metadata only: path, the SHA-256 of the redacted text,
 * size, harness and time. With the workspace's `configBodyUpload` on it also
 * carries the text, credential-shaped strings replaced by `[redacted]` first;
 * that is what config diffs and SkillOpt need.
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type {
  HarnessType,
  CapturedConfigFile,
  BatchConfigCapturePayload,
  GovernanceCoverageInputs,
} from '@intutic/shared-types'
import { SECRET_VALUE_PATTERNS } from '@intutic/shared-types'
import { HARNESS_FILES } from './configWriter.js'
import { redactSecrets } from './harness/holdRedaction.js'

// ─── Constants ───────────────────────────────────────────────────────

/** Capture every Nth sync iteration (default: every 5th = ~2.5 min at 30s poll). */
const DEFAULT_CAPTURE_INTERVAL = 5

/** Max file size to capture (prevent uploading massive files). */
const MAX_FILE_SIZE_BYTES = 512 * 1024  // 512 KB

// ─── Local hash cache ────────────────────────────────────────────────

/**
 * Last-uploaded content hash per file and upload mode. The mode is part of
 * the key so that turning `configBodyUpload` on uploads the content of a file
 * whose metadata was already sent, at the next capture rather than its next
 * edit.
 */
const lastUploadedHashes = new Map<string, string>()

/** Every credential-value pattern the hook gate and pre-commit scan refuse. */
const SECRET_VALUES = SECRET_VALUE_PATTERNS.map((p) => new RegExp(p.source, 'g'))

/**
 * A config file's text as it may leave the machine: the hold-snapshot
 * redactor (credential shapes, `name: value` assignments to secret-named keys,
 * PEM blocks) without its length cap, then every pattern in
 * `SECRET_VALUE_PATTERNS`. Both, because each catches shapes the other does
 * not (`vk_…` and `sk-or-v1-…` are only in the second, JWTs and Slack tokens
 * only in the first).
 */
export function redactConfigText(text: string): string {
  let out = redactSecrets(text, 0, Number.POSITIVE_INFINITY) as string
  for (const re of SECRET_VALUES) out = out.replace(re, '[redacted]')
  return out
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * The four enforcement inputs `POST /api/v1/governance-coverage/snapshot`
 * expects. Re-exported from `@intutic/shared-types` — previously
 * declared locally here as a hand-kept duplicate of
 * `harnessGradeSweep.ts`'s `deriveEnforcementInputs` return shape on the
 * control-plane side, which drifted (this module's sync-cycle consumer
 * was missing an `Array.isArray` guard the control-plane side had). Both
 * sides now derive from `packages/shared-types/src/governanceCoverage.ts`'s
 * single mapping — safe for this module to depend on since it is a leaf
 * package, not `services/control-plane` itself, so the publicly-mirrored
 * `services/sync-daemon` still never imports from the enterprise-only
 * service.
 */
export type { GovernanceCoverageInputs } from '@intutic/shared-types'

/**
 * Determine whether config capture should run on this iteration.
 * Captures every Nth iteration to avoid flooding the control plane.
 */
export function shouldCaptureThisIteration(iterationCount: number): boolean {
  const interval = parseInt(process.env.CONFIG_CAPTURE_INTERVAL ?? '', 10) || DEFAULT_CAPTURE_INTERVAL
  return iterationCount > 0 && iterationCount % interval === 0
}

/**
 * Read harness config files from the workspace.
 * For each active harness, reads the config file and hashes its redacted
 * text; the text itself is kept only with `includeContent`. Skips files that
 * don't exist or are too large.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param harnesses - Active harness types detected in the workspace.
 * @param opts.includeContent - The workspace's `configBodyUpload`.
 */
export async function readHarnessConfigs(
  workspaceRoot: string,
  harnesses: HarnessType[],
  opts: { includeContent: boolean },
): Promise<CapturedConfigFile[]> {
  const results: CapturedConfigFile[] = []

  for (const harness of harnesses) {
    const filename = HARNESS_FILES[harness]
    if (!filename) continue

    const filePath = path.join(workspaceRoot, filename)
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        console.warn(`[config-reader] Skipping ${filename}: ${stat.size} bytes exceeds ${MAX_FILE_SIZE_BYTES} limit`)
        continue
      }

      const redacted = redactConfigText(await fs.readFile(filePath, 'utf-8'))
      const contentHash = crypto.createHash('sha256').update(redacted).digest('hex')

      results.push({
        path: filename,
        contentHash,
        sizeBytes: stat.size,
        ...(opts.includeContent ? { content: redacted } : {}),
      })
    } catch (err: unknown) {
      // File doesn't exist or unreadable — skip silently
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[config-reader] Could not read ${filename}:`, err)
      }
    }
  }

  return results
}

/**
 * Upload captured config files to the control plane.
 * Deduplicates locally: only uploads files whose content hash changed
 * since the last upload.
 *
 * @param controlPlaneUrl - Control plane base URL.
 * @param apiKey - API key for authentication.
 * @param workspaceId - Workspace identifier.
 * @param harnessType - Which harness these configs belong to.
 * @param configs - Captured config files from readHarnessConfigs().
 * @returns Number of files actually uploaded (after dedup).
 */
export async function uploadConfigCapture(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  harnessType: HarnessType,
  configs: CapturedConfigFile[],
): Promise<number> {
  const cacheKey = (f: CapturedConfigFile) => `${f.content === undefined ? 'meta' : 'body'}:${harnessType}:${f.path}`
  // Filter out files whose hash hasn't changed since last upload
  const changed = configs.filter(f => lastUploadedHashes.get(cacheKey(f)) !== f.contentHash)

  if (changed.length === 0) return 0

  const payload: BatchConfigCapturePayload = {
    workspaceId,
    harnessType,
    files: changed,
  }

  const url = `${controlPlaneUrl}/api/v1/config/capture`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[config-reader] Upload failed (${res.status}): ${body}`)
    return 0
  }

  // Update local hash cache on success
  for (const f of changed) {
    lastUploadedHashes.set(cacheKey(f), f.contentHash)
  }

  return changed.length
}

/**
 * Trigger an immediate governance-coverage grade snapshot for one harness
 * (`POST /api/v1/governance-coverage/snapshot` — see that route's own doc
 * comment: "Called by the sync-daemon after detecting harness config
 * changes," which nothing actually did until this wiring). Best-effort and
 * non-fatal by design, matching `uploadConfigCapture`'s own network-failure
 * handling above: the hourly control-plane sweep (`harnessGradeSweep.ts`)
 * re-grades every harness regardless, so a failed request here only costs
 * the up-to-the-minute freshness this call exists to provide, never
 * correctness.
 */
export async function reportGovernanceCoverageSnapshot(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  harnessType: HarnessType,
  inputs: GovernanceCoverageInputs,
): Promise<void> {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/v1/governance-coverage/snapshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        workspaceId,
        harnessType,
        mcpProxyActive: inputs.mcpProxyActive,
        nativeHookActive: inputs.nativeHookActive,
        llmProxyActive: inputs.llmProxyActive,
        hasRulesFile: inputs.hasRulesFile,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[config-reader] Governance coverage snapshot failed (${res.status}): ${body}`)
    }
  } catch (err) {
    console.warn('[config-reader] Governance coverage snapshot request failed:', err)
  }
}

/**
 * Full config capture cycle: read + upload, one payload per harness.
 *
 * `includeContent` is the workspace's `configBodyUpload` as the latest synced
 * settings carry it, so a change reaches the next capture. Off, no request
 * built here carries a file's content.
 *
 * `governanceInputs` are this cycle's per-harness enforcement signals, derived
 * from the agent report facets. A governance-coverage snapshot fires only for
 * a harness whose rules file was actually uploaded this time, not on every
 * tick. Without inputs for a harness it falls back to `hasRulesFile: true` and
 * everything else `false`: a wrong mapping that overstated enforcement would
 * be worse than an empty grid.
 */
export async function captureAndUpload(opts: {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  workspaceRoot: string
  harnesses: HarnessType[]
  includeContent: boolean
  governanceInputs?: Partial<Record<HarnessType, GovernanceCoverageInputs>>
}): Promise<void> {
  const { controlPlaneUrl, apiKey, workspaceId } = opts
  for (const harness of opts.harnesses) {
    const configs = await readHarnessConfigs(opts.workspaceRoot, [harness], { includeContent: opts.includeContent })
    if (configs.length === 0) continue
    const uploaded = await uploadConfigCapture(controlPlaneUrl, apiKey, workspaceId, harness, configs)
    if (uploaded === 0) continue
    console.log(`[config-reader] Captured ${uploaded} ${harness} config file(s)`)
    await reportGovernanceCoverageSnapshot(
      controlPlaneUrl,
      apiKey,
      workspaceId,
      harness,
      opts.governanceInputs?.[harness] ?? {
        mcpProxyActive: false,
        nativeHookActive: false,
        llmProxyActive: false,
        hasRulesFile: true,
      },
    )
  }
}
