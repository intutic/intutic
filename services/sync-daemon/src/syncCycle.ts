/**
 * syncCycle.ts — the per-cycle work `intutic connect` runs against the
 * control plane.
 *
 * `intutic connect` (tools/cli/src/commands/connect.ts) owns the loop: it
 * polls the control plane, listens for pushed config over the WebSocket, and
 * on each cycle calls the helpers below. They live here, not in the CLI, so
 * they can be tested without starting a daemon and so the gate-side caches
 * are refreshed by exactly one implementation.
 *
 * This module used to also hold a second, complete loop (`startSyncLoop`)
 * that nothing started; the service has always run `connect`. The behaviours
 * only that loop had and the docs promise (SkillOpt edits, skill findings,
 * the decisions log, the bundled rule-author skill) are the helpers below and
 * run from `connect` now, as does its config capture (configReader.ts), which
 * uploads file content only when the workspace turned that on.
 *
 * @module
 */

import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { newIso } from '@intutic/id'
import type { HarnessType, SyncConfigPayload, SyncSopEntry } from '@intutic/shared-types'
import { deriveEnforcementInputs } from '@intutic/shared-types'
import { applyConfigEdits, loadLocalSopEntries } from './configWriter.js'
import type { ConfigEditApplyOutcome } from './configWriter.js'
import { parseSopConstraints } from './harness/claudeCodeHooks.js'
import { refreshPolicySnapshot } from './lib/policySnapshot.js'
import { refreshApprovedBypasses } from './lib/approvedBypasses.js'
import { refreshEgressPolicy } from './lib/egressPolicy.js'
import type { GovernanceCoverageInputs } from './configReader.js'
import { collectAgentReport, reportAgent, type AgentReport } from './agentReporter.js'
import { startHarnessSession } from './sessionReporter.js'

/** Narrow an unknown thrown value to a printable message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Turns a non-clean `scanSkillContent` result — already computed as part of
 * `collectAgentReport`'s `facets.skills` — into a `skill_flagged` hook event.
 *
 * Deliberately reuses the report the daemon already built for this cycle
 * rather than re-scanning: `agentReporter.ts`'s `collectSkills` runs
 * `scanSkillContent` on every `.agents/skills/**\/SKILL.md` as part of
 * building `facets.skills` already, so this only turns a result the daemon
 * already has into a visible signal — it does not add a second scan pass.
 *
 * Appends directly to `.intutic/events/hook-events.jsonl`, the SAME file
 * every emitted PreToolUse gate's `log_event`/`logEvent` writes to — not a
 * new event pipeline. `drainHookEvents` (`claudeCodeHooks.ts`) picks this
 * line up on its next pass exactly like a gate-written one, because it only
 * ever reads the file; it does not care who appended a given line.
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
      fs.mkdirSync(path.dirname(eventsLog), { recursive: true })
      fs.appendFileSync(eventsLog, entry, { flag: 'a' })
    } catch (err) {
      console.warn('[sync-daemon] failed to write skill_flagged event (non-fatal):', err)
    }
  }
}

/** The credentials every gate-side refresh takes. */
export interface GateCacheRefreshOptions {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  /** See {@link PolicySnapshotOptions.localHoldTokens}. */
  localHoldTokens?: readonly string[]
}

/**
 * The `review_before:` tokens the snapshot compiles into hold rules: from the
 * synced SOPs' front matter and JSON blocks, the workspace settings, and the
 * local `.intutic/sops`. The same parse the Claude Code writer runs for its
 * pattern blacklist, so the two cannot disagree about what is held.
 */
export async function localHoldTokensFor(
  workspaceRoot: string,
  sops: SyncSopEntry[],
  settings: Record<string, unknown> | undefined,
  harnesses: HarnessType[] = [],
): Promise<string[]> {
  const local = await loadLocalSopEntries(workspaceRoot, harnesses)
  return parseSopConstraints([...sops, ...local], settings).reviewBefore
}

/**
 * Refresh the three gate-side caches every hook reads: the policy snapshot
 * (`~/.intutic/hooks/policy-snapshot.rules`), the approved review-hold
 * bypasses and the central egress policy. Called on EVERY sync cycle, never
 * only when the config version moved: policy changes without the version
 * changing, and before this helper existed `connect` refreshed once at
 * startup and never again, so a guardrail promoted mid-session reached a
 * connected machine only on restart. None of the three throw; the return
 * says which of them landed.
 */
export async function refreshGateCaches(
  opts: GateCacheRefreshOptions,
): Promise<{ snapshot: boolean; bypasses: boolean; egress: boolean }> {
  const snapshot = (await refreshPolicySnapshot(opts)) !== null
  const bypasses = (await refreshApprovedBypasses(opts)) !== null
  const egress = (await refreshEgressPolicy(opts)) !== null
  return { snapshot, bypasses, egress }
}

/** Where the ids of SkillOpt suggestions that fully landed are remembered. */
export const APPLIED_SUGGESTIONS_RELATIVE_PATH = path.join('.intutic', 'applied-suggestions.json')

/**
 * Apply the SkillOpt config edits the control plane sent with this config,
 * and ack each outcome back (`POST /api/v1/skillopt/:id/apply-result`). A
 * suggestion queued for auto-apply reaches `applied` only through that ack.
 *
 * Only ids whose every operation landed are remembered in
 * `.intutic/applied-suggestions.json`, so a failed edit (a fuzzy-match miss,
 * a refused write) is retried next cycle rather than forgotten. With
 * `reapplyAll` every edit is applied again regardless: the caller has just
 * rewritten the harness config files from the SOPs, which drops every overlay
 * an earlier cycle applied. ADD is idempotent, so re-applying an edit that is
 * still present changes nothing.
 *
 * Never throws: a failed apply or ack must not abort the sync cycle. A
 * dropped ack only means the suggestion is synced and acked again next cycle.
 */
export async function applySkillOptEdits(opts: {
  workspaceRoot: string
  controlPlaneUrl: string
  apiKey: string
  appliedEdits: SyncConfigPayload['appliedEdits']
  bypassEnforcementTier?: string
  reapplyAll: boolean
}): Promise<ConfigEditApplyOutcome[]> {
  const appliedEdits = opts.appliedEdits ?? []
  if (appliedEdits.length === 0) return []

  const appliedPath = path.join(opts.workspaceRoot, APPLIED_SUGGESTIONS_RELATIVE_PATH)
  let localAppliedIds: string[] = []
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(appliedPath, 'utf-8'))
    if (Array.isArray(parsed)) localAppliedIds = parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    // Missing or unreadable: nothing has landed yet, so everything is applied.
  }

  const toApply = opts.reapplyAll
    ? appliedEdits
    : appliedEdits.filter((edit) => !localAppliedIds.includes(edit.suggestionId))
  if (toApply.length === 0) return []

  let results: ConfigEditApplyOutcome[]
  try {
    results = await applyConfigEdits(opts.workspaceRoot, toApply, opts.bypassEnforcementTier)
  } catch (err) {
    console.warn('[sync-daemon] Failed to apply SkillOpt config edits:', errorMessage(err))
    return []
  }

  for (const result of results) {
    await reportApplyResult(opts.controlPlaneUrl, opts.apiKey, result)
  }

  const landed = results.filter((r) => r.ok).map((r) => r.suggestionId)
  try {
    fs.mkdirSync(path.dirname(appliedPath), { recursive: true })
    fs.writeFileSync(appliedPath, JSON.stringify([...new Set([...localAppliedIds, ...landed])], null, 2), 'utf-8')
  } catch (err) {
    // Not fatal: the next cycle applies these again, and ADD is idempotent.
    console.warn('[sync-daemon] Could not record applied SkillOpt suggestions:', errorMessage(err))
  }
  return results
}

/** Ack one SkillOpt apply outcome back to the control plane. Never throws. */
async function reportApplyResult(
  controlPlaneUrl: string,
  apiKey: string,
  result: ConfigEditApplyOutcome,
): Promise<void> {
  try {
    const res = await fetch(`${controlPlaneUrl}/api/v1/skillopt/${result.suggestionId}/apply-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ok: result.ok, perOperation: result.perOperation }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[sync-daemon] reportApplyResult failed for ${result.suggestionId} (${res.status}): ${body}`)
    }
  } catch (err) {
    console.warn(`[sync-daemon] reportApplyResult request failed for ${result.suggestionId}:`, errorMessage(err))
  }
}

/**
 * Register each harness as an agent with its facets, report one session per
 * harness, and turn this cycle's skill-scan findings into `skill_flagged`
 * events. Returns each harness's governance-coverage inputs, derived from the
 * same facets, for the config capture.
 *
 * One harness failing must not stop the others, so failures are collected
 * and returned rather than thrown.
 */
export async function reportHarnessAgents(opts: {
  controlPlaneUrl: string
  apiKey: string
  workspaceId: string
  workspaceRoot: string
  harnesses: readonly HarnessType[]
  allowLocalVaults?: boolean
  /** The local proxy's instance id: the session context lands on its row. */
  proxyInstanceId?: string | null
}): Promise<{
  governanceInputs: Partial<Record<HarnessType, GovernanceCoverageInputs>>
  failures: Array<{ harness: HarnessType; error: string }>
}> {
  const governanceInputs: Partial<Record<HarnessType, GovernanceCoverageInputs>> = {}
  const failures: Array<{ harness: HarnessType; error: string }> = []
  // A skill is not harness-specific, and the scan runs once per harness.
  const skillFlaggedThisCycle = new Set<string>()
  for (const harness of opts.harnesses) {
    try {
      const report = await collectAgentReport({
        workspaceRoot: opts.workspaceRoot,
        harnessType: harness,
        configSynced: true,
        dlpEnabled: true,
        policyEnforced: true,
        allowLocalVaults: opts.allowLocalVaults,
      })
      await reportAgent(opts.controlPlaneUrl, opts.apiKey, opts.workspaceId, report)
      governanceInputs[harness] = deriveEnforcementInputs(report.facets)
      emitSkillFlaggedEvents({
        workspaceRoot: opts.workspaceRoot,
        workspaceId: opts.workspaceId,
        harnessType: harness,
        skills: report.facets.skills,
        alreadyEmitted: skillFlaggedThisCycle,
      })
      await startHarnessSession({
        controlPlaneUrl: opts.controlPlaneUrl,
        apiKey: opts.apiKey,
        workspaceId: opts.workspaceId,
        harnessType: harness,
        workspaceRoot: opts.workspaceRoot,
        ...(opts.proxyInstanceId ? { proxyInstanceId: opts.proxyInstanceId } : {}),
      })
    } catch (err) {
      failures.push({ harness, error: errorMessage(err) })
    }
  }
  return { governanceInputs, failures }
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
