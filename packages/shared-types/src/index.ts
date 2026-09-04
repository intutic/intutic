/**
 * @intutic/shared-types — Shared TypeScript types, interfaces, and enums
 *
 * This package is the single source of truth for all types used by 2+ packages
 * in the Intutic monorepo. Never duplicate type definitions across services.
 *
 * @packageDocumentation
 */

export {
  RiskLevel,
  EnforcementAction,
  TokenUtility,
  BudgetTier,
  ComplexityTier,
  ChangeClassification,
  AnomalyType,
  HarnessType,
  HARNESS_COUNT,
  HARNESS_HEADLINE_COUNT,
  ExecutionMode,
  IncidentStatus,
  PlanLifecycleState,
  PlanExecutionOutcome,
  SopLifecycleState,
  SopType,
  HookPhase,
  RoutingTier,
  WorkspaceRole,
  // WS-5 — MCP proxy governance settings
  McpProxyFailBehavior,
  McpProxyMode,
  BypassEnforcementTier,
  // Migration 163 — sop_amendments producer discriminator
  AmendmentSource,
} from './enums.js'

export {
  DEFAULT_WORKSPACE_SETTINGS,
  resolveWorkspaceSettings,
  resolveSecurityProbeSampleRate,
} from './workspaceSettings.js'

export type {
  WorkspaceSettings,
  McpProxyFailBehavior as McpProxyFailBehaviorType,
  McpProxyMode as McpProxyModeType,
  BypassEnforcementTier as BypassEnforcementTierType,
} from './workspaceSettings.js'

export type {
  PermissionSet,
  PolicyVerdict,
  DctToken,
  RiskCategory,
  InterventionMode,
  PluginVerdict,
  EvaluationCascadeResult,
} from './policy.js'

export type {
  TraceEntry,
  CostBreakdown,
  Attribution4D,
  TraceSummary,
  TraceListResult,
  TraceDetail,
  TraceFilters,
  TraceStep,
  TraceFindingSummary,
  ChangeManifestEntry,
} from './finops.js'


export {
  ANOMALY_SEVERITY_MAP,
} from './anomaly.js'

export type {
  AnomalyEvent,
  AnomalyClassification,
  AnomalySeverity,
  CorrectivePromptCard,
  ProbeType,
  ProbeResult,
  TrustScoreResult,
  TrustScoreUpdate,
  TrustEvent,
  GovernanceIncidentStatus,
  CapabilityMissEvent,
  CapabilityMissInput,
  DriftDirection,
  DriftEvent,
} from './anomaly.js'

export type {
  Session,
  SessionCheckpoint,
} from './session.js'

export type {
  Sop,
  SopProofTree,
  SopLifecycleTransition,
  SopHealthMetrics,
  DreamCycleQueueItem,
  DreamCycleEnqueueInput,
  GodelProbeResult,
  SopContentUpdate,
  SopLifecycleTransitionResult,
  CascadeImpactResult,
  CascadeInvalidationResult,
  AntiGamingResult,
  SopEdgeType,
  SopGraphEdge,
  DeviationType,
  PlanDeviation,
  PlanAdherenceScore,
  StoredPlan,
  DecisionRecommendation,
  DecisionMiningAnalysis,
  GodelGateResult,
  GodelScore,
  ProofTreeDiff,
  SopSummary,
  SopListResult,
  SopFilters,
  DecisionEntry,
  DecisionListResult,
  SopProvenance,
  SopProvenanceSource,
} from './sop.js'

export { SOURCE_PROVIDERS, DOCUMENT_PROVIDERS, PRIVILEGED_SOURCE_PROVIDERS, isSourceProvider, isDocumentProvider } from './sourceProviders.js'
export type { SourceProvider, DocumentProvider } from './sourceProviders.js'

export {
  ACTION_TOKENS,
  isActionToken,
  TOOL_TOKEN_RE,
  GuardrailIrSchema,
  IR_KINDS,
  FRONT_MATTER_KINDS,
  isFrontMatterIr,
  validateGuardrailIr,
  canonicalizeIr,
  irTokens,
  MAX_HOOK_TOOLS,
  MAX_LIST_TOKENS,
  MAX_LITERALS,
  MAX_LITERAL_CHARS,
  MAX_ROLES,
  MAX_TITLE_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_CALLS_LIMIT,
} from './guardrailIr.js'
export type {
  ActionToken,
  GuardrailIr,
  HookRuleIr,
  WasmPredicateIr,
  FrontMatterIr,
  IrKind,
  IrValidation,
} from './guardrailIr.js'

export {
  escapeRegexLiteral,
  renderToolPattern,
  renderArgPattern,
  scrubReason,
  renderHookReason,
  renderHookRule,
  renderFrontMatterLines,
  splitFrontMatter,
  parseFrontMatterEnforcing,
  isEnforceableFrontMatter,
  frontMatterToIrs,
  frontMatterIrsOf,
  MAX_REASON_CHARS,
  MAX_QUOTE_IN_REASON,
  renderGuardrailSopFile,
} from './guardrailRender.js'
export type { HookRuleCitation, RenderedHookRule, ParsedFrontMatter, GuardrailSopFileInput } from './guardrailRender.js'

export {
  GUARDRAIL_STATUSES,
  LIVE_GUARDRAIL_STATUSES,
  GUARDRAIL_SOP_TITLE_PREFIX,
  guardrailFileStem,
  guardrailIdFromSopTitle,
  GUARDRAIL_TARGETS,
  GUARDRAIL_EVENT_TYPES,
  isCandidateCitationEvidence,
} from './policyGuardrails.js'
export type {
  GuardrailStatus,
  GuardrailTarget,
  GuardrailEventType,
  GuardrailThresholds,
  GuardrailThresholdsResponse,
  GuardrailClauseRef,
  GuardrailDocumentRef,
  GuardrailSummary,
  GuardrailEvent,
  GuardrailPassageRef,
  GuardrailDetail,
  GuardrailListFilters,
  GuardrailReadiness,
  GuardrailReplay,
  GuardrailConflictKind,
  GuardrailConflict,
  PolicyExtractionRunRef,
  PolicyDocumentSummary,
  PolicyPassageRow,
  PolicyClauseRow,
  PolicyExtractionRunRow,
  PolicyDocumentDetail,
  ExtractDocumentResult,
  TokenCoverage,
  LedgerGraph,
  CandidateCitationEvidence,
} from './policyGuardrails.js'


export {
  VALID_SOP_TRANSITIONS,
  ENFORCEMENT_BY_STATE,
  VALID_PLAN_TRANSITIONS,
} from './sop.js'

export {
  IntuticError,
  E_NOT_FOUND,
  E_CACHE_UNAVAILABLE,
  E_UNAUTHORIZED,
  E_OFFBOARDING_IN_PROGRESS,
  E_SCIM_DUPLICATE,
  E_SCIM_AUTH_FAILED,
  E_FORBIDDEN,
  E_BUDGET_EXCEEDED,
  E_RATE_LIMITED,
  E_APPEND_ONLY_VIOLATION,
  E_APPROVAL_RATIONALE_REQUIRED,
  E_VALIDATION_FAILED,
  E_SIGNUP_DISABLED,
  E_DOMAIN_NOT_VERIFIED,
  // Identity Federation (LLD #11)
  E_SSO_DISABLED,
  E_SSO_NO_MEMBERSHIP,
  E_OIDC_INVALID_STATE,
  E_OIDC_TOKEN_EXCHANGE_FAILED,
  E_OIDC_CLAIMS_MISSING,
  E_PROVIDER_DISABLED,
  E_PROVIDER_IN_USE,
  E_FEATURE_NOT_AVAILABLE,
  E_SSL_NOT_ENFORCED,
  isIntuticError,
} from './errors.js'
export type { IntuticErrorCode } from './errors.js'

export {
  CreateSessionSchema,
  CreateTraceSchema,
  PolicyVerdictSchema,
} from './api-contracts.js'
export type {
  CreateSessionInput,
  CreateTraceInput,
  PolicyVerdictInput,
  ReviewBudget,
  ListMeta,
  IncidentRow,
  TrajectoryAlertRow,
  AnomalyRow,
} from './api-contracts.js'

export {
  LoginInputSchema,
  RegisterInputSchema,
  RefreshInputSchema,
  ChangePasswordInputSchema,
  InviteMemberInputSchema,
  UpdateRoleInputSchema,
  CreateApiKeyInputSchema,
  SignupInputSchema,
  OrgSignupInputSchema,
  VerifyEmailInputSchema,
  ResendVerificationInputSchema,
  MagicLinkRequestInputSchema,
  MagicLinkLoginInputSchema,
} from './auth.js'

export type {
  AuthContext,
  JwtPayload,
  LoginInput,
  LoginResult,
  RegisterInput,
  RegisterResult,
  RefreshResult,
  WorkspaceMemberInfo,
  InviteMemberInput,
  CreateApiKeyInput,
  CreateApiKeyResult,
  ApiKeyInfo,
  DashboardSummary,
  SignupParams,
  SignupResult,
  OrgSignupParams,
  OrgSignupResult,
  MagicLinkRequestInput,
  MagicLinkLoginInput,
} from './auth.js'

export {
  SopHashReportSchema,
  DaemonStatusSchema,
  BatchConfigCapturePayloadSchema,
} from './sync.js'

export type {
  SyncSopEntry,
  SyncConfigPayload,
  SopFileHash,
  SopHashReport,
  DetectedHarness,
  DaemonStatus,
  IntuticCredentials,
  IntuticConfig,
  IntegrityStore,
  CapturedConfigFile,
  BatchConfigCapturePayload,
  ConfigDiff,
} from './sync.js'

export {
  CreateSsoProviderSchema,
  UpdateUserProfileSchema,
  CreateScimTokenSchema,
} from './identity.js'

export type {
  User,
  UserInfo,
  SsoProvider,
  CreateSsoProviderInput,
  OidcClaims,
  UpdateUserProfileInput,
  // SCIM 2.0 (RFC 7643/7644) and the offboarding cascade it drives.
  ScimUserResource,
  ScimListResponse,
  ScimPatchOp,
  ScimTokenInfo,
  CreateScimTokenInput,
  OffboardingStepResult,
  OffboardingResult,
} from './identity.js'

// Usage
export type {
  UsageSummary,
  UsageEvent,
  ModelBreakdown,
} from './usage.js'

// WS2: Advanced Observability
export {
  PromptEstimateInputSchema,
} from './observability.js'

export type {
  PromptEstimateInput,
  PromptEstimateResult,
  CostHistoryEntry,
  CostHistoryResult,
  DriftReportResult,
  TraceDagNode,
  TraceDagResult,
} from './observability.js'

// WS4: Enterprise Identity & Compliance (LLD #19)
export {
  IssueOboTokenInputSchema,
  AttenuateTokenInputSchema,
} from './attenuation.js'

export type {
  OboTokenGrant,
  AttenuationResult,
  AttenuationChainLink,
  IssueOboTokenInput,
  AttenuateTokenInput,
  SsoGroupClearance,
  SsoGroupPolicy,
} from './attenuation.js'

// WS4 + WS5 new error codes
export {
  E_ATTENUATION_CAP_VIOLATION,
  E_OVERAGE_HARD_CAP_EXCEEDED,
} from './errors.js'

// Phase 7: Intelligence Engine types (LLDs #45, #47, #48, #49, #50, #51)
export type {
  // LLD #50 — SSL Runtime Enforcement
  SslSchedulingContext,
  SslActivationResult,
  SslGraphJson,
  SslStep,
  SslToolCallContext,
  SslEnforcementResult,
  SslStepState,
  SslViolationEntry,
  SslComplianceReport,
  SslOutOfOrderEntry,
  ConstraintViolation,
  ConstraintEvalResult,
  SslStepReport,
  // LLD #45 — Governance Output Injection
  GovernanceNotification,
  NotificationConfig,
  // LLD #47 — Token Intelligence
  ToolCallTokenBreakdown,
  CostPrediction,
  TokenBaseline,
  // LLD #48 — Auto-Classification & Optimization
  TraceClassificationContext,
  WastePattern,
  OptimizationRecommendation,
  LlmProbeResult,
  ProbeViolation,
  // LLD #49 — Prompt Quality & Slash Commands
  PromptQualityScore,
  PromptQualityContext,
  ContextGap,
  DedupHint,
  SlashCommandRequest,
  SlashCommandResponse,
  // LLD #51 — Harness Config & SkillOpt
  HarnessConfigSnapshot,
  ConfigEdit,
  ConfigEditWithTarget,
  SkillOptSuggestion,
  ConfigCapturePayload,
} from './intelligence.js'

export {
  // LLD #45
  type NotificationPriority,
  type NotificationCategory,
  // LLD #47
  type InputTokenBucket,
  getInputBucket,
  // LLD #48
  type WasteType,
  type RecommendationType,
} from './intelligence.js'

// LLD #45-slack: Notification Hub + Slack Adapter
export * from './notifications.js'

// Restored Stripe billing & subscription types
export * from './billing.js'

// Restored task management and alerting adapter types
export * from './taskManagement.js'

// LLD #67: multi-provider credential registry
export * from './providers.js'

// LLD #70: model catalog & cohort wizard
export * from './modelCatalog.js'
export * from './providerVerification.js'




export {
  WASM_HOST_IMPORTS,
  unsupportedWasmImports,
  explainWasmImport,
  type WasmHostImport,
} from './wasmHost.js'

export {
  FIELDS as RULE_DSL_FIELDS,
  OPERATORS as RULE_DSL_OPERATORS,
  RENDERABLE_VERDICTS,
  PredicateError,
  validatePredicate,
  renderRule,
  type Predicate,
  type Condition,
  type Operator,
  type FieldKind,
} from './rulePredicateDsl.js'

export { evaluatePredicate, compilePredicate, predicateStringValues } from './rulePredicateEval.js'

export {
  TOON_THRESHOLD_ROWS,
  TOON_MAX_CELL_CHARS,
  TOON_MAGIC,
  extractColumns,
  serializeCell,
  toonEncode,
  toonDecode,
  shouldToon,
  toonEncodeToolResult,
  toonDecodeToolResult,
} from './toon.js'

export {
  SECURITY_POSTURES,
  COST_POSTURES,
  findPosture,
  type PosturePreset,
  type PostureKind,
  type PreImageEntry,
} from './posturePresets.js'

export {
  SECRET_VALUE_PATTERNS,
  secretPatternAlternation,
  type SecretValuePattern,
} from './secretPatterns.js'

export {
  SKILL_SCAN_PATTERNS,
  scanSkillContent,
  excerptFor,
  EXCERPT_RADIUS,
  type SkillScanCategory,
  type SkillScanEngine,
  type SkillScanPattern,
  type SkillScanFinding,
  type SkillScanResult,
} from './skillScan.js'

export {
  SCRIPT_SCAN_PATTERNS,
  scanScriptContent,
  detectScriptLanguage,
  MAX_SKILL_DIR_DEPTH,
  MAX_FILES_PER_SKILL,
  MAX_SCRIPT_SCAN_BYTES,
  type ScriptLanguage,
  type ScriptScanPattern,
  type ScriptScanFinding,
  type ScriptScanResult,
} from './scriptScan.js'

export {
  deriveEnforcementInputs,
  type EnforcementFacets,
  type GovernanceCoverageInputs,
} from './governanceCoverage.js'
