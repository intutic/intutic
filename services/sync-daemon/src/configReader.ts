/**
 * configReader.ts — Read harness config files and upload to control plane.
 *
 * The daemon reads config files (.cursorrules, CLAUDE.md, etc.) from the
 * developer's workspace and POSTs them to the control plane for versioning,
 * diff tracking, and SkillOpt analysis.
 *
 * LLD #51 — Harness Config Capture + SkillOpt Pipeline
 *
 * @module
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { HarnessType, CapturedConfigFile, BatchConfigCapturePayload } from '@intutic/shared-types'
import { HARNESS_FILES } from './configWriter.js'

// ─── Constants ───────────────────────────────────────────────────────

/** Capture every Nth sync iteration (default: every 5th = ~2.5 min at 30s poll). */
const DEFAULT_CAPTURE_INTERVAL = 5

/** Max file size to capture (prevent uploading massive files). */
const MAX_FILE_SIZE_BYTES = 512 * 1024  // 512 KB

// ─── Local hash cache ────────────────────────────────────────────────

/** Cache of last-uploaded content hashes per file path. Avoids redundant uploads. */
const lastUploadedHashes = new Map<string, string>()

// ─── Public API ──────────────────────────────────────────────────────

/**
 * The four enforcement inputs `POST /api/v1/governance-coverage/snapshot`
 * expects — mirrors `harnessGradeSweep.ts`'s `deriveEnforcementInputs` on the
 * control-plane side, which derives the same four booleans from an agent's
 * reported `facets` (already computed once per cycle by
 * `agentReporter.ts#collectAgentReport` for `POST /api/v1/agents/report`).
 * Re-derived here rather than imported: this module ships in the publicly
 * mirrored `services/sync-daemon`, which must not import from
 * `services/control-plane`.
 */
export interface GovernanceCoverageInputs {
  mcpProxyActive: boolean
  nativeHookActive: boolean
  llmProxyActive: boolean
  hasRulesFile: boolean
}

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
 * For each active harness, reads the config file, computes SHA-256 hash,
 * and returns the content. Skips files that don't exist or are too large.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param harnesses - Active harness types detected in the workspace.
 * @returns Array of captured config files with content and hashes.
 */
export async function readHarnessConfigs(
  workspaceRoot: string,
  harnesses: HarnessType[],
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

      const content = await fs.readFile(filePath, 'utf-8')
      const contentHash = crypto.createHash('sha256').update(content).digest('hex')

      results.push({
        path: filename,
        content,
        contentHash,
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
  // Filter out files whose hash hasn't changed since last upload
  const changed = configs.filter(f => {
    const lastHash = lastUploadedHashes.get(f.path)
    return lastHash !== f.contentHash
  })

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
    lastUploadedHashes.set(f.path, f.contentHash)
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
 * Full config capture cycle: read + upload.
 * Groups by harness type for proper capture payloads.
 *
 * @param governanceInputs - This cycle's per-harness enforcement signals
 *   (from `runSyncIteration`'s agent-facets collection), used to fire a
 *   governance-coverage snapshot immediately after a harness's rules file is
 *   actually found to have changed — never on every sync tick, only on the
 *   iterations where `uploadConfigCapture`'s content-hash dedup lets a file
 *   through. Falls back to `hasRulesFile: true` / everything else `false`
 *   when the caller has no facets for a harness yet (first cycle before the
 *   agent-report step has run) — conservative in the same direction
 *   `harnessGradeSweep.ts`'s own doc comment argues for: "a wrong mapping
 *   overstates enforcement, which is worse than an empty grid."
 */
export async function captureAndUpload(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  workspaceRoot: string,
  harnesses: HarnessType[],
  governanceInputs?: Partial<Record<HarnessType, GovernanceCoverageInputs>>,
): Promise<void> {
  for (const harness of harnesses) {
    const configs = await readHarnessConfigs(workspaceRoot, [harness])
    if (configs.length > 0) {
      const uploaded = await uploadConfigCapture(
        controlPlaneUrl,
        apiKey,
        workspaceId,
        harness,
        configs,
      )
      if (uploaded > 0) {
        console.log(`[config-reader] Captured ${uploaded} ${harness} config file(s)`)

        await reportGovernanceCoverageSnapshot(
          controlPlaneUrl,
          apiKey,
          workspaceId,
          harness,
          governanceInputs?.[harness] ?? {
            mcpProxyActive: false,
            nativeHookActive: false,
            llmProxyActive: false,
            hasRulesFile: true,
          },
        )
      }
    }
  }
}
