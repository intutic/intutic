/**
 * `@intutic/gate` — pre-execution tool gate for JS/TS agent frameworks
 * without a shipped Intutic harness.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/gate/` (Python). Framework
 * adapters (`@intutic/gate/mastra`, `@intutic/gate/vercel`,
 * `@intutic/gate/dsh`) are sibling phases built on top of this core; see
 * README.md for the subpath convention they follow.
 */

export { classify, isDeploy, isTest, touchesInfra } from './actions.js'

export { GateClient } from './client.js'
export type { GateClientOptions, GateResponse } from './client.js'

export { GateError, GateConnectionError, IntuticGateHold, IntuticGateRefusal, GATE_REFUSAL_CODES } from './errors.js'
export type { GateRefusalCode } from './errors.js'

export { canonicalJson, holdKey, holdMessage } from './hold.js'

export { COMMAND_SIZE_LIMIT, ARGUMENTS_SIZE_LIMIT, GATE_DEADLINE_MS } from './limits.js'

export { Gate, READ_ONLY_TOOLS, install, active } from './gate.js'
export type { GateConfig, ToolInput } from './gate.js'

export { intuticHeaders } from './headers.js'
export type { IntuticHeadersOptions } from './headers.js'

export {
  checkCommand,
  checkImages,
  checkWrittenManifest,
  isDeployCommand,
  isPinned,
  manifestPathsFromCommand,
  parseImageRef,
  verdictReason,
} from './imagecheck.js'
export type { ImagePolicy, ImageRef, ImageRefusalCode, Verdict as ImageVerdict } from './imagecheck.js'

export {
  Snapshot,
  evaluate,
  guardDisabledFromEnv,
  loadSnapshot,
  snapshotPath,
  SEV_BLOCK,
  SEV_HOLD,
  SEV_SHADOW,
  SEV_WARN,
} from './snapshot.js'
export type { Decision, Rule, RuleSubject, Severity, SnapshotState } from './snapshot.js'

export type { SsoGroupClearance, SsoGroupPolicy, SsoGroupRecord } from './ssoGroups.js'

export type { McpAllowlistRecord, McpRegistryRecord } from './mcpRegistryRecord.js'

export {
  firstMatch,
  parseRules,
  ruleMatches,
  serialiseToolInput,
  supportsArgPatterns,
  fetchRules,
  ACTION_BLOCK,
  ACTION_WARN,
  ACTION_APPROVAL,
} from './soprules.js'
export type { SopRule } from './soprules.js'

export { wrapTool, wrapTools } from './wrapTools.js'
export type { AnyFn, ExecutableTool, WrapToolOptions } from './wrapTools.js'
