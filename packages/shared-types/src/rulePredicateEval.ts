/**
 * The TypeScript reading of a predicate — the same arithmetic `renderRule`
 * emits, evaluated over a stored context snapshot instead of compiled.
 *
 * Used where a compiled bundle does not exist yet: picking a block mock and
 * a near-miss for a policy-cited candidate (`/mocks` in citation mode) and
 * previewing "N of M captured contexts would have fired" for a `wasm_rule`
 * guardrail before anyone compiles anything. It decides nothing about
 * enforcement: the compiled rule is what the proxy runs, and the bundle
 * gates (`discriminates`, `historical_replay`) still run the real binary.
 *
 * Parity with the binary is pinned in
 * `packages/wasm-sdk/__tests__/generatedRules.test.ts`, which asserts this
 * function and the compiled module agree on every semantic case. That test
 * is the reason this file mirrors the guest's *defaults* as well as its
 * operators: a field the snapshot does not carry reads as `""`, `0`, `-1`
 * (optional numerics), `[]` or `false`, exactly as `readContext` leaves it.
 *
 * @module
 */

import { FIELDS, validatePredicate, type Condition, type Predicate } from './rulePredicateDsl.js'

/** Read one field out of a snapshot the way the guest parser would. */
function readField(ctx: Record<string, unknown>, field: string): string | number | boolean | string[] {
  const kind = FIELDS[field]
  const v = ctx[field]
  switch (kind) {
    case 'string':
      return typeof v === 'string' ? v : ''
    case 'int':
      // The guest reads an i32; a JSON decimal on an integer field truncates.
      return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
    case 'float':
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    case 'optionalFloat':
      return typeof v === 'number' && Number.isFinite(v) ? v : -1
    case 'optionalInt':
      return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : -1
    case 'stringList':
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    case 'bool':
      return v === true
    default:
      // Unreachable for a validated predicate; a caller that skipped
      // validation gets the same answer the guest gives an unknown field.
      return ''
  }
}

/** One condition, evaluated with the same guards `renderCondition` emits. */
function holds(c: Condition, ctx: Record<string, unknown>): boolean {
  const v = readField(ctx, c.field)
  const optional = String(FIELDS[c.field] ?? '').startsWith('optional')
  switch (c.op) {
    case 'equals':
      return v === String(c.value)
    case 'notEquals':
      return v !== String(c.value)
    case 'isTrue':
      return v === true
    case 'isFalse':
      return v === false
    case 'contains':
      return Array.isArray(v) && v.includes(String(c.value))
    case 'notContains':
      return !(Array.isArray(v) && v.includes(String(c.value)))
    case 'listEmpty':
      return Array.isArray(v) && v.length === 0
    case 'listNotEmpty':
      return Array.isArray(v) && v.length > 0
    case 'atLeast': {
      const n = typeof v === 'number' ? v : 0
      return optional ? n !== -1 && n >= Number(c.value) : n >= Number(c.value)
    }
    case 'atMost': {
      const n = typeof v === 'number' ? v : 0
      return optional ? n !== -1 && n <= Number(c.value) : n <= Number(c.value)
    }
    case 'exceedsField': {
      // Both sides must be known, and a zero budget means unbounded — the
      // four conjuncts the renderer writes, in the same order.
      const n = typeof v === 'number' ? v : -1
      const other = readField(ctx, String(c.value))
      const o = typeof other === 'number' ? other : -1
      return n !== -1 && o !== -1 && o !== 0 && n >= o
    }
    default:
      return false
  }
}

/**
 * Does this predicate fire on this snapshot? `true` means the compiled rule
 * would return its verdict; `false` means it would return 0 (allow).
 *
 * Does not validate: call {@link compilePredicate} to validate once and
 * evaluate many times, or `validatePredicate` yourself first.
 */
export function evaluatePredicate(predicate: Predicate, ctx: Record<string, unknown>): boolean {
  return predicate.all.every((c) => holds(c, ctx))
}

/**
 * Validate once, evaluate many. Throws `PredicateError` on anything outside
 * the vocabulary — the same refusal `renderRule` gives — so a stored
 * predicate that could not compile never reads as "fires on nothing".
 */
export function compilePredicate(predicate: unknown): (ctx: Record<string, unknown>) => boolean {
  validatePredicate(predicate)
  return (ctx) => evaluatePredicate(predicate, ctx)
}

/** Every string literal a predicate compares against; what a citation must ground. */
export function predicateStringValues(predicate: Predicate): string[] {
  const out: string[] = []
  for (const c of predicate.all) {
    if (c.op === 'exceedsField') continue
    if (typeof c.value === 'string') out.push(c.value)
  }
  return [...new Set(out)]
}
