/**
 * syncLoop.ts — Core bidirectional sync loop.
 *
 * The sync loop is the heartbeat of the daemon. Each iteration:
 * 1. Fetches config from the control plane (POST /api/v1/sync/config)
 * 2. If configVersion > local → writes SOP content to harness files
 * 3. Computes SHA-256 hashes of local config files
 * 4. Reports hashes + status back to the control plane
 * 5. Calls the onSync callback with the result
 * 6. Sleeps for pollIntervalMs (AbortSignal-aware)
 * 7. Repeats until signal.aborted
 *
 * Design: never crash on a single iteration failure. Errors are
 * caught per-iteration, logged, and the loop continues.
 *
 * HLD §3.14 — Real-Time State Mirroring
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { newIso } from '@intutic/id'
import type {
  HarnessType,
  SyncConfigPayload,
  SopFileHash,
  WorkspaceSettings,
} from '@intutic/shared-types'
import { writeConfigFiles, HARNESS_FILES, applyConfigEdits } from './configWriter.js'
import { computeFileHashes } from './hashReporter.js'
import { loadIntegrity, saveIntegrity } from './integrityStore.js'
import { drainHookEvents } from './harness/claudeCodeHooks.js'
import { writeRuntimeEnv } from './lib/runtimeEnv.js'
import { runComplianceProbes } from './lib/complianceProbes.js'
import { startWatcher } from './watcher/driftWatcher.js'
import { shouldCaptureThisIteration, captureAndUpload } from './configReader.js'
import { watch } from 'chokidar'
import Redis from 'ioredis'
import { TrajectoryMonitor } from './trajectoryMonitor.js'

// ─── Public interfaces ───────────────────────────────────────────────

/** Configuration for the sync loop. */
export interface SyncLoopOptions {
  /** Control plane base URL (e.g., `https://api.intutic.ai`). */
  controlPlaneUrl: string
  /** API key for authentication (vk_* or JWT). */
  apiKey: string
  /** Workspace identifier. */
  workspaceId: string
  /** Absolute path to the workspace root directory. */
  workspaceRoot: string
  /** Poll interval in milliseconds (default: 30000). */
  pollIntervalMs?: number
  /** Enable dev mode (relaxed checks, verbose logging). */
  devMode?: boolean
  /** Callback invoked after each successful sync iteration. */
  onSync?: (result: SyncResult) => void
  /** AbortSignal to gracefully stop the loop. */
  signal?: AbortSignal
  /** Adapter identifier for ContextGraph sync. */
  adapterId?: string
}

/** Result of a single sync iteration. */
export interface SyncResult {
  /** Config version from the control plane. */
  configVersion: number
  /** Number of harness config files written. */
  sopsWritten: number
  /** Number of files with hash drift. */
  driftCount: number
  /** ISO timestamp of this sync. */
  timestamp: string
  /** Resolved workspace settings from the control plane. WS-5. */
  settings?: WorkspaceSettings
  /** All active SOP rules. */
  sops?: SyncConfigPayload['sops']
  /** Proxy URL. */
  proxyUrl?: string
  /** Active harnesses. */
  harnesses?: HarnessType[]
}

// ─── Default constants ───────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 30_000

// ─── Core sync loop ──────────────────────────────────────────────────

/**
 * Start the sync loop. This function runs indefinitely until the
 * AbortSignal is triggered or the process exits.
 *
 * @param options - Sync loop configuration.
 */
export async function startSyncLoop(options: SyncLoopOptions): Promise<void> {
  const {
    controlPlaneUrl,
    apiKey,
    workspaceId,
    workspaceRoot,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onSync,
    signal,
    adapterId,
  } = options

  // Step -1: Start the Trajectory Monitor & Valkey Subscriber
  let trajectoryMonitor: TrajectoryMonitor | null = null
  let trajectorySubscriber: any = null

  if (process.env.VALKEY_URL || apiKey) {
    const valkeyUrl = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379'
    trajectoryMonitor = new TrajectoryMonitor({
      valkeyUrl,
      controlPlaneUrl,
      apiKey,
      windowMs: 300_000,
      submitIntervalMs: 60_000,
    })

    try {
      await trajectoryMonitor.start()
      trajectorySubscriber = new (Redis as any)(valkeyUrl)
      await trajectorySubscriber.psubscribe('trace:live:*')
      
      trajectorySubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        try {
          const event = JSON.parse(message)
          trajectoryMonitor?.handleTraceEvent(event)
        } catch (err) {
          // Non-blocking warning
          console.warn('[sync-daemon] Failed to parse trajectory trace event:', err)
        }
      })
      console.log('[sync-daemon] Trajectory monitor & subscriber started successfully')
    } catch (err) {
      console.warn('[sync-daemon] Could not start trajectory monitor:', err)
    }
  }

  // Tracking latest settings for use in drift handler
  let latestSettings: WorkspaceSettings | undefined
  let latestSops: SyncConfigPayload['sops'] = []
  let latestProxyUrl = ''
  let latestHarnesses: HarnessType[] = []

  // Step 0: Write runtime env file (hook scripts source this for credentials)
  // Runs once at startup and then again on every iteration.
  try {
    await writeRuntimeEnv({ controlPlaneUrl, apiKey, workspaceId })
  } catch (err) {
    console.warn('[sync-daemon] Could not write runtime env file (non-fatal):', err)
  }

  // Try to sync offline traces back to PostgreSQL
  try {
    await syncOfflineTraces(controlPlaneUrl, apiKey)
  } catch (err) {
    console.warn('[sync-daemon] Could not sync offline traces (non-fatal):', err)
  }

  // Set up FSEvents-driven hook event drain (replaces 30s fixed poll for drain step).
  // Drains immediately when the hook-events.jsonl file changes (written by hook scripts).
  // Falls back to a 60s safety-net interval for NFS/Docker mounts where inotify may not fire.
  const hookEventsLog = `${workspaceRoot}/.intutic/events/hook-events.jsonl`
  let fsWatcher: ReturnType<typeof watch> | null = null
  let drainSafetyTimer: ReturnType<typeof setInterval> | null = null

  const runDrain = async () => {
    try {
      const drained = await drainHookEvents(workspaceRoot, controlPlaneUrl, apiKey)
      if (drained > 0) {
        console.log(`[sync-daemon] Drained ${drained} hook governance events to control plane`)
      }
    } catch (err) {
      console.warn('[sync-daemon] Hook event drain error (non-fatal):', err)
    }
  }

  try {
    fsWatcher = watch(hookEventsLog, { ignoreInitial: true, persistent: false })
    fsWatcher.on('change', runDrain)
    fsWatcher.on('add', runDrain)
  } catch {
    // chokidar unavailable — rely on the 60s safety-net only
  }

  // 60-second safety-net drain poll (catches events missed by FSEvents on NFS/Docker)
  drainSafetyTimer = setInterval(runDrain, 60_000)

  signal?.addEventListener('abort', () => {
    fsWatcher?.close()
    if (drainSafetyTimer) clearInterval(drainSafetyTimer)
    trajectoryMonitor?.stop()
    trajectorySubscriber?.disconnect()
  }, { once: true })

  // WS-5 — Drift watcher with onDriftDetected callback
  // Wired once after first successful sync (when we have harness list).
  // The callback fires a config_tamper governance event and immediately rewrites config.
  let driftWatcher: { stop: () => void } | null = null

  const onDriftDetected = async (changedPath: string): Promise<void> => {
    // 1. Immediately rewrite config (if settings allow)
    if (latestSettings?.bypassEnforcementTier !== 'alert-only') {
      try {
        await writeConfigFiles(
          workspaceRoot,
          latestSops,
          latestProxyUrl,
          latestHarnesses,
          workspaceId,
          latestSettings?.bypassEnforcementTier,
        )
      } catch (err) {
        console.warn('[sync-daemon] onDriftDetected: writeConfigFiles failed (non-fatal):', err)
      }
    }

    // 2. Append config_tamper event to hook-events JSONL
    try {
      const tamperEntry = JSON.stringify({
        event: 'config_tamper',
        toolName: 'config_file',
        reason: 'Harness config file modified outside sync-daemon',
        workspaceId,
        filePath: changedPath,
        timestamp: new Date().toISOString(),
        incidentId: crypto.createHash('sha1').update(changedPath + Date.now()).digest('hex').slice(0, 16),
      }) + '\n'
      const hookEventsJsonl = path.join(os.homedir(), '.intutic', 'events', 'hook-events.jsonl')
      fs.appendFileSync(hookEventsJsonl, tamperEntry, { flag: 'a' })
    } catch (err) {
      console.warn('[sync-daemon] onDriftDetected: failed to write tamper event (non-fatal):', err)
    }
  }

  let iterationCount = 0

  while (!signal?.aborted) {
    try {
      // Refresh runtime env on every iteration (key rotation)
      const result = await runSyncIteration({
        controlPlaneUrl,
        apiKey,
        workspaceId,
        workspaceRoot,
        onSync,
        adapterId,
      })

      // Update cached state for drift handler
      if (result) {
        latestSettings = result.settings
        latestSops = result.sops ?? []
        latestProxyUrl = result.proxyUrl ?? ''
        latestHarnesses = result.harnesses ?? []
        await writeRuntimeEnv({
          controlPlaneUrl,
          apiKey,
          workspaceId,
          mcpProxyFailBehavior: result.settings?.mcpProxyFailBehavior,
          mcpProxyMode: result.settings?.mcpProxyMode,
          bypassEnforcementTier: result.settings?.bypassEnforcementTier,
        })
      }

      // Start the drift watcher on first successful sync (once harnesses are known)
      if (!driftWatcher && latestHarnesses.length > 0) {
        try {
          driftWatcher = startWatcher(workspaceRoot, latestHarnesses, onDriftDetected)
          signal?.addEventListener('abort', () => driftWatcher?.stop(), { once: true })
        } catch (err) {
          console.warn('[sync-daemon] Could not start drift watcher (non-fatal):', err)
        }
      }

      // Run network compliance probes to check for proxy bypass
      try {
        const probeResults = await runComplianceProbes(workspaceId)
        for (const res of probeResults) {
          if (!res.contained && res.incident) {
            const entry = JSON.stringify(res.incident) + '\n'
            fs.appendFileSync(hookEventsLog, entry, { flag: 'a' })
          }
        }
      } catch (err) {
        console.warn('[sync-daemon] Compliance probes failed (non-fatal):', err)
      }
      // 4b. Capture harness configs back to control plane (every Nth iteration)
      if (shouldCaptureThisIteration(iterationCount)) {
        try {
          await captureAndUpload(
            controlPlaneUrl, apiKey, workspaceId, workspaceRoot, latestHarnesses,
          )
        } catch (err) {
          console.warn('[sync-daemon] Config capture failed (non-fatal):', err)
        }
      }
      iterationCount++
    } catch (err) {
      console.error('[sync-daemon] iteration error:', err)
    }

    await sleep(pollIntervalMs, signal)
  }

  // Cleanup on exit
  fsWatcher?.close()
  driftWatcher?.stop()
  if (drainSafetyTimer) clearInterval(drainSafetyTimer)
}

// ─── Single iteration ────────────────────────────────────────────────

interface IterationContext {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  workspaceRoot: string
  onSync?: (result: SyncResult) => void
  adapterId?: string
}

/**
 * Execute a single sync iteration:
 * 1. Fetch config from control plane
 * 2. Write config files if version is newer
 * 3. Compute file hashes
 * 4. Report status back to control plane
 * 5. Update local integrity store
 * 6. Call onSync callback
 */
async function runSyncIteration(ctx: IterationContext): Promise<SyncResult> {
  const { controlPlaneUrl, apiKey, workspaceId, workspaceRoot, onSync, adapterId } = ctx

  // 1. Fetch config from control plane
  const config = await fetchConfig(controlPlaneUrl, apiKey, workspaceId)

  // 2. Load local integrity store
  const integrity = await loadIntegrity(workspaceRoot)
  const localVersion = integrity?.configVersion ?? -1

  let sopsWritten = 0

  // 3. If remote version is newer → write config files
  if (config.configVersion > localVersion) {
    const harnesses = extractHarnesses(config)
    const writeResult = await writeConfigFiles(
      workspaceRoot,
      config.sops,
      config.proxyUrl,
      harnesses,
    )
    sopsWritten = writeResult.filesWritten.length
  }

  // 3b. Apply custom config edits from SkillOpt suggestions
  if (config.appliedEdits && config.appliedEdits.length > 0) {
    const forceApply = sopsWritten > 0
    const appliedSuggestionsPath = path.join(workspaceRoot, '.intutic', 'applied-suggestions.json')
    let localAppliedIds: string[] = []

    try {
      if (fs.existsSync(appliedSuggestionsPath)) {
        localAppliedIds = JSON.parse(fs.readFileSync(appliedSuggestionsPath, 'utf-8'))
      }
    } catch {
      // ignore
    }

    const toApply = forceApply
      ? config.appliedEdits
      : config.appliedEdits.filter(edit => !localAppliedIds.includes(edit.suggestionId))

    if (toApply.length > 0) {
      try {
        await applyConfigEdits(
          workspaceRoot,
          toApply,
          config.settings.bypassEnforcementTier,
        )
        const newlyAppliedIds = Array.from(new Set([...localAppliedIds, ...toApply.map(e => e.suggestionId)]))
        try {
          fs.mkdirSync(path.dirname(appliedSuggestionsPath), { recursive: true })
          fs.writeFileSync(appliedSuggestionsPath, JSON.stringify(newlyAppliedIds, null, 2), 'utf-8')
        } catch {
          // ignore
        }
      } catch (err) {
        console.warn('[sync-daemon] Failed to apply custom SkillOpt config edits:', err)
      }
    }
  }

  // 4. Compute file hashes for drift detection
  const harnesses = extractHarnesses(config)
  const canonicalHashes = buildCanonicalHashMap(config)
  const fileHashes = await computeFileHashes(
    workspaceRoot,
    harnesses,
    canonicalHashes,
  )
  const driftCount = fileHashes.filter((f) => f.drifted).length

  // 5. Report status back to control plane per active harness
  for (const harness of harnesses) {
    const filename = HARNESS_FILES[harness]
    if (!filename) continue
    const harnessHashes = fileHashes.filter((f) => f.filePath === filename)
    if (harnessHashes.length > 0) {
      await reportStatus(controlPlaneUrl, apiKey, workspaceId, harness, harnessHashes)
    }
  }

  // 6. Update local integrity store
  const newFiles: Record<string, string> = {}
  for (const fh of fileHashes) {
    if (fh.localHash) {
      newFiles[fh.filePath] = fh.localHash
    }
  }
  await saveIntegrity(workspaceRoot, {
    lastSyncAt: newIso(),
    configVersion: config.configVersion,
    files: newFiles,
  })

  // 6b. ContextGraph Indexing Scan & Sync (WS1: LLD #16)
  if (adapterId) {
    try {
      const { BrainIndexer } = await import('./brainIndexer.js')
      const { loadContextIntegrity, saveContextIntegrity } = await import('./integrityStore.js')

      const scanResult = await BrainIndexer.scanWorkspace(workspaceRoot)
      const contextIntegrity = await loadContextIntegrity(workspaceRoot)
      const delta = BrainIndexer.computeDelta(scanResult, contextIntegrity)

      if (delta.upserted.length > 0 || delta.deleted.length > 0) {
        const syncUrl = `${controlPlaneUrl}/api/v1/context/sync`
        const res = await fetch(syncUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            adapterId,
            delta,
          }),
          signal: AbortSignal.timeout(15_000),
        })

        if (res.ok) {
          const newContextFiles: Record<string, string> = {}
          for (const [filePath, file] of Object.entries(scanResult.files)) {
            newContextFiles[filePath] = file.hash
          }
          await saveContextIntegrity(workspaceRoot, {
            lastSyncAt: newIso(),
            configVersion: config.configVersion,
            files: newContextFiles,
          })
        } else {
          console.warn(`[sync-daemon] ContextGraph sync failed: ${res.status} ${res.statusText}`)
        }
      }
    } catch (err) {
      console.warn('[sync-daemon] ContextGraph sync error:', err)
    }
  }

  // 6c. Hook event drain is now FSEvents-driven (see startSyncLoop).
  //     No per-iteration drain needed here; the chokidar watcher handles it.

  // 7. Invoke onSync callback
  const result: SyncResult = {
    configVersion: config.configVersion,
    sopsWritten,
    driftCount,
    timestamp: newIso(),
    settings: config.settings,
    sops: config.sops,
    proxyUrl: config.proxyUrl,
    harnesses,
  }
  onSync?.(result)
  return result
}

// ─── HTTP helpers ────────────────────────────────────────────────────

/**
 * Fetch the sync config from the control plane.
 *
 * POST /api/v1/sync/config
 */
async function fetchConfig(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
): Promise<SyncConfigPayload> {
  const url = `${controlPlaneUrl}/api/v1/sync/config`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ workspaceId }),
    signal: AbortSignal.timeout(15_000), // 15s request timeout
  })

  if (!res.ok) {
    throw new Error(
      `[sync-daemon] fetchConfig failed: ${res.status} ${res.statusText}`,
    )
  }

  return (await res.json()) as SyncConfigPayload
}

/**
 * Report file hashes and status back to the control plane.
 *
 * POST /api/v1/sync/sop-hash
 */
async function reportStatus(
  controlPlaneUrl: string,
  apiKey: string,
  workspaceId: string,
  harnessType: HarnessType,
  files: SopFileHash[],
): Promise<void> {
  const url = `${controlPlaneUrl}/api/v1/sync/sop-hash`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      workspaceId,
      harnessType,
      files,
      reportedAt: newIso(),
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    // Non-fatal: log but don't throw (control plane might be temporarily down)
    console.warn(
      `[sync-daemon] reportStatus failed for ${harnessType}: ${res.status} ${res.statusText}`,
    )
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract unique harness types from a sync config payload.
 */
function extractHarnesses(config: SyncConfigPayload): HarnessType[] {
  const set = new Set<HarnessType>()
  for (const sop of config.sops) {
    for (const h of sop.harnessTargets) {
      set.add(h)
    }
  }
  return [...set]
}

/**
 * Build a filePath → canonical hash map from the config's SOPs.
 * Uses the first canonical hash found for each file path.
 */
function buildCanonicalHashMap(
  config: SyncConfigPayload,
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const sop of config.sops) {
    // Each SOP has a single contentHash; in a multi-harness scenario
    // the same hash applies to the content source (not the formatted output).
    // For per-file canonical hashes, the control plane would need to
    // provide them per-harness. For now we use sop.contentHash as a
    // proxy keyed by sopId.
    map[sop.sopId] = sop.contentHash
  }
  return map
}

/**
 * Sleep for the given duration with AbortSignal support.
 *
 * Resolves immediately if the signal is already aborted.
 * Otherwise, resolves after `ms` milliseconds or when the
 * signal fires, whichever comes first.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function syncOfflineTraces(controlPlaneUrl: string, apiKey: string): Promise<void> {
  const logsDir = path.join(os.homedir(), '.intutic', 'logs')
  if (!fs.existsSync(logsDir)) return

  try {
    const files = fs.readdirSync(logsDir)
    const traceFiles = files.filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
    if (traceFiles.length === 0) return

    for (const file of traceFiles) {
      const originalPath = path.join(logsDir, file)
      const syncingPath = originalPath + '.syncing'

      // Rename to avoid write race conditions with the Rust proxy
      try {
        fs.renameSync(originalPath, syncingPath)
      } catch (renameErr: any) {
        console.error(`[sync-daemon] Failed to lock/rename file ${file}:`, renameErr.message)
        continue
      }

      try {
        const raw = fs.readFileSync(syncingPath, 'utf-8')
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
        if (lines.length === 0) {
          // Empty file, just clean it up
          fs.unlinkSync(syncingPath)
          continue
        }

        const traces = lines.map(line => JSON.parse(line))
        console.log(`[sync-daemon] Found ${traces.length} offline traces to sync back in ${file}.`)

        // Batch in groups of 100
        const batchSize = 100
        for (let i = 0; i < traces.length; i += batchSize) {
          const batch = traces.slice(i, i + batchSize)
          const res = await fetch(`${controlPlaneUrl}/api/v1/traces/sync-back`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ traces: batch }),
          })

          if (!res.ok) {
            throw new Error(`Sync-back API returned status ${res.status}`)
          }
        }

        // Successfully synced this sharded file, delete it
        fs.unlinkSync(syncingPath)
        console.log(`[sync-daemon] Successfully synced ${traces.length} offline traces back from ${file}.`)
      } catch (err: any) {
        console.error(`[sync-daemon] Failed to sync offline traces back from ${file}:`, err.message)
        // Revert rename on failure to allow retry on next cycle
        try {
          if (fs.existsSync(syncingPath)) {
            fs.renameSync(syncingPath, originalPath)
          }
        } catch (revertErr: any) {
          console.error(`[sync-daemon] Failed to revert rename for ${file}:`, revertErr.message)
        }
      }
    }
  } catch (err: any) {
    console.error(`[sync-daemon] Failed to scan offline traces directory:`, err.message)
  }
}
