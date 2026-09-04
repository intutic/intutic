/**
 * Wire types for the Policy Clause Ledger (LLD #71): what
 * `/api/v1/policy-guardrails/*` returns, as the control plane, the dashboard
 * page and `intutic guardrails` all read it. The control plane's service
 * imports these rather than declaring its own, so a field cannot drift
 * between the three.
 *
 * camelCase throughout: the routes select through Drizzle column maps, and
 * that is the casing they emit.
 */

import type { GuardrailIr } from './guardrailIr.js'

export const GUARDRAIL_STATUSES = ['PROPOSED', 'SHADOW', 'ENFORCING', 'REJECTED', 'RETIRED'] as const
/**
 * Statuses in which a guardrail's citation is live — the ones conflicts are
 * reported for and the ones that keep the cited document from being written
 * back over (LLD #71, Wave 8). A rejected proposal does not freeze a source.
 */
export const LIVE_GUARDRAIL_STATUSES = ['PROPOSED', 'SHADOW', 'ENFORCING'] as const

/**
 * A projected front-matter guardrail is served to the proxy as a SOP titled
 * `GUARDRAIL:<pgr> <first line>` (Wave 5). On disk, where the proxy titles a
 * SOP by its file stem, the same guardrail is `guardrail-<pgr>.md` (Wave 9):
 * no colon or space, so the name is legal on every platform, and the stem
 * still names the guardrail so its shadow reports are credited.
 */
export const GUARDRAIL_SOP_TITLE_PREFIX = 'GUARDRAIL:'

/** The file `intutic guardrails pull` writes for a guardrail, without the `.md`. */
export function guardrailFileStem(guardrailId: string): string {
  return `guardrail-${guardrailId}`
}

/**
 * `GUARDRAIL:pgr_x deny_tools: WebFetch` → `pgr_x`; `guardrail-pgr_x` (a pulled
 * file's stem, what a disk-loaded proxy reports as the title) → `pgr_x`;
 * anything else → null.
 */
export function guardrailIdFromSopTitle(title: string): string | null {
  const served = title.match(/^GUARDRAIL:([A-Za-z0-9_-]{4,64})(?:\s|$)/)
  if (served) return served[1]!
  const stem = title.match(/^guardrail-([A-Za-z0-9_-]{4,64})$/)
  return stem ? stem[1]! : null
}
export type GuardrailStatus = (typeof GUARDRAIL_STATUSES)[number]

export const GUARDRAIL_TARGETS = ['hook_rule', 'sop_front_matter', 'wasm_rule'] as const
export type GuardrailTarget = (typeof GUARDRAIL_TARGETS)[number]

export const GUARDRAIL_EVENT_TYPES = [
  'PROPOSED',
  'SHADOW_APPROVED',
  'PROMOTED',
  'REJECTED',
  'RETIRED',
  'SOURCE_STALE',
  'SOURCE_RECONFIRMED',
  'CITATION_REBOUND',
] as const
export type GuardrailEventType = (typeof GUARDRAIL_EVENT_TYPES)[number]

/** The one promotion rule (LLD #71 decision 7), as `GET …/thresholds` reports it. */
export interface GuardrailThresholds {
  minShadowEvaluations: number
  maxWouldActRate: number
  minAdjudicatedFires: number
  maxAdjudicatedFalsePositiveRate: number
}

export interface GuardrailThresholdsResponse {
  guardrail: GuardrailThresholds
  wasm: { minShadowEvaluations: number; maxFalsePositiveRate: number }
  extraction: { dailyCap: number }
}

export interface GuardrailClauseRef {
  clauseId: string
  quote: string
  quoteOffset: number
  passageHash: string
  passageId: string | null
  extractor: string
}

export interface GuardrailDocumentRef {
  docId: string
  title: string
  provider: string
  sourceUrl: string | null
}

export interface GuardrailSummary {
  guardrailId: string
  target: GuardrailTarget
  status: GuardrailStatus
  ir: GuardrailIr
  /** hook_rule: {toolPattern, argPattern?, reason}; sop_front_matter: {lines}; wasm_rule: {source}. */
  rendered: unknown
  roles: string[]
  scope: string
  shadowEvaluations: number
  shadowWouldAct: number
  enforcingFires: number
  sourceStale: boolean
  /** wasm_rule only: the rule candidate this guardrail was handed to on shadow approval (LLD #71, Wave 7). */
  ruleCandidateId: string | null
  proposedAt: string
  shadowAt: string | null
  promotedAt: string | null
  rejectedReason: string | null
  clause: GuardrailClauseRef
  document: GuardrailDocumentRef
}

export interface GuardrailEvent {
  eventId: string
  event: GuardrailEventType
  actorId: string | null
  detail: unknown
  createdAt: string
}

export interface GuardrailPassageRef {
  passageId: string
  text: string
  headingPath: string[]
  retired: boolean
}

export interface GuardrailDetail extends GuardrailSummary {
  /** [{name, passed, detail}] in the order the checks ran. */
  validation: unknown
  passage: GuardrailPassageRef | null
  events: GuardrailEvent[]
}

export interface GuardrailListFilters {
  status?: GuardrailStatus
  target?: GuardrailTarget
  docId?: string
  limit?: number
}

export interface GuardrailReadiness {
  ready: boolean
  /** Every unmet condition, in the rule's order; empty when ready. */
  reasons: string[]
  /** The rule never fired in shadow: promotable only with the caller's explicit acknowledgement. */
  neverFired: boolean
  evaluations: number
  wouldAct: number
  wouldActRate: number | null
  adjudicated: number
  adjudicatedRequired: number
  falsePositives: number
  falsePositiveRate: number | null
  thresholds: GuardrailThresholds
}

export interface GuardrailReplay {
  source: 'enforcement_log' | 'context_snapshots'
  windowDays: number
  captured: number
  fires: number
  sample: Array<{ toolName: string; at: string; excerpt: string }>
  truncated: boolean
  /** Keys this replay cannot answer for (`review_before` holds rather than acts). */
  unsupported: string[]
}

export type GuardrailConflictKind = 'deny_vs_count' | 'require_vs_forbid' | 'count_limits_differ' | 'hook_contains_vs_not_contains'

export interface GuardrailConflict {
  kind: GuardrailConflictKind
  token: string | null
  a: { id: string; quote: string }
  b: { id: string; quote: string }
  detail: string
}

export interface PolicyExtractionRunRef {
  runId: string
  extractor: string
  startedAt: string
  finishedAt: string | null
  error: string | null
}

export interface PolicyDocumentSummary {
  docId: string
  title: string
  provider: string
  sourceUrl: string | null
  status: string
  injectionFlagged: boolean
  sopId: string | null
  fetchedAt: string
  passageCount: number
  clauseCount: number
  guardrailCount: number
  lastRun: PolicyExtractionRunRef | null
}

export interface PolicyPassageRow {
  passageId: string
  ordinal: number
  headingPath: string[]
  text: string
  passageHash: string
  anchor: unknown
  tokenIndex: string[]
}

export interface PolicyClauseRow {
  clauseId: string
  passageId: string | null
  passageHash: string
  quote: string
  ir: unknown
  kind: string
  status: string
  extractor: string
  validation: unknown
  guardrailId: string | null
  guardrailStatus: string | null
}

export interface PolicyExtractionRunRow extends PolicyExtractionRunRef {
  clausesProposed: number
  clausesValid: number
  clausesRejected: number
}

export interface PolicyDocumentDetail extends PolicyDocumentSummary {
  contentHash: string
  upstreamVersion: string | null
  passages: PolicyPassageRow[]
  clauses: PolicyClauseRow[]
  runs: PolicyExtractionRunRow[]
}

export interface ExtractDocumentResult {
  docId: string
  runId: string | null
  extractor: string
  skipped: 'no_passages' | 'daily_cap' | 'cap_unavailable' | 'llm_disabled' | null
  cap: { count: number; cap: number } | null
  llmUnavailable: boolean
  chunks: number
  proposals: number
  verbatimQuotes: number
  valid: number
  rejected: number
  malformed: number
  guardrails: { proposed: number; rejectedForInjection: number; existing: number }
  lifted: { clauses: number; valid: number; errors: string[] }
  error: string | null
}

export interface TokenCoverage {
  token: string
  passages: Array<{ passageId: string; docId: string; title: string; sourceUrl: string | null; headingPath: string[]; excerpt: string }>
  guardrails: Array<{ guardrailId: string; clauseId: string; passageId: string | null; status: string; target: string; quote: string }>
}

export interface LedgerGraph {
  documents: Array<{ docId: string; title: string; provider: string; sourceUrl: string | null; status: string; passageCount: number; clauseCount: number }>
  clauses: Array<{ clauseId: string; docId: string; passageId: string | null; kind: string; status: string; extractor: string; quote: string }>
  guardrails: Array<{ guardrailId: string; clauseId: string; status: string; target: string }>
  edges: Array<{ from: string; to: string; type: 'CONTAINS' | 'COMPILES_TO' | 'OVERLAPS' | 'SUPERSEDES'; evidence?: unknown }>
  truncated: boolean
}

/** A candidate's evidence entry that carries a citation (policy-derived WASM candidates, Wave 7). */
export interface CandidateCitationEvidence {
  citation: {
    guardrailId: string
    quote: string
    sourceUrl: string | null
    passageHash: string
    documentTitle: string
  }
}

export function isCandidateCitationEvidence(value: unknown): value is CandidateCitationEvidence {
  if (!value || typeof value !== 'object') return false
  const c = (value as { citation?: unknown }).citation
  return !!c && typeof c === 'object' && typeof (c as { quote?: unknown }).quote === 'string' && typeof (c as { guardrailId?: unknown }).guardrailId === 'string'
}
