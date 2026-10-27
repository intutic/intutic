/**
 * Responses of the control plane routes in policyGuardrails.ts and connectors.ts:
 * the Policy Clause Ledger (`/api/v1/policy-guardrails`) and the connectors
 * that feed it (`/api/v1/connectors`).
 *
 * The ledger's rows are written by `policyGuardrailService.ts` and
 * `clauseExtractionService.ts` against the wire interfaces in
 * `../policyGuardrails.ts`; each schema here follows the service code that
 * builds the row. A field those interfaces type as `unknown` (a jsonb column
 * read as is) is `Json` here, described with what the code writes into it.
 *
 * @module
 */
import { z } from 'zod'
import { IsoTimestamp } from './common.js'
import { GuardrailIrSchema } from '../guardrailIr.js'
import { GUARDRAIL_EVENT_TYPES, GUARDRAIL_PROVENANCES, GUARDRAIL_STATUSES, GUARDRAIL_TARGETS } from '../policyGuardrails.js'

/**
 * A jsonb value the service passes through as read (typed `unknown` there).
 * Unlike `z.unknown()` it is a required key: the column is NOT NULL, so the
 * key is always on the wire.
 */
const Json = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.string(), z.any())])

const GuardrailStatus = z.enum(GUARDRAIL_STATUSES)
const GuardrailTarget = z.enum(GUARDRAIL_TARGETS)
const Count = z.number().int()

// ─── Documents ───────────────────────────────────────────────────────

const ExtractionRunRef = z.object({
  runId: z.string(),
  /** `llm:<model>` or `frontmatter`. */
  extractor: z.string().describe('`llm:<model>` or `frontmatter`'),
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp.nullable(),
  error: z.string().nullable(),
})

/** `listPolicyDocuments`: a current document with its live counts. */
const PolicyDocumentSummary = z.object({
  docId: z.string(),
  title: z.string(),
  /** `notion`, `confluence`, `github`, `gdrive` or `upload`. */
  provider: z.string().describe('`notion`, `confluence`, `github`, `gdrive` or `upload`'),
  sourceUrl: z.string().nullable(),
  /** `ACTIVE`, `UPSTREAM_DELETED` or `PARSE_FAILED`. */
  status: z.string().describe('`ACTIVE`, `UPSTREAM_DELETED` or `PARSE_FAILED`'),
  injectionFlagged: z.boolean(),
  sopId: z.string().nullable(),
  fetchedAt: IsoTimestamp,
  passageCount: Count.describe('Live (not retired) passages'),
  clauseCount: Count.describe('VALID clauses'),
  guardrailCount: Count,
  lastRun: ExtractionRunRef.nullable().describe('The newest extraction run; null before the first'),
})

/** `GET /api/v1/policy-guardrails/documents`: the workspace's current documents, newest fetch first. */
export const PolicyDocumentListResponse = z.object({ documents: z.array(PolicyDocumentSummary) })
export type PolicyDocumentListResponse = z.infer<typeof PolicyDocumentListResponse>

/** `GET /api/v1/policy-guardrails/documents/:docId`: `getPolicyDocument`. */
export const PolicyDocumentResponse = z.object({
  document: PolicyDocumentSummary.extend({
    contentHash: z.string().describe('SHA-256 of the ingested markdown'),
    upstreamVersion: z.string().nullable(),
    passages: z.array(
      z.object({
        passageId: z.string(),
        ordinal: Count,
        headingPath: z.array(z.string()),
        text: z.string(),
        passageHash: z.string(),
        anchor: Json.describe('Where the passage sits upstream: `{kind, id?}` (`notion_block`, `confluence_page`, `gh_lines`, `md_heading`)'),
        tokenIndex: z.array(z.string()).describe('Lower-cased tool, action and path tokens the passage mentions'),
      }),
    ),
    clauses: z.array(
      z.object({
        clauseId: z.string(),
        passageId: z.string().nullable(),
        passageHash: z.string(),
        quote: z.string(),
        ir: Json.describe('The clause IR as proposed; a REJECTED clause keeps the raw object'),
        /** The IR's `kind`, or `invalid` when it has none. */
        kind: z.string().describe("The IR's `kind`, or `invalid` when it has none"),
        /** `VALID` or `REJECTED`. */
        status: z.string().describe('`VALID` or `REJECTED`'),
        extractor: z.string(),
        validation: Json.describe('The validator checks, `[{name, passed, detail}]` in the order they ran'),
        guardrailId: z.string().nullable(),
        guardrailStatus: z.string().nullable(),
      }),
    ),
    runs: z.array(
      ExtractionRunRef.extend({
        clausesProposed: Count,
        clausesValid: Count,
        clausesRejected: Count,
      }),
    ),
  }),
})
export type PolicyDocumentResponse = z.infer<typeof PolicyDocumentResponse>

/** `POST /api/v1/policy-guardrails/documents/:docId/extract`: `extractClausesForDocument`'s result. */
export const PolicyExtractResponse = z.object({
  result: z.object({
    docId: z.string(),
    runId: z.string().nullable(),
    extractor: z.string(),
    skipped: z.enum(['no_passages', 'daily_cap', 'cap_unavailable', 'llm_disabled']).nullable().describe('Why the model was not called, when it was not'),
    cap: z.object({ count: Count, cap: Count }).nullable().describe("Today's extraction reservations and the daily cap; null when extraction stopped before reserving"),
    llmUnavailable: z.boolean().describe('The model could not be reached or answered without content; the run row carries the error'),
    chunks: Count,
    proposals: Count,
    verbatimQuotes: Count,
    valid: Count,
    rejected: Count,
    malformed: Count,
    guardrails: z.object({ proposed: Count, rejectedForInjection: Count, existing: Count }),
    lifted: z.object({ clauses: Count, valid: Count, errors: z.array(z.string()) }).describe('The zero-model front-matter lift, which always runs'),
    error: z.string().nullable(),
  }),
})
export type PolicyExtractResponse = z.infer<typeof PolicyExtractResponse>

// ─── The ledger ──────────────────────────────────────────────────────

/** `GET /api/v1/policy-guardrails/coverage?token=`: `coverageForToken`. */
export const GuardrailCoverageResponse = z.object({
  coverage: z.object({
    token: z.string().describe('The token, trimmed and lower-cased'),
    passages: z.array(
      z.object({
        passageId: z.string(),
        docId: z.string(),
        title: z.string(),
        sourceUrl: z.string().nullable(),
        headingPath: z.array(z.string()),
        excerpt: z.string(),
      }),
    ),
    guardrails: z.array(
      z.object({
        guardrailId: z.string(),
        clauseId: z.string(),
        passageId: z.string().nullable(),
        status: z.string(),
        target: z.string(),
        quote: z.string(),
      }),
    ),
  }),
})
export type GuardrailCoverageResponse = z.infer<typeof GuardrailCoverageResponse>

/** `GET /api/v1/policy-guardrails/search?q=`: `searchPassages`, best match first. */
export const PassageSearchResponse = z.object({
  search: z.object({
    query: z.string(),
    passages: z.array(
      z.object({
        passageId: z.string(),
        docId: z.string(),
        title: z.string(),
        sourceUrl: z.string().nullable(),
        headingPath: z.array(z.string()),
        excerpt: z.string(),
        rank: z.number().describe('Postgres `ts_rank`'),
      }),
    ),
  }),
})
export type PassageSearchResponse = z.infer<typeof PassageSearchResponse>

/** `GET /api/v1/policy-guardrails/impact`: `ledgerImpact`. */
export const LedgerImpactResponse = z.object({
  impact: z.object({
    seed: z.object({ docId: z.string().nullable(), passageId: z.string().nullable() }),
    maxDepth: Count,
    passages: z.array(
      z.object({ passageId: z.string(), docId: z.string(), title: z.string(), depth: Count, retired: z.boolean(), excerpt: z.string() }),
    ),
    clauses: z.array(
      z.object({ clauseId: z.string(), passageId: z.string(), docId: z.string(), kind: z.string(), quote: z.string(), depth: Count }),
    ),
    guardrails: z.array(
      z.object({
        guardrailId: z.string(),
        clauseId: z.string(),
        status: z.string(),
        target: z.string(),
        sourceStale: z.boolean(),
        ruleCandidateId: z.string().nullable(),
        depth: Count,
      }),
    ),
    truncated: z.boolean(),
  }),
})
export type LedgerImpactResponse = z.infer<typeof LedgerImpactResponse>

const DuplicateSide = z.object({
  passageId: z.string(),
  docId: z.string(),
  title: z.string(),
  excerpt: z.string(),
  guardrailIds: z.array(z.string()).describe('Live guardrails standing on the passage'),
})

/** `GET /api/v1/policy-guardrails/duplicates`: `listLedgerDuplicates`. */
export const LedgerDuplicatesResponse = z.object({
  duplicates: z.object({
    minJaccard: z.number().describe('The line applied: the request, never below the line the edges were recorded at'),
    passagePairs: z.array(
      z.object({
        jaccard: z.number(),
        intersection: z.number(),
        union: z.number(),
        nearIdentical: z.boolean(),
        a: DuplicateSide,
        b: DuplicateSide,
      }),
    ),
    sameRule: z.array(
      z.object({
        irCanonical: z.string(),
        kind: z.string(),
        clauses: z.array(
          z.object({
            clauseId: z.string(),
            docId: z.string(),
            title: z.string(),
            quote: z.string(),
            guardrailId: z.string().nullable(),
            guardrailStatus: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
})
export type LedgerDuplicatesResponse = z.infer<typeof LedgerDuplicatesResponse>

/** `GET /api/v1/policy-guardrails/conflicts`: `listGuardrailConflicts`. */
export const GuardrailConflictListResponse = z.object({
  conflicts: z.array(
    z.object({
      kind: z.enum(['deny_vs_count', 'require_vs_forbid', 'count_limits_differ', 'hook_contains_vs_not_contains']),
      token: z.string().nullable(),
      /** A guardrail (`pgr_…`) or a lifted front-matter clause (`pcl_…`), and the sentence it stands on. */
      a: z.object({ id: z.string(), quote: z.string() }),
      b: z.object({ id: z.string(), quote: z.string() }),
      detail: z.string(),
    }),
  ),
})
export type GuardrailConflictListResponse = z.infer<typeof GuardrailConflictListResponse>

// ─── Guardrails ──────────────────────────────────────────────────────

/** `listGuardrails` / `toSummary`: a guardrail with its citation, if it has one. */
const GuardrailSummary = z.object({
  guardrailId: z.string(),
  provenance: z.enum(GUARDRAIL_PROVENANCES),
  name: z.string().nullable().describe('Authored only; null for an extracted guardrail'),
  description: z.string().nullable().describe('Authored only'),
  version: Count,
  supersedes: z.string().nullable().describe('The guardrail id of the version this one replaced'),
  target: GuardrailTarget,
  status: GuardrailStatus,
  ir: GuardrailIrSchema,
  rendered: Json.describe('What the enforcer reads, by target: hook_rule `{kind, toolPattern, argPattern?, reason}`; front matter `{kind, lines}`; wasm `{kind, source}`; workspace_setting `{kind, key, values}`'),
  roles: z.array(z.string()),
  /** `workspace` or `org`. */
  scope: z.string().describe('`workspace` or `org`'),
  shadowEvaluations: Count,
  shadowWouldAct: Count,
  enforcingFires: Count,
  sourceStale: z.boolean(),
  ruleCandidateId: z.string().nullable().describe('wasm_rule only: the rule candidate it was handed to on shadow approval'),
  proposedAt: IsoTimestamp,
  shadowAt: IsoTimestamp.nullable(),
  promotedAt: IsoTimestamp.nullable(),
  rejectedReason: z.string().nullable(),
  clause: z
    .object({
      clauseId: z.string(),
      quote: z.string(),
      quoteOffset: Count.describe('Offset of the quote in the passage text; -1 when only the normalised forms matched'),
      passageHash: z.string(),
      passageId: z.string().nullable(),
      extractor: z.string(),
    })
    .nullable()
    .describe('Null for an authored guardrail'),
  document: z
    .object({ docId: z.string(), title: z.string(), provider: z.string(), sourceUrl: z.string().nullable() })
    .nullable()
    .describe('Null for an authored guardrail'),
})

/** `getGuardrailDetail`: the summary, its checks, passage, history and successor. */
const GuardrailDetail = GuardrailSummary.extend({
  validation: Json.describe('The validator checks, `[{name, passed, detail}]` in the order they ran: the clause\'s for an extracted guardrail, the row\'s for an authored one'),
  passage: z.object({ passageId: z.string(), text: z.string(), headingPath: z.array(z.string()), retired: z.boolean() }).nullable(),
  events: z.array(
    z.object({
      eventId: z.string(),
      event: z.enum(GUARDRAIL_EVENT_TYPES),
      actorId: z.string().nullable().describe('The member who acted; null for the system'),
      detail: Json.describe("The event's jsonb detail object"),
      createdAt: IsoTimestamp,
    }),
  ),
  supersededBy: z.string().nullable().describe('The id of the version that replaced this one'),
})

/** `GET /api/v1/policy-guardrails/guardrails`: newest proposal first. */
export const GuardrailListResponse = z.object({ guardrails: z.array(GuardrailSummary) })
export type GuardrailListResponse = z.infer<typeof GuardrailListResponse>

/** `GET /api/v1/policy-guardrails/guardrails/:guardrailId`. */
export const GuardrailDetailResponse = z.object({ guardrail: GuardrailDetail })
export type GuardrailDetailResponse = z.infer<typeof GuardrailDetailResponse>

/** The guardrail as it stands after a write, read back by id. */
const ReadBack = GuardrailDetail.describe('The guardrail read back after the write. Never null: a write whose read-back finds nothing answers 500 GUARDRAIL_READ_BACK_FAILED')

/**
 * `POST /api/v1/policy-guardrails/guardrails` (201) and
 * `PUT /api/v1/policy-guardrails/guardrails/:guardrailId` (200).
 */
export const GuardrailWriteResponse = z.object({
  ok: z.literal(true),
  guardrail: ReadBack,
  forked: z.boolean().describe('The IR changed: a new version, PROPOSED with no evidence, replaced the old one, which is now RETIRED'),
  supersedes: z.string().nullable().describe('The id of the version this one replaced, when `forked`'),
})
export type GuardrailWriteResponse = z.infer<typeof GuardrailWriteResponse>

/** What a guardrail renders to, as `lib/guardrailValidator.ts` `RenderedArtifact` types it. */
const RenderedArtifact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hook_rule'), toolPattern: z.string(), argPattern: z.string().optional(), reason: z.string() }),
  z.object({ kind: z.literal('front_matter'), lines: z.string() }),
  z.object({ kind: z.literal('wasm_predicate'), source: z.string() }),
  z.object({ kind: z.literal('workspace_setting'), key: z.enum(['allowedModels', 'egressAllow']), values: z.array(z.string()) }),
  z.object({ kind: z.literal('none') }),
])

/** `POST /api/v1/policy-guardrails/guardrails/validate`: what a create or an IR edit would be refused for. */
export const GuardrailValidateResponse = z.object({
  valid: z.boolean(),
  validation: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })).describe('Every check that ran, in order'),
  target: GuardrailTarget.nullable().describe('Null when the IR did not validate'),
  rendered: RenderedArtifact.nullable().optional().describe('The artifact the enforcer would read; null when the IR did not validate'),
})
export type GuardrailValidateResponse = z.infer<typeof GuardrailValidateResponse>

/**
 * A transition that answers with the guardrail as it now stands:
 * approve-shadow, reject, retire, reconfirm, and the authored delete.
 */
export const GuardrailTransitionResponse = z.object({ ok: z.literal(true), guardrail: GuardrailDetail })
export type GuardrailTransitionResponse = z.infer<typeof GuardrailTransitionResponse>

const Counter = z.number().int().nullable()

/** `computeGuardrailReadiness` and its wasm, egress and allowed-models variants. */
const GuardrailReadiness = z.object({
  ready: z.boolean(),
  reasons: z.array(z.string()).describe('Every unmet condition, in the rule\'s order; empty when ready'),
  neverFired: z.boolean().describe('The rule never fired in shadow: promotable only with `acknowledgeNoTraffic`'),
  evaluations: Counter.describe('Null when the evidence counters could not be read'),
  wouldAct: Counter.describe('Null when the evidence counters could not be read'),
  wouldActRate: z.number().nullable(),
  adjudicated: Counter.describe('Null when the evidence counters could not be read'),
  adjudicatedRequired: Count,
  falsePositives: Counter.describe('Null when the evidence counters could not be read'),
  falsePositiveRate: z.number().nullable(),
  thresholds: z.object({
    minShadowEvaluations: z.number(),
    maxWouldActRate: z.number(),
    minAdjudicatedFires: z.number(),
    maxAdjudicatedFalsePositiveRate: z.number(),
  }),
})

/** `POST /api/v1/policy-guardrails/guardrails/:guardrailId/promote`. */
export const GuardrailPromoteResponse = z.object({
  ok: z.literal(true),
  guardrail: ReadBack,
  readiness: GuardrailReadiness.describe('The evidence the promotion was decided on'),
})
export type GuardrailPromoteResponse = z.infer<typeof GuardrailPromoteResponse>

/** `GET /api/v1/policy-guardrails/guardrails/:guardrailId/readiness`. */
export const GuardrailReadinessResponse = z.object({ readiness: GuardrailReadiness })
export type GuardrailReadinessResponse = z.infer<typeof GuardrailReadinessResponse>

/** `POST /api/v1/policy-guardrails/guardrails/:guardrailId/replay`: `replayGuardrail`. */
export const GuardrailReplayResponse = z.object({
  replay: z.object({
    source: z.enum(['enforcement_log', 'context_snapshots', 'execution_traces', 'none']).describe('`none`: nothing captured can answer (egress)'),
    windowDays: Count,
    captured: Count,
    fires: Count,
    sample: z.array(z.object({ toolName: z.string(), at: IsoTimestamp, excerpt: z.string() })),
    truncated: z.boolean(),
    unsupported: z.array(z.string()).describe('Keys this replay cannot answer for'),
  }),
})
export type GuardrailReplayResponse = z.infer<typeof GuardrailReplayResponse>

// ─── Connectors ──────────────────────────────────────────────────────

/** `POST /api/v1/connectors` (201): the connector as created; the token is never echoed. */
export const ConnectorCreateResponse = z.object({
  connector_id: z.string(),
  provider: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  last_synced_at: z.null().describe('Always null: a new connector has not synced'),
})
export type ConnectorCreateResponse = z.infer<typeof ConnectorCreateResponse>

/** `GET /api/v1/connectors`: every connector of the workspace, source and memory providers alike. */
export const ConnectorListResponse = z.object({
  items: z.array(
    z.object({
      connector_id: z.string(),
      provider: z.string(),
      name: z.string(),
      config: z.record(z.string(), z.unknown()).describe('The connector settings (provider config, `auto_sync`, the cron\'s last attempt)'),
      last_synced_at: IsoTimestamp.nullable(),
      last_sync_error: z.string().nullable().describe("The scheduled sync's last failed attempt, read from `config`"),
      last_attempt_at: z.string().nullable().describe("When the scheduled sync last tried, as the cron wrote it into `config`"),
      created_at: IsoTimestamp,
    }),
  ),
})
export type ConnectorListResponse = z.infer<typeof ConnectorListResponse>

/** `POST /api/v1/connectors/:connectorId/sync`: `syncConnector`'s counts. */
export const ConnectorSyncResponse = z.object({
  success: z.literal(true),
  processed_docs: Count,
  updated_sops: z.array(z.string()).describe('SOPs this sync created or rewrote'),
  successor_sops: z.array(z.string()).describe('DRAFT successors created behind an enforced SOP whose upstream text changed'),
})
export type ConnectorSyncResponse = z.infer<typeof ConnectorSyncResponse>
