/**
 * Decide (Intutic 3.0): the responses of `routes/decide.ts`
 * (`/api/v1/decide/…`) and the `decideRules` that `GET /api/v1/policy/resolve`
 * serves.
 *
 * @module
 */
import { z } from 'zod'
import { IsoTimestamp } from './common.js'

const Band = z.object({ yes_at: z.number(), no_below: z.number() })

/** A calibration a rule may enforce under, as `decideRecord.ts`'s `DecidePin` reads it. */
export const DecidePinResponse = z.object({
  modelDigest: z.string(),
  temperature: z.record(z.string(), z.number()).optional(),
  band: Band.optional(),
  combiner: z.object({ bias: z.number(), weights: z.record(z.string(), z.number()) }).optional(),
  evalRunId: z.string(),
  source: z.enum(['local', 'server']),
})

/**
 * One `decide:` line of an enforced SOP or a decide guardrail, as the sync
 * daemon's `ServedDecideRule` reads it. `ir` is the line's text after
 * `decide:`; the daemon validates it itself, so a line that does not read is
 * served too (every gate then refuses what it names).
 */
export const ServedDecideRuleResponse = z.object({
  sopId: z.string().describe('The SOP id, or `guardrail:<pgr>` for a decide guardrail.'),
  sopTitle: z.string(),
  ruleText: z.string().describe('The SOP body, or the guardrail description.'),
  ir: z.string().describe('The text after `decide:`.'),
  rollout: z.literal('shadow').optional().describe('The server stamp: present when the kill switch (`INTUTIC_DECIDE=shadow`), a shadow guardrail or a `mode: shadow` SOP holds the rule in shadow.'),
  ruleHash: z.string().optional().describe('The rule hash the server computed; absent on a line that does not read.'),
  pins: z.array(DecidePinResponse).describe('The active calibrations of this rule hash.'),
})
export type ServedDecideRuleResponse = z.infer<typeof ServedDecideRuleResponse>

/** `POST /api/v1/decide/events`. */
export const DecideEventsIngestResponse = z.object({
  accepted: z.number().int().describe('Rule decisions stored.'),
  duplicates: z.number().int().describe('Rule decisions already stored (a re-sent batch).'),
  overBudget: z.number().int().describe('Rule decisions refused by the per-workspace daily row budget.'),
  outOfWindow: z.number().int().describe('Rule decisions older than 30 days or more than a day ahead.'),
  invalid: z.number().int().describe('Rule decisions that did not read.'),
  ignored: z.number().int().describe('Log lines that are not decisions (drift, canary, unavailable events).'),
  argsDropped: z.boolean().describe('Arguments excerpts were dropped: `decideLogUploadArgs` is off.'),
})
export type DecideEventsIngestResponse = z.infer<typeof DecideEventsIngestResponse>

export const DecideEventResponse = z.object({
  eventId: z.string(),
  createdAt: IsoTimestamp,
  receivedAt: IsoTimestamp,
  source: z.string(),
  harness: z.string().nullable(),
  ruleRef: z.string(),
  ruleHash: z.string(),
  modelId: z.string().nullable(),
  modelDigest: z.string().nullable(),
  adapter: z.string().nullable(),
  rollout: z.string(),
  effective: z.string(),
  outcome: z.string(),
  answers: z.record(z.string(), z.unknown()).nullable(),
  whenValue: z.string().nullable(),
  stateHash: z.string().nullable(),
  argsExcerpt: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  reviewId: z.string().nullable(),
})

/** `GET /api/v1/decide/events`. */
export const DecideEventListResponse = z.object({
  events: z.array(DecideEventResponse),
  nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last.'),
})
export type DecideEventListResponse = z.infer<typeof DecideEventListResponse>

export const DecideCalibrationResponse = z.object({
  calibrationId: z.string(),
  ruleHash: z.string(),
  modelDigest: z.string(),
  modelId: z.string().nullable(),
  status: z.enum(['candidate', 'active', 'retired']),
  temperature: z.record(z.string(), z.number()),
  combiner: z.object({ bias: z.number(), weights: z.record(z.string(), z.number()) }).nullable(),
  band: Band,
  evalRunId: z.string().nullable(),
  labelsN: z.number().int().nullable(),
  fittedAt: IsoTimestamp,
  promotedBy: z.string().nullable(),
  promotedAt: IsoTimestamp.nullable(),
  retiredAt: IsoTimestamp.nullable(),
})

/** `GET /api/v1/decide/calibrations`. */
export const DecideCalibrationListResponse = z.object({ calibrations: z.array(DecideCalibrationResponse) })
export type DecideCalibrationListResponse = z.infer<typeof DecideCalibrationListResponse>

/** `POST /api/v1/decide/calibrations/:id/promote` and `…/retire`. */
export const DecideCalibrationChangedResponse = z.object({ calibration: DecideCalibrationResponse })
export type DecideCalibrationChangedResponse = z.infer<typeof DecideCalibrationChangedResponse>

export const DecideEvalRunResponse = z.object({
  evalRunId: z.string(),
  ruleHash: z.string(),
  modelDigest: z.string(),
  preregHash: z.string(),
  prereg: z.record(z.string(), z.unknown()),
  registeredAt: IsoTimestamp,
  setHash: z.string().nullable(),
  results: z.record(z.string(), z.unknown()).nullable(),
  passed: z.boolean().nullable(),
  completedAt: IsoTimestamp.nullable(),
  source: z.enum(['cli', 'job']),
  reusedSet: z.boolean().nullable(),
})

/** `POST /api/v1/decide/eval-runs` and `…/:id/results`. */
export const DecideEvalRunChangedResponse = z.object({
  evalRun: DecideEvalRunResponse,
  marks: z
    .record(z.string(), z.boolean())
    .optional()
    .describe('On results: each pass mark of the exit rule the run met (marks 1–3 and 5).'),
})
export type DecideEvalRunChangedResponse = z.infer<typeof DecideEvalRunChangedResponse>

/** `GET /api/v1/decide/eval-runs`. */
export const DecideEvalRunListResponse = z.object({ evalRuns: z.array(DecideEvalRunResponse) })
export type DecideEvalRunListResponse = z.infer<typeof DecideEvalRunListResponse>
export type DecideEvalRun = z.infer<typeof DecideEvalRunResponse>
export type DecideCalibration = z.infer<typeof DecideCalibrationResponse>

// ─── The dashboard's rules view ──────────────────────────────────────

/** One probability bucket of a question's answers: `[lo, hi)`, the last one closed. */
export const DecideQuestionBucket = z.object({
  lo: z.number(),
  hi: z.number(),
  n: z.number().int().describe('Answers whose probability fell in the bucket (a choice question: its top option).'),
  unknown: z.number().int().describe('Of those, answers inside the band: unknown.'),
  labelled: z.number().int().describe('Of those, decisions a person ruled on in the review queue.'),
  refuseLabels: z.number().int().describe('Of the ruled ones, those ruled a violation (refuse).'),
})

export const DecideQuestionStats = z.object({
  name: z.string(),
  type: z.enum(['yes_no', 'choice']),
  ask: z.string(),
  n: z.number().int(),
  unknownRate: z.number().nullable().describe('Share of answers inside the band; null with no answers.'),
  buckets: z.array(DecideQuestionBucket).describe('Ten buckets of width 0.1, from 0 to 1.'),
})

export const DecideRuleStats = z.object({
  decisions: z.number().int(),
  outcomes: z.object({ allow: z.number().int(), refuse: z.number().int(), escalate: z.number().int(), unavailable: z.number().int() }),
  shadow: z.number().int().describe('Decisions the rule made in shadow.'),
  enforce: z.number().int().describe('Decisions the rule made enforcing.'),
  shadowWouldAct: z.number().int().describe('Shadow decisions that refused or escalated: the call went through, and an enforcing rule would have stopped it.'),
  enforceActed: z.number().int().describe('Enforcing decisions that refused or escalated.'),
  escalationRate: z.number().nullable().describe('Escalations over decisions; null with none.'),
  shadowDisagreementRate: z.number().nullable().describe('shadowWouldAct over shadow decisions: how often the shadow run and an enforcing rule would have disagreed; null with no shadow decisions.'),
  questions: z.array(DecideQuestionStats),
})

export const DecideRuleSummary = z.object({
  sopId: z.string().describe('The SOP id, or `guardrail:<pgr>` for a decide guardrail.'),
  sopTitle: z.string(),
  guardrailId: z.string().nullable(),
  ruleRef: z.string().nullable().describe('`<sopId>#<id>`; null on a line that does not read.'),
  ruleHash: z.string().nullable(),
  rule: z.record(z.string(), z.unknown()).nullable().describe('The rule as its line carries it (the IR without `kind`); null on a line that does not read.'),
  error: z.string().nullable().describe('Why the line does not read; null when it does.'),
  stamp: z.literal('shadow').nullable().describe('The server stamp: shadow under the kill switch, for a shadow guardrail or a `mode: shadow` SOP.'),
  pins: z.array(DecidePinResponse),
  stats: DecideRuleStats,
})

/** `GET /api/v1/decide/rules`. */
export const DecideRuleListResponse = z.object({
  mode: z.enum(['off', 'shadow', 'on']).describe('The server kill switch for this workspace (`INTUTIC_DECIDE`): off serves no rule.'),
  windowDays: z.number().int(),
  rules: z.array(DecideRuleSummary),
})
export type DecideRuleListResponse = z.infer<typeof DecideRuleListResponse>
export type DecideRuleSummary = z.infer<typeof DecideRuleSummary>
export type DecideQuestionStats = z.infer<typeof DecideQuestionStats>
