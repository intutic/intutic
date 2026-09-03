/**
 * Guardrail IR — the only thing a policy compiler may say (LLD #71).
 *
 * An LLM reading corporate policy prose is allowed to propose exactly two
 * things: a verbatim quote anchored to a passage it was shown, and a clause in
 * this closed IR. Everything after that is deterministic code: the validator
 * (`services/control-plane/src/lib/guardrailValidator.ts`) checks the quote by
 * containment and the IR against the grammar the proxy and the harness gates
 * already enforce, the renderers in `./guardrailRender.ts` turn it into the
 * exact bytes those enforcers read, and cross-language parity fixtures prove
 * the renderers and the Rust / gate-script parsers agree.
 *
 * The grammar is a subset of what a human may author, on purpose:
 *
 * - `hook_rule` — a per-call condition on a tool and its arguments, enforced
 *   by the sync daemon's emitted harness gate scripts. Regexes are never model
 *   output: the tool pattern is rendered from literal tool tokens and the
 *   argument pattern from literal substrings (`argContains` / `argNotContains`),
 *   escaped and composed as lookaheads — the dialect JS `RegExp` and Python
 *   `re` share, so the bash gates' `python3` clause and the JS gates agree.
 * - the six union-safe SOP front-matter keys the Rust proxy enforces
 *   (`deny_tools`, `review_before`, `requires_before`, `forbid_after`,
 *   `max_calls`, `forbid_with`). `~>` adjacency is not offered; `->` only.
 * - `wasm_predicate` — the existing closed predicate DSL, verdict 3 (reask)
 *   only. A generated rule can never originate a block.
 * - `none` — "this passage contains no enforceable rule", so the corpus can
 *   measure over-generation.
 *
 * Deliberately absent: the three allowlist keys (`allow_harnesses`,
 * `plan_steps`, `scope_paths` — intersection-composed, empty-means-unrestricted;
 * a generated allowlist can silently deny everything), raw regexes, raw
 * AssemblyScript, `BLOCK:` titles, DLP patterns, SSL graphs, verdict 1, OR.
 *
 * Structural impossibilities match the Rust parser's own refusals: a token with
 * whitespace (a shell command) cannot exist, a `forbid_with` taint is an enum,
 * and an ordering rule is one pair.
 *
 * @module
 */

import { z } from 'zod'
import { validatePredicate } from './rulePredicateDsl.js'

/**
 * The eight `action:` tokens the proxy's classifier synthesises from tool
 * calls. Moved here from `services/control-plane/src/services/learnedHoldService.ts`
 * so the IR, the validator and the hold miner read one list; that file
 * re-exports it. A token outside this set and outside the observed tool names
 * compiles into a control that can never fire.
 */
export const ACTION_TOKENS = [
  'action:deploy',
  'action:publish',
  'action:release',
  'action:db_write',
  'action:secret_read',
  'action:http_post',
  'action:pii_export',
  'action:run_tests',
] as const

export type ActionToken = (typeof ACTION_TOKENS)[number]

export function isActionToken(value: string): value is ActionToken {
  return (ACTION_TOKENS as readonly string[]).includes(value)
}

/**
 * A tool name the harness could plausibly call: `Bash`, `run_command`,
 * `mcp__github__create_issue`, `developer__shell`. No whitespace, so a shell
 * command can never be mistaken for a tool (sops.rs `parse_ordering` refuses
 * the same shape for the same reason). `.`, `:` and `-` are allowed because
 * namespaced harness tools carry them.
 */
export const TOOL_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

export const MAX_HOOK_TOOLS = 8
export const MAX_LIST_TOKENS = 16
export const MAX_LITERALS = 4
export const MAX_LITERAL_CHARS = 64
export const MAX_ROLES = 8
export const MAX_TITLE_CHARS = 80
export const MAX_RATIONALE_CHARS = 480
export const MAX_CALLS_LIMIT = 1000

const Token = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => isActionToken(v) || TOOL_TOKEN_RE.test(v), {
    message: 'a token is a tool name (`Bash`, `mcp__github__create_issue`) or one of the eight `action:` tokens — never a command',
  })

/**
 * A literal substring of the serialised tool input. No tab or newline (the
 * `.rules` snapshot is line- and tab-delimited), and no `"` or `\` — those
 * are JSON-escaped in the haystack the gates match against, so a literal
 * containing them could never match the bytes it was written for.
 */
const Literal = z
  .string()
  .min(1)
  .max(MAX_LITERAL_CHARS)
  .refine((v) => !/[\t\r\n"\\]/.test(v), {
    message: 'a literal may not contain a tab, newline, double quote or backslash',
  })

const Roles = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'a role is lower-case: `deployer`, `reviewer`'))
  .max(MAX_ROLES)
  .optional()

const Title = z.string().min(1).max(MAX_TITLE_CHARS)
const Rationale = z.string().max(MAX_RATIONALE_CHARS)

const HookRuleSchema = z
  .object({
    kind: z.literal('hook_rule'),
    title: Title,
    tools: z.array(Token).min(1).max(MAX_HOOK_TOOLS),
    argContains: z.array(Literal).max(MAX_LITERALS).optional(),
    argNotContains: z.array(Literal).max(MAX_LITERALS).optional(),
    roles: Roles,
  })
  .strict()

const DenyToolsSchema = z
  .object({ kind: z.literal('deny_tools'), tools: z.array(Token).min(1).max(MAX_LIST_TOKENS), roles: Roles })
  .strict()

const ReviewBeforeSchema = z
  .object({ kind: z.literal('review_before'), tokens: z.array(Token).min(1).max(MAX_LIST_TOKENS), roles: Roles })
  .strict()

const orderingShape = {
  first: Token,
  then: Token,
  roles: Roles,
}

// Discriminated-union members must be plain objects, so the two cross-field
// rules (ordering tokens differ; a wasm predicate validates) are applied in
// `validateGuardrailIr` after the shape parse rather than as refinements here.
const RequiresBeforeSchema = z.object({ kind: z.literal('requires_before'), ...orderingShape }).strict()

const ForbidAfterSchema = z.object({ kind: z.literal('forbid_after'), ...orderingShape }).strict()

const MaxCallsSchema = z
  .object({
    kind: z.literal('max_calls'),
    token: Token,
    limit: z.number().int().min(1).max(MAX_CALLS_LIMIT),
    roles: Roles,
  })
  .strict()

const ForbidWithSchema = z
  .object({
    kind: z.literal('forbid_with'),
    taint: z.enum(['secrets()', 'pii()']),
    token: Token,
    roles: Roles,
  })
  .strict()

const WasmPredicateSchema = z
  .object({
    kind: z.literal('wasm_predicate'),
    title: Title,
    rationale: Rationale,
    predicate: z.unknown(),
    verdict: z.literal(3),
    roles: Roles,
  })
  .strict()

const NoneSchema = z.object({ kind: z.literal('none'), reason: Rationale }).strict()

export const GuardrailIrSchema = z.discriminatedUnion('kind', [
  HookRuleSchema,
  DenyToolsSchema,
  ReviewBeforeSchema,
  RequiresBeforeSchema,
  ForbidAfterSchema,
  MaxCallsSchema,
  ForbidWithSchema,
  WasmPredicateSchema,
  NoneSchema,
])

export type GuardrailIr = z.infer<typeof GuardrailIrSchema>
export type HookRuleIr = z.infer<typeof HookRuleSchema>
export type WasmPredicateIr = z.infer<typeof WasmPredicateSchema>
export type FrontMatterIr = Extract<GuardrailIr, { kind: 'deny_tools' | 'review_before' | 'requires_before' | 'forbid_after' | 'max_calls' | 'forbid_with' }>
export type IrKind = GuardrailIr['kind']

/** Every kind, in one place, for the lint gate (`check-guardrail-ir-keys.js`). */
export const IR_KINDS = [
  'hook_rule',
  'deny_tools',
  'review_before',
  'requires_before',
  'forbid_after',
  'max_calls',
  'forbid_with',
  'wasm_predicate',
  'none',
] as const

/** The kinds that render to a SOP front-matter key the Rust proxy reads. */
export const FRONT_MATTER_KINDS = [
  'deny_tools',
  'review_before',
  'requires_before',
  'forbid_after',
  'max_calls',
  'forbid_with',
] as const

export function isFrontMatterIr(ir: GuardrailIr): ir is FrontMatterIr {
  return (FRONT_MATTER_KINDS as readonly string[]).includes(ir.kind)
}

export type IrValidation = { ok: true; ir: GuardrailIr } | { ok: false; reason: string }

/**
 * Parse an untrusted value into the IR, or say why it is not one. Never
 * throws. This — not `GuardrailIrSchema.parse` — is the entry point: the
 * shape parse cannot express "the two ordering tokens differ" or "the wasm
 * predicate is in the closed DSL", so both are checked here.
 */
export function validateGuardrailIr(value: unknown): IrValidation {
  const parsed = GuardrailIrSchema.safeParse(value)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return { ok: false, reason: `${where}${first?.message ?? 'not a guardrail IR'}` }
  }
  const ir = parsed.data
  if ((ir.kind === 'requires_before' || ir.kind === 'forbid_after') && ir.first === ir.then) {
    return { ok: false, reason: `${ir.kind}: an ordering rule needs two different tokens` }
  }
  if (ir.kind === 'wasm_predicate') {
    try {
      validatePredicate(ir.predicate)
    } catch (err) {
      return { ok: false, reason: `predicate: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: true, ir }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * The identity of a control, as a stable string.
 *
 * Two proposals that name the same control from the same passage are one
 * proposal — `policy_clauses` is unique on `(passage_hash, ir_canonical)` —
 * so the title and rationale, which change nothing about what is enforced,
 * are not part of it. Lists are sorted and deduplicated; roles are lower-case
 * (the proxy lowercases them too); tool tokens keep their case (the proxy
 * matches `Bash` case-sensitively).
 */
export function canonicalizeIr(ir: GuardrailIr): string {
  const roles = ir.kind === 'none' ? undefined : ir.roles && ir.roles.length ? uniqueSorted(ir.roles.map((r) => r.toLowerCase())) : undefined
  let core: Record<string, unknown>
  switch (ir.kind) {
    case 'hook_rule':
      core = {
        tools: uniqueSorted(ir.tools),
        argContains: uniqueSorted(ir.argContains ?? []),
        argNotContains: uniqueSorted(ir.argNotContains ?? []),
      }
      break
    case 'deny_tools':
      core = { tools: uniqueSorted(ir.tools) }
      break
    case 'review_before':
      core = { tokens: uniqueSorted(ir.tokens) }
      break
    case 'requires_before':
    case 'forbid_after':
      core = { first: ir.first, then: ir.then }
      break
    case 'max_calls':
      core = { token: ir.token, limit: ir.limit }
      break
    case 'forbid_with':
      core = { taint: ir.taint, token: ir.token }
      break
    case 'wasm_predicate':
      core = { predicate: ir.predicate, verdict: ir.verdict }
      break
    case 'none':
      core = {}
      break
  }
  return JSON.stringify({ kind: ir.kind, ...core, ...(roles ? { roles } : {}) }, sortedKeys)
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
  return value
}

/** Every token (tool or action) an IR names — the set a validator must find in the cited passage. */
export function irTokens(ir: GuardrailIr): string[] {
  switch (ir.kind) {
    case 'hook_rule':
    case 'deny_tools':
      return [...ir.tools]
    case 'review_before':
      return [...ir.tokens]
    case 'requires_before':
    case 'forbid_after':
      return [ir.first, ir.then]
    case 'max_calls':
    case 'forbid_with':
      return [ir.token]
    case 'wasm_predicate':
    case 'none':
      return []
  }
}
