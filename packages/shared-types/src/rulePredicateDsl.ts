/**
 * The closed-vocabulary predicate language, and its deterministic renderer.
 *
 * A generated rule is described here as JSON and turned into AssemblyScript by
 * `renderRule`. **The generator never emits AssemblyScript.** That boundary is
 * the whole design, and it exists because the starter rule library encodes three
 * inversions an LLM writing source would reintroduce:
 *
 *   - `-1` means **unknown**, not zero. A rule written
 *     `if (spend > budget)` reads unknown as "under budget"; one written
 *     `if (remaining < 10)` reads it as "broke" and blocks every request
 *     outside a workflow.
 *   - An **empty** allowlist means unrestricted, not "permit nothing". Reading
 *     it the other way blocks every request in a workspace that never declared
 *     one.
 *   - `new_tool_calls` is this turn's delta; `tool_sequence` is the whole
 *     session. Matching a hold against history re-fires it forever.
 *
 * Each of those is a one-token difference in source and a *structural*
 * impossibility in the DSL: there is no operator that compares an optional
 * numeric without the unknown check, and `listEmpty` is spelled differently from
 * `notIn`.
 *
 * ## Closed by construction
 *
 * `FIELDS` below is the vocabulary. A field the guest parser does not read
 * cannot be named, so a predicate cannot reference something that will silently
 * be zero at runtime — the shape that produced every inert control in this
 * codebase. `check-rule-dsl-fields.js` asserts the table against the SDK's real
 * parser.
 *
 * @module
 */

/** Types the DSL can reason about, mapped to what the guest exposes. */
export type FieldKind = 'string' | 'int' | 'float' | 'optionalFloat' | 'optionalInt' | 'stringList' | 'bool'

/**
 * Every field a predicate may name, with the guest type it resolves to.
 *
 * Derived by hand from `packages/wasm-sdk/assembly/index.ts` and gated against
 * it. Deliberately excludes the structured lists (`tools`, `tool_calls`,
 * `changes`, `tool_call_counts`, the four SOP rule arrays) — comparing those
 * needs operators this vocabulary does not have, and half-supporting them
 * would let a generator produce a predicate that renders to something that
 * always evaluates false.
 */
export const FIELDS: Record<string, FieldKind> = {
  model: 'string',
  harness: 'string',
  risk_tier: 'string',
  agent_role: 'string',
  estimated_input_tokens: 'int',
  depth: 'int',
  graph_node_count: 'int',
  calls_last_60s: 'int',
  budget_remaining_usd: 'float',
  // Optional numerics arrive as -1 when the host has nothing to send. The
  // `optional` kinds are what force an unknown check into the rendered source.
  graph_spend_usd: 'optionalFloat',
  graph_budget_usd: 'optionalFloat',
  workflow_spend_usd: 'optionalFloat',
  workflow_budget_usd: 'optionalFloat',
  parent_alive: 'optionalInt',
  tool_sequence: 'stringList',
  new_tool_calls: 'stringList',
  injection_findings: 'stringList',
  injection_sources: 'stringList',
  denied_tools: 'stringList',
  allowed_harnesses: 'stringList',
  review_before: 'stringList',
  plan_steps: 'stringList',
  scope_paths: 'stringList',
  tool_contract_changed: 'bool',
}

/** Operators, each valid only for certain field kinds. */
export const OPERATORS = {
  equals: ['string'],
  notEquals: ['string'],
  isTrue: ['bool'],
  isFalse: ['bool'],
  /** Membership in this turn's delta or the session history. */
  contains: ['stringList'],
  notContains: ['stringList'],
  /** The empty-list-means-unrestricted case, spelled so it cannot be confused. */
  listEmpty: ['stringList'],
  listNotEmpty: ['stringList'],
  /**
   * `atLeast` / `atMost` on an optional numeric render WITH the unknown guard.
   * There is no operator that compares one without it.
   */
  atLeast: ['int', 'float', 'optionalFloat', 'optionalInt'],
  atMost: ['int', 'float', 'optionalFloat', 'optionalInt'],
  /** Compares two optional numerics; unknown on either side yields false. */
  exceedsField: ['optionalFloat'],
} as const

export type Operator = keyof typeof OPERATORS

export interface Condition {
  field: string
  op: Operator
  /** Absent for `isTrue`/`isFalse`/`listEmpty`/`listNotEmpty`. */
  value?: string | number
}

export interface Predicate {
  /** Conditions are ANDed. Deliberately no OR: a rule that fires for two
   *  unrelated reasons is two rules, and shadow evidence for one of them says
   *  nothing about the other. */
  all: Condition[]
}

export class PredicateError extends Error {}

/** Rejects anything the vocabulary does not permit, with the reason. */
export function validatePredicate(p: unknown): asserts p is Predicate {
  if (!p || typeof p !== 'object' || !Array.isArray((p as Predicate).all)) {
    throw new PredicateError('predicate must be { all: Condition[] }')
  }
  const all = (p as Predicate).all
  if (all.length === 0) {
    throw new PredicateError(
      'predicate has no conditions, so it would fire on every request',
    )
  }
  if (all.length > 8) {
    throw new PredicateError(
      `predicate has ${all.length} conditions; more than 8 is not a rule anyone can review`,
    )
  }
  for (const c of all) {
    const kind = FIELDS[c.field]
    if (!kind) {
      throw new PredicateError(
        `"${c.field}" is not a field a rule may read. A predicate naming a field ` +
          'the guest does not parse renders to a comparison against a default, ' +
          'which is a rule that silently never fires.',
      )
    }
    const allowed = (OPERATORS as Record<string, readonly string[]>)[c.op]
    if (!allowed) throw new PredicateError(`"${c.op}" is not an operator`)
    if (!allowed.includes(kind)) {
      throw new PredicateError(
        `"${c.op}" cannot apply to ${c.field}, which is ${kind}`,
      )
    }
    const needsValue = !['isTrue', 'isFalse', 'listEmpty', 'listNotEmpty'].includes(c.op)
    if (needsValue && (c.value === undefined || c.value === null)) {
      throw new PredicateError(`"${c.op}" on ${c.field} needs a value`)
    }
    if (!needsValue && c.value !== undefined) {
      throw new PredicateError(`"${c.op}" on ${c.field} takes no value`)
    }
    if (needsValue) {
      // `exceedsField` compares two fields, so its value is a field NAME even
      // though the field it applies to is numeric. Checked before the type rule
      // below, which would otherwise reject every valid use of it.
      if (c.op === 'exceedsField') {
        if (typeof c.value !== 'string' || !FIELDS[c.value]) {
          throw new PredicateError(
            `exceedsField must name a field; "${String(c.value)}" is not one`,
          )
        }
        if (!String(FIELDS[c.value]).startsWith('optional')) {
          throw new PredicateError(
            `exceedsField compares two optional numerics; ${String(c.value)} is ${FIELDS[c.value]}`,
          )
        }
        continue
      }
      const numeric = ['int', 'float', 'optionalFloat', 'optionalInt'].includes(kind)
      if (numeric && typeof c.value !== 'number') {
        throw new PredicateError(`${c.field} is numeric; "${String(c.value)}" is not`)
      }
      if (!numeric && typeof c.value !== 'string') {
        throw new PredicateError(`${c.field} is textual; ${String(c.value)} is not`)
      }
    }
  }
}

/** AssemblyScript string literal. Never interpolate a value without this. */
function lit(v: string): string {
  return JSON.stringify(v)
}

/**
 * One condition as an AssemblyScript expression.
 *
 * The optional-numeric arms carry their own `!= -1` guard, which is why the DSL
 * has no bare comparison operator for them: the guard cannot be forgotten
 * because there is no way to express the comparison without it.
 */
function renderCondition(c: Condition): string {
  const f = `ctx.${c.field}`
  switch (c.op) {
    case 'equals':
      return `${f} == ${lit(String(c.value))}`
    case 'notEquals':
      return `${f} != ${lit(String(c.value))}`
    case 'isTrue':
      return f
    case 'isFalse':
      return `!${f}`
    case 'contains':
      return `listHas(${f}, ${lit(String(c.value))})`
    case 'notContains':
      return `!listHas(${f}, ${lit(String(c.value))})`
    case 'listEmpty':
      return `${f}.length == 0`
    case 'listNotEmpty':
      return `${f}.length > 0`
    case 'atLeast':
      return FIELDS[c.field].startsWith('optional')
        ? `(${f} != -1 && ${f} >= ${c.value})`
        : `${f} >= ${c.value}`
    case 'atMost':
      return FIELDS[c.field].startsWith('optional')
        ? `(${f} != -1 && ${f} <= ${c.value})`
        : `${f} <= ${c.value}`
    case 'exceedsField': {
      const other = `ctx.${String(c.value)}`
      // Both sides must be known. Unknown on either yields false, never a block.
      return `(${f} != -1 && ${other} != -1 && ${other} != 0 && ${f} >= ${other})`
    }
  }
}

/** Verdict codes the renderer will emit. 2 is deprecated and refused. */
export const RENDERABLE_VERDICTS = [1, 3] as const

/**
 * Renders a validated predicate to standalone AssemblyScript.
 *
 * Deterministic: the same predicate always produces byte-identical source, so a
 * candidate's compiled hash is reproducible and a reviewer diffing two versions
 * sees only what actually changed.
 */
export function renderRule(input: {
  predicate: Predicate
  verdict: number
  title: string
  rationale: string
  candidateId: string
}): string {
  validatePredicate(input.predicate)
  if (!(RENDERABLE_VERDICTS as readonly number[]).includes(input.verdict)) {
    throw new PredicateError(
      `verdict ${input.verdict} is not renderable. 1 blocks, 3 reasks; 0 would be a ` +
        'rule that does nothing and 2 is deprecated — the proxy maps it to a block.',
    )
  }

  const conditions = input.predicate.all.map(renderCondition)
  // One condition per line, ANDed. Formatted rather than joined into one
  // expression so a reviewer can read the generated source at all.
  const expr = conditions.map((c) => `    ${c}`).join(' &&\n')

  // Comments carry no backticks or ${: this string is assembled here, but the
  // title and rationale come from a generator and must not be able to terminate
  // anything downstream. JSON-encoding them makes that structural.
  //
  // That goes for the candidate id too, which was the one field interpolated
  // raw while the comment above claimed all three were encoded. A `//` comment
  // is terminated by a newline, so an id carrying one moved whatever followed it
  // onto a line of its own — as AssemblyScript, in a file about to be compiled
  // and loaded as a policy rule. Only tests construct ids today, which is what
  // made it latent rather than live.
  return `// Generated by Intutic from reviewed decisions. Do not edit.
//
// Candidate: ${JSON.stringify(input.candidateId)}
// Title:     ${JSON.stringify(input.title)}
// Rationale: ${JSON.stringify(input.rationale)}
//
// Rendered deterministically from a closed-vocabulary predicate; the generator
// does not write AssemblyScript. Verdict ${input.verdict} — 1 blocks, 3 reasks.
import { RequestContext, readContext } from "../../assembly/index";

export { allocate } from "../../assembly/index";

function listHas(xs: string[], needle: string): bool {
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] == needle) return true;
  }
  return false;
}

export function rule(ctx: RequestContext): i32 {
  if (
${expr}
  ) {
    return ${input.verdict};
  }
  return 0;
}

export function evaluate(offset: i32, len: i32): i32 {
  return rule(readContext(offset, len));
}
`
}
