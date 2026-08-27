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
   * Days of SSO inactivity after which a member's API keys stop authenticating.
   *
   * `null` disables the gate. Defaults to 30 days. SCIM provisioning was removed,
   * so nothing reconciles membership against the identity provider: without this,
   * removing a developer at the IdP stops their dashboard login but not their
   * agents, because API-key auth never consults SSO (TD-218). Setting it makes IdP
   * removal expire the keys on its own.
   *
   * Opt-in on purpose — a CI key belongs to a member who may never log in
   * interactively, and enabling this globally would break those pipelines.
   */
  ssoKeyMaxIdleDays: number | null

  /**
   * ISO timestamp of when `ssoKeyMaxIdleDays` was switched on, set by the settings
   * endpoint. The gate grants one full window from this point before it refuses
   * anything, so enabling it ramps rather than cutting off members who have no
   * recorded SSO login yet. Cleared when the gate is turned off.
   */
  ssoKeyGateEnabledAt: string | null

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
   * Applies to 8/19 harnesses (those with MCP proxy injection — 9 config
   * paths across 8 harnesses, see sync-daemon mcpAutoWrite.ts).
   * See TD-151 for the harnesses this does not reach.
   */
  mcpProxyFailBehavior: McpProxyFailBehavior

  /**
   * MCP proxy deployment model.
   *
   * - `'per-session'` (default): a new proxy process is spawned per
   *   MCP connection. Policy is fetched from control plane at startup with a
   *   60s in-process TTL.
   * - `'daemon'` (active): a long-lived proxy daemon shares its policy cache
   *   across all MCP sessions. Requires macOS notarization. See TD-153.
   *
   * The sync-daemon writes this value through verbatim to
   * ~/.intutic/env/runtime.env (lib/runtimeEnv.ts) and the MCP proxy honours
   * it: with `'daemon'` set, policy lookups go through the daemon's Unix
   * socket. Caveat: daemon health telemetry is not reported — the
   * health-snapshot route was removed and the dashboard flag is hardcoded off.
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
    /**
     * Evaluate every detector, record what it would have done, and allow the
     * request anyway. Read by the proxy from `workspace:feature_flags:{ws}`.
     *
     * Declaring it here is not enough on its own — the PUT schema in
     * `routes/workspace.ts` must list it too, because that `z.object` strips
     * unknown keys. `ff_metaclaw_evolution` above was declared here and omitted
     * there, so it has never been settable either.
     */
    ff_shadow_enforcement?: boolean
    /**
     * Let a MetaClaw evolution proposal auto-apply instead of waiting for
     * human review. Read directly off raw settings JSON by
     * `promptEvolutionService.runEvolutionCycle` — no Valkey mirror, since
     * nothing else needs a hot-path read of it.
     *
     * Also declared here without being settable until now — same "declared,
     * never added to the PUT schema" bug as `ff_shadow_enforcement` above.
     */
    ff_metaclaw_auto_apply?: boolean
    /**
     * Let a high-confidence SkillOpt config-edit suggestion auto-apply
     * instead of waiting for human review. Mirrored into Valkey
     * (`ff:{workspaceId}:skillopt_auto_apply`) by `persistAndSyncSettings`,
     * since `skillOptService.autoApplyIfEnabled` needs a hot-path read.
     */
    ff_skillopt_auto_apply?: boolean
  }


  /**
   * Whether to automatically delete local skills/rules segments that fail
   * security audits (leakage of secrets or unsafe wildcard command patterns).
   * Defaults to `false`.
   */
  enableLocalSkillAuditDelete?: boolean

  /**
   * Phase S3. Whether `intutic skill audit` should AUTOMATICALLY run the
   * opt-in Cisco `skill-scanner` integration (`tools/cli/src/lib/ciscoScanner.ts`)
   * alongside native scanning, when the `skill-scanner` binary happens to be
   * on PATH. Off by default — a workspace that never configured this must
   * not start shelling out to an external tool it never asked for.
   *
   * This is distinct from `--engine cisco` (an explicit, per-invocation
   * request that fails loudly if the binary is absent): this setting gates
   * a graceful, best-effort AUTO-run — when true but the binary is absent,
   * the CLI logs an info-level skip and continues with native scanning
   * only, exactly the "opt-in but gracefully degrading" contract this
   * integration promises throughout.
   *
   * No Valkey projection, following the exact precedent
   * `enableLocalSkillAuditDelete` sets immediately above: the CLI reads
   * this straight off the synced `settings` object via `fetchConfig`, and
   * nothing else needs a hot-path read of it.
   */
  ciscoSkillScannerEnabled?: boolean

  /**
   * Configurable trigger keywords for classifying bandit task types.
   */
  banditKeywords?: {
    testing?: string[]
    deployment?: string[]
    review?: string[]
    debugging?: string[]
  }

  /**
   * Container-image provenance policy, enforced at the gate before a deploy
   * runs. Off unless explicitly enabled — a workspace that never configured
   * this must not start refusing deploys because a default changed.
   *
   * The control plane has no filesystem, so it can only verify images written
   * into the tool call itself. `unverifiableAction` decides what happens to a
   * `kubectl apply -f manifest.yaml`, and defaults to `allow`: refusing every
   * file-based apply would refuse the correct ones too, and a control that
   * broad gets switched off. See imageProvenanceService.ts.
   */
  imageProvenance?: {
    enabled?: boolean
    /** Refuse any image not pinned to an `@sha256:` digest. */
    requireDigest?: boolean
    /** Registry prefixes that may be pulled from. Empty means any. */
    allowedRegistries?: string[]
    /** `repository -> approved digests`. Empty means any digest satisfies pinning. */
    approvedDigests?: Record<string, string[]>
    unverifiableAction?: 'allow' | 'warn' | 'block'
  }

  /**
   * Whether an APPROVED `review_before` decision may let the *matching retried
   * call* through the local gate, instead of only recording the decision.
   *
   * Off (undefined/false) by default. `POST /api/v1/decisions` and its Slack
   * approve button have always recorded a decision — this flag governs a
   * separate, additive effect: when true, approving a decision tied to a
   * `review_before` hold writes a short-lived, exact-match bypass entry
   * (workspace + SOP rule + normalised tool name + hashed target/command) to
   * Valkey, synced to `.intutic/hooks/approved-bypasses.jsonl` and consulted by
   * the gate immediately before it would otherwise block on that rule. It never
   * relaxes the rule itself, never matches fuzzily, and never outlives
   * {@link reviewHoldBypassTtlMinutes}.
   */
  reviewHoldBypassEnabled?: boolean

  /**
   * Minutes an approved `review_before` bypass stays valid, when
   * {@link reviewHoldBypassEnabled} is true. Defaults to 10 when the feature is
   * on but this is unset; capped at 60 by the settings PUT schema — a bypass is
   * meant to let one already-reviewed retry through, not to stand up a lasting
   * exemption.
   */
  reviewHoldBypassTtlMinutes?: number

  /**
   * Central egress-enforcement posture, distributed to this workspace's proxies
   * (LLD #63 §4). One of `'off'` | `'monitor'` | `'enforce'`. When set, the
   * sync-daemon writes it to `.intutic/hooks/egress-policy.json` and the proxy
   * hot-reloads it, so an admin sets the mode once here rather than in each
   * developer's local config. Undefined leaves the proxy on its local config /
   * `INTUTIC_EGRESS_MODE` — central management is additive, never a silent
   * override of a deployment that never opted in.
   */
  egressMode?: 'off' | 'monitor' | 'enforce'

  /**
   * Central egress allow policy: exact hosts, `.suffix` domains, or CIDRs the
   * proxy permits in `enforce`/`monitor` mode, distributed alongside
   * {@link egressMode}. UNIONed with the proxy's local allow entries so a
   * developer's local infra allowances are never dropped by a central list.
   */
  egressAllow?: string[]

  /**
   * Approved-models allowlist: model ids the proxy will accept for this
   * workspace's completions. Distributed to the proxy's control-plane cache
   * under `workspace:allowed_models:{workspaceId}` (mirrors the `egressAllow`
   * distribution pattern above).
   *
   * Absent or empty means UNRESTRICTED — matches `egressAllow`'s own
   * backward-compatible default, so a workspace that never configured this
   * must not start refusing completions because a default changed.
   */
  allowedModels?: string[]

  /**
   * Additive MCP server allowlist: server names the MCP governance proxy
   * (`packages/mcp-proxy`) will proxy for this workspace, matched against
   * the `--server-name` identity threaded through by
   * `services/sync-daemon/src/harness/mcpAutoWrite.ts`'s `wrapWithProxy`.
   * Delivered to the proxy the same way `mcpAllowedTools` already is — via
   * `PolicyClient.absorbCuration` (`packages/mcp-proxy/src/policy.ts`),
   * fed from `GET /api/v1/sop/rules` (`services/control-plane/src/routes/
   * sops.ts`).
   *
   * Absent or empty means UNRESTRICTED — the exact same convention as
   * `allowedModels` above: a workspace that never configured this must not
   * start refusing every MCP server because a default changed.
   */
  mcpAllowedServers?: string[]

  /**
   * Whether agents in this workspace must run inside a sandbox (LLD #63 §6).
   * - `'off'` (default): `intutic exec` runs on the host as before.
   * - `'warn'`: an un-sandboxed `intutic exec` runs but prints a warning.
   * - `'require'`: `intutic exec` refuses to run un-sandboxed and tells the
   *   developer to add `--sandbox`.
   *
   * Enforced client-side by the CLI (the natural point — only it knows whether
   * `--sandbox` was passed), the same layer as the harness-config controls. A
   * server-side attestation (the proxy refusing traffic that cannot prove it
   * originated in a sandbox) is a stronger follow-on, noted in the LLD.
   * `undefined` leaves it off; open core, which has no control plane to read
   * this from, is therefore never affected.
   */
  sandboxRequirement?: 'off' | 'warn' | 'require'

  /**
   * Promotes REPEATED anomaly findings within one session into enforcement
   * (HIJACK steers with a corrective card, KILL blocks outright) — on top
   * of ordinary per-trace detection, which always runs regardless of this
   * setting. See `anomalyEnforcementService.ts` for the full mechanism:
   * off by default and a single false positive can never trigger it, only
   * a sustained pattern within one session can.
   *
   * Stored under the snake_case key `anomaly_enforcement`, not
   * `anomalyEnforcement` — deliberately inconsistent with every other
   * field here, because that key is already the load-bearing contract
   * `anomalyEnforcementService.ts` (and its tests) read and write
   * directly; renaming it to match this file's camelCase convention would
   * be a breaking migration for every already-stored workspace setting,
   * for no behavioral benefit.
   *
   * This is the wire/stored shape, not the resolved one — the read side
   * additionally floors `minRepeats` at 2 (a workspace cannot configure
   * its way to blocking on a single finding) and falls back `action` to
   * `HIJACK` for anything other than exactly `'KILL'`. The PUT schema
   * mirrors that floor as a 400 at write time, so an operator who tries a
   * lower value is told now rather than discovering later that it was
   * silently clamped.
   */
  anomaly_enforcement?: {
    enabled?: boolean
    minRepeats?: number
    minConfidence?: number
    action?: 'HIJACK' | 'KILL'
    /** Categories eligible for promotion. Empty/absent means all of them. */
    categories?: string[]
  }

  /**
   * Governed decisions log: whether the sync-daemon writes a bounded,
   * auto-maintained record of GOVERNANCE decisions (adjudications,
   * approved/rejected decisions, SOP-related settings changes) as context
   * files the coding agent's harness reads — `.intutic/DECISIONS.md` (the
   * full bounded record) plus a marker-delimited section injected into the
   * `claude-code` harness's own regenerated config file. See
   * `services/control-plane/src/routes/workspace.ts`'s
   * `GET /api/v1/workspace/decisions-digest` and
   * `services/sync-daemon/src/lib/decisionsDigest.ts`.
   *
   * Deliberately narrow: this is governance-decision records only, never
   * conversational memory or general context management (this repo pivoted
   * away from that harness product — see this repo's own CLAUDE.md history).
   *
   * Off (undefined/false) by default — per the standing rule elsewhere in
   * this file (see {@link imageProvenance}, {@link reviewHoldBypassEnabled}):
   * a workspace that never configured this must not start seeing new files
   * written into its tree, and a growing context file is token spend the
   * product must not silently impose on every workspace.
   */
  decisionsLogEnabled?: boolean

  /**
   * Opt-in LLM-based semantic analysis of skill files (Phase S5, TD-357),
   * on top of the always-on deterministic `scanSkillContent` pattern scan.
   * When true:
   * - The CLI (`intutic skill audit`) attaches the FULL content of a
   *   `SKILL.md` file (capped at 64 KiB) to its `/skills/report` entries —
   *   never bundled scripts, which stay S2/S3/S4's domain.
   * - The control plane judges that content once per distinct sha256 (a
   *   30-day Valkey marker skips re-judging unchanged content), subject to
   *   a per-workspace daily judge-call cap
   *   (`SEMANTIC_SKILL_JUDGE_DAILY_CAP`), and strips `content` from what it
   *   persists — only the verdict (`'clean' | 'suspicious' | 'malicious' |
   *   'unjudged'`) is stored, never the judged text.
   *
   * Off (undefined/false) by default, per the standing rule elsewhere in
   * this file: full skill content transiting the control plane is a real
   * privacy/cost tradeoff a workspace must opt into, not one a default
   * change should impose. See `apps/docs/guide/skill-scanning.md`'s
   * "Semantic analysis (optional)" section for the full transit/retention
   * statement.
   */
  semanticSkillAnalysisEnabled?: boolean

  /**
   * BYO judge model for the MANAGED LLM-as-judge path (LLD #70).
   *
   * When set, chunk/finalize judge calls for this workspace run on this
   * model, routed through the platform data-plane gateway with the
   * workspace's own vk_ — so the completion is billed to the workspace's
   * provider key (the key wizard), not the platform. Trade-offs, stated
   * plainly rather than implied:
   * - This REPLACES the platform's independent trusted monitor
   *   (`INTUTIC_TRUSTED_MONITOR_MODEL`) for this workspace. Verdicts are
   *   stamped `[workspace-judge]`; a judge equal to the monitored model is
   *   additionally stamped `[self-graded]` — provenance stays visible, it
   *   is never re-labelled as independent.
   * - Judged content still transits the control plane and the platform
   *   gateway to the workspace's provider. The self-hosted local judge
   *   (`INTUTIC_GATEWAY_LOCAL_JUDGE`) remains the keep-content-in-org path.
   * - Chunk judging fires per paragraph — that cost lands on the
   *   workspace's provider key.
   * - A workspace policy KILL (DLP, budget) on the judge call itself fails
   *   safe to the standard judge-unavailable note, not a bypass.
   *
   * `null`/absent = the platform trusted monitor, exactly as before.
   */
  managedJudgeModel?: string | null

  /**
   * Opt-in VirusTotal hash lookup for skill-bundled SCRIPTS (Phase S4,
   * TD-361). When true, and only when a `connector_credentials` row for
   * provider `'virustotal'` is also stored, `POST .../skills/report`
   * fire-and-forget enqueues any reported script sha256 hashes for a
   * `GET /api/v3/files/{sha256}` lookup — never an upload, never SKILL.md
   * prose, see `virusTotalService.ts`'s own doc comment for the full
   * hash-only doctrine. Off by default, per the standing rule elsewhere in
   * this file: a workspace that never configured this must not start
   * sending script hashes to a third party because a default changed.
   *
   * Distinct from, and narrower than, this product's standing decline of a
   * global MCP-server-reputation/VirusTotal integration — see
   * `apps/docs/guide/mcp-governance.md` and `docs/TECH_DEBT.md` TD-359 for
   * that separate decision, which this setting does not reverse.
   */
  virusTotalSkillLookupEnabled?: boolean

  /**
   * Whether corrective governance cards accumulate adoption labels in
   * `governance_card_labels` — the dataset a future judge fine-tune trains on.
   *
   * When true (the default), every corrective card queued for this workspace
   * writes a row (card snapshot + queued_at), the proxy's delivery marker sets
   * delivered_at, and the label sweep infers ADOPTED/NOT_ADOPTED from the
   * session's subsequent traces unless a human has already ruled. Human labels
   * (`label_source='human'`) always win over auto labels and are weighted
   * higher when the dataset is used.
   *
   * When false, row creation and the auto-watcher stop, and the human labeling
   * route refuses — data retention stops. Card generation, queueing, and
   * delivery are UNCHANGED either way: opting out stops the dataset, not
   * governance itself. On by default because the rows contain only what the
   * workspace's own traces already persist (the card text the agent was shown),
   * no third party is involved, and the aggregate is what makes the judge
   * improve for everyone.
   */
  governanceCardLabelingEnabled: boolean
}

/**
 * Default workspace settings.
 * Applied when a workspace has no explicit settings (new workspaces)
 * or when a setting key is missing from the stored JSONB.
 */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  mcpProxyFailBehavior: 'open',
  allowLocalMemoryVaults: true,
  // ON by default. Without it, removing a developer at the identity provider stops
  // their dashboard login but not their agents, and nothing reconciles membership.
  // 30 days is long enough that an ordinary working month keeps a key alive, and
  // short enough that an offboarded developer's agents stop within a sprint. Set to
  // null to disable. Automation keys are exempt (api_keys.is_service_account), and
  // the gate only applies to workspaces that actually have an SSO provider.
  ssoKeyMaxIdleDays: 30,
  ssoKeyGateEnabledAt: null,
  mcpProxyMode:         'per-session',
  bypassEnforcementTier: 'rewrite',
  featureFlags: {
    ff_bandit_routing: false,
    ff_response_cache_exact: false,
    ff_response_cache_semantic: false,
    ff_metaclaw_evolution: false,
    // Off by default, and the proxy resolves an absent flag to false as well —
    // an unreachable flag service must never silently disable enforcement.
    ff_shadow_enforcement: false,
    ff_metaclaw_auto_apply: false,
    ff_skillopt_auto_apply: false,
  },
  enableLocalSkillAuditDelete: false,
  // Off by default — see the field doc above. A workspace must explicitly
  // opt in before the CLI shells out to any externally-installed tool.
  ciscoSkillScannerEnabled: false,
  // Off by default — full skill content transiting the control plane for
  // semantic judging is opt-in. See the field doc for the full statement.
  semanticSkillAnalysisEnabled: false,
  banditKeywords: {
    testing: ['test', 'spec', 'assert', 'vitest', 'jest', 'unittest'],
    deployment: ['deploy', 'release', 'kubernetes', 'docker', 'gke', 'pipeline', 'ci/cd'],
    review: ['review', 'audit', 'lint', 'eslint', 'pr'],
    debugging: ['fix', 'bug', 'issue', 'error', 'crash', 'debug'],
  },
  // Off, and `enabled` must be literally true to turn it on. A workspace that
  // never configured image provenance must not begin refusing deploys.
  imageProvenance: {
    enabled: false,
    requireDigest: true,
    allowedRegistries: [],
    approvedDigests: {},
    unverifiableAction: 'allow',
  },
  // Off by default — approving a review_before decision is observation-only
  // until a workspace opts in. See the field doc for what turning it on does.
  reviewHoldBypassEnabled: false,
  // Only load-bearing once reviewHoldBypassEnabled is true; the value here is
  // what "enabled but unset" resolves to.
  reviewHoldBypassTtlMinutes: 10,
  // Platform trusted monitor judges by default — see the field doc for what
  // setting a workspace's own model trades away.
  managedJudgeModel: null,
  // Off by default — see the field doc for why a growing auto-written
  // context file must be opt-in.
  decisionsLogEnabled: false,
  // Off by default — mirrors anomalyEnforcementService.ts's own DISABLED
  // default exactly, so a workspace that never configures this sees the
  // identical values whether resolved here or read directly from the DB.
  anomaly_enforcement: {
    enabled: false,
    minRepeats: 3,
    minConfidence: 0.8,
    action: 'HIJACK',
    categories: [],
  },
  // Off by default — see the field doc for the hash-only doctrine and why
  // this must never turn on for a workspace that never configured it.
  virusTotalSkillLookupEnabled: false,
  // ON by default — see the field doc. Opting out stops label retention for
  // the judge fine-tuning dataset, never card delivery itself.
  governanceCardLabelingEnabled: true,
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
