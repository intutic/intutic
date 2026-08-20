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
import { deriveEnforcementInputs } from '@intutic/shared-types'
import { writeConfigFiles, HARNESS_FILES, applyConfigEdits } from './configWriter.js'
import type { ConfigEditApplyOutcome } from './configWriter.js'
import { injectMcpServer } from './harness/mcpAutoWrite.js'
import { discoverWorktrees } from './lib/gitWorktrees.js'
import { computeFileHashes } from './hashReporter.js'
import { loadIntegrity, saveIntegrity } from './integrityStore.js'
import {
  drainHookEvents,
  drainReviewRequests,
  REVIEW_REQUESTS_LOG,
} from './harness/claudeCodeHooks.js'
import { writeRuntimeEnv } from './lib/runtimeEnv.js'
import { refreshPolicySnapshot } from './lib/policySnapshot.js'
import { refreshApprovedBypasses } from './lib/approvedBypasses.js'
import { refreshEgressPolicy } from './lib/egressPolicy.js'
import { refreshDecisionsDigest } from './lib/decisionsDigest.js'
import { runComplianceProbes } from './lib/complianceProbes.js'
import { startWatcher } from './watcher/driftWatcher.js'
import { shouldCaptureThisIteration, captureAndUpload, type GovernanceCoverageInputs } from './configReader.js'
import { watch } from 'chokidar'
// Named import, not default: this package is ESM ("type": "module") and under
// Node16 resolution the default import of ioredis's CJS typings resolves to the
// module namespace, which is neither constructable nor usable as a type. The
// named export is the class itself. (The old `new (Redis as any)(...)` cast
// silenced exactly this, at the cost of also erasing the instance type.)
import { Redis } from 'ioredis'
import { TrajectoryMonitor } from './trajectoryMonitor.js'
import { collectAgentReport, reportAgent, type AgentReport } from './agentReporter.js'
import { startHarnessSession, endAllOpenSessions } from './sessionReporter.js'
import type { TraceEvent } from './trajectoryMonitor.js'

/** Narrow an unknown thrown value to a printable message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Structural guard for trace events arriving over the `trace:live:*` Valkey
 * channel. The payload is JSON off the wire, so it is genuinely unknown here;
 * `handleTraceEvent` indexes `sessionId`/`workspaceId` immediately and a
 * malformed publish would otherwise fault inside the buffer bookkeeping.
 */
function isTraceEvent(value: unknown): value is TraceEvent {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return typeof e['sessionId'] === 'string' && typeof e['workspaceId'] === 'string'
}

/**
 * Turns a non-clean `scanSkillContent` result — already computed as part of
 * `collectAgentReport`'s `facets.skills` — into a `skill_flagged` hook event
 * (TD-358).
 *
 * Deliberately reuses the report the daemon already built for this cycle
 * rather than re-scanning: `agentReporter.ts`'s `collectSkills` runs
 * `scanSkillContent` on every `.agents/skills/**\/SKILL.md` as part of
 * building `facets.skills` already, so this only turns a result the daemon
 * already has into a visible signal — it does not add a second scan pass.
 *
 * Appends directly to `.intutic/events/hook-events.jsonl`, the SAME file
 * every emitted PreToolUse gate's `log_event`/`logEvent` writes to and the
 * SAME mechanism `onDriftDetected` below already uses for `config_tamper` —
 * not a new event pipeline. `drainHookEvents` (`claudeCodeHooks.ts`) picks
 * this line up on its next pass exactly like a gate-written one, because it
 * only ever reads the file; it does not care who appended a given line.
 *
 * Report-only, per `scanSkillContent`'s own doc comment on the unmeasured
 * false-positive rate against real, benign skill markdown: this NEVER
 * blocks, mutates, or removes a skill. `hookEvents.ts`'s
 * `HookEventSchema.event` enum (control plane) counts `skill_flagged`
 * exactly like `tool_flagged` — advisory telemetry, not an incident.
 *
 * A failure to append is caught and warned, never thrown: a governance
 * telemetry write must not be able to abort the sync cycle it rides in on.
 */
export function emitSkillFlaggedEvents(opts: {
  workspaceRoot: string
  workspaceId: string
  harnessType: HarnessType
  skills: AgentReport['facets']['skills']
  /** Skills already emitted in this cycle, keyed `source:name`, mutated in
   *  place. A skill is not harness-specific, and the caller invokes this
   *  once per harness in the workspace — without a shared set, a workspace
   *  with two active harnesses would double-emit every flagged skill. */
  alreadyEmitted: Set<string>
}): void {
  const eventsLog = path.join(opts.workspaceRoot, '.intutic', 'events', 'hook-events.jsonl')
  for (const skill of opts.skills) {
    if (!skill.scanned || skill.clean) continue
    const key = `${skill.source}:${skill.name}`
    if (opts.alreadyEmitted.has(key)) continue
    opts.alreadyEmitted.add(key)
    try {
      const ts = newIso()
      const entry =
        JSON.stringify({
          event: 'skill_flagged',
          toolName: `skill:${skill.name}`,
          reason:
            `scanSkillContent found ${skill.findingsCount} finding(s) in ` +
            `${skill.source}/${skill.name}/SKILL.md — advisory only, see skillScan.ts`,
          workspaceId: opts.workspaceId,
          harnessType: opts.harnessType,
          timestamp: ts,
          incidentId: crypto
            .createHash('sha1')
            .update(ts + skill.name + opts.workspaceId)
            .digest('hex')
            .slice(0, 16),
          filePath: `${skill.source}/${skill.name}/SKILL.md`,
        }) + '\n'
      fs.appendFileSync(eventsLog, entry, { flag: 'a' })
    } catch (err) {
      console.warn('[sync-daemon] failed to write skill_flagged event (non-fatal):', err)
    }
  }
}

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
  /**
   * This cycle's per-harness governance-coverage enforcement signals, derived
   * from the same `collectAgentReport` facets step 5b already computes for
   * `POST /api/v1/agents/report` — see that step's inline derivation for the
   * mapping. Consumed by the outer loop's config-capture step to fire
   * `POST /api/v1/governance-coverage/snapshot` once per harness whose rules
   * file content actually changed this cycle.
   */
  harnessGovernanceInputs?: Partial<Record<HarnessType, GovernanceCoverageInputs>>
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
  } = options

  // Step -1: Start the Trajectory Monitor & Valkey Subscriber
  let trajectoryMonitor: TrajectoryMonitor | null = null
  let trajectorySubscriber: Redis | null = null

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
      trajectorySubscriber = new Redis(valkeyUrl)
      await trajectorySubscriber.psubscribe('trace:live:*')

      trajectorySubscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
        try {
          const event: unknown = JSON.parse(message)
          if (!isTraceEvent(event)) {
            console.warn('[sync-daemon] Discarding malformed trajectory trace event')
            return
          }
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
  let latestGovernanceInputs: Partial<Record<HarnessType, GovernanceCoverageInputs>> = {}

  // Step 0: Write runtime env file (hook scripts source this for credentials)
  // Runs once at startup and then again on every iteration.
  try {
    await writeRuntimeEnv({ controlPlaneUrl, apiKey, workspaceId })
  } catch (err) {
    console.warn('[sync-daemon] Could not write runtime env file (non-fatal):', err)
  }

  // Step 0b: Refresh the policy snapshot every gate reads.
  //
  // Deliberately here beside writeRuntimeEnv, and deliberately NOT inside
  // writeConfigFiles: that path is gated on the config version, so a snapshot
  // written there would go stale by construction on every cycle where the
  // version did not move. Policy changes without the config version changing.
  await refreshPolicySnapshot({ controlPlaneUrl, apiKey, workspaceId })

  // Step 0c: Refresh the approved review_before bypass cache, on the same
  // cadence as the policy snapshot and for the same reason — a bypass an
  // operator just approved has to reach the gate before the developer's very
  // next retry, not on the next config-version bump.
  await refreshApprovedBypasses({ controlPlaneUrl, apiKey, workspaceId })

  // Step 0d: Refresh the central egress policy, same cadence — an admin who
  // flips the workspace to `enforce` wants it on the developer's running proxy
  // this cycle, not on the next restart. The proxy hot-reloads the file.
  await refreshEgressPolicy({ controlPlaneUrl, apiKey, workspaceId })

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
  // The review-hold log, watched alongside it. Two named files rather than the
  // directory: a directory watch would also fire on `.rejected.jsonl`, which the
  // drain itself writes, and a drain that retriggers itself is a loop.
  const reviewHoldsLog = `${workspaceRoot}/${REVIEW_REQUESTS_LOG}`
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
    // Separate try: a failure draining events must not skip the holds. They go
    // to different endpoints and one being down says nothing about the other.
    try {
      const held = await drainReviewRequests(workspaceRoot, controlPlaneUrl, apiKey)
      if (held > 0) {
        console.log(`[sync-daemon] Drained ${held} review hold(s) to control plane`)
      }
    } catch (err) {
      console.warn('[sync-daemon] Review hold drain error (non-fatal):', err)
    }
  }

  try {
    fsWatcher = watch([hookEventsLog, reviewHoldsLog], { ignoreInitial: true, persistent: false })
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
      })

      // Update cached state for drift handler
      if (result) {
        latestSettings = result.settings
        latestSops = result.sops ?? []
        latestProxyUrl = result.proxyUrl ?? ''
        latestHarnesses = result.harnesses ?? []
        latestGovernanceInputs = result.harnessGovernanceInputs ?? {}
        await writeRuntimeEnv({
          controlPlaneUrl,
          apiKey,
          workspaceId,
          mcpProxyFailBehavior: result.settings?.mcpProxyFailBehavior,
          mcpProxyMode: result.settings?.mcpProxyMode,
          bypassEnforcementTier: result.settings?.bypassEnforcementTier,
        })
        // Same reasoning as Step 0b: policy rides the sync cycle, not the
        // config version.
        await refreshPolicySnapshot({ controlPlaneUrl, apiKey, workspaceId })
        // Same reasoning as Step 0c.
        await refreshApprovedBypasses({ controlPlaneUrl, apiKey, workspaceId })
        // Same reasoning as Step 0d.
        await refreshEgressPolicy({ controlPlaneUrl, apiKey, workspaceId })

        // Governed decisions log — opt-in only (WorkspaceSettings.decisionsLogEnabled,
        // default off: a growing context file is token spend the product must not
        // silently impose on every workspace). No Step-0-equivalent unconditional
        // call before the loop, unlike egress/policy/bypasses above: this gate can
        // only be evaluated once `result.settings` is known, which is not yet true
        // before the first iteration completes. When disabled, this is simply not
        // called — existing files (if any, from before the workspace disabled the
        // feature) are left as last written rather than force-deleted or overwritten
        // with a stale/wrong "disabled" digest.
        if (result.settings?.decisionsLogEnabled) {
          await refreshDecisionsDigest({
            controlPlaneUrl,
            apiKey,
            workspaceId,
            workspaceRoot,
            harnesses: latestHarnesses,
          })
        }
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
            latestGovernanceInputs,
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
  // Mark this run's harness sessions ended so the dashboard's live list
  // reflects reality.
  await endAllOpenSessions(controlPlaneUrl, apiKey)
}

// ─── Single iteration ────────────────────────────────────────────────

export interface IterationContext {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  workspaceRoot: string
  onSync?: (result: SyncResult) => void
}

/**
 * Execute a single sync iteration:
 * 1. Fetch config from control plane
 * 2. Write config files if version is newer
 * 3. Compute file hashes
 * 4. Report status back to control plane
 * 5. Update local integrity store
 * 6. Call onSync callback
 *
 * Exported (in addition to being used internally by `startSyncLoop`'s
 * polling loop) as a test seam — it is the unit that exercises exactly one
 * cycle's worth of work, including the injectMcpServer call (step 3c),
 * without the surrounding while-loop's extra one-time/Nth-iteration network
 * calls (policy snapshot, approved bypasses, egress policy, compliance
 * probes, drift watcher, decisions digest, config capture).
 */
export async function runSyncIteration(ctx: IterationContext): Promise<SyncResult> {
  const { controlPlaneUrl, apiKey, workspaceId, workspaceRoot, onSync } = ctx

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
        const results = await applyConfigEdits(
          workspaceRoot,
          toApply,
          config.settings.bypassEnforcementTier,
        )

        // Ack every result back to control-plane (TD-349). Best-effort per
        // suggestion — one failed ack must not block the others or abort
        // the sync cycle; see reportApplyResult's own non-fatal handling.
        for (const result of results) {
          await reportApplyResult(controlPlaneUrl, apiKey, result.suggestionId, result)
        }

        // Only remember ids that fully landed (every operation for that
        // suggestion applied). Recording every ATTEMPTED id regardless of
        // outcome (the old behavior) meant a fuzzy-match miss was silently
        // never retried — the id was in applied-suggestions.json forever,
        // and forceApply is the only other thing that re-attempts an id
        // already in this file. A failed edit must remain retryable.
        const landedIds = results.filter((r) => r.ok).map((r) => r.suggestionId)
        const newlyAppliedIds = Array.from(new Set([...localAppliedIds, ...landedIds]))
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

  // 3c. Proxy-wrap MCP servers across all supported harness configs. This is
  // a continuous invariant, not a one-shot done only at `connect` time: a
  // server a user adds to a harness config after their first `connect` would
  // otherwise never get wrapped and stay invisible to governance. Safe to run
  // every cycle because mcpAutoWrite's writeJsonFile is write-if-changed — an
  // already-wrapped, unchanged config writes zero bytes. Non-fatal, matching
  // step 3b above: a failure here must not abort the sync cycle.
  try {
    await injectMcpServer(workspaceRoot, workspaceId)
  } catch (err) {
    console.warn('[sync-daemon] injectMcpServer failed (non-fatal):', err)
  }

  // 3d. Worktree propagation (O1). `workspaceRoot` above only ever covers the
  // ONE checkout this daemon was pointed at — a `git worktree add`-created
  // sibling checkout has its own independent working tree, and every
  // project-tier governance file this product writes is untracked, so none
  // of it exists in a worktree by default (see gitWorktrees.ts's module doc
  // for the full mechanics and why Xirp is what surfaced this). Discovering
  // worktrees fresh every cycle — never caching the list across
  // iterations — is what makes worktree REMOVAL fall out for free: a
  // worktree `git worktree remove`d since the last cycle simply stops being
  // returned here, with no stale-entry cleanup logic required.
  //
  // Config-content writes reuse the SAME `config.configVersion > localVersion`
  // gate step 3 already used — every worktree of one repo shares the one
  // control-plane config, so re-deriving per-worktree versioning would just
  // reproduce a decision already made above. `injectMcpServer` runs
  // unconditionally per worktree, same as it does for the main root: it is
  // write-if-changed internally (mcpAutoWrite's writeJsonFile), so an
  // unchanged worktree costs a few file reads and no writes.
  try {
    const worktrees = await discoverWorktrees(workspaceRoot)
    for (const worktreeRoot of worktrees) {
      if (worktreeRoot === workspaceRoot) continue // already covered above
      try {
        if (config.configVersion > localVersion) {
          await writeConfigFiles(worktreeRoot, config.sops, config.proxyUrl, extractHarnesses(config))
        }
        await injectMcpServer(worktreeRoot, workspaceId)
      } catch (err) {
        console.warn(`[sync-daemon] worktree propagation failed for ${worktreeRoot} (non-fatal):`, err)
      }
    }
  } catch (err) {
    console.warn('[sync-daemon] discoverWorktrees failed (non-fatal):', err)
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

  // 5b. Register each harness as a durable agent with its facets, so the
  // dashboard agent graph + posture ring stay live. Best-effort: a failed
  // report never blocks the sync loop.
  //
  // Skills scanned this cycle whose finding has already been emitted, keyed
  // `source:name`. `collectAgentReport` recomputes the same workspace-wide
  // skill scan once per harness in this loop — a skill is not harness-
  // specific — so without this a workspace with two active harnesses would
  // double-emit every flagged skill every cycle.
  const skillFlaggedThisCycle = new Set<string>()
  // Per-harness governance-coverage enforcement signals for this cycle,
  // derived from the same facets `collectAgentReport` just computed — see
  // `SyncResult.harnessGovernanceInputs`'s doc comment. Uses the shared
  // `deriveEnforcementInputs` (`@intutic/shared-types`, TD-443) so this
  // mapping cannot drift from `harnessGradeSweep.ts`'s control-plane-side
  // sweep the way the two hand-kept copies previously did — safe to depend
  // on since `@intutic/shared-types` is a leaf package, not
  // `services/control-plane` itself, so this publicly-mirrored module still
  // never imports from the enterprise-only service.
  const harnessGovernanceInputs: Partial<Record<HarnessType, GovernanceCoverageInputs>> = {}
  for (const harness of harnesses) {
    const filename = HARNESS_FILES[harness]
    const configSynced = filename
      ? !fileHashes.some((f) => f.filePath === filename && f.drifted)
      : false
    const report = await collectAgentReport({
      workspaceRoot,
      harnessType: harness,
      configSynced,
      dlpEnabled: true, // the daemon-managed proxy ships DLP on by default
      policyEnforced: Boolean(controlPlaneUrl),
      allowLocalVaults: config.settings?.allowLocalMemoryVaults,
    })
    await reportAgent(controlPlaneUrl, apiKey, workspaceId, report)

    harnessGovernanceInputs[harness] = deriveEnforcementInputs(report.facets)

    // 5b-i. Skill-content scan findings, surfaced as `skill_flagged` events
    // (TD-358). See `emitSkillFlaggedEvents`'s own doc comment for why this
    // rides the existing hook-events drain rather than a new pipeline.
    emitSkillFlaggedEvents({
      workspaceRoot,
      workspaceId,
      harnessType: harness,
      skills: report.facets.skills,
      alreadyEmitted: skillFlaggedThisCycle,
    })

    // 5c. Open a real session for the harness (once per daemon run — the
    // reporter dedupes). This is what switches on branch/commit capture and
    // the task-context cascade; without it sessions only ever existed as
    // server-minted synthetic rows.
    await startHarnessSession({
      controlPlaneUrl,
      apiKey,
      workspaceId,
      harnessType: harness,
      workspaceRoot,
    })
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

  // 6b. ContextGraph indexing — REMOVED.
  //
  // This block scanned the whole workspace every sync cycle and POSTed the
  // delta to /api/v1/context/sync, an ingest stripped from the control plane
  // with the Context Graph feature (commit 9cfc0200). Worse than dead: the
  // integrity file is only written on a 2xx, so every cycle re-scanned and
  // re-posted the same delta forever on every developer machine.

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
    harnessGovernanceInputs,
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

/**
 * Ack a SkillOpt config-edit apply outcome back to the control plane
 * (TD-349) — POST /api/v1/skillopt/:suggestionId/apply-result.
 *
 * Same HTTP call shape as `reportGovernanceCoverageSnapshot`
 * (configReader.ts): `fetch` + `AbortSignal.timeout(10_000)`, fully
 * non-fatal. This ack closing the loop is important, but it must never be
 * allowed to abort a sync cycle that otherwise succeeded — a dropped ack
 * just means the suggestion re-syncs and gets acked again next cycle
 * (getSyncConfig re-pushes 'applied' and 'apply_unconfirmed' rows alike).
 */
async function reportApplyResult(
  controlPlaneUrl: string,
  apiKey: string,
  suggestionId: string,
  result: ConfigEditApplyOutcome,
): Promise<void> {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/v1/skillopt/${suggestionId}/apply-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ok: result.ok,
        perOperation: result.perOperation,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[sync-daemon] reportApplyResult failed for ${suggestionId} (${res.status}): ${body}`)
    }
  } catch (err) {
    console.warn(`[sync-daemon] reportApplyResult request failed for ${suggestionId}:`, err)
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
      } catch (renameErr) {
        console.error(`[sync-daemon] Failed to lock/rename file ${file}:`, errorMessage(renameErr))
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
      } catch (err) {
        console.error(`[sync-daemon] Failed to sync offline traces back from ${file}:`, errorMessage(err))
        // Revert rename on failure to allow retry on next cycle
        try {
          if (fs.existsSync(syncingPath)) {
            fs.renameSync(syncingPath, originalPath)
          }
        } catch (revertErr) {
          console.error(`[sync-daemon] Failed to revert rename for ${file}:`, errorMessage(revertErr))
        }
      }
    }
  } catch (err) {
    console.error(`[sync-daemon] Failed to scan offline traces directory:`, errorMessage(err))
  }
}
