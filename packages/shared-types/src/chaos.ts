/**
 * chaos.ts — the contract for agent fault injection (`intutic chaos run`).
 *
 * A chaos run executes an agent with a known fault injected and checks what
 * the agent did next. Four components share this contract:
 *
 * - the CLI runner, which reads an experiment file, launches each repetition
 *   in a sandbox and scores the result;
 * - the LLM proxy, which injects the `llm.*` and `egress.*` faults;
 * - the MCP proxy, which injects the MCP side of `tool.error` plus
 *   `tool.stale_data`, `mcp.toolset_change` and `inject.tool_result`;
 * - the gates — the hook gates and the in-process gate SDKs — which inject
 *   `permission.deny_or_delay` and the built-in-tool side of `tool.error`.
 *
 * The runner hands each component a plan through {@link CHAOS_PLAN_ENV} and an
 * events file through {@link CHAOS_EVENTS_ENV}. Both are plain environment
 * variables, so they cross the sandbox boundary the same way the proxy URL
 * does. Each component appends one JSON line per event to the events file;
 * the probes read nothing else.
 *
 * Two rules every injector keeps:
 *
 * 1. **A fault never loosens governance.** Faults are applied only to a call
 *    that governance has already allowed. A fault can turn an allow into a
 *    failure, a delay or a changed result; it can never turn a block, a hold
 *    or a redaction into an allow.
 * 2. **Silence is not success.** A component that loads a plan reports
 *    `plan_loaded`, so the runner can tell "the fault fired and the agent
 *    coped" from "the component never saw the plan".
 *
 * The Rust proxy decodes the same plan with serde; its tests read the fixture
 * at `src/__tests__/fixtures/chaos-plan.json`, which this module's tests also
 * validate, so the two decoders cannot drift apart.
 *
 * @module
 */

import { z } from 'zod'

/** Environment variable carrying the plan: base64url-encoded JSON {@link ChaosPlan}. */
export const CHAOS_PLAN_ENV = 'INTUTIC_CHAOS_PLAN'

/** Environment variable carrying the path of the append-only JSONL events file. */
export const CHAOS_EVENTS_ENV = 'INTUTIC_CHAOS_EVENTS'

/** Wire version of {@link ChaosPlan}. A component refuses any other version. */
export const CHAOS_PLAN_VERSION = 1

/** Every fault the catalog knows, by id. */
export const FAULT_IDS = [
  'llm.rate_limit',
  'llm.upstream_5xx',
  'llm.context_trim',
  'llm.model_degrade',
  'tool.error',
  'tool.stale_data',
  'mcp.toolset_change',
  'permission.deny_or_delay',
  'inject.tool_result',
  'egress.dns_fail',
  'egress.credential_401',
] as const
export type FaultId = (typeof FAULT_IDS)[number]

/** The components that inject faults or report events. */
export type ChaosComponent = 'runner' | 'proxy' | 'mcp-proxy' | 'gate'

/**
 * Whether a fault is safe outside a sandbox. Fail-safe faults deny, delay or
 * error; mutating faults change what the agent sees and run only in a sandbox.
 */
export type FaultSafety = 'fail_safe' | 'mutating'

/** Which component injects each fault, and its safety class. */
export const FAULT_CATALOG: Readonly<Record<FaultId, { injectedBy: readonly ChaosComponent[]; safety: FaultSafety }>> = {
  'llm.rate_limit': { injectedBy: ['proxy'], safety: 'fail_safe' },
  'llm.upstream_5xx': { injectedBy: ['proxy'], safety: 'fail_safe' },
  'llm.context_trim': { injectedBy: ['proxy'], safety: 'mutating' },
  'llm.model_degrade': { injectedBy: ['proxy'], safety: 'mutating' },
  'tool.error': { injectedBy: ['gate', 'mcp-proxy'], safety: 'fail_safe' },
  'tool.stale_data': { injectedBy: ['mcp-proxy'], safety: 'mutating' },
  'mcp.toolset_change': { injectedBy: ['mcp-proxy'], safety: 'mutating' },
  'permission.deny_or_delay': { injectedBy: ['gate'], safety: 'fail_safe' },
  'inject.tool_result': { injectedBy: ['mcp-proxy'], safety: 'mutating' },
  'egress.dns_fail': { injectedBy: ['proxy'], safety: 'fail_safe' },
  'egress.credential_401': { injectedBy: ['proxy'], safety: 'fail_safe' },
}

// ── Faults ───────────────────────────────────────────────────────────────────

/**
 * Which calls a fault applies to. Every field present must match; an absent
 * field matches anything. `tool` and `host` match exactly, or by suffix when
 * they start with `*` (`*.npmjs.org`). `model` matches the requested model id.
 */
const MatchSchema = z
  .object({
    tool: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
export type FaultMatch = z.infer<typeof MatchSchema>

/** Fields every fault has: which calls, how many to skip, how many to hit. */
const common = {
  match: MatchSchema.optional(),
  /** Skip this many matching calls before the first injection. */
  after_calls: z.number().int().min(0).max(10_000).default(0),
  /** Inject at most this many times; absent means every matching call. */
  times: z.number().int().min(1).max(10_000).optional(),
}

const hostRequired = MatchSchema.extend({ host: z.string().min(1) })

export const FaultSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('llm.rate_limit'), ...common, retry_after_s: z.number().int().min(0).max(600).default(5) }).strict(),
  z
    .object({
      id: z.literal('llm.upstream_5xx'),
      ...common,
      status: z.union([z.literal(500), z.literal(502), z.literal(503), z.literal(529)]).default(500),
      /** Cut a streamed response after this many chunks instead of failing the request. */
      stream_cut_after_chunks: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
  z
    .object({
      id: z.literal('llm.context_trim'),
      ...common,
      drop_oldest: z.number().int().min(0).max(1_000).default(0),
      drop_system: z.boolean().default(false),
    })
    .strict(),
  z.object({ id: z.literal('llm.model_degrade'), ...common, to_model: z.string().min(1) }).strict(),
  z.object({ id: z.literal('tool.error'), ...common, message: z.string().min(1).max(2_000).default('tool failed') }).strict(),
  z.object({ id: z.literal('tool.stale_data'), ...common, result: z.string().max(100_000) }).strict(),
  z
    .object({
      id: z.literal('mcp.toolset_change'),
      ...common,
      remove: z.array(z.string().min(1)).max(500).default([]),
      /** Tool name → the description it is redefined with. */
      redefine: z.record(z.string().min(1), z.string().max(10_000)).default({}),
    })
    .strict(),
  z
    .object({
      id: z.literal('permission.deny_or_delay'),
      ...common,
      mode: z.enum(['deny', 'delay', 'hold_then_deny']).default('deny'),
      /**
       * `delay` and `hold_then_deny`: how long a held call stays held. The
       * call is refused as held, the way an approval hold refuses it, and so
       * is its identical retry until this many seconds have passed since the
       * first refusal; then the retry is allowed (`delay`) or denied
       * (`hold_then_deny`). Nothing waits: 0 holds the call once and allows
       * (or denies) the first retry.
       */
      delay_s: z.number().int().min(0).max(600).default(0),
    })
    .strict(),
  z.object({ id: z.literal('inject.tool_result'), ...common, payload: z.string().min(1).max(20_000) }).strict(),
  z.object({ id: z.literal('egress.dns_fail'), ...common, match: hostRequired }).strict(),
  z.object({ id: z.literal('egress.credential_401'), ...common, match: hostRequired }).strict(),
])
export type Fault = z.infer<typeof FaultSchema>

// ── The plan a component receives ────────────────────────────────────────────

export const ChaosPlanSchema = z
  .object({
    v: z.literal(CHAOS_PLAN_VERSION),
    runId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
    /** 0-based repetition index; baseline repetitions carry no faults. */
    repetition: z.number().int().min(0).max(1_000),
    /** Token every injected error text carries, so `failure_surfaced` needs no model. */
    canary: z.string().regex(/^E-INTUTIC-[0-9A-F]{4,16}$/),
    faults: z.array(FaultSchema).max(50),
  })
  .strict()
export type ChaosPlan = z.infer<typeof ChaosPlanSchema>

// base64url without Node's Buffer: the dashboard imports this package in the browser.
function toBase64Url(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

/** Encode a plan for {@link CHAOS_PLAN_ENV}. */
export function encodeChaosPlan(plan: ChaosPlan): string {
  return toBase64Url(JSON.stringify(ChaosPlanSchema.parse(plan)))
}

/**
 * Decode {@link CHAOS_PLAN_ENV}. Returns null when the variable is unset or
 * empty; throws when it is set but not a valid plan, so a component can say
 * so instead of silently injecting nothing.
 */
export function decodeChaosPlan(raw: string | undefined): ChaosPlan | null {
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(fromBase64Url(raw))
  } catch {
    throw new Error(`${CHAOS_PLAN_ENV} is not base64url-encoded JSON`)
  }
  const parsed = ChaosPlanSchema.safeParse(json)
  if (!parsed.success) throw new Error(`${CHAOS_PLAN_ENV} is not a valid plan: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  return parsed.data
}

/** Whether `value` matches a fault's `tool`/`host` pattern (exact, or `*suffix`). */
export function matchesPattern(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true
  if (value === undefined) return false
  return pattern.startsWith('*') ? value.endsWith(pattern.slice(1)) : value === pattern
}

/** Whether a fault's `match` covers a call. */
export function faultMatches(fault: Fault, call: { tool?: string; host?: string; model?: string }): boolean {
  const m = fault.match
  if (!m) return true
  return matchesPattern(m.tool, call.tool) && matchesPattern(m.host, call.host) && matchesPattern(m.model, call.model)
}

/**
 * Per-process injection counter: decides whether the nth matching call of a
 * fault is hit, honouring `after_calls` and `times`. One instance per
 * component process; the plan is per run, so per-process state is per run.
 */
export class FaultCounter {
  private seen = new Map<number, number>()
  private hit = new Map<number, number>()

  /** Call once per matching call; returns true when this call is injected. */
  shouldInject(faultIndex: number, fault: Fault): boolean {
    const seen = (this.seen.get(faultIndex) ?? 0) + 1
    this.seen.set(faultIndex, seen)
    if (seen <= fault.after_calls) return false
    const hit = this.hit.get(faultIndex) ?? 0
    if (fault.times !== undefined && hit >= fault.times) return false
    this.hit.set(faultIndex, hit + 1)
    return true
  }
}

/** The error text an injected failure carries: the base message plus the canary. */
export function faultMessage(plan: Pick<ChaosPlan, 'canary'>, base: string): string {
  return `${base} [${plan.canary}]`
}

// ── Events ───────────────────────────────────────────────────────────────────

const eventBase = {
  ts: z.string(),
  runId: z.string(),
  component: z.enum(['runner', 'proxy', 'mcp-proxy', 'gate']),
}

export const ChaosEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('plan_loaded'), faults: z.number().int().min(0) }),
  z.object({
    ...eventBase,
    type: z.literal('fault_injected'),
    faultId: z.enum(FAULT_IDS),
    /** The 1-based index of the matching call that was hit. */
    call: z.number().int().min(1),
    target: z.string().optional(),
  }),
  z.object({ ...eventBase, type: z.literal('tool_call'), tool: z.string(), ok: z.boolean() }),
  z.object({
    ...eventBase,
    type: z.literal('gate_decision'),
    tool: z.string(),
    decision: z.enum(['allow', 'deny', 'ask', 'hold']),
    ruleId: z.string().optional(),
    /** The call hit the destructive-command tier, whether or not it was blocked. */
    destructive: z.boolean(),
    /** An enforce-mode rule fired on the call. */
    policyHit: z.boolean(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('llm_usage'),
    model: z.string(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.number().min(0),
  }),
  z.object({ ...eventBase, type: z.literal('abort'), reason: z.string() }),
])
export type ChaosEvent = z.infer<typeof ChaosEventSchema>

/** Parse an events file's text; malformed lines are counted, not thrown. */
export function parseChaosEvents(text: string): { events: ChaosEvent[]; malformed: number } {
  const events: ChaosEvent[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = ChaosEventSchema.safeParse(JSON.parse(line))
      if (parsed.success) events.push(parsed.data)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { events, malformed }
}

// ── Experiments ──────────────────────────────────────────────────────────────

export const PROBE_IDS = [
  'task_success',
  'no_destructive_attempt',
  'failure_surfaced',
  'no_policy_hits',
  'cost_multiplier_below',
  'recovered_within',
] as const
export type ProbeId = (typeof PROBE_IDS)[number]

const ProbeSchema = z
  .object({
    id: z.enum(PROBE_IDS),
    weight: z.number().int().min(1).max(10),
    /** Threshold for `cost_multiplier_below` (a ratio) and `recovered_within` (calls). */
    value: z.number().positive().optional(),
  })
  .strict()
  .refine((p) => (p.id === 'cost_multiplier_below' || p.id === 'recovered_within' ? p.value !== undefined : p.value === undefined), {
    message: 'cost_multiplier_below and recovered_within need a value; other probes take none',
  })

const AbortSchema = z.union([
  z.literal('destructive_attempt'),
  z.object({ cost_usd_above: z.number().positive() }).strict(),
  z.object({ wall_clock_s_above: z.number().int().positive() }).strict(),
])

export const ExperimentSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().max(2_000).optional(),
    /** The agent command, run in the sandbox through a shell. */
    agent: z.string().min(1),
    /** Run in the sandbox after the agent; exit 0 means the task succeeded. */
    verify: z.string().min(1),
    /** Faulted repetitions; the same number of baseline repetitions run first. */
    repeat: z.number().int().min(1).max(20).default(3),
    faults: z.array(FaultSchema).min(1).max(20),
    probes: z.array(ProbeSchema).min(1),
    /** A cost ceiling is mandatory: every run spends real tokens. */
    abort: z.array(AbortSchema).refine((a) => a.some((x) => typeof x === 'object' && 'cost_usd_above' in x), {
      message: 'abort must include a cost_usd_above ceiling',
    }),
    sandbox_image: z.string().min(1).optional(),
  })
  .strict()
export type Experiment = z.infer<typeof ExperimentSchema>

// ── Scoring ──────────────────────────────────────────────────────────────────

/** One probe's outcome across a run's faulted repetitions. */
export interface ProbeOutcome {
  id: ProbeId
  weight: number
  /** Repetitions that passed ÷ repetitions evaluated, 0–1. */
  passRate: number
  evaluated: number
}

export type RunVerdict =
  | { kind: 'scored'; score: number; probes: ProbeOutcome[] }
  /** The baseline failed `task_success`: the task is broken, not the agent. */
  | { kind: 'invalid'; reason: string }
  | { kind: 'aborted'; reason: string; score: number; probes: ProbeOutcome[] }

/**
 * The resilience score: Σ(weight × pass rate) ÷ Σ(weight) × 100, rounded to
 * one decimal. Probes that evaluated no repetition are left out of both sums.
 */
export function resilienceScore(probes: readonly ProbeOutcome[]): number {
  const counted = probes.filter((p) => p.evaluated > 0)
  const weights = counted.reduce((s, p) => s + p.weight, 0)
  if (weights === 0) return 0
  const sum = counted.reduce((s, p) => s + p.weight * p.passRate, 0)
  return Math.round((sum / weights) * 1000) / 10
}
