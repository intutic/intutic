/**
 * Phase 7 Intelligence Types
 *
 * Types for LLDs #45, #47, #48, #49, #50, #51
 * SSL Runtime Enforcement, Governance Output Injection,
 * Token Intelligence, Auto-Classification, Prompt Quality,
 * Harness Config & SkillOpt
 *
 * @module @intutic/shared-types/intelligence
 */

// ============================================
// LLD #50: SSL Runtime Enforcement
// ============================================

export interface SslSchedulingContext {
  workspaceId: string
  sessionId: string
  harnessType: string
  toolName?: string
  taskType?: string
}

export interface SslActivationResult {
  sopId: string
  sslGraph: SslGraphJson
}

export interface SslGraphJson {
  scheduling_layer: {
    triggers: string[]
    activation_rules: Record<string, string>
  }
  structural_layer: {
    steps: SslStep[]
  }
  logical_layer: {
    constraints: Record<string, string>
  }
}

export interface SslStep {
  index: number
  name: string
  tools: string[]
  description?: string
}

export interface SslToolCallContext {
  toolName: string
  toolArguments?: Record<string, unknown>
  callIndex?: number
}

export interface SslEnforcementResult {
  pass: boolean
  violationType?: 'OUT_OF_ORDER' | 'UNAUTHORIZED_TOOL' | 'EXTRA_STEP' | 'CONSTRAINT_BREACH'
  message?: string
  constraintKey?: string
  suggestedAction?: 'BYPASS' | 'ENHANCE' | 'HIJACK'
}

export interface SslStepState {
  currentStep: number
  completedSteps: number[]
  violations: SslViolationEntry[]
}

export interface SslViolationEntry {
  type: string
  expectedStep: number
  actualStep: number
  skippedSteps: number[]
  toolName: string
  timestamp: string
}

export interface SslComplianceReport {
  reportId: string
  sessionId: string
  sopId: string
  structuralScore: number
  logicalScore: number
  overallScore: number
  totalSteps: number
  completedSteps: number
  skippedSteps: number[]
  outOfOrderSteps: SslOutOfOrderEntry[]
  unauthorizedTools: string[]
  constraintViolations: ConstraintViolation[]
}

export interface SslOutOfOrderEntry {
  expectedStep: number
  actualStep: number
  tool: string
}

export interface ConstraintViolation {
  constraintKey: string
  constraintRule: string
  evidence: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface ConstraintEvalResult {
  pass: boolean
  failedKey?: string
  message?: string
}

export interface SslStepReport {
  stepIndex: number
  stepName: string
  expectedTools: string[]
}

// ============================================
// LLD #45: Governance Output Injection
// ============================================

export type NotificationPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO'

export type NotificationCategory =
  | 'anomaly'
  | 'budget'
  | 'ssl_violation'
  | 'decision'
  | 'incident'
  | 'corrective'
  | 'system'

export interface GovernanceNotification {
  notificationId: string
  sessionId: string
  workspaceId: string
  priority: NotificationPriority
  category: NotificationCategory
  title: string
  body: string
  correctiveCard?: CorrectivePromptCard
  actionUrl?: string
  dedupHash: string
  createdAt: string
}

export interface CorrectivePromptCard {
  cardId: string
  promptText: string
  anomalyType: string
  severity: string
}

export interface NotificationConfig {
  workspaceId: string
  inlineEnabled: boolean
  inlinePriority: NotificationPriority
  secondaryChannels: {
    slack?: { webhookUrl: string; minPriority: NotificationPriority }
    email?: { addresses: string[]; minPriority: NotificationPriority }
  }
}

// ============================================
// LLD #47: Token Intelligence
// ============================================

export interface ToolCallTokenBreakdown {
  toolName: string
  argumentTokens: number
  resultTokens: number
  totalTokens: number
}

export interface CostPrediction {
  inputTokens: number
  estimatedOutputTokens: number
  estimatedReasoningTokens: number | null
  estimatedCostUsd: number
  confidence: 'high' | 'medium' | 'low'
  basedOnSamples: number
}

export interface TokenBaseline {
  model: string
  taskType: string
  inputBucket: InputTokenBucket
  avgOutputTokens: number
  p50OutputTokens: number
  p95OutputTokens: number
  reasoningAvg: number
  sampleCount: number
}

export type InputTokenBucket = '0-1k' | '1k-5k' | '5k-20k' | '20k-50k' | '50k+'

/**
 * Maps an input token count to its bucket for baseline lookups.
 */
export function getInputBucket(inputTokens: number): InputTokenBucket {
  if (inputTokens < 1000) return '0-1k'
  if (inputTokens < 5000) return '1k-5k'
  if (inputTokens < 20000) return '5k-20k'
  if (inputTokens < 50000) return '20k-50k'
  return '50k+'
}

// ============================================
// LLD #48: Auto-Classification & Optimization
// ============================================

export type WasteCategory =
  | 'NONE'
  | 'TOKEN_WASTE'
  | 'LOOP_WASTE'
  | 'RETRY_WASTE'
  | 'CONTEXT_BLOAT'
  | 'MODEL_MISMATCH'

export interface TokenUtilityResult {
  utility: 'USEFUL' | 'WASTED' | 'AMBIGUOUS'
  score: number
  wasteCategory: WasteCategory
  confidence: number
  reason: string
}

export interface TraceClassificationContext {
  traceId: string
  workspaceId: string
  sessionId: string
  model: string
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  taskType: string
  anomalyDetected?: string
  enforcementAction: string
  toolName?: string
  toolCallMetrics?: ToolCallTokenBreakdown[]
  sslComplianceScore?: number
}

export interface WastePattern {
  patternId: string
  workspaceId: string
  wasteType: WasteCategory
  period: '24h' | '7d' | '30d'
  affectedTraces: number
  totalTokens: number
  wastedTokens: number
  wastePercentage: number
  avgTokens: number
  baselineTokens: number
  confidence: number
  details: Record<string, unknown>
  createdAt: string
  expiresAt: string
}

export type RecommendationType =
  | 'MODEL_SWITCH'
  | 'SOP_REFINE'
  | 'USER_COACHING'
  | 'CONFIG_EDIT'
  | 'CACHE_CANDIDATE'

export interface OptimizationRecommendation {
  recommendationId: string
  workspaceId: string
  patternId: string
  type: RecommendationType
  status: 'pending' | 'applied' | 'dismissed'
  title: string
  description: string
  estimatedSavingsUsd: number
  estimatedSavingsPct: number
  actionPayload: Record<string, unknown>
  appliedAt?: string
  dismissedAt?: string
  dismissReason?: string
  createdAt: string
}

export interface LlmProbeResult {
  probeId: string
  traceId: string
  verdict: 'COMPLIANT' | 'VIOLATION' | 'AMBIGUOUS'
  confidence: number
  violations: ProbeViolation[]
  reasoning: string
}

export interface ProbeViolation {
  constraint: string
  evidence: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
}

// ============================================
// LLD #49: Prompt Quality & Slash Commands
// ============================================

export interface PromptQualityScore {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  dimensions: {
    clarity: number
    specificity: number
    actionability: number
    contextCompleteness: number
  }
  suggestions: string[]
}

export interface PromptQualityContext {
  model: string
  inputTokens: number
  activeSOPs: string[]
  harnessType: string
}

export interface ContextGap {
  gapType: 'SOP_UNLINKED' | 'SOP_TRIGGER_MATCH' | 'CONFIG_RULE_RELEVANT'
  description: string
  sopId?: string
  sopTitle?: string
  actionUrl?: string
}

export interface DedupHint {
  priorTraceId: string
  priorDate: string
  similarity: number
}

export interface SlashCommandRequest {
  sessionId: string
  workspaceId: string
  command: string
  args: string[]
  messageContext?: string | null
}

export interface SlashCommandResponse {
  responseText: string
  metadata?: Record<string, unknown>
}

// ============================================
// LLD #51: Harness Config & SkillOpt
// ============================================

export interface HarnessConfigSnapshot {
  snapshotId: string
  workspaceId: string
  harnessType: string
  filePath: string
  content: string
  contentHash: string
  previousHash?: string
  changeSource: 'daemon' | 'manual' | 'skillopt'
  diffSummary?: { added: number; removed: number; changed: number }
  capturedAt: string
}

export interface ConfigEdit {
  operation: 'ADD' | 'DELETE' | 'REPLACE'
  section: string
  target?: string
  content?: string
  reason: string
}

export interface ConfigEditWithTarget extends ConfigEdit {
  harnessType: string
  filePath: string
}

export interface SkillOptSuggestion {
  suggestionId: string
  workspaceId: string
  harnessType: string
  filePath: string
  status: 'pending' | 'applied' | 'dismissed'
  source: 'waste_pattern' | 'metaclaw' | 'manual_review'
  edits: ConfigEdit[]
  rationale: string
  confidence: number
  wastePatternId?: string
  sopAmendmentId?: string
  appliedAt?: string
  dismissedAt?: string
  dismissReason?: string
  createdAt: string
}

export interface ConfigCapturePayload {
  workspaceId: string
  harnessType: string
  filePath: string
  content: string
  capturedAt: string
}
