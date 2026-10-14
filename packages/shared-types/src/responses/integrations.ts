/**
 * Responses of the control plane routes in notifications.ts, siem.ts, mcpServers.ts, attenuate.ts, compliance.ts, githubWebhooks.ts,
 * openaiAgentTraces.ts, agentcoreGateway.ts, gateLiveness.ts, intelligence.ts and routing.ts.
 *
 * @module
 */
import { z } from 'zod'
import { NOTIFICATION_EVENT_TYPES } from '../notifications.js'
import { IsoTimestamp, listEnvelope } from './common.js'

// ─── Notification rules (routes/notifications.ts) ───────────────────

/**
 * A rule's channel config as `notificationHubService.ts` `redactChannelConfig`
 * returns it: the webhook signing secret dropped, the PagerDuty routing key
 * masked.
 */
export const NotificationChannelConfigResponse = z.object({
  slackChannelId: z.string().optional(),
  slackChannelName: z.string().optional(),
  emailRecipients: z.array(z.string()).optional(),
  webhookUrl: z.string().optional(),
  pagerdutyRoutingKey: z.string().optional().describe('Masked: the first six characters and `…`. Send it back unchanged to keep the stored key.'),
})
export type NotificationChannelConfigResponse = z.infer<typeof NotificationChannelConfigResponse>

/** A notification rule, as `notificationHubService.ts` `mapRowToRule` returns it. */
export const NotificationRuleResponse = z.object({
  ruleId: z.string(),
  workspaceId: z.string(),
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  channel: z.enum(['slack', 'email', 'webhook', 'pagerduty']),
  channelConfig: NotificationChannelConfigResponse,
  filters: z.object({
    // Stored as sent before severities were normalised to uppercase, so a value is not guaranteed to be one of them.
    severity: z.array(z.string()).optional(),
    harnessType: z.array(z.string()).optional(),
    userId: z.array(z.string()).optional(),
  }),
  cooldownMinutes: z.number().int(),
  enabled: z.boolean(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  signingSecret: z
    .string()
    .optional()
    .describe('A webhook rule\'s signing secret in plaintext: only in the response that generated it (create, or an update that made the rule a webhook).'),
})
export type NotificationRuleResponse = z.infer<typeof NotificationRuleResponse>

/** `GET /api/v1/notifications/rules`: the workspace's rules, oldest first. */
export const NotificationRuleListResponse = listEnvelope('rules', 'camel').extend({ rules: z.array(NotificationRuleResponse) })
export type NotificationRuleListResponse = z.infer<typeof NotificationRuleListResponse>

/** `DELETE /api/v1/notifications/rules/:ruleId`. */
export const NotificationRuleDeletedResponse = z.object({ ok: z.literal(true) })
export type NotificationRuleDeletedResponse = z.infer<typeof NotificationRuleDeletedResponse>

/** `POST /api/v1/notifications/rules/:ruleId/signing-secret`: the new secret, returned once. */
export const NotificationRuleSigningSecretResponse = z.object({
  ruleId: z.string(),
  signingSecret: z.string().describe('The new signing secret in plaintext, shown only in this response.'),
})
export type NotificationRuleSigningSecretResponse = z.infer<typeof NotificationRuleSigningSecretResponse>

// ─── SIEM destinations (routes/siem.ts) ─────────────────────────────

// Stored as text; create accepts only these values, and nothing changes it after.
const SiemAdapterType = z.enum(['syslog_cef', 'webhook_https', 'gcs', 's3', 'splunk_hec', 'datadog_logs'])

const siemDestinationFields = {
  destinationId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  adapterType: SiemAdapterType,
  isActive: z.boolean(),
  sourceTables: z.array(z.string()).describe('Sources the destination receives; empty means every source except the opt-in ones.'),
  batchSize: z.number().int(),
  flushIntervalMs: z.number().int(),
  pausedReason: z
    .string()
    .nullable()
    .describe('Why an active destination sends nothing (the workspace\'s plan has no SIEM export), or null while it streams.'),
}

/** The stored fields a read adds: health and timestamps. */
const siemDestinationStoredFields = {
  lastHeartbeatAt: IsoTimestamp.nullable(),
  lastError: z.string().nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
}

/** The destination's config with each credential masked (`********` and, past eight characters, its last four). */
const SiemMaskedConfig = z.record(z.unknown()).describe('The adapter config, each credential masked.')

/** A destination as `GET /api/v1/siem/destinations` lists it: no config. */
export const SiemDestinationSummaryResponse = z.object({ ...siemDestinationFields, ...siemDestinationStoredFields })
export type SiemDestinationSummaryResponse = z.infer<typeof SiemDestinationSummaryResponse>

/** `GET /api/v1/siem/destinations`: the destinations and the source names one can filter on. */
export const SiemDestinationListResponse = z.object({
  items: z.array(SiemDestinationSummaryResponse),
  sources: z.object({
    all: z.array(z.string()).describe('Every source name a destination can list in `sourceTables`.'),
    defaults: z.array(z.string()).describe('The sources an empty `sourceTables` means.'),
  }),
})
export type SiemDestinationListResponse = z.infer<typeof SiemDestinationListResponse>

/** `GET /api/v1/siem/destinations/:id`. */
export const SiemDestinationResponse = z.object({
  ...siemDestinationFields,
  ...siemDestinationStoredFields,
  config: SiemMaskedConfig.describe('The adapter config, each credential masked; empty when the stored config cannot be decrypted.'),
})
export type SiemDestinationResponse = z.infer<typeof SiemDestinationResponse>

/** `PUT /api/v1/siem/destinations/:id`: the destination after the edit. */
export const SiemDestinationUpdatedResponse = z.object({
  ...siemDestinationFields,
  ...siemDestinationStoredFields,
  config: SiemMaskedConfig.optional().describe('The adapter config, each credential masked; absent when the stored config cannot be decrypted.'),
})
export type SiemDestinationUpdatedResponse = z.infer<typeof SiemDestinationUpdatedResponse>

/** `POST /api/v1/siem/destinations`: the new destination. */
export const SiemDestinationCreatedResponse = z.object({
  ...siemDestinationFields,
  config: SiemMaskedConfig,
  signingSecret: z
    .string()
    .optional()
    .describe('A webhook destination\'s signing secret in plaintext, shown only in this response.'),
})
export type SiemDestinationCreatedResponse = z.infer<typeof SiemDestinationCreatedResponse>

/** `DELETE /api/v1/siem/destinations/:id`: the destination is deactivated, not removed. */
export const SiemDestinationDeactivatedResponse = z.object({
  success: z.literal(true),
  destinationId: z.string(),
  isActive: z.literal(false),
})
export type SiemDestinationDeactivatedResponse = z.infer<typeof SiemDestinationDeactivatedResponse>

/** `POST /api/v1/siem/destinations/:id/signing-secret`: the new secret, returned once. */
export const SiemSigningSecretResponse = z.object({
  destinationId: z.string(),
  signingSecret: z.string().describe('The new signing secret in plaintext, shown only in this response.'),
})
export type SiemSigningSecretResponse = z.infer<typeof SiemSigningSecretResponse>

// ─── MCP server registry (routes/mcpServers.ts) ─────────────────────

/** The latest scored change to a server's tool set (`mcpRegistryService.ts` `toToolChange`). */
export const McpToolChangeResponse = z.object({
  changeId: z.string(),
  createdAt: IsoTimestamp,
  riskScore: z.number().int().describe('0–100.'),
  riskLevel: z.enum(['none', 'low', 'medium', 'high']),
  reasons: z.array(
    z.object({
      rule: z.string(),
      tool: z.string(),
      points: z.number(),
      detail: z.string().describe('What the rule saw, in words.'),
    }),
  ),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()).describe('Tools whose description or input schema changed.'),
})
export type McpToolChangeResponse = z.infer<typeof McpToolChangeResponse>

/** An MCP server the workspace's proxies have seen (`mcpRegistryService.ts` `toRow`). */
export const McpServerResponse = z.object({
  serverId: z.string(),
  serverName: z.string(),
  status: z.enum(['candidate', 'approved', 'blocked']),
  harness: z.string().nullable(),
  transport: z.string().nullable(),
  pinFingerprint: z.string().nullable(),
  tools: z.array(z.string()).describe('The tool names a proxy last saw the server declare.'),
  disabledTools: z.array(z.string()),
  firstSeenAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp,
  decidedBy: z.string().nullable(),
  decidedAt: IsoTimestamp.nullable(),
  ungovernedReason: z.string().nullable(),
  heldForReview: z.boolean().describe('A high-risk tool change returned the server to the queue; proxies refuse it until someone decides.'),
  lastToolChange: McpToolChangeResponse.nullable(),
})
export type McpServerResponse = z.infer<typeof McpServerResponse>

/** One MCP call budget, as the `mcpBudgets` workspace setting stores it. */
export const McpBudgetResponse = z.object({
  id: z.string(),
  scope: z.enum(['server', 'tool', 'member', 'member_server']),
  server: z.string().optional(),
  tool: z.string().optional(),
  memberId: z.string().optional(),
  period: z.enum(['hour', 'day']),
  limit: z.number().int(),
})
export type McpBudgetResponse = z.infer<typeof McpBudgetResponse>

/** `GET /api/v1/mcp/servers`: the servers, most recently seen first, and the registry's workspace settings. */
export const McpServerListResponse = listEnvelope('servers', 'camel').extend({
  servers: z.array(McpServerResponse),
  defaultPolicy: z.enum(['allow', 'deny']),
  highRiskToolChange: z.enum(['notify', 'hold']),
  budgets: z.object({
    budgets: z.array(McpBudgetResponse),
    warnAtPct: z.number().int().optional(),
  }),
  pendingCount: z.number().int().describe('Servers awaiting a decision (`candidate`).'),
})
export type McpServerListResponse = z.infer<typeof McpServerListResponse>

/** `POST /api/v1/mcp/servers/:serverId/status` and `/tools`: the server after the decision. */
export const McpServerDecisionResponse = z.object({ ok: z.literal(true), server: McpServerResponse })
export type McpServerDecisionResponse = z.infer<typeof McpServerDecisionResponse>

/**
 * `POST /api/v1/mcp/servers/observe`: a proxy reported a server it governs.
 * The row's status after the sighting, and the scored change when the
 * sighting's tool definitions differ from the stored ones.
 */
export const McpServerObserveResponse = z.object({
  ok: z.literal(true),
  status: z.enum(['candidate', 'approved', 'blocked']),
  created: z.boolean().describe('The first sighting of this server in the workspace.'),
  toolChange: z
    .object({
      changeId: z.string(),
      serverId: z.string(),
      score: z.number().int().describe('0–100.'),
      level: z.enum(['none', 'low', 'medium', 'high']),
      reasons: z.array(z.object({ rule: z.string(), tool: z.string(), points: z.number(), detail: z.string() })),
      added: z.array(z.string()),
      removed: z.array(z.string()),
      changed: z.array(z.string()),
      held: z.boolean().describe('The change returned the server to the approval queue (`mcpHighRiskToolChange: hold`).'),
    })
    .optional(),
})
export type McpServerObserveResponse = z.infer<typeof McpServerObserveResponse>

// ─── Token attenuation (routes/attenuate.ts) ────────────────────────

/** `POST /api/v1/attenuate`: the child key, returned once. */
export const AttenuationResponse = z.object({
  childKey: z.string().describe('The child `vk_*` key in plaintext, shown only in this response.'),
  childKeyId: z.string(),
  attenuationChainId: z.string(),
  grantedCaps: z.array(z.string()),
  expiresAt: IsoTimestamp,
})
export type AttenuationResponse = z.infer<typeof AttenuationResponse>

/** A link of a delegation chain. */
export const AttenuationChainLinkResponse = z.object({
  chainId: z.string(),
  parentKeyId: z.string(),
  childKeyId: z.string(),
  workspaceId: z.string(),
  grantedCaps: z.array(z.string()),
  expiresAt: IsoTimestamp,
  createdAt: IsoTimestamp,
})
export type AttenuationChainLinkResponse = z.infer<typeof AttenuationChainLinkResponse>

/** `GET /api/v1/attenuate/chain/:chainId`: the chain's lineage, parent to child. */
export const AttenuationChainResponse = z.object({ chain: z.array(AttenuationChainLinkResponse) })
export type AttenuationChainResponse = z.infer<typeof AttenuationChainResponse>

// ─── Compliance (routes/compliance.ts) ──────────────────────────────

const ProbeType = z.enum([
  'policy_check',
  'mfa_enforcement',
  'data_residency',
  'audit_log_integrity',
  'token_rotation',
  'sop_coverage',
  'auto_apply_provenance',
  'sop_git_drift',
  'guard_liveness',
  'guardrail_authority',
  'provider_availability',
])
const ProbeStatus = z.enum(['pass', 'fail', 'warn', 'error', 'not_enforced'])
const ControlState = z.enum(['evidenced', 'warning', 'failing', 'not_evidenced', 'records_only'])

/** A compliance probe's result (`complianceProbesService.ts` `ProbeResult`). */
export const ProbeResultResponse = z.object({
  probeId: z.string(),
  probeType: ProbeType,
  status: ProbeStatus,
  score: z.number().describe('0–100.'),
  details: z.record(z.unknown()),
  remediation: z.string().nullable(),
  probedAt: IsoTimestamp.describe('The newest run that produced this result.'),
  observedSince: IsoTimestamp.describe('The first run of the span of identical results this one belongs to.'),
  observations: z.number().int().describe('Runs in that span, this one included.'),
})
export type ProbeResultResponse = z.infer<typeof ProbeResultResponse>

/** `GET /api/v1/compliance/frameworks/:frameworkId/coverage` (JSON): coverage of one framework from the latest probe results. */
export const FrameworkCoverageResponse = z.object({
  frameworkId: z.enum(['eu_ai_act', 'iso_42001', 'nist_ai_rmf', 'mitre_atlas']),
  name: z.string(),
  citation: z.string().describe('The edition the control catalog was built from.'),
  scope: z.string().describe('What the catalog includes.'),
  mappingVersion: z.string(),
  generatedAt: IsoTimestamp,
  summary: z.object({
    controls: z.number().int(),
    mapped: z.number().int(),
    full: z.number().int(),
    partial: z.number().int(),
    states: z.object({
      evidenced: z.number().int(),
      warning: z.number().int(),
      failing: z.number().int(),
      not_evidenced: z.number().int(),
      records_only: z.number().int(),
    }),
  }),
  controls: z.array(
    z.object({
      controlId: z.string(),
      title: z.string(),
      coverage: z.enum(['full', 'partial', 'not_mapped']),
      state: ControlState.nullable().describe('Null for a control with no mapping.'),
      evidence: z.array(
        z.object({
          kind: z.enum(['probe', 'artifact', 'control']),
          id: z.string(),
          title: z.string(),
          reference: z.string().nullable().describe('The route that serves a record, or the source file of a product control; null for probes.'),
          satisfies: z.string(),
          state: z.enum(['pass', 'fail', 'warn', 'error', 'not_enforced', 'not_run', 'available']),
          probedAt: IsoTimestamp.nullable(),
        }),
      ),
      gaps: z.array(z.string()),
      mitigates: z
        .array(z.object({ id: z.string(), name: z.string() }))
        .optional()
        .describe('MITRE ATLAS only: the techniques this mitigation mitigates.'),
    }),
  ),
})
export type FrameworkCoverageResponse = z.infer<typeof FrameworkCoverageResponse>

/** A SOC 2 evidence archive (`soc2EvidenceService.ts` `Soc2EvidenceArchive`). */
export const Soc2EvidenceArchiveResponse = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  workspaceId: z.string(),
  runId: z.string(),
  periodStart: IsoTimestamp,
  periodEnd: IsoTimestamp,
  collectedAt: IsoTimestamp,
  overallScore: z.number().nullable().describe('Mean of the scored categories.'),
  categories: z.array(
    z.object({
      category: z.enum(['security', 'availability', 'processing_integrity', 'confidentiality', 'privacy']),
      score: z.number().nullable(),
      probes: z.array(ProbeResultResponse),
      counts: z.record(z.number()),
      sampleIds: z.record(z.array(z.string())),
      gaps: z.array(z.string()),
    }),
  ),
  probeHistoryDigest: z.array(
    z.object({
      probeType: ProbeType,
      rows: z.number().int(),
      firstAt: IsoTimestamp.nullable(),
      lastAt: IsoTimestamp.nullable(),
      statusCounts: z.record(z.number().int()),
    }),
  ),
  frameworks: z
    .array(
      z.object({
        coverage: FrameworkCoverageResponse,
        report: z.string().describe('Markdown.'),
        csv: z.string().optional(),
        pdf: z.string().optional().describe('Base64.'),
      }),
    )
    .optional(),
  manifest: z.object({
    algorithm: z.literal('sha256'),
    sections: z.record(z.string()),
    archiveSha256: z.string(),
    signed: z.boolean().optional(),
    unsignedReason: z.string().optional(),
  }),
  signature: z
    .object({
      algorithm: z.literal('Ed25519'),
      keyId: z.string(),
      preimageDomain: z.string(),
      value: z.string(),
    })
    .nullable(),
})
export type Soc2EvidenceArchiveResponse = z.infer<typeof Soc2EvidenceArchiveResponse>

const soc2CollectFields = {
  runId: z.string(),
  archive: Soc2EvidenceArchiveResponse,
  artifactUrl: z.string().nullable().describe('Where the archive was uploaded, when the deployment has an evidence bucket.'),
}

/** `POST /api/v1/compliance/soc2-collect`: the sealed archive of a fresh collection, and whether it is signed. */
export const Soc2CollectResponse = z.union([
  z.object({ ...soc2CollectFields, signed: z.literal(true), signingKeyId: z.string() }),
  z.object({ ...soc2CollectFields, signed: z.literal(false), unsignedReason: z.string() }),
])
export type Soc2CollectResponse = z.infer<typeof Soc2CollectResponse>

// ─── GitHub webhook (routes/githubWebhooks.ts) ──────────────────────

/** `GET /api/v1/integrations/github/webhook`. The secret is never returned here. */
export const GitHubWebhookResponse = z.object({
  configured: z.boolean(),
  url: z.string().nullable().describe('Payload URL to paste into GitHub; null until a secret has been made.'),
  createdAt: IsoTimestamp.nullable(),
  secretRotatedAt: IsoTimestamp.nullable(),
  lastDeliveryAt: IsoTimestamp.nullable(),
})
export type GitHubWebhookResponse = z.infer<typeof GitHubWebhookResponse>

/** `POST /api/v1/integrations/github/webhook/secret`: the payload URL and the new secret, returned once. */
export const GitHubWebhookSecretResponse = z.object({
  url: z.string(),
  secret: z.string().describe('The webhook secret in plaintext, shown only in this response.'),
})
export type GitHubWebhookSecretResponse = z.infer<typeof GitHubWebhookSecretResponse>

// ─── OpenAI Agents traces (routes/openaiAgentTraces.ts) ─────────────

/** `POST /api/v1/integrations/openai-agents/traces/ingest`: what the batch added. */
export const OpenAiAgentTracesIngestResponse = z.object({
  ingested: z.number().int().describe('Generation spans recorded as usage.'),
  skipped: z.number().int().describe('Other spans (function, agent, handoff…): counted, not stored.'),
  duplicates: z.number().int().describe('Generation spans already recorded.'),
  redactions: z.number().int().describe('DLP matches redacted from the recorded spans.'),
})
export type OpenAiAgentTracesIngestResponse = z.infer<typeof OpenAiAgentTracesIngestResponse>

// ─── AgentCore gateway (routes/agentcoreGateway.ts) ─────────────────

/**
 * `POST /api/v1/integrations/agentcore/gateway-check`: the verdict on one
 * tool call through an AgentCore gateway. A refusal answers 200 with
 * `allowed: false` (a DLP or SOP block), or 403 when a check could not run
 * under fail-closed (`code: GOVERNANCE_UNAVAILABLE`).
 */
export const AgentCoreGatewayCheckResponse = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  code: z.string().optional().describe('`GOVERNANCE_UNAVAILABLE` when a check could not run.'),
  degraded: z.boolean().optional().describe('A shadow workspace\'s allow for a call a check could not evaluate.'),
})
export type AgentCoreGatewayCheckResponse = z.infer<typeof AgentCoreGatewayCheckResponse>

// ─── Gate liveness (routes/gateLiveness.ts) ─────────────────────────

/** `GET /api/v1/governance/gate-liveness`: per-harness gate status. */
export const GateLivenessResponse = z.object({
  windowHours: z.number().int().describe('How long a gate\'s last event counts as reporting.'),
  gates: z.array(
    z.object({
      harnessType: z.string(),
      kind: z.enum(['hook', 'sdk']),
      status: z.enum(['reporting', 'silent', 'new']),
      lastSeen: z.string().nullable().describe('When the gate last sent an event inside the window, or null.'),
      agentLastSeen: IsoTimestamp.nullable().describe('When the control plane last heard from any agent of this harness.'),
      alertOpen: z.boolean().describe('Whether a `governance.gate.silent` alert for this harness is open.'),
    }),
  ),
})
export type GateLivenessResponse = z.infer<typeof GateLivenessResponse>

// ─── Cost prediction (routes/intelligence.ts) ───────────────────────

/** `POST /api/v1/predict-cost` (`tokenIntelligenceService.ts` `predictCost`). */
export const CostPredictionResponse = z.object({
  inputTokens: z.number().int(),
  estimatedOutputTokens: z.number().int(),
  estimatedReasoningTokens: z.number().int().nullable(),
  estimatedCostUsd: z.number(),
  confidence: z.enum(['high', 'medium', 'low']).describe('`high` from 10+ samples of the workspace\'s own baseline, `medium` from 3+, else `low` (a default multiplier).'),
  basedOnSamples: z.number().int(),
})
export type CostPredictionResponse = z.infer<typeof CostPredictionResponse>

// ─── Mirror adoption (routes/routing.ts) ────────────────────────────

/** `GET /api/v1/routing/mirror-adoption-report`: the report, or why there is not enough data for one. */
export const MirrorAdoptionReportResponse = z.union([
  z.object({
    candidateModel: z.string(),
    sufficientData: z.literal(true),
    sampleCount: z.number().int(),
    candidateBetter: z.number().int(),
    originalBetter: z.number().int(),
    tie: z.number().int(),
    unjudged: z.number().int(),
    faultRateDelta: z.number().nullable().describe('Candidate fault rate minus original fault rate; negative means the candidate faults less.'),
    averageCostDeltaUsd: z.number().nullable(),
    averageLatencyDeltaMs: z.number().nullable(),
  }),
  z.object({
    candidateModel: z.string(),
    sufficientData: z.literal(false),
    sampleCount: z.number().int(),
    minimumRequired: z.number().int(),
    reason: z.string(),
  }),
])
export type MirrorAdoptionReportResponse = z.infer<typeof MirrorAdoptionReportResponse>
