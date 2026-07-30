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
/** BYOC trace-storage configuration (mirrors the control plane's WorkspaceByocConfig). */
export interface ByocStorageConfig {
  provider: 'gcs' | 's3' | 'disabled'
  bucketName?: string
  prefix?: string
  projectId?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  credentials?: string
  mode?: 'mirror' | 'primary'
}

export interface WorkspaceSettings {
  /**
   * Whether developers' local markdown vaults (Obsidian/Logseq/Foam) may feed
   * the `/fix` command's Memory context on their machines.
   *
   * Enforced by the proxy at connect time via the sync channel. Vault content
   * never reaches the control plane either way — this governs only whether
   * the local search runs at all. Personal notes injected into prompts are a
   * memory-poisoning surface (OWASP agentic T1), which is why the switch is a
   * workspace policy rather than purely personal preference.
   */
  allowLocalMemoryVaults: boolean

  /**
   * Bring-your-own-cloud trace storage. Optional — absent means Intutic-managed
   * storage. Previously accessed only through `as unknown as` casts; typed here
   * so the settings UI and the control plane share one shape.
   */
  byocStorage?: ByocStorageConfig

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
  }


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
  allowLocalMemoryVaults: true,
  mcpProxyMode:         'per-session',
  bypassEnforcementTier: 'rewrite',
  featureFlags: {
    ff_bandit_routing: false,
    ff_response_cache_exact: false,
    ff_response_cache_semantic: false,
  },
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
