/**
 * Responses of the control plane routes in policies.ts, wasmRules.ts, sops.ts, decisions.ts, judge.ts and hookEvents.ts.
 *
 * @module
 */
import { z } from 'zod'
import { ChangeClassification, ComplexityTier, RiskLevel, SopLifecycleState } from '../enums.js'
import { PII_ACTIONS, PII_DETECTOR_IDS } from '../piiDetectors.js'
import { DeletedResponse, IsoTimestamp, listEnvelope } from './common.js'

const InterventionMode = z.enum(['TRANSPARENT', 'OPAQUE', 'SILENT_LOG'])

// ─── Enforcement policies (routes/policies.ts, deprecated) ────────────

/** A `pcas_policies` row as the routes select it. */
export const PolicyResponse = z.object({
  policyId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  riskCategory: z.enum(['NONE', 'DESTRUCTIVE', 'CREDENTIAL_ACCESS']).nullable(),
  targetToolPattern: z.string(),
  /** `OBSERVED` is never written by these routes, but a row may carry it. */
  enforcementAction: z.enum(['BYPASS', 'ENHANCE', 'HIJACK', 'REASK', 'KILL', 'OBSERVED']),
  interventionMode: InterventionMode.nullable(),
  priority: z.number().int().nullable(),
  conditions: z.unknown().describe('The policy conditions: a JSON object, or null.'),
  isActive: z.boolean().nullable(),
  currentVersion: z.number().int(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  deletedAt: IsoTimestamp.nullable(),
})
export type PolicyResponse = z.infer<typeof PolicyResponse>

/** `GET /api/v1/policies`: the live policies, newest first, and where the workspace's intervention mode comes from. */
export const PolicyListResponse = z.object({
  ok: z.literal(true),
  policies: z.array(PolicyResponse),
  interventionMode: z.object({
    mode: InterventionMode,
    source: z.enum(['setting', 'policy', 'default']).describe('The `interventionMode` setting, the lowest-priority active policy (deprecated fallback), or the default.'),
    policyId: z.string().nullable().describe('The policy whose mode applies, when `source` is `policy`.'),
  }),
})
export type PolicyListResponse = z.infer<typeof PolicyListResponse>

/** `POST /api/v1/policies`: the created policy. */
export const PolicyCreatedResponse = z.object({ ok: z.literal(true), policy: PolicyResponse })
export type PolicyCreatedResponse = z.infer<typeof PolicyCreatedResponse>

/** `PUT /api/v1/policies/:policyId`: the policy as updated, and its new version. */
export const PolicyUpdatedResponse = z.object({ ok: z.literal(true), policy: PolicyResponse, currentVersion: z.number().int() })
export type PolicyUpdatedResponse = z.infer<typeof PolicyUpdatedResponse>

/** `DELETE /api/v1/policies/:policyId`: soft-deleted. */
export const PolicyDeletedResponse = z.object({ ok: z.literal(true) })
export type PolicyDeletedResponse = z.infer<typeof PolicyDeletedResponse>

/** Enable, disable or roll back a policy: the version the change recorded. */
export const PolicyVersionResponse = z.object({ ok: z.literal(true), currentVersion: z.number().int() })
export type PolicyVersionResponse = z.infer<typeof PolicyVersionResponse>

/** The hook rule a converted policy became (`lib/policyConversion.ts`). */
const ConvertedHookRule = z.object({
  kind: z.literal('hook_rule'),
  title: z.string(),
  tools: z.array(z.string()),
  argContains: z.array(z.string()).optional(),
  argNotContains: z.array(z.string()).optional(),
})

/**
 * `POST /api/v1/policies/:policyId/convert-to-guardrail`: the guardrail made
 * from the policy (201, or 200 when a concurrent conversion made it first),
 * or the one an earlier conversion made (200, without `ir`).
 */
export const PolicyGuardrailConversionResponse = z.union([
  z.object({
    ok: z.literal(true),
    created: z.boolean(),
    guardrailId: z.string(),
    status: z.literal('SHADOW'),
    ir: ConvertedHookRule,
  }),
  z.object({
    ok: z.literal(true),
    created: z.literal(false),
    guardrailId: z.string(),
    status: z.string().describe('The existing guardrail\'s status.'),
  }),
])
export type PolicyGuardrailConversionResponse = z.infer<typeof PolicyGuardrailConversionResponse>

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
  verdictCounts: z.record(z.number().int()).describe('Verdict code (0 allow, 1 block, 3 reask; 2 deprecated) → contexts that produced it.'),
  sampleMatches: z.array(z.record(z.unknown())).describe('Up to 20 contexts the rule acted on.'),
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

/** `POST /api/v1/sops`: the created SOP; its tiers are the ones the request named. */
export const SopCreatedResponse = SopResponse.extend({
  riskTier: z.nativeEnum(RiskLevel),
  complexityTier: z.nativeEnum(ComplexityTier),
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
  toolDescriptionOverrides: z.record(z.string()),
  allowedServers: z.array(z.string()).describe('Empty means unrestricted.'),
  mcpInjectionPatterns: z.array(z.string()),
  mcpRegistry: z.object({
    defaultPolicy: z.enum(['allow', 'deny']),
    approvedServers: z.array(z.string()),
    blockedServers: z.array(z.string()),
    heldServers: z.array(z.string()),
    disabledTools: z.record(z.array(z.string())).describe('Server name → tools disabled within it.'),
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
  mcpAnomalyOverrides: z.record(z.enum(['steer', 'reask', 'kill', 'off'])).optional(),
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
})
export type PolicyResolveResponse = z.infer<typeof PolicyResolveResponse>

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
