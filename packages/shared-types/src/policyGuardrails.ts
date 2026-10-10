/**
 * Wire types for the Policy Clause Ledger: what
 * `/api/v1/policy-guardrails/*` returns, as the control plane, the dashboard
 * page and `intutic guardrails` all read it. The control plane's service
 * imports these rather than declaring its own, so a field cannot drift
 * between the three.
 *
 * camelCase throughout: the routes select through Drizzle column maps, and
 * that is the casing they emit.
 */

import { z } from 'zod'
import { MAX_RATIONALE_CHARS, MAX_TITLE_CHARS, type GuardrailIr } from './guardrailIr.js'

export const GUARDRAIL_STATUSES = ['PROPOSED', 'SHADOW', 'ENFORCING', 'REJECTED', 'RETIRED'] as const
/**
 * Statuses in which a guardrail's citation is live — the ones conflicts are
 * reported for and the ones that keep the cited document from being written
 * back over. A rejected proposal does not freeze a source.
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

/**
 * `workspace_setting` is the one target no rule endpoint
 * projects: an `allowed_models` or `egress_allow` guardrail is written into
 * the workspace setting the proxy already enforces when a member promotes it,
 * and unwound when it is retired.
 */
export const GUARDRAIL_TARGETS = ['hook_rule', 'sop_front_matter', 'wasm_rule', 'workspace_setting'] as const
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
  /** The stored render was recomputed by the current renderer; shadow evidence gathered under the old render was reset. */
  'RENDER_REBOUND',
  /** An authored guardrail's name or description changed in place; what it enforces did not. */
  'UPDATED',
] as const
export type GuardrailEventType = (typeof GUARDRAIL_EVENT_TYPES)[number]

/**
 * Where a guardrail came from.
 *
 * - `extracted`: compiled from a cited clause of a policy document. It stands
 *   on a passage, carries the quote, and goes stale when the passage changes.
 * - `authored`: written directly by an OWNER or ADMIN (API, CLI, Terraform or
 *   the dashboard). It has a name and an optional description instead of a
 *   citation, and is held to the same IR and the same validator — minus the
 *   checks that ground a model's proposal in the passage it was shown, which
 *   have nothing to read.
 *
 * Both start PROPOSED and move through the same transitions on the same
 * evidence.
 */
export const GUARDRAIL_PROVENANCES = ['extracted', 'authored'] as const
export type GuardrailProvenance = (typeof GUARDRAIL_PROVENANCES)[number]

/** An authored guardrail's name is a one-line label: it titles the projected SOP and the review card. */
export const AUTHORED_NAME_MAX_CHARS = MAX_TITLE_CHARS
/** The description stands where an extracted guardrail's quote stands — in a hook rule's block message, among others — so it has the quote's ceiling. */
export const AUTHORED_DESCRIPTION_MAX_CHARS = MAX_RATIONALE_CHARS

const AuthoredName = z
  .string()
  .min(1)
  .max(AUTHORED_NAME_MAX_CHARS)
  .refine((v) => [...v].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f), { message: 'a name is one line: no tab, newline or control character' })
  .refine((v) => v === v.trim(), { message: 'a name has no leading or trailing whitespace' })

const AuthoredDescription = z.string().min(1).max(AUTHORED_DESCRIPTION_MAX_CHARS)

/**
 * `POST /api/v1/policy-guardrails/guardrails`. The IR is checked by the
 * guardrail validator, not here: this schema only says the envelope is right.
 */
export const AuthoredGuardrailCreateSchema = z
  .object({
    name: AuthoredName,
    description: AuthoredDescription.nullable().optional(),
    ir: z.unknown().refine((v) => v !== undefined, { message: 'ir is required' }),
  })
  .strict()

/**
 * `PUT /api/v1/policy-guardrails/guardrails/:guardrailId`: any of the three.
 * A changed IR creates a new version; `description: null` clears it.
 */
export const AuthoredGuardrailUpdateSchema = z
  .object({
    name: AuthoredName.optional(),
    description: AuthoredDescription.nullable().optional(),
    ir: z.unknown().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined || v.ir !== undefined, { message: 'nothing to update: send name, description or ir' })

export type AuthoredGuardrailCreate = z.infer<typeof AuthoredGuardrailCreateSchema>
export type AuthoredGuardrailUpdate = z.infer<typeof AuthoredGuardrailUpdateSchema>

/** One named validator check, in the order the checks ran. */
export interface GuardrailCheckResult {
  name: string
  passed: boolean
  detail: string
}

/** `POST …/guardrails/validate`: what a create or an IR edit would be refused for, without writing anything. */
export interface GuardrailValidationResponse {
  valid: boolean
  validation: GuardrailCheckResult[]
  /** The enforcer the IR is projected into; null when the IR did not validate. */
  target: GuardrailTarget | null
  /** The artifact the enforcer would read; null when the IR did not validate. */
  rendered: unknown
}

/** The 400 a create or an IR edit answers with when a check refuses the IR. */
export interface GuardrailValidationFailure {
  error: string
  code: 'invalid_guardrail'
  validation: GuardrailCheckResult[]
}

/** The answer to an authored create (201) or update (200). */
export interface AuthoredGuardrailWriteResult {
  ok: true
  guardrail: GuardrailDetail
  /** The IR changed: a new version, back in PROPOSED with no evidence, replaced the old one, which is now RETIRED. */
  forked: boolean
  /** The id of the version this one replaced, when `forked`. */
  supersedes: string | null
}

/** The one promotion rule, as `GET …/thresholds` reports it. */
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
  provenance: GuardrailProvenance
  /** Authored only: the author's label for it. Null for an extracted guardrail, whose label is its document and quote. */
  name: string | null
  /** Authored only: what the rule is for, in the author's words; shown where an extracted guardrail shows its quote. */
  description: string | null
  /** 1 for an extracted guardrail. Each IR edit of an authored guardrail creates the next version under a new id. */
  version: number
  /** The guardrail id of the version this one replaced, or null. */
  supersedes: string | null
  target: GuardrailTarget
  status: GuardrailStatus
  ir: GuardrailIr
  /** hook_rule: {toolPattern, argPattern?, reason}; sop_front_matter: {lines}; wasm_rule: {source}; workspace_setting: {key, values}. */
  rendered: unknown
  roles: string[]
  scope: string
  shadowEvaluations: number
  shadowWouldAct: number
  enforcingFires: number
  sourceStale: boolean
  /** wasm_rule only: the rule candidate this guardrail was handed to on shadow approval. */
  ruleCandidateId: string | null
  proposedAt: string
  shadowAt: string | null
  promotedAt: string | null
  rejectedReason: string | null
  /** Null for an authored guardrail: it cites nothing. */
  clause: GuardrailClauseRef | null
  /** Null for an authored guardrail. */
  document: GuardrailDocumentRef | null
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
  /** The id of the version that replaced this one (an authored guardrail whose IR was edited), or null. */
  supersededBy: string | null
}

export interface GuardrailListFilters {
  status?: GuardrailStatus
  target?: GuardrailTarget
  provenance?: GuardrailProvenance
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
  /** `execution_traces`: an allowed-models guardrail, one request per trace. `none`: nothing captured can answer (egress has no replay source). */
  source: 'enforcement_log' | 'context_snapshots' | 'execution_traces' | 'none'
  windowDays: number
  captured: number
  fires: number
  sample: Array<{ toolName: string; at: string; excerpt: string }>
  truncated: boolean
  /** Keys this replay cannot answer for (`review_before` holds rather than acts; `egress_allow` has no captured source). */
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

/**
 * The ledger's two Jaccard lines: passages at or above the overlap
 * line are recorded as OVERLAPS edges, and a retired passage's successor must
 * clear the near-identical line to be recorded as SUPERSEDES. One definition
 * for the ingest that writes the edges and the duplicates query that reads
 * them.
 */
export const LEDGER_OVERLAP_JACCARD = 0.7
export const LEDGER_NEAR_IDENTICAL_JACCARD = 0.85

/** How far the impact walk follows computed passage edges from its seed. */
export const LEDGER_IMPACT_MAX_DEPTH = 5

/**
 * Every edge the ledger names. The first six are foreign keys or hash
 * equalities; OVERLAPS and SUPERSEDES are computed rows that carry their
 * Jaccard arithmetic as `evidence`.
 *
 * - CONTAINS       document → passage (document → clause when the cited passage row is gone)
 * - SUPPORTS       passage → clause that quotes it
 * - COMPILES_TO    clause → guardrail
 * - EMITS          guardrail → finding its shadow fires or blocks filed
 * - ADJUDICATED_BY finding → member who marked it true or false positive
 * - APPROVED_BY    guardrail → member who moved it (the event is the evidence)
 */
export const LEDGER_EDGE_TYPES = ['CONTAINS', 'SUPPORTS', 'COMPILES_TO', 'EMITS', 'ADJUDICATED_BY', 'APPROVED_BY', 'OVERLAPS', 'SUPERSEDES'] as const
export type LedgerEdgeType = (typeof LEDGER_EDGE_TYPES)[number]

export interface LedgerGraph {
  documents: Array<{ docId: string; title: string; provider: string; sourceUrl: string | null; status: string; passageCount: number; clauseCount: number }>
  /** The passages a clause cites or a computed edge touches — not every passage; a document's full count is on its node. */
  passages: Array<{ passageId: string; docId: string; ordinal: number; headingPath: string[]; excerpt: string; retired: boolean }>
  clauses: Array<{ clauseId: string; docId: string; passageId: string | null; kind: string; status: string; extractor: string; quote: string }>
  guardrails: Array<{ guardrailId: string; clauseId: string; status: string; target: string }>
  /** Findings filed as `guardrail:<pgr>`, newest first. */
  findings: Array<{ findingId: string; guardrailId: string; outcome: string | null; shadowed: boolean; at: string }>
  /** Members who moved a guardrail or adjudicated one of its findings. */
  members: Array<{ memberId: string; displayName: string | null }>
  edges: Array<{ from: string; to: string; type: LedgerEdgeType; evidence?: unknown }>
  truncated: boolean
}

/** What a change to a document or passage reaches: passages within `maxDepth` computed edges, the clauses citing them, their guardrails. */
export interface LedgerImpact {
  seed: { docId: string | null; passageId: string | null }
  maxDepth: number
  passages: Array<{ passageId: string; docId: string; title: string; depth: number; retired: boolean; excerpt: string }>
  clauses: Array<{ clauseId: string; passageId: string; docId: string; kind: string; quote: string; depth: number }>
  guardrails: Array<{ guardrailId: string; clauseId: string; status: string; target: string; sourceStale: boolean; ruleCandidateId: string | null; depth: number }>
  truncated: boolean
}

/** Full-text search over live passages (Postgres `websearch_to_tsquery`, English configuration). */
export interface PassageSearchResult {
  query: string
  passages: Array<{ passageId: string; docId: string; title: string; sourceUrl: string | null; headingPath: string[]; excerpt: string; rank: number }>
}

export interface LedgerDuplicateSide {
  passageId: string
  docId: string
  title: string
  excerpt: string
  guardrailIds: string[]
}

export interface LedgerDuplicates {
  minJaccard: number
  /** OVERLAPS edges between live passages at or above `minJaccard`, strongest first. */
  passagePairs: Array<{ jaccard: number; intersection: number; union: number; nearIdentical: boolean; a: LedgerDuplicateSide; b: LedgerDuplicateSide }>
  /** The same canonical rule cited from more than one passage. */
  sameRule: Array<{
    irCanonical: string
    kind: string
    clauses: Array<{ clauseId: string; docId: string; title: string; quote: string; guardrailId: string | null; guardrailStatus: string | null }>
  }>
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

/** A candidate's evidence entry when the guardrail it came from was authored, not extracted: there is no citation to carry. */
export interface AuthoredCandidateEvidence {
  authored: {
    guardrailId: string
    name: string
    version: number
  }
}

export function isCandidateCitationEvidence(value: unknown): value is CandidateCitationEvidence {
  if (!value || typeof value !== 'object') return false
  const c = (value as { citation?: unknown }).citation
  return !!c && typeof c === 'object' && typeof (c as { quote?: unknown }).quote === 'string' && typeof (c as { guardrailId?: unknown }).guardrailId === 'string'
}
