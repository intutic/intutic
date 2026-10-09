/**
 * @intutic/sync-daemon — Barrel export.
 *
 * Re-exports the public API of the sync daemon package. `intutic connect`
 * (tools/cli) runs the sync loop and calls the per-cycle helpers in
 * syncCycle.ts; the harness writers live under harness/.
 *
 * HLD §3.14 — Real-Time State Mirroring
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

export {
  syncOfflineTraces,
  refreshGateCaches,
  localHoldTokensFor,
  applySkillOptEdits,
  reportHarnessAgents,
  emitSkillFlaggedEvents,
  APPLIED_SUGGESTIONS_RELATIVE_PATH,
} from './syncCycle.js'

export { collectAgentReport, reportAgent, fetchLocalProxyInstanceId } from './agentReporter.js'
export { collectDeviceInventory, reportDeviceInventory } from './inventory.js'
export type { DetectedHarness } from './inventory.js'
export { startHarnessSession, endAllOpenSessions, readGitInfo } from './sessionReporter.js'

export { loadLocalSopEntries, HARNESS_FILES, clearImmutable, setImmutable } from './configWriter.js'

export { captureAndUpload, shouldCaptureThisIteration, redactConfigText } from './configReader.js'

export { writeBundledSkills } from './skillWriter.js'

export { SyncWsClient } from './wsClient.js'
export type { WsClientOptions } from './wsClient.js'

export { startWatcher } from './watcher/driftWatcher.js'

export {
  updatePreToolUseHooks,
  parseSopConstraints,
  drainHookEvents,
  drainReviewRequests,
  REVIEW_REQUESTS_LOG,
  REVIEW_REQUESTS_BASENAME,
  REVIEW_REQUEST_VERSION,
} from './harness/claudeCodeHooks.js'
export type { SopHookConstraints } from './harness/claudeCodeHooks.js'

export { injectMcpServer } from './harness/mcpAutoWrite.js'
export { planDisconnect, DisconnectPlan, HARNESS_REVERSERS, keepOriginal, noteWritten, noteProxyUrl, writeOwnedFile } from './disconnect/index.js'
export type { DisconnectOptions, PlannedChange, PlanNote } from './disconnect/index.js'

export { guardPolicySnapshot, guardSettingsFile, isGuardedPath, warnIfDshCoverageGap } from './watcher/settingsGuard.js'

export { readJsonObjectForMerge } from './harness/jsonMergeTarget.js'
export { writeRulesSection, retireRulesFile, rulesSectionOf, RULES_SECTION_START, RULES_SECTION_END, RULES_MARKERS, DECISIONS_MARKERS } from './harness/rulesSection.js'
export type { SectionMarkers } from './harness/rulesSection.js'
export { gateKindForHarness } from '@intutic/shared-types'

// Gap 3 fix — Antigravity (Gemini CLI) hook coverage
export { writeAntigravityHooks, buildGeminiBeforeToolEntry } from './harness/antigravityHooks.js'
export { writeAntigravityCliHooks, buildAntigravityHookEntry, ANTIGRAVITY_HOOK_NAME } from './harness/antigravityCliHooks.js'
export { antigravityGateIdentities } from './harness/antigravityProducts.js'

// WS-B — new harness hook coverage (continue, open-webui, n8n)
export { mergeContinueConfig } from './harness/continueConfigMerger.js'
export { writeOpenWebuiHooks } from './harness/openWebuiHooks.js'
export { writeN8nHooks } from './harness/n8nHooks.js'

// WS-C — Proprietary harness hook coverage (Hermes, Openclaw, Pi)
export { writeHermesHooks } from './harness/hermesHooks.js'
export { writeOpenclawHooks, openclawAgentWorkspace } from './harness/openclawHooks.js'
export { writePiHooks } from './harness/piHooks.js'

// Formerly ungated harnesses with verified native mechanisms
// (codex: ~/.codex/hooks.json; github-copilot: VS Code agent hooks, Preview)
export { writeCodexHooks } from './harness/codexHooks.js'
export { mergeCodexConfig } from './harness/codexConfigMerger.js'
export { writeGithubCopilotHooks } from './harness/githubCopilotHooks.js'

// WS-A & WS-F — runtime env writer and compliance probes
export { writeRuntimeEnv } from './lib/runtimeEnv.js'
export {
  refreshPolicySnapshot,
  writePolicySnapshot,
  fetchResolvedPolicy,
  buildSnapshotRules,
  validateRule,
  DEFAULT_SNAPSHOT_DIR,
  DESTRUCTIVE_TIER_SEVERITY,
} from './lib/policySnapshot.js'
export { runComplianceProbes } from './lib/complianceProbes.js'
export { getActiveAgentProcesses } from './lib/processPoller.js'

export { TrajectoryMonitor } from './trajectoryMonitor.js'

// Phase 6 — governed decisions log
export {
  refreshDecisionsDigest,
  fetchDecisionsDigest,
  renderDecisionsMarkdown,
  renderDecisionsSectionBody,
  retireClaudeMdDigest,
  writeDecisionsTargets,
  DECISIONS_LOG_RELATIVE_PATH,
  DECISIONS_FILE_HEADER,
} from './lib/decisionsDigest.js'
export { claudeCodeReadsAgentsMd } from './harness/claudeAgentsMd.js'
export type {
  DecisionsDigestEntry,
  DecisionsDigestResponse,
  DecisionsDigestOptions,
} from './lib/decisionsDigest.js'
