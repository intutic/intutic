/**
 * workspaceSettings.ts — Per-workspace MCP governance configuration.
 *
 * Stored as a JSONB column in `workspaces.settings`. Read by the sync-daemon
 * on every poll cycle and propagated to `~/.intutic/env/runtime.env` so that
 * proxy processes and hook scripts pick up changes without restarting.
 *
 * WS-5 — Q1 (fail behavior), Q2 (proxy mode), Q3 (bypass enforcement)
 * TD-151, TD-153, TD-154
 *
 * @module
 */

import type { McpProxyFailBehavior, McpProxyMode, BypassEnforcementTier } from './enums.js'

// Re-export so callers only need one import
export type { McpProxyFailBehavior, McpProxyMode, BypassEnforcementTier }

/**
 * Per-workspace MCP governance settings.
 *
 * All fields are optional on the wire — missing fields are filled in from
 * DEFAULT_WORKSPACE_SETTINGS by the control-plane GET handler and the
 * sync-daemon before writing runtime.env.
 */
export interface WorkspaceSettings {
  /**
   * What the MCP governance proxy does when the Intutic control plane is
   * unreachable during a tool call interception attempt.
   *
   * - `'open'`   (default): pass the tool call through + emit a warning event
   * - `'closed'`: block the tool call with a user-visible MCP error message:
   *     "Governance check failed — Intutic control plane unreachable.
   *      Tool call blocked by workspace policy."
   *
   * Applies to 13/17 harnesses (those with MCP proxy injection).
   * See TD-151 for the 4 harnesses this does not reach.
   */
  mcpProxyFailBehavior: McpProxyFailBehavior

  /**
   * MCP proxy deployment model.
   *
   * - `'per-session'` (default, Phase 4): a new proxy process is spawned per
   *   MCP connection. Policy is fetched from control plane at startup with a
   *   60s in-process TTL.
   * - `'daemon'` (Phase 5, stored but not yet active): a long-lived proxy
   *   daemon shares policy cache across all MCP sessions. Requires macOS
   *   notarization. See TD-153.
   *
   * In Phase 4, setting this to `'daemon'` is accepted and stored but the
   * sync-daemon will log a warning and continue in per-session mode.
   */
  mcpProxyMode: McpProxyMode

  /**
   * How aggressively the sync-daemon defends harness config files against
   * manual edits (bypass attempts).
   *
   * - `'rewrite'`    (default): chokidar drift watcher detects edits within ~1s
   *   and immediately rewrites the config. Also fires a `config_tamper`
   *   governance incident.
   * - `'immutable'`  (opt-in, macOS only): after writing, sets `chflags uchg`
   *   on the config file. Direct edits fail immediately. The flag is cleared
   *   before the next sync write. See TD-154 for UX risk.
   * - `'alert-only'`: drift triggers a governance incident but does NOT rewrite
   *   the config. For teams that want audit logs without enforced reversion.
   */
  bypassEnforcementTier: BypassEnforcementTier
  /** Feature flags for platform capabilities (Phase 5+) */
  featureFlags?: {
    ff_bandit_routing?: boolean
    ff_response_cache_exact?: boolean
    ff_response_cache_semantic?: boolean
    /** Phase 5 — MetaClaw prompt evolution engine (Enterprise only) */
    ff_metaclaw_evolution?: boolean
    /** Phase 6 — Network controls MDM enforcement */
    ff_network_controls?: boolean
    /** Phase 6 — Multi-region residency enforcement */
    ff_multi_region?: boolean
  }

  /**
   * TD-126 — Autonomous Skill Transfer
   *
   * When `true`, this workspace participates in the cross-workspace SOP
   * propagation system:
   * - High-performing validated SOPs (Gödel score ≥ 0.85) from this workspace
   *   may be cloned to other opt-in workspaces as DRAFT SOPs.
   * - This workspace will receive propagated SOPs from other opt-in workspaces
   *   provided no structurally similar SOP already exists (Jaccard ≥ 0.70).
   *
   * Defaults to `false` (opt-in only).
   */
  enableAutonomousSkillTransfer?: boolean

  /**
   * Whether to automatically delete local skills/rules segments that fail
   * security audits (leakage of secrets or unsafe wildcard command patterns).
   * Defaults to `false`.
   */
  enableLocalSkillAuditDelete?: boolean

  /**
   * Configurable trigger keywords for classifying bandit task types.
   */
  banditKeywords?: {
    testing?: string[]
    deployment?: string[]
    review?: string[]
    debugging?: string[]
  }
}

/**
 * Default workspace settings.
 * Applied when a workspace has no explicit settings (new workspaces)
 * or when a setting key is missing from the stored JSONB.
 */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  mcpProxyFailBehavior: 'open',
  mcpProxyMode:         'per-session',
  bypassEnforcementTier: 'rewrite',
  featureFlags: {
    ff_bandit_routing: false,
    ff_response_cache_exact: false,
    ff_response_cache_semantic: false,
  },
  enableAutonomousSkillTransfer: false,
  enableLocalSkillAuditDelete: false,
  banditKeywords: {
    testing: ['test', 'spec', 'assert', 'vitest', 'jest', 'unittest'],
    deployment: ['deploy', 'release', 'kubernetes', 'docker', 'gke', 'pipeline', 'ci/cd'],
    review: ['review', 'audit', 'lint', 'eslint', 'pr'],
    debugging: ['fix', 'bug', 'issue', 'error', 'crash', 'debug'],
  },
}

/**
 * Merge partial stored settings with defaults.
 * Ensures callers always receive a complete WorkspaceSettings object.
 */
export function resolveWorkspaceSettings(
  stored: Partial<WorkspaceSettings> | null | undefined
): WorkspaceSettings {
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...(stored ?? {}),
  }
}
