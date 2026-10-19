/**
 * Responses of the control plane routes in gateways.ts, gatewayHeartbeat.ts, workspace.ts, providerCredentials.ts, harnessConfig.ts, sync.ts, devices.ts and sessions.ts, and the proxy's `GET /api/v1/auth/key-context`.
 *
 * @module
 */
import { z } from 'zod'
import { BypassEnforcementTier, HarnessType, McpProxyFailBehavior, McpProxyMode } from '../enums.js'
import { PII_ACTIONS, PII_DETECTOR_IDS } from '../piiDetectors.js'
import { UPSTREAM_PROVIDERS } from '../upstreamRetry.js'
import { MCP_ANOMALY_DETECTOR_IDS } from '../workspaceSettings.js'
import { IsoTimestamp } from './common.js'

// ─── Gateways (routes/gateways.ts, routes/gatewayHeartbeat.ts) ───────

/** The `gateway_deployment_target` enum. `managed_cell` rows are created by the platform, never registered. */
const GatewayDeploymentTarget = z.enum(['docker', 'kubernetes', 'bare_metal', 'managed_cell'])

/** The `gateway_status` enum. */
const GatewayStatusValue = z.enum(['pending', 'online', 'degraded', 'unreachable', 'revoked'])

/**
 * A gateway's `config` column: the flags `PATCH /api/v1/gateways/:id/config`
 * sets, plus the cluster-local endpoint the cell provisioner records on a
 * managed cell. A flag never set is absent: the gateway runs its deployment's
 * own value.
 */
export const GatewayConfig = z.object({
  requireVk: z.boolean().optional().describe('Refuse requests without a virtual key.'),
  requireProvisionedKey: z.boolean().optional().describe('Refuse requests for a provider the workspace has no provisioned credential for.'),
  internalEndpoint: z.string().optional().describe('Managed cells only: the cluster-local URL the cell provisioner recorded.'),
})
export type GatewayConfig = z.infer<typeof GatewayConfig>

/** `POST /api/v1/gateways`: the registered gateway and its token, shown this once. */
export const GatewayRegisterResponse = z.object({
  gatewayId: z.string(),
  name: z.string(),
  deploymentTarget: z.enum(['docker', 'kubernetes', 'bare_metal']),
  status: z.literal('pending'),
  token: z.string().describe('The gwk_ token, returned only here; the control plane keeps its hash.'),
  instructions: z.string(),
})
export type GatewayRegisterResponse = z.infer<typeof GatewayRegisterResponse>

/** One row of `GET /api/v1/gateways`: a live (not revoked) gateway of the caller's org. Never the token. */
export const GatewayResponse = z.object({
  gatewayId: z.string(),
  name: z.string(),
  deploymentTarget: GatewayDeploymentTarget,
  status: GatewayStatusValue.describe('As of the last heartbeat; GET /api/v1/gateways/:id/status reads the live value.'),
  keyPrefix: z.string().describe('The first 12 characters of the current token.'),
  lastHeartbeatAt: IsoTimestamp.nullable(),
  proxyVersion: z.string().nullable(),
  registeredEndpoint: z.string().nullable().describe('Where the gateway is reachable; null until something records it.'),
  region: z.enum(['us', 'eu', 'apac']),
  deprovisionAt: IsoTimestamp.nullable().describe('When a scheduled removal takes effect; null when none is pending.'),
  config: GatewayConfig.nullable(),
  createdAt: IsoTimestamp,
  revokedAt: IsoTimestamp.nullable().describe('Always null: revoked gateways are not listed.'),
})
export type GatewayResponse = z.infer<typeof GatewayResponse>

/** `GET /api/v1/gateways`: the org's gateways, newest first, and its managed-cell usage. */
export const GatewayListResponse = z.object({
  data: z.array(GatewayResponse),
  cells: z
    .object({
      used: z.number().int().describe('Managed cells the org holds.'),
      limit: z.number().int().describe("The most its plan allows."),
    })
    .describe("The org's managed gateway cells against its plan's ceiling."),
})
export type GatewayListResponse = z.infer<typeof GatewayListResponse>

/** `POST /api/v1/gateways/:id/rotate`: the new token, shown this once, and how long the old one keeps working. */
export const GatewayRotateResponse = z.object({
  gatewayId: z.string(),
  token: z.string().describe('The new gwk_ token, returned only here.'),
  previousTokenValidUntil: IsoTimestamp.describe('Until when the replaced token still authenticates.'),
  instructions: z.string(),
})
export type GatewayRotateResponse = z.infer<typeof GatewayRotateResponse>

/** `DELETE /api/v1/gateways/:id`. */
export const GatewayRevokedResponse = z.object({ revoked: z.literal(true) })
export type GatewayRevokedResponse = z.infer<typeof GatewayRevokedResponse>

/**
 * `GET /api/v1/gateways/:id/config` (`PATCH` answers the same shape): the
 * gateway's config and the version the latest change produced.
 */
export const GatewayConfigResponse = z.object({
  config: GatewayConfig,
  configVersion: z.number().int().describe('Bumped by every config change; 0 before any. The gateway pulls the config when it is ahead of the version it applied.'),
})
export type GatewayConfigResponse = z.infer<typeof GatewayConfigResponse>

/** The gateway's last heartbeat, while it is inside its time-to-live. Fields the gateway did not report are absent. */
const GatewayLiveStatus = z.object({
  status: z.enum(['online', 'degraded']),
  proxyVersion: z.string().optional(),
  uptimeSeconds: z.number().int().optional(),
  activeWorkspaces: z.number().int().optional(),
  litellmReachable: z.boolean().optional(),
  lastError: z.string().optional(),
  sopCount: z.number().int().optional().describe('SOPs the gateway holds a fresh cache for, across every workspace it serves.'),
  sopHash: z.string().optional(),
  reportedAt: IsoTimestamp,
  appliedConfigVersion: z.number().int().nullable().describe('The config version the gateway runs; null when it has not reported one.'),
  desiredConfigVersion: z.number().int(),
})

/** No heartbeat inside the time-to-live: every reported field is null. */
const GatewayUnreachableStatus = z.object({
  status: z.literal('unreachable'),
  proxyVersion: z.null(),
  uptimeSeconds: z.null(),
  activeWorkspaces: z.null(),
  litellmReachable: z.null(),
  lastError: z.null(),
  reportedAt: z.null(),
  sopCount: z.null(),
  sopHash: z.null(),
  appliedConfigVersion: z.null(),
  desiredConfigVersion: z.number().int(),
})

/** `GET /api/v1/gateways/:id/status`: the gateway's last heartbeat, and the config version it should run. */
export const GatewayStatusResponse = z.union([GatewayLiveStatus, GatewayUnreachableStatus])
export type GatewayStatusResponse = z.infer<typeof GatewayStatusResponse>

/** `PATCH /api/v1/workspace/gateway`: the workspace's gateway override, null when cleared. */
export const WorkspaceGatewayResponse = z.object({
  workspaceId: z.string(),
  gatewayId: z.string().nullable(),
})
export type WorkspaceGatewayResponse = z.infer<typeof WorkspaceGatewayResponse>

/** The gateway a workspace resolves to. Never the token. */
const ResolvedGateway = z.object({
  gatewayId: z.string(),
  name: z.string(),
  deploymentTarget: GatewayDeploymentTarget,
  status: GatewayStatusValue,
  registeredEndpoint: z.string().nullable().describe('Where a client should point; null when nothing recorded it.'),
})

/**
 * `GET /api/v1/workspace/gateway-resolution`: the gateway a client for this
 * workspace should use — the workspace's override, else the org's default,
 * else the shared gateway (`source: default`).
 */
export const GatewayResolutionResponse = z.union([
  z.object({
    source: z.enum(['workspace', 'org']),
    gateway: z.null(),
    staleAssignment: z.string().describe('The assigned gateway id, which is revoked or gone.'),
  }),
  z.object({ source: z.enum(['workspace', 'org']), gateway: ResolvedGateway }),
  z.object({ source: z.literal('default'), gateway: z.null() }),
])
export type GatewayResolutionResponse = z.infer<typeof GatewayResolutionResponse>

// ─── Workspace settings (routes/workspace.ts, routes/sync.ts) ────────

const StringList = z.array(z.string())

/** The workspace's retry and fallback setting (`UpstreamRetrySettingsSchema`), as stored. */
const UpstreamRetry = z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().optional(),
  initialBackoffMs: z.number().int().optional(),
  maxBackoffMs: z.number().int().optional(),
  budgetMs: z.number().int().optional(),
  onStatus: z.array(z.number().int()).optional(),
  fallbacks: z
    .record(z.array(z.object({ model: z.string().optional(), provider: z.enum(UPSTREAM_PROVIDERS).optional() })))
    .optional(),
})

/** Detector id → action (`piiDetectors`). */
const PiiDetectorActions = z.record(z.enum(PII_DETECTOR_IDS), z.enum(PII_ACTIONS))

/** The workspace's own trace bucket (`byocStorage`); its secrets are `__redacted__` where a route returns them. */
const ByocStorage = z.object({
  provider: z.enum(['gcs', 's3', 'disabled']),
  bucketName: z.string().optional(),
  prefix: z.string().optional(),
  projectId: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  credentials: z.string().optional(),
  mode: z.enum(['mirror', 'primary']).optional(),
})

/**
 * Workspace settings as the control plane answers them: the stored settings
 * merged over the defaults (`resolveWorkspaceSettings`), BYOC secrets
 * replaced by `__redacted__` where a route redacts them.
 */
export const ResolvedWorkspaceSettings = z
  .object({
    mcpProxyFailBehavior: z.nativeEnum(McpProxyFailBehavior),
    allowLocalMemoryVaults: z.boolean(),
    ssoKeyMaxIdleDays: z.number().int().nullable(),
    ssoKeyGateEnabledAt: z.string().nullable().describe('When the SSO-recency key gate was switched on.'),
    sso_group_policy: z
      .object({ highRiskTools: StringList, requiredGroups: StringList, requireOboFor: StringList })
      .nullable()
      .optional(),
    piiDetectors: PiiDetectorActions.nullable().optional(),
    storeToolArguments: z.boolean().optional(),
    upstreamRetry: UpstreamRetry.nullable().optional(),
    byocStorage: ByocStorage.optional(),
    mcpProxyMode: z.nativeEnum(McpProxyMode),
    bypassEnforcementTier: z.nativeEnum(BypassEnforcementTier),
    featureFlags: z
      .object({
        ff_bandit_routing: z.boolean().optional(),
        ff_shadow_routing: z.boolean().optional(),
        ff_response_cache_exact: z.boolean().optional(),
        ff_response_cache_semantic: z.boolean().optional(),
        ff_metaclaw_evolution: z.boolean().optional(),
        ff_shadow_enforcement: z.boolean().optional(),
        ff_skillopt_auto_apply: z.boolean().optional(),
        ff_sql_drop_strict_block: z.boolean().optional(),
      })
      .optional(),
    enableLocalSkillAuditDelete: z.boolean().optional(),
    ciscoSkillScannerEnabled: z.boolean().optional(),
    banditKeywords: z
      .object({
        testing: StringList.optional(),
        deployment: StringList.optional(),
        review: StringList.optional(),
        debugging: StringList.optional(),
      })
      .optional(),
    imageProvenance: z
      .object({
        enabled: z.boolean().optional(),
        requireDigest: z.boolean().optional(),
        allowedRegistries: StringList.optional(),
        approvedDigests: z.record(StringList).optional(),
        unverifiableAction: z.enum(['allow', 'warn', 'block']).optional(),
      })
      .optional(),
    reviewHoldBypassEnabled: z.boolean().optional(),
    reviewHoldBypassTtlMinutes: z.number().optional(),
    loop_review: z.object({ requireDistinctApprover: z.boolean().optional(), requireVerifiedCompletion: z.boolean().optional() }).optional(),
    closedLanes: z.array(z.enum(['irreversible', 'reversible_wide'])).optional(),
    revertLane: z
      .object({
        mode: z.enum(['off', 'shadow', 'enforce']),
        threshold: z.number().optional(),
        minExecutions: z.number().int().optional(),
        minReversals: z.number().int().optional(),
        windowDays: z.number().int().optional(),
      })
      .optional(),
    egressMode: z.enum(['off', 'monitor', 'enforce']).optional(),
    egressAllow: StringList.optional(),
    allowedModels: StringList.optional(),
    routingCandidates: StringList.optional(),
    mcpAllowedServers: StringList.optional(),
    mcpDefaultPolicy: z.enum(['allow', 'deny']).optional(),
    mcpInjectionAction: z.enum(['warn', 'block']).optional(),
    mcpAnomalyMode: z.enum(['enforce', 'warn', 'off']).optional(),
    mcpAnomalyOverrides: z.record(z.enum(MCP_ANOMALY_DETECTOR_IDS), z.enum(['steer', 'reask', 'kill', 'off'])).optional(),
    mcpInjectionPatterns: StringList.optional(),
    mcpBudgets: z
      .object({
        budgets: z.array(
          z.object({
            id: z.string(),
            scope: z.enum(['server', 'tool', 'member', 'member_server']),
            server: z.string().optional(),
            tool: z.string().optional(),
            memberId: z.string().optional(),
            period: z.enum(['hour', 'day']),
            limit: z.number().int(),
          }),
        ),
        warnAtPct: z.number().int().optional(),
      })
      .optional(),
    enforcement_mode: z.enum(['soft', 'hard']).optional(),
    workspace_hard_cap_enabled: z.boolean().optional(),
    mcpHighRiskToolChange: z.enum(['notify', 'hold']).optional(),
    contractedRates: z.record(z.object({ inputCostPer1k: z.number(), outputCostPer1k: z.number() })).optional(),
    sandboxRequirement: z.enum(['off', 'warn', 'require']).optional(),
    anomaly_enforcement: z
      .object({
        enabled: z.boolean().optional(),
        minRepeats: z.number().optional(),
        minConfidence: z.number().optional(),
        action: z.enum(['HIJACK', 'KILL']).optional(),
        categories: StringList.optional(),
      })
      .optional(),
    trajectory_monitor_mode: z.enum(['ACTIVE', 'PASSIVE', 'OFF']).optional(),
    interventionMode: z.enum(['TRANSPARENT', 'OPAQUE', 'SILENT_LOG']).optional(),
    mcpAllowedTools: StringList.optional(),
    mcpToolDescriptionOverrides: z.record(z.string()).optional(),
    decisionsLogEnabled: z.boolean().optional(),
    semanticSkillAnalysisEnabled: z.boolean().optional(),
    virusTotalSkillLookupEnabled: z.boolean().optional(),
    configBodyUpload: z.boolean().optional(),
    securityProbeSampleRate: z.number().optional(),
    governanceCardLabelingEnabled: z.boolean(),
    decideLogUploadEnabled: z.boolean().optional(),
    decideLogUploadArgs: z.boolean().optional(),
    decideAutoPromote: z.boolean().optional(),
    appliedSecurityPosture: z.string().optional().describe('The security posture preset last applied; removed by a manual edit to a knob it governs.'),
    appliedCostPosture: z.string().optional().describe('The cost posture preset last applied; removed by a manual edit to a knob it governs.'),
  })
  .catchall(z.unknown())
  .describe('Every setting, resolved with its default. Other keys stored on the workspace (written by other routes, or by older versions) are returned as stored.')
export type ResolvedWorkspaceSettings = z.infer<typeof ResolvedWorkspaceSettings>

/** `GET /api/v1/workspace/settings`. */
export const WorkspaceSettingsResponse = z.object({
  workspaceId: z.string(),
  settings: ResolvedWorkspaceSettings,
})
export type WorkspaceSettingsResponse = z.infer<typeof WorkspaceSettingsResponse>

/** `PUT /api/v1/workspace/settings`: the settings as stored after the update. */
export const WorkspaceSettingsUpdateResponse = WorkspaceSettingsResponse.extend({ updated: z.literal(true) })
export type WorkspaceSettingsUpdateResponse = z.infer<typeof WorkspaceSettingsUpdateResponse>

/**
 * `GET /api/v1/workspace/sops-policy`: the SOPs the proxy enforces for this
 * workspace — its VALIDATED active SOPs (org-level first), then the policy
 * guardrails in shadow or enforcing, as SOP files.
 */
export const SopsPolicyResponse = z.object({
  workspaceId: z.string(),
  sops: z.array(
    z.object({
      title: z.string().describe('A guardrail entry is titled `GUARDRAIL:<guardrailId> <summary>`.'),
      markdownContent: z.string(),
      scope: z.enum(['workspace', 'org']),
    }),
  ),
})
export type SopsPolicyResponse = z.infer<typeof SopsPolicyResponse>

/**
 * `GET /api/v1/workspace/egress-policy`: the workspace's central egress
 * policy, which the sync daemon hands the proxy.
 */
export const EgressPolicyResponse = z.object({
  workspaceId: z.string(),
  mode: z
    .enum(['off', 'monitor', 'enforce'])
    .nullable()
    .describe('Null: central management is not configured, and the proxy keeps its local config. `off` is an admin turning it off.'),
  allow: z.array(z.string()).describe('Exact hosts, `.suffix` domains or CIDRs the proxy may reach, unioned with its local list.'),
})
export type EgressPolicyResponse = z.infer<typeof EgressPolicyResponse>

/**
 * `GET /api/v1/workspace/decisions-digest`: the last governance decisions,
 * newest first, each a one-line summary rendered by the control plane. The
 * sync daemon writes them into `.intutic/DECISIONS.md`.
 */
export const DecisionsDigestResponse = z.object({
  workspaceId: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['decision', 'incident', 'settings_change', 'detector_adjudication']),
      timestamp: IsoTimestamp,
      summary: z.string(),
    }),
  ),
})
export type DecisionsDigestResponse = z.infer<typeof DecisionsDigestResponse>

/**
 * `GET /api/v1/auth/key-context`: what the proxy reads about a virtual key and
 * its workspace (`packages/proxy/src/key_context.rs` and the readers it
 * feeds). A field that could not be read is null, never absent; each reader
 * says what null means to it.
 */
export const KeyContextResponse = z.object({
  workspaceId: z.string(),
  memberId: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'EM', 'DEVELOPER', 'VIEWER']),
  orgId: z.string().nullable(),
  allowedModels: z.array(z.string()).nullable().describe("The key's own model allowlist; null inherits the workspace list."),
  byokRequired: z.boolean().nullable().describe('Whether the workspace must bring its own provider key; null reads as required under `INTUTIC_GATEWAY_REQUIRE_PROVISIONED_KEY=paid`.'),
  keyId: z.string().nullable(),
  hardBudgets: z
    .array(z.object({ scope: z.enum(['workspace', 'key', 'member']), period: z.enum(['day', 'month']), limitUsd: z.number() }))
    .nullable(),
  rateLimit: z.object({ rpm: z.number().int().nullable().optional(), tpm: z.number().int().nullable().optional() }).nullable(),
  scopes: z.array(z.string()).nullable(),
  ssoGroups: z
    .object({
      policy: z
        .object({ highRiskTools: StringList, requiredGroups: StringList, requireOboFor: StringList })
        .nullable(),
      memberGroups: StringList.nullable().describe('Null when the workspace has no policy, or the key has no active member.'),
    })
    .nullable()
    .describe('Null when the read failed.'),
  piiDetectors: PiiDetectorActions.nullable().describe('Null when unreadable; the proxy applies its policy fail mode.'),
  upstreamRetry: UpstreamRetry.nullable(),
  storeToolArguments: z.boolean().nullable().describe('Only `true` keeps tool-call argument values in replay contexts.'),
  decideLogUploadEnabled: z.boolean().nullable().describe("Only `true` sends the gateway's decide log lines to `POST /api/v1/decide/events`."),
  decideLogUploadArgs: z.boolean().nullable().describe('Only `true` sends the arguments excerpt with them.'),
  budget: z.object({ dailyUsd: z.number(), monthlyUsd: z.number() }).nullable().describe('Null when the caps could not be read: the proxy refuses as BUDGET_UNVERIFIABLE.'),
  interventionMode: z.enum(['TRANSPARENT', 'OPAQUE', 'SILENT_LOG']).nullable(),
  llmJudgeEnabled: z.boolean().nullable(),
})
export type KeyContextResponse = z.infer<typeof KeyContextResponse>

/** `GET /api/v1/auth/key-context`, with the reversibility-lane settings. */
export const KeyContextGatesResponse = KeyContextResponse.extend({
  closedLanes: z
    .array(z.enum(['irreversible', 'reversible_wide']))
    .nullable()
    .describe('The workspace `closedLanes`: every role holds the tokens of these classes. Null when unset or unreadable.'),
  revertLane: z
    .object({
      mode: z.enum(['off', 'shadow', 'enforce']),
      threshold: z.number(),
      minExecutions: z.number().int(),
      minReversals: z.number().int(),
      windowDays: z.number().int(),
    })
    .nullable()
    .describe('The workspace `revertLane`, defaults filled in. Null when the settings could not be read.'),
})
export type KeyContextGatesResponse = z.infer<typeof KeyContextGatesResponse>

// ─── Provider credentials (routes/providerCredentials.ts) ────────────

/** A provider's provisioning status. Never the credential itself. */
export const ProviderCredentialStatusResponse = z.object({
  provider: z.string(),
  routingLive: z.boolean().describe('Whether the gateway can route to this provider today.'),
  provisioned: z.boolean(),
  lastFour: z.string().nullable().describe('The last four characters of the secret field, when it has one.'),
  updatedAt: z.string().nullable(),
})
export type ProviderCredentialStatusResponse = z.infer<typeof ProviderCredentialStatusResponse>

/** `GET /api/v1/workspace/provider-credentials`: every provider in the registry. */
export const ProviderCredentialListResponse = z.object({ data: z.array(ProviderCredentialStatusResponse) })
export type ProviderCredentialListResponse = z.infer<typeof ProviderCredentialListResponse>

/** `DELETE /api/v1/workspace/provider-credentials/:provider`. */
export const ProviderCredentialRemovedResponse = z.object({
  provider: z.string(),
  routingLive: z.boolean(),
  provisioned: z.literal(false),
})
export type ProviderCredentialRemovedResponse = z.infer<typeof ProviderCredentialRemovedResponse>

/** `POST /api/v1/workspace/provider-credentials/:provider/verify`: the verdict on the stored credential. Never its value. */
export const ProviderCredentialVerifyResponse = z.object({
  provider: z.string(),
  status: z.enum(['valid', 'invalid', 'unknown', 'unsupported', 'not_provisioned']),
  httpStatus: z.number().int().optional().describe("The provider's HTTP status, when it answered."),
  detail: z.string(),
  models: StringList.optional().describe('The models the provider listed, on a valid verdict from a list-models probe.'),
})
export type ProviderCredentialVerifyResponse = z.infer<typeof ProviderCredentialVerifyResponse>

/** `GET /api/v1/workspace/provider-credentials/:provider/models`: null until a verify records a list. */
export const ProviderModelListResponse = z.object({
  provider: z.string(),
  models: StringList.nullable(),
  checkedAt: z.string().nullable(),
})
export type ProviderModelListResponse = z.infer<typeof ProviderModelListResponse>

// ─── Skills report (routes/harnessConfig.ts) ─────────────────────────

/** `POST /api/v1/workspaces/:workspaceId/skills/report`. */
export const SkillsReportAckResponse = z.object({ ok: z.literal(true) })
export type SkillsReportAckResponse = z.infer<typeof SkillsReportAckResponse>

// ─── Sync daemon (routes/sync.ts) ────────────────────────────────────

/** `POST /api/v1/sync/config`: the workspace config the sync daemon writes into harness files. */
export const SyncConfigResponse = z.object({
  workspaceId: z.string(),
  configVersion: z.number().int(),
  sops: z.array(
    z.object({
      sopId: z.string(),
      title: z.string(),
      content: z.string(),
      contentHash: z.string().describe('SHA-256 of `content`, hex.'),
      harnessTargets: z.array(z.nativeEnum(HarnessType)),
      sopRef: z.string().optional(),
    }),
  ).describe('Active SOPs in HYPOTHESIZED, REFINED or VALIDATED state.'),
  proxyUrl: z.string().describe("The workspace's proxy URL, else its online gateway's endpoint, else empty."),
  settings: ResolvedWorkspaceSettings.extend({
    byocStorage: ByocStorage.omit({ accessKeyId: true, secretAccessKey: true, credentials: true })
      .optional()
      .describe('Without its credentials, which no daemon reads: never sent here.'),
  }),
  appliedEdits: z
    .array(
      z.object({
        suggestionId: z.string(),
        harnessType: z.string().nullable(),
        filePath: z.string().nullable(),
        edits: z.unknown().describe('The suggestion edits, forwarded as stored.'),
        appliedAt: z.string().nullable(),
      }),
    )
    .optional()
    .describe('Applied SkillOpt edits to write locally; absent when there are none.'),
})
export type SyncConfigResponse = z.infer<typeof SyncConfigResponse>

/** `POST /api/v1/sync/status`. */
export const SyncStatusAckResponse = z.object({
  ack: z.literal(true),
  configVersion: z.number().int().describe("The workspace's current config version, for the daemon to compare."),
})
export type SyncStatusAckResponse = z.infer<typeof SyncStatusAckResponse>

/** `POST /api/v1/sync/sop-hash`. */
export const SopHashReportResponse = z.object({
  driftCount: z.number().int().describe('Drifted files recorded from this report.'),
})
export type SopHashReportResponse = z.infer<typeof SopHashReportResponse>

/** `GET /api/v1/sync/report`: the sync daemon's last heartbeat, as the dashboard shows it. */
export const SyncReportResponse = z.object({
  ok: z.literal(true),
  harnesses: z.array(
    z.object({
      harnessType: z.string(),
      drifted: z.boolean().describe('Its rules file has an unresolved drift record.'),
      lastSynced: z.string().optional(),
    }),
  ),
  activeProcesses: z.array(z.string()),
  connectedSince: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  components: z.record(z.unknown()).nullable().describe('The heartbeat\'s component report, as the daemon sent it.'),
})
export type SyncReportResponse = z.infer<typeof SyncReportResponse>

// ─── Devices (routes/devices.ts) ─────────────────────────────────────

/** `POST /api/v1/devices/report`. */
export const DeviceReportResponse = z.object({
  deviceId: z.string(),
  status: z.enum(['pending', 'enforcing', 'degraded', 'unenforced', 'stale', 'retired']),
})
export type DeviceReportResponse = z.infer<typeof DeviceReportResponse>

/** `POST /api/v1/devices/disconnect`. */
export const DeviceDisconnectResponse = z.object({
  disconnectId: z.string(),
  agentsDisconnected: z.number().int().describe("This device's agents marked disconnected."),
})
export type DeviceDisconnectResponse = z.infer<typeof DeviceDisconnectResponse>

// ─── Sessions (routes/sessions.ts) ───────────────────────────────────

/** `POST /api/v1/sessions`: the session and the task context resolved for it. */
export const SessionCreateResponse = z.object({
  sessionId: z.string(),
  taskContext: z.object({
    taskId: z.string().nullable(),
    taskSource: z.enum(['manual', 'branch', 'commit', 'env', 'pagerduty', 'adapter', 'untagged']),
    provider: z.string().describe('The tracker the task belongs to, or `untagged`.'),
    storyPoints: z.number().nullable(),
    sprintId: z.string().nullable(),
    epicKey: z.string().nullable(),
    branchName: z.string().nullable(),
    commitHash: z.string().nullable(),
  }),
})
export type SessionCreateResponse = z.infer<typeof SessionCreateResponse>

/** `PATCH /api/v1/sessions/:sessionId/end`. */
export const SessionEndResponse = z.object({
  data: z.object({ session_id: z.string(), ended: z.literal(true) }),
})
export type SessionEndResponse = z.infer<typeof SessionEndResponse>
