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
  ExecutionMode,
  IncidentStatus,
  PlanLifecycleState,
  SopLifecycleState,
  SopType,
  HookPhase,
  RoutingTier,
  WorkspaceRole,
  // WS-5 — MCP proxy governance settings
  McpProxyFailBehavior,
  McpProxyMode,
  BypassEnforcementTier,
} from './enums.js'

export {
  DEFAULT_WORKSPACE_SETTINGS,
  resolveWorkspaceSettings,
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
} from './sop.js'


export {
  VALID_SOP_TRANSITIONS,
  ENFORCEMENT_BY_STATE,
} from './sop.js'

export {
  IntuticError,
  E_NOT_FOUND,
  E_CACHE_UNAVAILABLE,
  E_UNAUTHORIZED,
  E_FORBIDDEN,
  E_BUDGET_EXCEEDED,
  E_RATE_LIMITED,
  E_APPEND_ONLY_VIOLATION,
  E_APPROVAL_RATIONALE_REQUIRED,
  E_VALIDATION_FAILED,
  // Identity Federation (LLD #11)
  E_SSO_DISABLED,
  E_SSO_NO_MEMBERSHIP,
  E_OIDC_INVALID_STATE,
  E_OIDC_TOKEN_EXCHANGE_FAILED,
  E_OIDC_CLAIMS_MISSING,
  E_PROVIDER_DISABLED,
  E_PROVIDER_IN_USE,
  E_FEATURE_NOT_AVAILABLE,
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
} from './identity.js'

export type {
  User,
  UserInfo,
  SsoProvider,
  CreateSsoProviderInput,
  OidcClaims,
  UpdateUserProfileInput,
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
  TokenUtilityResult,
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
  type WasteCategory,
  type RecommendationType,
} from './intelligence.js'

// LLD #45-slack: Notification Hub + Slack Adapter
export * from './notifications.js'

// Restored Stripe billing & subscription types
export * from './billing.js'

// Restored task management and alerting adapter types
export * from './taskManagement.js'




