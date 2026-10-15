/**
 * Responses of the control plane routes in incidents.ts, traces.ts, findings.ts, integrity.ts, inventory.ts, usage.ts and loops.ts.
 *
 * @module
 */
import { z } from 'zod'
import { INCIDENT_TYPES } from '../enums.js'
import { IsoTimestamp, listEnvelope } from './common.js'

/**
 * A timestamp a raw SQL query (`db.execute`) returned: Postgres's own text
 * form (`2026-10-14 16:40:42.965558+00`), which the driver passes through
 * unparsed. Not ISO 8601, though `Date.parse` reads it.
 */
const PgTimestampText = z.string().describe('Postgres timestamptz text, e.g. `2026-10-14 16:40:42.965558+00` (not ISO 8601).')

const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

// ─── Incidents (`routes/incidents.ts`) ────────────────────────────────

/** A governance incident, as `GET /api/v1/incidents/:id` maps its `governance_incidents` row. */
export const IncidentResponse = z.object({
  incident_id: z.string(),
  workspace_id: z.string(),
  trace_id: z.string().nullable(),
  session_id: z.string().nullable(),
  severity: RiskLevel,
  anomaly_type: z.enum(INCIDENT_TYPES).describe('An anomaly category or a system incident type.'),
  description: z.string(),
  resolution_status: z.string().nullable().describe('OPEN, INVESTIGATING, RESOLVED or AUTO_RESOLVED; free text in the column.'),
  resolved_by: z.string().nullable(),
  resolved_at: IsoTimestamp.nullable(),
  escalation_chain: z
    .record(z.unknown())
    .nullable()
    .describe('Where the incident came from and how it was escalated (jsonb; its keys depend on the source); a resolve adds `resolution_notes`.'),
  created_at: IsoTimestamp,
})
export type IncidentResponse = z.infer<typeof IncidentResponse>

/** `GET /api/v1/incidents/:id`. */
export const IncidentDetailResponse = z.object({ data: IncidentResponse })
export type IncidentDetailResponse = z.infer<typeof IncidentDetailResponse>

/** How much of a ranked review queue the audit budget covers (`services/reviewPriority.ts` `describeBudget`). */
export const ReviewBudgetResponse = z.object({
  budget: z.number().int().describe('How many items a reviewer is expected to get through (INTUTIC_AUDIT_BUDGET).'),
  matched: z.number().int().describe('How many matched the filter in total.'),
  withheld: z.number().int().describe('How many are not shown because the budget ran out.'),
  overBudget: z.boolean(),
})
export type ReviewBudgetResponse = z.infer<typeof ReviewBudgetResponse>

const IncidentListMeta = z.object({
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  audit: ReviewBudgetResponse,
})

/** One row of the incident list: the incident with its rank. */
export const IncidentListRowResponse = IncidentResponse.extend({
  review_priority: z.number().describe('How far up the review queue the incident ranks; the list is sorted by it, highest first.'),
})
export type IncidentListRowResponse = z.infer<typeof IncidentListRowResponse>

/**
 * `GET /api/v1/incidents`. A page of 20 or more rows is TOON-encoded: the rows
 * are one string under `data`, and `listProperty` names where a decoder puts
 * them (`data` again).
 */
export const IncidentListResponse = z.union([
  listEnvelope('data', 'snake').extend({
    format: z.literal('toon'),
    data: z.string().describe('The rows, TOON-encoded (`@intutic/shared-types` `toonDecode`).'),
    meta: IncidentListMeta,
  }),
  listEnvelope('data', 'snake').extend({ data: z.array(IncidentListRowResponse), meta: IncidentListMeta }),
])
export type IncidentListResponse = z.infer<typeof IncidentListResponse>

// ─── Traces (`routes/traces.ts`) ──────────────────────────────────────

/**
 * One trace in the list (`traceQueryService.ts` `listTraces`). `breakGlass` and
 * `breakGlassRequestId` are always sent; they are optional here because
 * `TraceSummary` declares them so.
 */
export const TraceSummaryResponse = z.object({
  traceId: z.string(),
  timestamp: IsoTimestamp,
  requestedModel: z.string(),
  actualModelRouted: z.string(),
  enforcementAction: z.string().describe('BYPASS, ENHANCE, HIJACK, REASK, KILL or OBSERVED.'),
  complianceScore: z.number(),
  actualCostUsd: z.number(),
  anomalyDetected: z.string().nullable().describe('The winning anomaly category, null when none.'),
  breakGlass: z.boolean().optional().describe('True when the request ran under a break-glass token.'),
  breakGlassRequestId: z.string().nullable().optional(),
})
export type TraceSummaryResponse = z.infer<typeof TraceSummaryResponse>

/**
 * `GET /api/v1/traces`. A page of 20 or more rows is TOON-encoded: the rows are
 * one string under `data`, and `listProperty: 'traces'` names where a decoder
 * puts them.
 */
export const TraceListResponse = z.union([
  listEnvelope('traces', 'camel').extend({
    format: z.literal('toon'),
    data: z.string().describe('The rows, TOON-encoded (`@intutic/shared-types` `toonDecode`).'),
    total: z.number().int(),
  }),
  listEnvelope('traces', 'camel').extend({
    traces: z.array(TraceSummaryResponse),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
])
export type TraceListResponse = z.infer<typeof TraceListResponse>

/** One tool call the enforcement log recorded for the trace's request. */
const TraceStepResponse = z.object({
  logId: z.string(),
  toolName: z.string(),
  toolArguments: z.unknown().describe('The tool call\'s arguments as logged (jsonb).'),
  riskCategory: z.string().nullable(),
  verdict: z.string(),
  confidence: z.number(),
  reason: z.string(),
  loopDetected: z.boolean(),
  latencyMs: z.number().int().nullable(),
  timestamp: IsoTimestamp,
})

/** One persisted detector finding on the trace (`detector_findings`). */
const TraceFindingResponse = z.object({
  findingId: z.string(),
  detectorId: z.string(),
  anomalyKind: z.string(),
  severity: z.string(),
  disposition: z.string().describe('STEER, REASK, ASK or KILL: what the finding did.'),
  confidence: z.number(),
  reason: z.string(),
  shadowed: z.boolean().describe('True when recorded in shadow mode, not enforced.'),
})

/** One thing the request touched, as the proxy's change manifest records it (`ChangeEntry` in `packages/proxy/src/manifest.rs`). */
const ChangeManifestEntryResponse = z.object({
  tool: z.string(),
  op: z.enum(['write', 'edit', 'delete', 'move', 'execute', 'read', 'fetch', 'unknown']),
  target: z.string(),
  target_kind: z.enum(['path', 'url', 'command', 'opaque']),
  risk: z.array(z.string()).optional(),
  bytes: z.number().optional(),
})

/** One upstream call the proxy made for the request (`lib/upstreamAttempts.ts`). */
const UpstreamAttemptResponse = z.object({
  model: z.string(),
  provider: z.string(),
  outcome: z.string().describe('`ok`, `http_<status>`, `timeout`, `connect_error`, `transport_error`, or `skipped`.'),
  status: z.number().optional(),
  latencyMs: z.number(),
  backoffMs: z.number().optional(),
  serverDelay: z.boolean().optional(),
  stopped: z.string().optional(),
})

/** The fallback target that served the request (`lib/upstreamAttempts.ts`). */
const UpstreamFallbackResponse = z.object({
  fromModel: z.string(),
  toModel: z.string(),
  toProvider: z.string(),
  cacheAffinityBroken: z.boolean().optional(),
})

/**
 * `GET /api/v1/traces/:id` (`traceQueryService.ts` `getTraceById`). Every field
 * is always sent; the ones marked optional are optional because `TraceDetail`
 * declares them so.
 */
export const TraceDetailResponse = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  timestamp: IsoTimestamp,
  sopEffectiveDate: IsoTimestamp,
  requestedModel: z.string(),
  actualModelRouted: z.string(),
  routingTier: z.string(),
  complexityScore: z.number(),
  rawInputTokens: z.number().int(),
  compressedInputTokens: z.number().int(),
  outputTokens: z.number().int(),
  rawCostUsd: z.number(),
  actualCostUsd: z.number(),
  savingsUsd: z.number(),
  tokenUtility: z.string().nullable().describe('USEFUL or WASTED: a person\'s re-label, else the value ingest set; null when nobody classified it.'),
  tokenUtilityClassifiedBy: z.string().nullable().optional().describe('Who re-labelled the trace; null when it holds its insert-time value.'),
  tokenUtilityScore: z.number().nullable().describe('A person\'s label\'s score (1 USEFUL, 0 WASTED); null without one.'),
  complianceScore: z.number(),
  enforcementAction: z.string().describe('BYPASS, ENHANCE, HIJACK, REASK, KILL or OBSERVED.'),
  anomalyDetected: z.string().nullable(),
  anomalyConfidenceScore: z.number().nullable(),
  taxonomyMetadata: z.unknown().describe('jsonb, null when none.'),
  rootCauseAttribution: z.unknown().describe('jsonb, null when none.'),
  correctivePromptCard: z.unknown().describe('jsonb, null when none.'),
  reasoningTokens: z.number().int().nullable().optional(),
  cacheReadInputTokens: z.number().int().nullable().optional(),
  cacheCreationInputTokens: z.number().int().nullable().optional(),
  toolCallMetrics: z.unknown().optional().describe('Token accounting per tool (jsonb), null when none.'),
  changeManifest: z.array(ChangeManifestEntryResponse).nullable().optional().describe('What the request touched; null when it touched nothing the proxy recorded.'),
  responseIntegrity: z.number().int().nullable().optional().describe('0–100 when the response was scored; null when not measured.'),
  qualityFault: z.string().nullable().optional(),
  routingShadowModel: z.string().nullable().optional(),
  upstreamAttempts: z.array(UpstreamAttemptResponse).nullable().optional().describe('Every upstream call when the proxy retried or fell back; null for a single call.'),
  upstreamFallback: UpstreamFallbackResponse.nullable().optional(),
  breakGlass: z.boolean().optional(),
  breakGlassRequestId: z.string().nullable().optional(),
  steps: z.array(TraceStepResponse).optional().describe('The enforcement log for the request, oldest first.'),
  findings: z.array(TraceFindingResponse).optional().describe('Every detector finding on the trace, most severe first.'),
})
export type TraceDetailResponse = z.infer<typeof TraceDetailResponse>

// ─── Findings (`routes/findings.ts`) ──────────────────────────────────

/** One detector finding (`detector_findings`), snake_cased by the list route. */
export const FindingResponse = z.object({
  finding_id: z.string(),
  trace_id: z.string(),
  session_id: z.string().nullable(),
  loop_run_id: z.string().nullable(),
  detector_id: z.string(),
  anomaly_kind: z.string(),
  severity: z.string(),
  disposition: z.string(),
  confidence: z.number(),
  reason: z.string(),
  harness: z.string().nullable(),
  shadowed: z.boolean(),
  suppressed: z.boolean().describe('True when a suppression auto-labelled it; excluded from the precision counts.'),
  outcome: z.enum(['TRUE_POSITIVE', 'FALSE_POSITIVE']).nullable().describe('Null until a human (or a suppression) ruled.'),
  outcome_by: z.string().nullable(),
  outcome_at: IsoTimestamp.nullable(),
  outcome_note: z.string().nullable().describe('Withheld (null) on a `response_injection:*` finding unless the caller is OWNER or ADMIN.'),
  created_at: IsoTimestamp,
})
export type FindingResponse = z.infer<typeof FindingResponse>

/** `GET /api/v1/findings`. */
export const FindingListResponse = z.object({ findings: z.array(FindingResponse) })
export type FindingListResponse = z.infer<typeof FindingListResponse>

/** `POST /api/v1/findings/:findingId/adjudicate`. */
export const FindingAdjudicationResponse = z.object({
  finding_id: z.string(),
  outcome: z.enum(['TRUE_POSITIVE', 'FALSE_POSITIVE']),
})
export type FindingAdjudicationResponse = z.infer<typeof FindingAdjudicationResponse>

/** `GET /api/v1/findings/stats`: precision per detector, over adjudicated findings. */
export const FindingStatsResponse = z.object({
  detectors: z.array(
    z.object({
      detector_id: z.string(),
      anomaly_kind: z.string(),
      shadowed: z.boolean().describe('Findings recorded in shadow mode get their own row.'),
      total_findings: z.number().int(),
      adjudicated: z.number().int(),
      false_positives: z.number().int(),
      false_positive_rate: z.number().nullable().describe('false_positives / adjudicated; null when nothing has been ruled on.'),
    }),
  ),
  caveats: z.array(z.string()),
})
export type FindingStatsResponse = z.infer<typeof FindingStatsResponse>

/** `GET /api/v1/findings/response-echo/report` (`responseInjectionCorpusService.ts`). */
export const ResponseEchoReportResponse = z.object({
  window: z.object({ since: IsoTimestamp, until: IsoTimestamp }),
  tracesIngested: z.number().int().describe('Traces in the window: the denominator that tells "checked, found nothing" from "did not check".'),
  refusal: z.string().nullable().describe('Set when no traces were ingested in the window.'),
  patterns: z.array(
    z.object({
      pattern: z.enum(['override-instructions', 'reveal-system-prompt', 'role-reassignment', 'guardrail-bypass', 'instruction-boundary-forgery']),
      findings: z.number().int(),
      adjudicated: z.number().int(),
      truePositives: z.number().int(),
      falsePositives: z.number().int(),
      falsePositiveRate: z.number().nullable().describe('Null, with `refusal` set, below 20 adjudicated findings.'),
      refusal: z.string().nullable(),
    }),
  ),
})
export type ResponseEchoReportResponse = z.infer<typeof ResponseEchoReportResponse>

// ─── Trace integrity (`routes/integrity.ts`) ──────────────────────────

/** A sealed Merkle root as `GET /api/v1/integrity/roots` selects it (raw SQL, so snake_case and Postgres timestamp text). */
export const IntegrityRootSummaryResponse = z.object({
  root_id: z.string(),
  loop_run_id: z.string().nullable(),
  leaf_schema_version: z.number().int(),
  merkle_root: z.string(),
  leaf_count: z.number().int(),
  first_trace_at: PgTimestampText,
  last_trace_at: PgTimestampText,
  signature_alg: z.string().nullable(),
  signing_key_id: z.string().nullable(),
  sealed_at: PgTimestampText,
})
export type IntegrityRootSummaryResponse = z.infer<typeof IntegrityRootSummaryResponse>

/** `GET /api/v1/integrity/roots`: the workspace's sealed roots, newest first (at most 50). */
export const IntegrityRootListResponse = listEnvelope('data', 'snake').extend({
  ok: z.literal(true),
  data: z.array(IntegrityRootSummaryResponse),
  leafSchemaVersion: z.number().int().describe('The leaf encoding new roots are sealed under.'),
})
export type IntegrityRootListResponse = z.infer<typeof IntegrityRootListResponse>

/** Every column of a `trace_merkle_roots` row (`SELECT *`). */
export const IntegrityRootRowResponse = IntegrityRootSummaryResponse.extend({
  workspace_id: z.string(),
  sample_preimage: z.string().describe('The preimage of leaf 0.'),
  signature: z.string().nullable(),
  previous_root: z.string().nullable().describe('The merkle_root of the workspace\'s previous root; null on the first, or from a writer before migration 108.'),
  signing_preimage_version: z.number().int(),
})
export type IntegrityRootRowResponse = z.infer<typeof IntegrityRootRowResponse>

/** One leaf of a sealed root. */
export const IntegrityLeafResponse = z.object({
  trace_id: z.string(),
  leaf_index: z.number().int(),
  leaf_hash: z.string(),
})
export type IntegrityLeafResponse = z.infer<typeof IntegrityLeafResponse>

/** `GET /api/v1/integrity/roots/:rootId`: the root and the leaves it covers, in order. */
export const IntegrityRootDetailResponse = listEnvelope('leaves', 'snake').extend({
  ok: z.literal(true),
  root: IntegrityRootRowResponse,
  leaves: z.array(IntegrityLeafResponse),
})
export type IntegrityRootDetailResponse = z.infer<typeof IntegrityRootDetailResponse>

/** `POST /api/v1/integrity/roots/:rootId/recompute` (`traceRootSweep.ts` `recomputeRoot`). A mismatch is an answer, so every verdict is a 200. */
export const IntegrityRecomputeResponse = z.object({
  ok: z.literal(true),
  verdict: z.enum(['match', 'mismatch', 'missing_traces']),
  storedRoot: z.string(),
  recomputedRoot: z.string().nullable().describe('Null when traces are missing.'),
  changedTraceIds: z.array(z.string()).describe('Traces whose leaf no longer matches.'),
  missingTraceIds: z.array(z.string()),
  redactedTraceIds: z.array(z.string()).describe('Traces rewritten by a documented redaction after the root was sealed; checked against the leaf recorded at the redaction.'),
  retentionExpired: z.boolean().describe('True when the missing traces were deleted by the retention schedule, not lost.'),
})
export type IntegrityRecomputeResponse = z.infer<typeof IntegrityRecomputeResponse>

/**
 * `GET /api/v1/integrity/chain` (`traceRootSweep.ts` `verifyRootChain`). A
 * break answers 409 with this same body (`ok: false`, `breaks` filled); a 200
 * never carries a break.
 */
export const IntegrityChainResponse = z.object({
  ok: z.boolean().describe('Same as `intact`.'),
  workspaceId: z.string(),
  rootsWalked: z.number().int(),
  rootsNotWalked: z.number().int().describe('Older roots outside the walked window; their links were not examined.'),
  unchainedRootIds: z.array(z.string()).describe('Roots with no previous_root that are not the first: nothing claimed, so not a break.'),
  breaks: z.array(
    z.object({
      rootId: z.string(),
      namedPrevious: z.string(),
      precedingRootId: z.string(),
      precedingMerkleRoot: z.string(),
    }),
  ),
  intact: z.boolean(),
})
export type IntegrityChainResponse = z.infer<typeof IntegrityChainResponse>

/**
 * `GET /api/v1/integrity/config-chain` (`harnessConfigService.ts`
 * `verifyConfigChain`). A break or an edited body answers 409 with this same
 * body; a 200 never carries either.
 */
export const IntegrityConfigChainResponse = z.object({
  ok: z.boolean().describe('Same as `intact`.'),
  workspaceId: z.string(),
  harnessType: z.string().nullable().describe('The harness type the walk was scoped to; null for all.'),
  snapshotsWalked: z.number().int(),
  snapshotsNotWalked: z.number().int().describe('Saturates at 1: more snapshots than the walk covered.'),
  unchainedSnapshotIds: z.array(z.string()),
  breaks: z.array(
    z.object({
      snapshotId: z.string(),
      harnessType: z.string(),
      filePath: z.string(),
      namedPrevious: z.string(),
      precedingSnapshotId: z.string(),
      precedingContentHash: z.string(),
    }),
  ),
  contentMismatches: z.array(
    z.object({
      snapshotId: z.string(),
      harnessType: z.string(),
      filePath: z.string(),
      storedHash: z.string(),
      recomputedHash: z.string(),
    }),
  ),
  snapshotsWithoutContent: z.number().int().describe('Walked snapshots captured without content, which cannot be re-hashed.'),
  intact: z.boolean(),
})
export type IntegrityConfigChainResponse = z.infer<typeof IntegrityConfigChainResponse>

// ─── AI inventory (`routes/inventory.ts`) ─────────────────────────────

/** `GET /api/v1/inventory/summary` (`devInventoryService.ts` `summarize`). */
export const InventorySummaryResponse = z.object({
  data: z.object({
    devices: z.number().int(),
    staleDevices: z.number().int(),
    harnesses: z.number().int(),
    governedHarnesses: z.number().int(),
    governedPercent: z.number().int().nullable().describe('Governed harnesses as a whole percentage; null with none.'),
    ungovernedHarnesses: z.number().int(),
    staleGates: z.number().int(),
    unverifiedHarnesses: z.number().int(),
    mcpServers: z.number().int(),
    ungovernedMcpServers: z.number().int(),
    skills: z.number().int(),
  }),
})
export type InventorySummaryResponse = z.infer<typeof InventorySummaryResponse>

/** One machine (`devInventoryService.ts` `InventoryDeviceRow`). */
export const InventoryDeviceResponse = z.object({
  deviceId: z.string(),
  hostname: z.string(),
  platform: z.string(),
  cliVersion: z.string().nullable(),
  reportedBy: z.string().nullable().describe('Email of the member whose credentials sent the latest report.'),
  workspace: z.string().nullable().describe('The workspace path the daemon reported.'),
  guardProbes: z
    .object({ total: z.number(), failed: z.number(), ranAt: z.number().describe('Unix seconds.') })
    .nullable(),
  firstSeenAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp,
  stale: z.boolean().describe('Not reported for the stale window; never true for a disconnected machine.'),
  disconnectedAt: IsoTimestamp.nullable(),
  harnesses: z.number().int(),
  ungovernedHarnesses: z.number().int(),
  staleGates: z.number().int(),
  mcpServers: z.number().int(),
  ungovernedMcpServers: z.number().int(),
  skills: z.number().int(),
})
export type InventoryDeviceResponse = z.infer<typeof InventoryDeviceResponse>

const InventoryItemBase = z.object({
  itemId: z.string(),
  deviceId: z.string(),
  hostname: z.string(),
  deviceStale: z.boolean(),
  firstSeenAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp,
})

/** One harness on one machine (`InventoryHarnessRow`). */
export const InventoryHarnessResponse = InventoryItemBase.extend({
  harness: z.string(),
  version: z.string().nullable(),
  configured: z.boolean(),
  gateKind: z.enum(['hook', 'sdk', 'none', 'delegated', 'bridge']),
  gateInstalled: z.boolean().nullable(),
  gateFile: z.string().nullable(),
  lastHookEventAt: z.string().nullable().describe('As the daemon reported it.'),
  status: z.enum(['governed', 'ungoverned', 'gate_stale', 'unverified']),
  reason: z
    .enum([
      'no_gate_mechanism',
      'not_connected',
      'gate_missing',
      'guards_disabled',
      'gate_silent',
      'awaiting_first_event',
      'gate_not_observable',
      'disconnected',
    ])
    .nullable()
    .describe('Null when governed.'),
  reasonText: z.string().nullable(),
})
export type InventoryHarnessResponse = z.infer<typeof InventoryHarnessResponse>

/** One MCP server on one machine (`InventoryMcpServerRow`). */
export const InventoryMcpServerResponse = InventoryItemBase.extend({
  server: z.string(),
  harness: z.string(),
  transport: z.enum(['stdio', 'http', 'sse', 'unknown']),
  endpoint: z.string().nullable(),
  status: z.enum(['governed', 'ungoverned']).describe('Governed when the MCP governance proxy fronts it.'),
  reason: z.string().nullable(),
})
export type InventoryMcpServerResponse = z.infer<typeof InventoryMcpServerResponse>

/** One skill bundle on one machine (`InventorySkillRow`). */
export const InventorySkillResponse = InventoryItemBase.extend({
  name: z.string(),
  source: z.string(),
  sha256: z.string().nullable(),
  scanned: z.boolean(),
  clean: z.boolean(),
  findingsCount: z.number().int(),
  scriptCount: z.number().int(),
})
export type InventorySkillResponse = z.infer<typeof InventorySkillResponse>

/** One `intutic disconnect` a machine reported (`deviceDisconnectService.ts` `DeviceDisconnectRow`). */
export const DeviceDisconnectRowResponse = z.object({
  disconnectId: z.string(),
  hostname: z.string(),
  fingerprint: z.string(),
  scope: z.enum(['machine', 'harness']),
  harnesses: z.array(z.string()),
  memberId: z.string().nullable(),
  reportedBy: z.string().nullable(),
  createdAt: IsoTimestamp,
})
export type DeviceDisconnectRowResponse = z.infer<typeof DeviceDisconnectRowResponse>

/** `GET /api/v1/inventory/devices`. */
export const InventoryDeviceListResponse = listEnvelope('data', 'camel').extend({ data: z.array(InventoryDeviceResponse) })
export type InventoryDeviceListResponse = z.infer<typeof InventoryDeviceListResponse>
/** `GET /api/v1/inventory/harnesses` (JSON; `?format=csv` answers text). */
export const InventoryHarnessListResponse = listEnvelope('data', 'camel').extend({ data: z.array(InventoryHarnessResponse) })
export type InventoryHarnessListResponse = z.infer<typeof InventoryHarnessListResponse>
/** `GET /api/v1/inventory/mcp-servers` (JSON; `?format=csv` answers text). */
export const InventoryMcpServerListResponse = listEnvelope('data', 'camel').extend({ data: z.array(InventoryMcpServerResponse) })
export type InventoryMcpServerListResponse = z.infer<typeof InventoryMcpServerListResponse>
/** `GET /api/v1/inventory/skills`. */
export const InventorySkillListResponse = listEnvelope('data', 'camel').extend({ data: z.array(InventorySkillResponse) })
export type InventorySkillListResponse = z.infer<typeof InventorySkillListResponse>
/** `GET /api/v1/inventory/disconnects`, newest first. */
export const DeviceDisconnectListResponse = listEnvelope('data', 'camel').extend({ data: z.array(DeviceDisconnectRowResponse) })
export type DeviceDisconnectListResponse = z.infer<typeof DeviceDisconnectListResponse>

// ─── Usage (`routes/usage.ts`) ────────────────────────────────────────

const UsageScope = z.enum(['workspace', 'self']).describe('`self` when the caller sees only their own calls (below EM).')

const UsageTotals = {
  totalCostUsd: z.number(),
  totalRawCostUsd: z.number(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  traceCount: z.number().int(),
}

/** One member's usage (`finopsService.ts` `getMemberUsage`). */
export const MemberUsageRowResponse = z.object({
  memberId: z.string().nullable().describe('Null for the unattributed bucket.'),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  ...UsageTotals,
  models: z.array(z.string()).describe('Distinct requested models, sorted.'),
  activeDays: z.number().int().describe('Distinct UTC days with a call.'),
})
export type MemberUsageRowResponse = z.infer<typeof MemberUsageRowResponse>

/** `GET /api/v1/usage/members`. */
export const MemberUsageListResponse = listEnvelope('members', 'camel').extend({
  scope: UsageScope,
  members: z.array(MemberUsageRowResponse),
})
export type MemberUsageListResponse = z.infer<typeof MemberUsageListResponse>

/** `GET /api/v1/usage/teams` (`getTeamUsage`): per SCIM group. */
export const TeamUsageListResponse = listEnvelope('teams', 'camel').extend({
  scimGroups: z.boolean().describe('False when the workspace has no SCIM groups, so no teams.'),
  teams: z.array(
    z.object({
      groupId: z.string(),
      displayName: z.string(),
      memberCount: z.number().int().describe('Members in the group, nested groups included.'),
      activeMembers: z.number().int(),
      ...UsageTotals,
    }),
  ),
})
export type TeamUsageListResponse = z.infer<typeof TeamUsageListResponse>

/** `GET /api/v1/usage/branches` (`getBranchUsage`). */
export const BranchUsageListResponse = listEnvelope('branches', 'camel').extend({
  scope: UsageScope,
  branches: z.array(
    z.object({
      repo: z.string().nullable().describe('Normalised origin remote; null on the row for calls with no git context.'),
      branch: z.string().nullable(),
      commitCount: z.number().int(),
      ...UsageTotals,
      lastCallAt: IsoTimestamp,
    }),
  ),
})
export type BranchUsageListResponse = z.infer<typeof BranchUsageListResponse>

/** `GET /api/v1/usage/commits` (`getCommitUsage`). */
export const CommitUsageListResponse = listEnvelope('commits', 'camel').extend({
  scope: UsageScope,
  commits: z.array(
    z.object({
      repo: z.string().nullable(),
      branch: z.string().nullable(),
      commit: z.string().nullable(),
      ...UsageTotals,
      firstCallAt: IsoTimestamp,
      lastCallAt: IsoTimestamp,
    }),
  ),
})
export type CommitUsageListResponse = z.infer<typeof CommitUsageListResponse>

/** `GET /api/v1/usage/pull-requests` (`getPullRequestUsage`, `getPullRequestSources`). */
export const PullRequestUsageListResponse = listEnvelope('pullRequests', 'camel').extend({
  scope: UsageScope,
  github: z.object({
    connector: z.boolean().describe('A GitHub source connector exists.'),
    webhook: z.boolean().describe('The pull-request webhook is set up.'),
    apiHost: z.string(),
    noAccessRepos: z.array(z.string()).describe('Repositories the connector\'s token was refused.'),
    mappedPullRequests: z.number().int(),
    lastCheckedAt: IsoTimestamp.nullable(),
  }),
  pullRequests: z.array(
    z.object({
      repo: z.string(),
      number: z.number().int(),
      title: z.string(),
      author: z.string().nullable(),
      state: z.enum(['open', 'closed', 'merged']),
      headBranch: z.string(),
      baseBranch: z.string().nullable(),
      url: z.string(),
      openedAt: IsoTimestamp,
      mergedAt: IsoTimestamp.nullable(),
      closedAt: IsoTimestamp.nullable(),
      ...UsageTotals,
      memberCount: z.number().int(),
      firstCallAt: IsoTimestamp,
      lastCallAt: IsoTimestamp,
    }),
  ),
})
export type PullRequestUsageListResponse = z.infer<typeof PullRequestUsageListResponse>

/** `POST /api/v1/usage/pull-requests/refresh` (`syncWorkspacePullRequests`). */
export const PullRequestRefreshResponse = z.object({
  checked: z.number().int().describe('Branches looked up.'),
  notModified: z.number().int(),
  pullRequests: z.number().int().describe('Pull requests written or updated.'),
  noAccess: z.number().int(),
  rateLimited: z.boolean(),
})
export type PullRequestRefreshResponse = z.infer<typeof PullRequestRefreshResponse>

// ─── Loop runs (`routes/loops.ts`) ────────────────────────────────────

/** A `loop_runs` row. */
export const LoopRunResponse = z.object({
  loopRunId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'PENDING_REVIEW', 'COMPLETED', 'FAILED', 'KILLED']),
  startedBy: z.string().nullable().describe('Member id of whoever started it.'),
  reviewReason: z.string().nullable().describe('Why the run was held; null unless it was.'),
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoTimestamp.nullable(),
  reviewNote: z.string().nullable(),
  totalTokenCostUsd: z.string().describe('Decimal string.'),
  budgetLimitUsd: z.string().describe('Decimal string.'),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type LoopRunResponse = z.infer<typeof LoopRunResponse>

/** `POST /api/v1/loops/start` and `GET /api/v1/loops/:loopRunId`. */
export const LoopRunEnvelopeResponse = z.object({ ok: z.literal(true), loop: LoopRunResponse })
export type LoopRunEnvelopeResponse = z.infer<typeof LoopRunEnvelopeResponse>

/** `GET /api/v1/loops`, newest first. */
export const LoopRunListResponse = listEnvelope('loops', 'camel').extend({
  ok: z.literal(true),
  loops: z.array(LoopRunResponse),
})
export type LoopRunListResponse = z.infer<typeof LoopRunListResponse>

/** `POST /api/v1/loops/:loopRunId/complete`. */
export const LoopRunCompleteResponse = z.object({ ok: z.literal(true), outcome: z.enum(['SUCCEEDED', 'FAILED']) })
export type LoopRunCompleteResponse = z.infer<typeof LoopRunCompleteResponse>

/** `POST /api/v1/loops/:loopRunId/kill`. */
export const LoopRunKillResponse = z.object({ ok: z.literal(true) })
export type LoopRunKillResponse = z.infer<typeof LoopRunKillResponse>

/** `POST /api/v1/loops/:loopRunId/review`: the run's status after the review. */
export const LoopRunReviewResponse = z.object({
  ok: z.literal(true),
  status: z.enum(['ACTIVE', 'KILLED']).describe('ACTIVE when approved, KILLED when rejected.'),
})
export type LoopRunReviewResponse = z.infer<typeof LoopRunReviewResponse>
