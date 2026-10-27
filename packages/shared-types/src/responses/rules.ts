/**
 * Responses of the control plane routes in wasmRules.ts, sops.ts, dreamCycle.ts, decisions.ts, judge.ts and hookEvents.ts.
 *
 * @module
 */
import { z } from 'zod'
import { ChangeClassification, ComplexityTier, RiskLevel, SopLifecycleState } from '../enums.js'
import { PII_ACTIONS, PII_DETECTOR_IDS } from '../piiDetectors.js'
import { DeletedResponse, IsoTimestamp, listEnvelope } from './common.js'
import { ServedDecideRuleResponse } from './decide.js'

const InterventionMode = z.enum(['TRANSPARENT', 'OPAQUE', 'SILENT_LOG'])

// ─── WASM rules (routes/wasmRules.ts) ─────────────────────────────────

/** A `wasm_rule_bundles` row without its binary. */
export const WasmRuleResponse = z.object({
  ruleId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  bundleSha256: z.string(),
  isActive: z.boolean(),
  /** Ascending; lower runs first. */
  priority: z.number().int(),
  mode: z.string().describe('`ENFORCE` or `SHADOW`.'),
  version: z.number().int(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type WasmRuleResponse = z.infer<typeof WasmRuleResponse>

/** `GET /api/v1/wasm-rules`: every rule of the workspace, as a bare array. */
export const WasmRuleListResponse = z.array(WasmRuleResponse)
export type WasmRuleListResponse = z.infer<typeof WasmRuleListResponse>

/** `PUT /api/v1/wasm-rules/:ruleId`. */
export const WasmRuleUpdatedResponse = z.object({ updated: z.literal(true) })
export type WasmRuleUpdatedResponse = z.infer<typeof WasmRuleUpdatedResponse>

/** `DELETE /api/v1/wasm-rules/:ruleId`. */
export const WasmRuleDeletedResponse = DeletedResponse
export type WasmRuleDeletedResponse = z.infer<typeof WasmRuleDeletedResponse>

/** `POST /api/v1/wasm-rules/:ruleId/replay`: the rule run over sampled request contexts (`summarizeReplay`). */
export const WasmRuleReplayResponse = z.object({
  ruleId: z.string(),
  since: IsoTimestamp.nullable().describe('The start of the sampled window, when the request gave one.'),
  contextCount: z.number().int(),
  wouldActCount: z.number().int(),
  wouldActRate: z.number(),
  verdictCounts: z.record(z.string(), z.number().int()).describe('Verdict code (0 allow, 1 block, 3 reask; 2 deprecated) → contexts that produced it.'),
  sampleMatches: z.array(z.record(z.string(), z.unknown())).describe('Up to 20 contexts the rule acted on.'),
  argumentsWithheld: z.number().int().describe('Contexts that carry tool-call argument keys and sizes, not values.'),
  argumentsNote: z.string().optional().describe('Present when `argumentsWithheld` is above zero.'),
})
export type WasmRuleReplayResponse = z.infer<typeof WasmRuleReplayResponse>

// ─── SOPs (routes/sops.ts) ────────────────────────────────────────────

/** A SOP as `sopService.ts` returns it. Which optional fields are present depends on the route. */
export const SopResponse = z.object({
  sopId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  version: z.string(),
  markdownContent: z.string(),
  /** Null for a SOP written without one (the `sop_registry` view applies no column default; the SOP health cron writes none). */
  riskTier: z.nativeEnum(RiskLevel).nullable(),
  complexityTier: z.nativeEnum(ComplexityTier).nullable(),
  isActive: z.boolean(),
  lifecycleState: z.nativeEnum(SopLifecycleState),
  createdAt: IsoTimestamp.optional(),
  updatedAt: IsoTimestamp.optional(),
  contentHash: z.string().optional().describe('sha256 of `markdownContent`.'),
  dependencies: z.array(z.string()).optional().describe('SOP ids this SOP depends on (detail route).'),
  createdBy: z.string().optional(),
  versionCounter: z.number().int().optional().describe('The optimistic-lock token to send back on update.'),
  priorVersionId: z.string().nullable().optional(),
  shadowEvaluations: z.number().int().optional(),
  shadowWouldBlock: z.number().int().optional(),
  gitDriftStatus: z.string().optional(),
  gitDriftCheckedAt: IsoTimestamp.optional(),
  sslCompileState: z.enum(['compiled', 'stale', 'uncompiled']).optional(),
})
export type SopResponse = z.infer<typeof SopResponse>

/**
 * A SOP uses front-matter keys that some of the org's registered gateways are
 * too old to read (`sopKeySince.ts`). A proxy ignores a key it does not know,
 * so on those gateways the rule does nothing; the save itself succeeds.
 */
export const SopGatewayWarning = z.object({
  code: z.literal('sop_key_needs_newer_gateway'),
  message: z.string(),
  keys: z.array(z.object({ key: z.string(), since: z.string() })).describe('Each key, and the proxy release that first reads it.'),
  gateways: z
    .array(z.object({ gatewayId: z.string(), name: z.string(), proxyVersion: z.string().nullable() }))
    .describe('The active gateways too old for at least one key; `proxyVersion` null when one has never reported it.'),
})
export type SopGatewayWarning = z.infer<typeof SopGatewayWarning>

/** `POST /api/v1/sops`: the created SOP; its tiers are the ones the request named. */
export const SopCreatedResponse = SopResponse.extend({
  riskTier: z.nativeEnum(RiskLevel),
  complexityTier: z.nativeEnum(ComplexityTier),
  warnings: z.array(SopGatewayWarning).optional().describe('Present when the SOP uses a key a registered gateway is too old to read.'),
})
export type SopCreatedResponse = z.infer<typeof SopCreatedResponse>

/** `GET /api/v1/sops`: one page of SOPs. */
export const SopListResponse = listEnvelope('items', 'camel').extend({
  items: z.array(SopResponse),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
})
export type SopListResponse = z.infer<typeof SopListResponse>

/** `PUT /api/v1/sops/:sopId`: the updated SOP (a new DRAFT version when the SOP was not a DRAFT), and the anti-gaming analysis when the content changed. */
export const SopUpdatedResponse = z.object({
  sop: SopResponse,
  antiGaming: z
    .object({
      changeClassification: z.nativeEnum(ChangeClassification),
      requiresElevatedApproval: z.boolean(),
      impactSummary: z.string(),
    })
    .optional(),
  warnings: z.array(SopGatewayWarning).optional().describe('Present when the SOP uses a key a registered gateway is too old to read.'),
})
export type SopUpdatedResponse = z.infer<typeof SopUpdatedResponse>

/** `DELETE /api/v1/sops/:sopId`: soft-deleted. */
export const SopDeletedResponse = DeletedResponse
export type SopDeletedResponse = z.infer<typeof SopDeletedResponse>

/** `POST /api/v1/sops/git-drift-report`. */
export const SopGitDriftReportResponse = z.object({ ok: z.literal(true), recorded: z.number().int().describe('Results written.') })
export type SopGitDriftReportResponse = z.infer<typeof SopGitDriftReportResponse>

/** A rule the MCP proxy and the hook gate enforce: from a SOP title, or projected from a hook-rule guardrail (`origin: 'guardrail'`). */
export const SopRuleResponse = z.object({
  id: z.string().describe('The SOP id, or `guardrail:<guardrailId>`.'),
  toolPattern: z.string().describe('A regular expression over the tool name.'),
  argPattern: z.string().optional().describe('A regular expression over the JSON-encoded arguments.'),
  action: z.enum(['block', 'warn', 'require_approval']),
  reason: z.string(),
  origin: z.literal('guardrail').optional(),
  roles: z.array(z.string()).optional().describe('The lower-cased roles a guardrail rule is scoped to; absent when it applies to everyone.'),
})
export type SopRuleResponse = z.infer<typeof SopRuleResponse>

/**
 * The workspace's MCP curation (`lib/mcpCuration.ts`), which
 * `GET /api/v1/sop/rules` and `GET /api/v1/policy/resolve` both send, so the
 * per-session and daemon-mode MCP proxies see the same curation.
 */
const McpCuration = z.object({
  allowedTools: z.array(z.string()).describe('Empty means unrestricted.'),
  toolDescriptionOverrides: z.record(z.string(), z.string()),
  allowedServers: z.array(z.string()).describe('Empty means unrestricted.'),
  mcpInjectionPatterns: z.array(z.string()),
  mcpRegistry: z.object({
    defaultPolicy: z.enum(['allow', 'deny']),
    approvedServers: z.array(z.string()),
    blockedServers: z.array(z.string()),
    heldServers: z.array(z.string()),
    disabledTools: z.record(z.string(), z.array(z.string())).describe('Server name → tools disabled within it.'),
  }),
  mcpBudgets: z.object({
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
    warnAtPct: z.number().int(),
  }),
  piiDetectors: z
    .record(z.enum(PII_DETECTOR_IDS), z.enum(PII_ACTIONS))
    .nullable()
    .describe('Detector id → action; null when the stored setting no longer validates.'),
  wasmRules: z.array(
    z.object({
      ruleId: z.string(),
      name: z.string(),
      sha256: z.string(),
      priority: z.number().int(),
      mode: z.enum(['ENFORCE', 'SHADOW']),
    }),
  ),
  ssoGroupPolicy: z
    .object({ highRiskTools: z.array(z.string()), requiredGroups: z.array(z.string()), requireOboFor: z.array(z.string()) })
    .nullable(),
  principal: z
    .object({ memberId: z.string(), email: z.string(), role: z.string(), ssoGroups: z.array(z.string()) })
    .nullable()
    .describe('The member behind the caller\'s key, with their SSO groups; null when there is none.'),
  mcpProxyFailBehavior: z.enum(['open', 'closed']).optional(),
  mcpInjectionAction: z.enum(['warn', 'block']).optional(),
  mcpAnomalyMode: z.enum(['enforce', 'warn', 'off']).optional(),
  mcpAnomalyOverrides: z.record(z.string(), z.enum(['steer', 'reask', 'kill', 'off'])).optional(),
})

/** `GET /api/v1/sop/rules`: the rule set and MCP curation the MCP proxy polls. */
export const SopRulesResponse = listEnvelope('rules', 'camel')
  .extend({ ok: z.literal(true), rules: z.array(SopRuleResponse) })
  .merge(McpCuration)
  .extend({ interventionMode: InterventionMode })
export type SopRulesResponse = z.infer<typeof SopRulesResponse>

/**
 * `GET /api/v1/policy/resolve`: the same rules and curation as
 * `GET /api/v1/sop/rules`, as the sync daemon and the daemon-mode MCP proxy
 * cache them, plus the flags the daemon's policy snapshot carries.
 */
export const PolicyResolveResponse = McpCuration.extend({
  workspaceId: z.string(),
  sopRules: z.array(SopRuleResponse),
  interventionMode: InterventionMode,
  sqlDropStrictBlock: z.boolean().describe('`ff_sql_drop_strict_block`: the daemon\'s destructive-SQL hook rule blocks instead of warning.'),
  decideRules: z
    .array(ServedDecideRuleResponse)
    .optional()
    .describe('The `decide:` lines of the enforced SOPs and decide guardrails, with their active calibrations as pins. Empty under `INTUTIC_DECIDE=off`; absent from a control plane before 3.0.'),
})
export type PolicyResolveResponse = z.infer<typeof PolicyResolveResponse>

/** A hold rule policy resolve compiles, in the snapshot's rule shape. */
export const ServedHoldRuleResponse = z.object({
  id: z.string().describe('`sop.lane.<class>.<token>` for a closed lane, `revert.<token>` for a revert hold.'),
  source: z.string().describe('For `phrase`, the token\'s phrases joined by `|`; for `action`, a pattern over the classified action tokens.'),
  subject: z.enum(['phrase', 'action']),
  ignoreCase: z.literal(true),
  severity: z.enum(['hold', 'shadow']),
  reason: z.string(),
  rationale: z.string(),
})
export type ServedHoldRuleResponse = z.infer<typeof ServedHoldRuleResponse>

/** A `@rule` record a workspace SOP compiles to; the daemon encodes the line and its fallback. */
export const ServedGateRecordResponse = z.object({
  sopId: z.string(),
  kind: z.enum(['requires_outcome', 'scope_paths', 'plan_approval']),
  rollout: z.enum(['shadow', 'enforce']),
  fallbackId: z.string().nullable().describe('`<kind>-fallback:<n>@<sha256(sopId)[:12]>`; null for a shadow record, which has no fallback line.'),
  payload: z.object({ v: z.literal(1), ref: z.string(), sopTitle: z.string() }).passthrough().describe('The record\'s canonical JSON payload: `{v, ref, sopTitle, …kind fields}`.'),
})
export type ServedGateRecordResponse = z.infer<typeof ServedGateRecordResponse>

/** `GET /api/v1/policy/resolve`, with the 3.0 fields. */
export const PolicyResolveGatesResponse = PolicyResolveResponse.extend({
  gateRecords: z.array(ServedGateRecordResponse).describe('Qualified `requires_before`, enforced `scope_paths` and `plan_approval` of the enforced SOPs with no `roles:`.'),
  holdRules: z.array(ServedHoldRuleResponse).describe('Closed-lane holds (SOP `closed_lanes:` and the workspace `closedLanes`) and revert holds.'),
  revertHolds: z
    .array(z.object({ subject: z.string(), revertRate: z.number().nullable(), rejectionRate: z.number().nullable() }))
    .describe('Reversible-wide tokens held by `revertLane` (role \'\' only); empty when the mode is off.'),
})
export type PolicyResolveGatesResponse = z.infer<typeof PolicyResolveGatesResponse>

// ─── Plans (routes/plans.ts) ──────────────────────────────────────────

/** `GET /api/v1/plans/approved`: the plans hook gates may treat as approved. */
export const ApprovedPlansResponse = z.object({
  plans: z.array(
    z.object({
      sessionId: z.string().describe('The harness session the plan governs.'),
      planId: z.string(),
      state: z.enum(['APPROVED', 'EXECUTING']),
      tools: z.array(z.string()).describe('The tool names of the plan\'s steps, deduped case-insensitively. Compare case-insensitively.'),
      updatedAt: z.string(),
    }),
  ),
})
export type ApprovedPlansResponse = z.infer<typeof ApprovedPlansResponse>

// ─── Decisions and rule candidates (routes/decisions.ts) ─────────────

/** `POST /api/v1/decisions`: how many holds became queue entries. */
export const DecisionIngestResponse = z.object({
  accepted: z.number().int(),
  dropped: z.number().int().describe('Holds that did not validate or could not be recorded.'),
  entryIds: z.array(z.string()),
})
export type DecisionIngestResponse = z.infer<typeof DecisionIngestResponse>

/** One approved bypass as `maybeWriteReviewHoldBypass` writes it to Valkey. */
export const ApprovedBypassResponse = z.object({
  workspaceId: z.string(),
  sopRuleId: z.string(),
  toolNameNormalized: z.string(),
  targetHash: z.string(),
  holdId: z.string(),
  decidedBy: z.string(),
  decidedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
})
export type ApprovedBypassResponse = z.infer<typeof ApprovedBypassResponse>

/** `GET /api/v1/decisions/approved-bypasses`. */
export const ApprovedBypassListResponse = z.object({ ok: z.literal(true), bypasses: z.array(ApprovedBypassResponse) })
export type ApprovedBypassListResponse = z.infer<typeof ApprovedBypassListResponse>

/**
 * `GET /api/v1/decisions/:entryId`: one decision-queue entry, found by its
 * entry id or by the hold id a gate gave the agent (`hold_…`). The MCP
 * proxy's `intutic_hold_status` tool reads `status`.
 */
export const DecisionDetailResponse = z.object({
  entry_id: z.string(),
  session_id: z.string().nullable(),
  workspace_id: z.string(),
  original_tool_call: z.unknown().describe('The held tool call, as the gate reported it.'),
  hijacked_tool_call: z.unknown(),
  outcome: z.string(),
  trace_id: z.string().nullable(),
  rationale: z.string().nullable(),
  status: z.string().nullable().describe('`PENDING_REVIEW` until a person decides it; `APPROVED` or `REJECTED` after.'),
  created_at: IsoTimestamp.nullable(),
})
export type DecisionDetailResponse = z.infer<typeof DecisionDetailResponse>

/** `POST /api/v1/decisions/:entryId/review`. */
export const DecisionReviewResponse = z.object({
  ok: z.literal(true),
  status: z.enum(['APPROVED', 'REJECTED']),
  bypassWritten: z.boolean().describe('Whether the approval wrote an exact-match bypass (workspaces with `reviewHoldBypassEnabled`).'),
})
export type DecisionReviewResponse = z.infer<typeof DecisionReviewResponse>

/** `GET /api/v1/rule-candidates/:candidateId/source`: the AssemblyScript a candidate renders to. */
export const RuleCandidateSourceResponse = z.object({
  candidateId: z.string(),
  guardrailId: z.string().nullable(),
  status: z.string(),
  source: z.string(),
  sourceSha256: z.string(),
})
export type RuleCandidateSourceResponse = z.infer<typeof RuleCandidateSourceResponse>

const RuleGateResult = z.object({
  gate: z.enum(['predicate_valid', 'mocks_from_history', 'compiles_and_links', 'default_allow', 'discriminates', 'historical_replay']),
  passed: z.boolean(),
  detail: z.string(),
})

/** `POST /api/v1/rule-candidates/:candidateId/bundle`: 201 with the SHADOW rule when every gate passed, else 200 with the gates. */
export const RuleCandidateBundleResponse = z.union([
  z.object({ accepted: z.literal(true), ruleId: z.string(), mode: z.literal('SHADOW'), gates: z.array(RuleGateResult) }),
  z.object({ accepted: z.literal(false), gates: z.array(RuleGateResult) }),
])
export type RuleCandidateBundleResponse = z.infer<typeof RuleCandidateBundleResponse>

// ─── Judge (routes/judge.ts) ──────────────────────────────────────────

const CascadeBand = z.object({ lo: z.number(), hi: z.number() })

/** Stage one of the judge cascade, as a verdict reports it. */
const CascadeSummary = z.object({
  decision: z.enum(['clean', 'violation', 'review']),
  score: z.number().nullable().describe('Null when stage 1 did not answer.'),
  band: CascadeBand,
  model: z.string(),
  reviewId: z.string().optional(),
})

/** `POST /api/v1/judge/chunk`: the verdict on one streamed segment of a response. */
export const JudgeChunkResponse = z.object({
  verdict: z.enum(['TRIGGERED', 'PASS']),
  triggered: z.boolean().describe('An organization SOP was violated.'),
  personalTriggered: z.boolean().describe('A personal (local-only) SOP was violated; never persisted.'),
  explanation: z.string(),
  cascade: CascadeSummary.optional().describe('When the cascade\'s stage 1 graded the segment.'),
  independent: z.boolean().describe('False when the judge is the monitored model grading itself.'),
  judgeSource: z.literal('platform'),
  judgeModel: z.string(),
})
export type JudgeChunkResponse = z.infer<typeof JudgeChunkResponse>

/** `POST /api/v1/judge/finalize`: the final verdict on a response. */
export const JudgeFinalizeResponse = z.object({
  verdict: z.enum(['TRIGGERED', 'REVIEW', 'PASS']).describe('`REVIEW`: held for a person; no org verdict exists yet.'),
  triggered: z.boolean().describe('An organization SOP was violated.'),
  personalTriggered: z.boolean().describe('A personal (local-only) SOP was violated; never persisted.'),
  explanation: z.string().optional().describe('Only when the workspace has no active SOP.'),
  correctionSummary: z.string(),
  independent: z.boolean().describe('False when the judge is the monitored model grading itself.'),
  judgeSource: z.literal('platform'),
  judgeModel: z.string(),
  typedAdvisory: z
    .object({ violation: z.boolean(), pViolation: z.number(), threshold: z.number(), model: z.string(), independent: z.boolean() })
    .optional(),
  cascade: CascadeSummary.optional(),
  personalCascade: z.object({ decision: z.enum(['clean', 'violation', 'review']), score: z.number() }).optional(),
  deprecation: z
    .object({ code: z.literal('FREE_TEXT_VERDICT_DEPRECATED'), removedIn: z.literal('4.0'), message: z.string() })
    .optional()
    .describe('When `builtin:finalize` has no band for the workspace: the free-text verdict decided, as before 3.0. Deprecated; retired in 4.0.'),
})
export type JudgeFinalizeResponse = z.infer<typeof JudgeFinalizeResponse>

// ─── Hook events and the hook gate (routes/hookEvents.ts) ────────────

/** `POST /api/v1/hook-events`: what the batch became. */
export const HookEventsResponse = z.object({
  ok: z.literal(true),
  summary: z.object({
    total: z.number().int().describe('Events that parsed.'),
    incidents_created: z.number().int(),
    tamper_alerts: z.number().int(),
    bypass_alerts: z.number().int(),
    allowed: z.number().int(),
    flagged: z.number().int(),
    skill_flagged: z.number().int(),
    would_block: z.number().int(),
    wasm_shadow_evaluations: z.number().int(),
    detector_findings: z.number().int(),
    guardrail_evidence: z.object({
      replayed: z.boolean(),
      evaluations: z.number().int(),
      evidenceRows: z.number().int(),
      findings: z.number().int(),
      guardrailsTouched: z.number().int(),
      errors: z.number().int(),
    }),
    snapshot_issues: z.number().int(),
    guards_disabled: z.number().int(),
    rejected: z.number().int().describe('Events dropped because they did not parse.'),
    replayed: z.number().int().describe('Events skipped because their `eventId` was already processed.'),
    errors: z.number().int(),
  }),
})
export type HookEventsResponse = z.infer<typeof HookEventsResponse>

/**
 * `POST /api/v1/hook-gate`: a verdict on one tool call, each naming its
 * `decisionId`: a refusal (`allowed: false`; in an OPAQUE workspace a generic
 * `reason` and no `ruleId`), a degraded allow (a shadow workspace whose checks
 * could not run), or an allow.
 */
export const HookGateResponse = z.union([
  z.object({
    allowed: z.literal(false),
    reason: z.string(),
    incidentId: z.string().optional(),
    code: z.string().optional(),
    ruleId: z.string().optional(),
    decisionId: z.string(),
  }),
  z.object({
    allowed: z.literal(true),
    degraded: z.literal(true),
    code: z.literal('GOVERNANCE_UNAVAILABLE'),
    reason: z.string(),
    decisionId: z.string(),
  }),
  z.object({ allowed: z.literal(true), decisionId: z.string() }),
])
export type HookGateResponse = z.infer<typeof HookGateResponse>

// ─── SOP Optimizer approval mode (routes/dreamCycle.ts) ───────────────

/**
 * The SOP Optimizer's approval mode, as `dreamCycleService.ts`
 * `getDreamCycleSettings` returns it: `manual` at 0.85 for a workspace that
 * never set one.
 */
export const OptimizerSettingsResponse = z.object({
  workspaceId: z.string(),
  mode: z.enum(['manual', 'auto']).describe('`auto` lets a manually triggered optimizer run apply a STRENGTHEN proposal that reaches `autoThreshold` without review; `manual` applies nothing.'),
  autoThreshold: z.number().describe('The score (0 to 1) a proposal must reach to be auto-applied in `auto`.'),
})
export type OptimizerSettingsResponse = z.infer<typeof OptimizerSettingsResponse>

/** `GET /api/v1/dream-cycle/settings` and `PUT /api/v1/dream-cycle/settings`: the settings now in force. */
export const DreamCycleSettingsResponse = z.object({ ok: z.literal(true), settings: OptimizerSettingsResponse })
export type DreamCycleSettingsResponse = z.infer<typeof DreamCycleSettingsResponse>
