/**
 * @intutic/sync-daemon — Barrel export.
 *
 * Re-exports the public API of the sync daemon package:
 * - `startSyncLoop` — core sync loop (syncLoop.ts)
 * - `writeConfigFiles` — SOP→harness config writer (configWriter.ts)
 * - `computeFileHashes` / `hashFile` — integrity hashing (hashReporter.ts)
 * - `loadIntegrity` / `saveIntegrity` — local integrity store (integrityStore.ts)
 *
 * HLD §3.14 — Real-Time State Mirroring
 * LLD #8 — Sync Daemon / CLI
 *
 * @module
 */

export { startSyncLoop, syncOfflineTraces } from './syncLoop.js'

export { collectAgentReport, reportAgent } from './agentReporter.js'
export { startHarnessSession, endAllOpenSessions, readGitInfo } from './sessionReporter.js'
export type { SyncLoopOptions, SyncResult } from './syncLoop.js'

export { writeConfigFiles } from './configWriter.js'
export type { WriteResult } from './configWriter.js'

export { computeFileHashes, hashFile } from './hashReporter.js'

export { loadIntegrity, saveIntegrity } from './integrityStore.js'

export { HARNESS_FILES } from './configWriter.js'

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

export { guardSettingsFile, warnIfDshCoverageGap } from './watcher/settingsGuard.js'

// Gap 3 fix — Antigravity (Gemini CLI) hook coverage
export { writeAntigravityHooks } from './harness/antigravityHooks.js'

// WS-B — new harness hook coverage (claude-desktop, roo-code, continue, open-webui, n8n)
export { writeClaudeDesktopHooks } from './harness/claudeDesktopHooks.js'
export { writeRooCodeHooks } from './harness/rooCodeHooks.js'
export { writeContinueHooks } from './harness/continueHooks.js'
export { writeOpenWebuiHooks } from './harness/openWebuiHooks.js'
export { writeN8nHooks } from './harness/n8nHooks.js'

// WS-C — Proprietary harness hook coverage (Hermes, Openclaw, Pi)
export { writeHermesHooks } from './harness/hermesHooks.js'
export { writeOpenclawHooks } from './harness/openclawHooks.js'
export { writePiHooks } from './harness/piHooks.js'

// Formerly ungated harnesses with verified native mechanisms
// (codex: ~/.codex/hooks.json; github-copilot: VS Code agent hooks, Preview)
export { writeCodexHooks } from './harness/codexHooks.js'
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
  renderBoundedSection,
  injectBoundedSection,
  DECISIONS_LOG_RELATIVE_PATH,
} from './lib/decisionsDigest.js'
export type {
  DecisionsDigestEntry,
  DecisionsDigestResponse,
  DecisionsDigestOptions,
} from './lib/decisionsDigest.js'
