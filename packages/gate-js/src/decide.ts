/**
 * Decide rules: the grammar, the validator and the semantics.
 *
 * A decide rule asks a self-hosted model a few narrow `yes_no` or `choice`
 * questions about a tool call or a model response, turns each answer's
 * probability into yes, no or unknown through a band, and combines the
 * answers with the rule's `when` expression in Kleene three-valued logic:
 * true refuses, false allows, unknown escalates. It is written as one SOP
 * front-matter line, `decide: {json}`, one rule per line, the way a
 * `hook_rule:` line is.
 *
 * This module is the pure part every layer shares:
 *
 * - {@link parseDecideLine} and {@link validateDecideRule}: the shape and the
 *   eight ordered checks, each failure with one fixed reason;
 * - {@link parseWhen} and {@link canonicalWhen}: the `when` grammar and its
 *   fully parenthesised form, `!=` and `IN` rewritten;
 * - {@link decideHashInput}: the canonical JSON the rule hash is taken over,
 *   which leaves out `id`, `title`, `escalate` and `rollout`;
 * - {@link bandValue}, {@link choiceOrders}, {@link choiceAtoms}, the Kleene
 *   connectives, {@link decideRuleOutcome} and {@link decideCallOutcome}.
 *
 * Self-contained (no imports, no module state) so `@intutic/gate` can carry
 * a byte-identical copy (`packages/gate-js/src/decide.ts`). The proxy's port
 * is `packages/proxy/src/decide/mod.rs` and the Python gate's is
 * `intutic_clawde/gate/decide.py`; all of them run
 * `fixtures/decide-vectors.json` and must give the same answer, reason text
 * included. The SHA-256 is passed in ({@link decideRuleHash}), because this
 * file also runs where `node:crypto` does not.
 *
 * @module
 */

// ─── Limits ───────────────────────────────────────────────────────────

export const DECIDE_MAX_QUESTIONS = 8
export const DECIDE_MAX_OPTIONS = 8
export const DECIDE_MAX_RULES_PER_CALL = 4
export const DECIDE_MAX_WHEN_CHARS = 256
export const DECIDE_MIN_ASK_CHARS = 8
export const DECIDE_MAX_ASK_CHARS = 300
export const DECIDE_DEFAULT_BAND: DecideBand = { yes_at: 0.85, no_below: 0.15 }
/** Appended to every `choice` question's options when absent, and always asked last. */
export const NONE_OF_THESE = 'none_of_these'

// The same values as `TOOL_TOKEN_RE`, `MAX_HOOK_TOOLS` and `MAX_TITLE_CHARS`
// in `guardrailIr.ts`; a test holds them equal.
const TOOL_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const MAX_TOOLS = 8
const MAX_TITLE = 80
const RULE_ID = /^[a-z][a-z0-9_-]{0,47}$/
const NAME = /^[a-z][a-z0-9_]{0,31}$/
const KEYWORDS = ['AND', 'OR', 'NOT', 'IN']

/**
 * A question that asks about approval. Approval comes from the harness's ask
 * or the review queue, never from a model reading text, so the validator
 * refuses such a question (check 8). ASCII word boundaries and case folding,
 * as JavaScript, Python's `re.ASCII` and Rust's `(?-u)` all read it.
 */
export const DECIDE_APPROVAL_RE = /\b(approv\w*|authori[sz]\w*|pre-?approv\w*|consent\w*|permi(t|ssion)\w*|sign(ed)?[- ]off)\b/i

// ─── Types ────────────────────────────────────────────────────────────

export interface DecideBand {
  yes_at: number
  no_below: number
}

export interface DecideQuestion {
  type: 'yes_no' | 'choice'
  ask: string
  /** `choice` only, as written; {@link decideOptions} places `none_of_these`. */
  options?: string[]
  band?: DecideBand
}

/** A rule as its front-matter line carries it: the IR without `kind`. */
export interface DecideRule {
  id: string
  title?: string
  on: 'tool_call' | 'response'
  tools?: string[]
  questions: Record<string, DecideQuestion>
  when: string
  band?: DecideBand
  escalate?: 'ask' | 'review' | 'refuse'
  rollout?: 'shadow' | 'enforce'
  context?: Array<'last_user_turn'>
}

/** A parsed `when`, with `!=` and `IN` already rewritten. */
export type DecideExpr =
  | { op: 'yes'; q: string }
  | { op: 'eq'; q: string; o: string }
  | { op: 'not'; a: DecideExpr }
  | { op: 'and' | 'or'; a: DecideExpr; b: DecideExpr }

export type DecideValidation = { ok: true; rule: DecideRule; expr: DecideExpr } | { ok: false; reason: string }

/** A `decide:` line, read or not. An unreadable line is kept, never dropped: it refuses what it would have judged. */
export type DecideDecl = { kind: 'rule'; rule: DecideRule; expr: DecideExpr } | { kind: 'unreadable'; id: string | null; error: string }

// ─── Shape ────────────────────────────────────────────────────────────

const RULE_FIELDS = ['id', 'title', 'on', 'tools', 'questions', 'when', 'band', 'escalate', 'rollout', 'context']
const QUESTION_FIELDS = ['type', 'ask', 'options', 'band']
const BAND_FIELDS = ['yes_at', 'no_below']

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** An own, defined property: `in` would also see `Object.prototype`, and an `undefined` field is an absent one. */
function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && (obj as Record<string, unknown>)[key] !== undefined
}

function own<T>(obj: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

/** Length in code points, as Python's `len` and Rust's `chars().count()` measure it. */
function codePoints(s: string): number {
  return Array.from(s).length
}

function unknownField(obj: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k) && obj[k] !== undefined)
    .sort()[0]
}

function bandShape(v: unknown, path: string): string | null {
  if (!isObject(v)) return `${path} must be an object`
  const extra = unknownField(v, BAND_FIELDS)
  if (extra !== undefined) return `${path}: unknown field ${extra}`
  if (!has(v, 'yes_at')) return `${path}.yes_at is required`
  if (typeof v.yes_at !== 'number' || !(v.yes_at > 0.5 && v.yes_at < 1)) return `${path}.yes_at must be above 0.5 and below 1`
  if (!has(v, 'no_below')) return `${path}.no_below is required`
  if (typeof v.no_below !== 'number' || !(v.no_below > 0)) return `${path}.no_below must be above 0`
  return null
}

function questionShape(name: string, v: unknown): string | null {
  const path = `questions.${name}`
  if (!isObject(v)) return `${path} must be an object`
  const extra = unknownField(v, QUESTION_FIELDS)
  if (extra !== undefined) return `${path}: unknown field ${extra}`
  if (!has(v, 'type')) return `${path}.type is required`
  if (v.type !== 'yes_no' && v.type !== 'choice') return `${path}.type must be yes_no or choice`
  if (!has(v, 'ask')) return `${path}.ask is required`
  const ask = v.ask
  if (typeof ask !== 'string' || codePoints(ask) < DECIDE_MIN_ASK_CHARS || codePoints(ask) > DECIDE_MAX_ASK_CHARS || /[\t\r\n]/.test(ask)) {
    return `${path}.ask must be ${DECIDE_MIN_ASK_CHARS} to ${DECIDE_MAX_ASK_CHARS} characters with no tab or newline`
  }
  if (v.type === 'yes_no') {
    if (has(v, 'options')) return `${path}.options applies to choice questions only`
  } else {
    if (!has(v, 'options')) return `${path}.options is required for a choice question`
    const options = v.options
    if (!Array.isArray(options)) return `${path}.options must be a list`
    if (options.length < 2 || options.length > DECIDE_MAX_OPTIONS) return `${path}.options lists 2 to ${DECIDE_MAX_OPTIONS} options`
    for (let i = 0; i < options.length; i++) {
      const o = options[i]
      if (typeof o !== 'string' || !NAME.test(o)) return `${path}.options[${i}] is not an option name`
      if (options.indexOf(o) !== i) return `${path}.options[${i}] repeats ${o}`
    }
  }
  if (has(v, 'band')) return bandShape(v.band, `${path}.band`)
  return null
}

function ruleShape(v: unknown): string | null {
  if (!isObject(v)) return 'a rule is a JSON object'
  const extra = unknownField(v, RULE_FIELDS)
  if (extra !== undefined) return `unknown field ${extra}`

  if (!has(v, 'id')) return 'id is required'
  if (typeof v.id !== 'string' || !RULE_ID.test(v.id)) return 'id must be a lower-case letter, then up to 47 of a-z, 0-9, _ or -'

  if (has(v, 'title')) {
    const t = v.title
    if (typeof t !== 'string' || codePoints(t) < 1 || codePoints(t) > MAX_TITLE || /[\t\r\n]/.test(t)) {
      return `title must be 1 to ${MAX_TITLE} characters with no tab or newline`
    }
  }

  if (!has(v, 'on')) return 'on is required'
  if (v.on !== 'tool_call' && v.on !== 'response') return 'on must be tool_call or response'

  if (has(v, 'tools')) {
    const tools = v.tools
    if (!Array.isArray(tools)) return 'tools must be a list'
    if (tools.length < 1 || tools.length > MAX_TOOLS) return `tools names 1 to ${MAX_TOOLS} tools`
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i]
      if (typeof t !== 'string' || !TOOL_TOKEN.test(t)) return `tools[${i}] is not a tool name`
    }
  }

  if (!has(v, 'questions')) return 'questions is required'
  const questions = v.questions
  if (!isObject(questions)) return 'questions must be an object'
  for (const name of Object.keys(questions).sort()) {
    if (!NAME.test(name)) return `questions: ${name} is not a question name`
    if (KEYWORDS.includes(name.toUpperCase())) return `questions: ${name} is a when keyword`
    const why = questionShape(name, questions[name])
    if (why) return why
  }

  if (!has(v, 'when')) return 'when is required'
  if (typeof v.when !== 'string') return 'when must be a string'
  if (codePoints(v.when) < 1 || codePoints(v.when) > DECIDE_MAX_WHEN_CHARS) return `when must be 1 to ${DECIDE_MAX_WHEN_CHARS} characters`

  if (has(v, 'band')) {
    const why = bandShape(v.band, 'band')
    if (why) return why
  }
  if (has(v, 'escalate') && v.escalate !== 'ask' && v.escalate !== 'review' && v.escalate !== 'refuse') return 'escalate must be ask, review or refuse'
  if (has(v, 'rollout') && v.rollout !== 'shadow' && v.rollout !== 'enforce') return 'rollout must be shadow or enforce'
  if (has(v, 'context')) {
    const c = v.context
    if (!Array.isArray(c)) return 'context must be a list'
    if (c.length > 1 || (c.length === 1 && c[0] !== 'last_user_turn')) return 'context may list last_user_turn, once'
  }
  return null
}

// ─── `when` ───────────────────────────────────────────────────────────

type Tok = { t: 'name' | 'kw' | '(' | ')' | ',' | '==' | '!=' | 'end'; v: string; col: number }

/** Thrown inside the parser only; {@link parseWhen} turns it into a result. */
class WhenError {
  constructor(
    readonly message: string,
    readonly column: number,
  ) {}
}

function isWordChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_'
}

function tokenize(src: string): Tok[] {
  const cs = Array.from(src)
  const out: Tok[] = []
  let i = 0
  while (i < cs.length) {
    const c = cs[i]!
    const col = i + 1
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
    } else if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, v: c, col })
      i++
    } else if ((c === '=' || c === '!') && cs[i + 1] === '=') {
      out.push({ t: c === '=' ? '==' : '!=', v: `${c}=`, col })
      i += 2
    } else if (isWordChar(c)) {
      let j = i
      while (j < cs.length && isWordChar(cs[j]!)) j++
      const w = cs.slice(i, j).join('')
      if (KEYWORDS.includes(w)) out.push({ t: 'kw', v: w, col })
      else if (/^[a-z][a-z0-9_]*$/.test(w)) out.push({ t: 'name', v: w, col })
      else throw new WhenError(`unknown word ${w}`, col)
      i = j
    } else {
      throw new WhenError(`unexpected character ${c}`, col)
    }
  }
  out.push({ t: 'end', v: '', col: cs.length + 1 })
  return out
}

/** Parse a `when` expression (§3.3 of the decide LLD). Never throws. Names are not checked here; {@link validateDecideRule} does that. */
export function parseWhen(src: string): { ok: true; expr: DecideExpr } | { ok: false; message: string; column: number } {
  try {
    const toks = tokenize(src)
    let k = 0
    const peek = () => toks[k]!
    const next = () => toks[k++]!
    const isKw = (w: string) => peek().t === 'kw' && peek().v === w
    const option = (): string => {
      const t = next()
      if (t.t !== 'name') throw new WhenError('expected an option', t.col)
      return t.v
    }
    const parseOr = (): DecideExpr => {
      let a = parseAnd()
      while (isKw('OR')) {
        next()
        a = { op: 'or', a, b: parseAnd() }
      }
      return a
    }
    const parseAnd = (): DecideExpr => {
      let a = parseUnary()
      while (isKw('AND')) {
        next()
        a = { op: 'and', a, b: parseUnary() }
      }
      return a
    }
    const parseUnary = (): DecideExpr => {
      if (isKw('NOT')) {
        next()
        return { op: 'not', a: parseUnary() }
      }
      return parseAtom()
    }
    const parseAtom = (): DecideExpr => {
      const t = next()
      if (t.t === '(') {
        const e = parseOr()
        const close = next()
        if (close.t !== ')') throw new WhenError('expected )', close.col)
        return e
      }
      if (t.t !== 'name') throw new WhenError('expected a question name, NOT or (', t.col)
      const q = t.v
      if (peek().t === '==') {
        next()
        return { op: 'eq', q, o: option() }
      }
      if (peek().t === '!=') {
        next()
        return { op: 'not', a: { op: 'eq', q, o: option() } }
      }
      if (isKw('IN')) {
        next()
        const open = next()
        if (open.t !== '(') throw new WhenError('expected (', open.col)
        let e: DecideExpr = { op: 'eq', q, o: option() }
        for (;;) {
          const sep = next()
          if (sep.t === ')') return e
          if (sep.t !== ',') throw new WhenError('expected , or )', sep.col)
          e = { op: 'or', a: e, b: { op: 'eq', q, o: option() } }
        }
      }
      return { op: 'yes', q }
    }
    const expr = parseOr()
    if (peek().t !== 'end') throw new WhenError('expected AND, OR or the end', peek().col)
    return { ok: true, expr }
  } catch (err) {
    if (err instanceof WhenError) return { ok: false, message: err.message, column: err.column }
    throw err
  }
}

/** The canonical form: fully parenthesised, `!=` and `IN` rewritten. `a AND b != o` → `(a AND (NOT (b == o)))`. */
export function canonicalWhen(e: DecideExpr): string {
  switch (e.op) {
    case 'yes':
      return e.q
    case 'eq':
      return `(${e.q} == ${e.o})`
    case 'not':
      return `(NOT ${canonicalWhen(e.a)})`
    case 'and':
      return `(${canonicalWhen(e.a)} AND ${canonicalWhen(e.b)})`
    case 'or':
      return `(${canonicalWhen(e.a)} OR ${canonicalWhen(e.b)})`
  }
}

/** Every atom, left to right as written. */
function atomsOf(e: DecideExpr, out: Array<Extract<DecideExpr, { op: 'yes' | 'eq' }>> = []): Array<Extract<DecideExpr, { op: 'yes' | 'eq' }>> {
  if (e.op === 'yes' || e.op === 'eq') out.push(e)
  else if (e.op === 'not') atomsOf(e.a, out)
  else {
    atomsOf(e.a, out)
    atomsOf(e.b, out)
  }
  return out
}

// ─── Validation ───────────────────────────────────────────────────────

/** A `choice` question's options as asked: `none_of_these` appended when absent and moved last when present. */
export function decideOptions(q: DecideQuestion): string[] {
  return [...(q.options ?? []).filter((o) => o !== NONE_OF_THESE), NONE_OF_THESE]
}

/** The band a question is judged on: its own, else the rule's, else the default. */
export function decideQuestionBand(rule: DecideRule, name: string): DecideBand {
  return own(rule.questions, name)?.band ?? rule.band ?? DECIDE_DEFAULT_BAND
}

/**
 * Validate an untrusted value as a decide rule (the line's JSON, without
 * `kind`). Never throws. The shape comes first, then the eight checks in
 * their fixed order; the first failure is the reason. Questions are visited
 * in sorted name order and `when` atoms left to right, so every port reports
 * the same first failure.
 */
export function validateDecideRule(value: unknown): DecideValidation {
  const shape = ruleShape(value)
  if (shape) return { ok: false, reason: `decide: ${shape}` }
  const rule = value as DecideRule
  const names = Object.keys(rule.questions).sort()

  if ((rule.on === 'tool_call') !== (rule.tools !== undefined)) {
    return { ok: false, reason: 'decide: tools is required for on: tool_call and not allowed for on: response' }
  }
  if (rule.on !== 'tool_call' && rule.context !== undefined) return { ok: false, reason: 'decide: context applies to on: tool_call only' }
  if (names.length < 1 || names.length > DECIDE_MAX_QUESTIONS) return { ok: false, reason: `decide: a rule asks 1 to ${DECIDE_MAX_QUESTIONS} questions` }
  if (rule.band && !(rule.band.no_below < rule.band.yes_at)) return { ok: false, reason: 'decide: band: no_below must be below yes_at' }
  for (const n of names) {
    const b = rule.questions[n]!.band
    if (b && !(b.no_below < b.yes_at)) return { ok: false, reason: `decide: ${n}: no_below must be below yes_at` }
  }

  const parsed = parseWhen(rule.when)
  if (!parsed.ok) return { ok: false, reason: `decide: when: ${parsed.message} at column ${parsed.column}` }
  const used = new Set<string>()
  for (const atom of atomsOf(parsed.expr)) {
    const q = own(rule.questions, atom.q)
    if (!q) return { ok: false, reason: `decide: when: unknown question ${atom.q}` }
    if (atom.op === 'yes' && q.type !== 'yes_no') return { ok: false, reason: `decide: when: ${atom.q} is not a yes_no question` }
    if (atom.op === 'eq') {
      if (q.type !== 'choice') return { ok: false, reason: `decide: when: ${atom.q} is not a choice question` }
      if (!decideOptions(q).includes(atom.o)) return { ok: false, reason: `decide: when: unknown option ${atom.o} for ${atom.q}` }
    }
    used.add(atom.q)
  }
  for (const n of names) {
    if (!used.has(n)) return { ok: false, reason: `decide: question ${n} is never used in when` }
  }
  for (const n of names) {
    if (DECIDE_APPROVAL_RE.test(rule.questions[n]!.ask)) {
      return { ok: false, reason: `decide: ${n} asks about approval; approval comes from the harness ask or the review queue, never from a question` }
    }
  }
  return { ok: true, rule, expr: parsed.expr }
}

/** The value of one `decide:` line (the text after the key). */
export function parseDecideLine(raw: string): DecideDecl {
  const text = raw.trim()
  if (!text) return { kind: 'unreadable', id: null, error: 'decide: the line is empty; write one rule per line as `decide: {json}`' }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', id: null, error: 'decide: the value is not JSON; write one rule per line as `decide: {json}`' }
  }
  const id = isObject(value) && has(value, 'id') && typeof value.id === 'string' && value.id !== '' ? value.id : null
  const v = validateDecideRule(value)
  return v.ok ? { kind: 'rule', rule: v.rule, expr: v.expr } : { kind: 'unreadable', id, error: v.reason }
}

/** Every `decide:` line of one SOP, in order. A line reusing an earlier line's id is unreadable: ids are unique within a SOP. */
export function parseDecideLines(values: readonly string[]): DecideDecl[] {
  const seen = new Set<string>()
  return values.map((raw) => {
    const d = parseDecideLine(raw)
    const id = d.kind === 'rule' ? d.rule.id : d.id
    if (id === null) return d
    if (seen.has(id)) return { kind: 'unreadable', id, error: `decide: id ${id} is used twice in this SOP` }
    seen.add(id)
    return d
  })
}

// ─── Identity ─────────────────────────────────────────────────────────

/** JSON with keys sorted at every level and no whitespace. Numbers as `JSON.stringify` writes them, which the other ports reproduce. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObject(v)) {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

function uniqueSorted(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort()
}

/**
 * What the rule hash covers: `on`, `tools` (sorted), the questions with
 * their bands made explicit and `none_of_these` placed, `when` in canonical
 * form and `context` (sorted), as canonical JSON. `id`, `title`, `escalate`
 * and `rollout` are left out, so flipping shadow to enforce keeps the rule's
 * evidence, while a changed word, option or band starts it over.
 * `tools` and `context` are `[]` when absent.
 */
export function decideHashInput(rule: DecideRule): string {
  const parsed = parseWhen(rule.when)
  if (!parsed.ok) throw new Error(`decideHashInput: when does not parse (${parsed.message})`)
  const questions: Record<string, unknown> = {}
  for (const name of Object.keys(rule.questions)) {
    const q = rule.questions[name]!
    const b = decideQuestionBand(rule, name)
    questions[name] = {
      type: q.type,
      ask: q.ask,
      ...(q.type === 'choice' ? { options: decideOptions(q) } : {}),
      band: { yes_at: b.yes_at, no_below: b.no_below },
    }
  }
  return canonicalJson({
    on: rule.on,
    tools: uniqueSorted(rule.tools ?? []),
    questions,
    when: canonicalWhen(parsed.expr),
    context: uniqueSorted(rule.context ?? []),
  })
}

/** `ruleHash`: lower-case hex SHA-256 of {@link decideHashInput}. `sha256Hex` hashes a string's UTF-8 bytes. */
export function decideRuleHash(rule: DecideRule, sha256Hex: (text: string) => string): string {
  return sha256Hex(decideHashInput(rule))
}

// ─── Semantics ────────────────────────────────────────────────────────

/** Kleene's three values: true, false, unknown. */
export type Tri = 'T' | 'F' | 'U'

export function kAnd(a: Tri, b: Tri): Tri {
  return a === 'F' || b === 'F' ? 'F' : a === 'T' && b === 'T' ? 'T' : 'U'
}

export function kOr(a: Tri, b: Tri): Tri {
  return a === 'T' || b === 'T' ? 'T' : a === 'F' && b === 'F' ? 'F' : 'U'
}

export function kNot(a: Tri): Tri {
  return a === 'T' ? 'F' : a === 'F' ? 'T' : 'U'
}

/** A probability through a band: T at or above `yes_at`, F below `no_below`, U between. */
export function bandValue(p: number, band: DecideBand): Tri {
  if (p >= band.yes_at) return 'T'
  if (p < band.no_below) return 'F'
  return 'U'
}

/**
 * The orders a `choice` question is asked in, as index lists over its n
 * options: as written and reversed, plus, past three options, the list
 * rotated by half, because reversing leaves the middle in the middle. The
 * order rule of `attributeSops` in the judge cascade.
 */
export function choiceOrders(n: number): number[][] {
  const ids = Array.from({ length: n }, (_, i) => i)
  const half = Math.floor(n / 2)
  return [ids, [...ids].reverse(), ...(n > 3 ? [[...ids.slice(half), ...ids.slice(0, half)]] : [])]
}

export interface ChoiceAtom {
  /** The probability averaged over the orders. */
  p: number
  /** The largest probability any order gave minus the smallest. */
  spread: number
  value: Tri
}

/**
 * Each option's atom `q == o` from the per-order probabilities (option name
 * to probability, one map per order; an option a map leaves out is 0). The
 * mean goes through the band; when the orders disagree by more than the
 * band's width the atom is U whatever the mean. No orders at all is U.
 */
export function choiceAtoms(options: readonly string[], perOrder: ReadonlyArray<Readonly<Record<string, number>>>, band: DecideBand): Record<string, ChoiceAtom> {
  const out: Record<string, ChoiceAtom> = {}
  for (const o of options) {
    const ps = perOrder.map((m) => own(m, o) ?? 0)
    if (ps.length === 0) {
      out[o] = { p: 0, spread: 0, value: 'U' }
      continue
    }
    let sum = 0
    for (const p of ps) sum += p
    const p = sum / ps.length
    const spread = Math.max(...ps) - Math.min(...ps)
    out[o] = { p, spread, value: spread > band.yes_at - band.no_below ? 'U' : bandValue(p, band) }
  }
  return out
}

/** The atoms a `when` is evaluated over. A missing atom is U. */
export interface DecideAtoms {
  yes: Record<string, Tri>
  eq: Record<string, Record<string, Tri>>
}

export function evalWhen(e: DecideExpr, atoms: DecideAtoms): Tri {
  switch (e.op) {
    case 'yes':
      return own(atoms.yes, e.q) ?? 'U'
    case 'eq':
      return own(own(atoms.eq, e.q), e.o) ?? 'U'
    case 'not':
      return kNot(evalWhen(e.a, atoms))
    case 'and':
      return kAnd(evalWhen(e.a, atoms), evalWhen(e.b, atoms))
    case 'or':
      return kOr(evalWhen(e.a, atoms), evalWhen(e.b, atoms))
  }
}

/** An engine's answer: `p` = p(yes) for `yes_no`; `perOrder` for `choice`, one option map per order of {@link choiceOrders}. */
export interface DecideAnswerInput {
  p?: number
  perOrder?: Array<Record<string, number>>
}

/** A fitted combiner: it replaces `when`, and is judged on its own band. */
export interface DecideCombiner {
  bias: number
  weights: Record<string, number>
  band: DecideBand
}

function logit(p: number): number {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12)
  return Math.log(q / (1 - q))
}

/**
 * s = σ(bias + Σ w_q · logit(p_q)), summed in sorted question order. A
 * `choice` question enters through the averaged probability of its top
 * option. Null when a weighted
 * question has no answer, which the caller reads as U.
 */
export function combinerScore(rule: DecideRule, answers: Readonly<Record<string, DecideAnswerInput>>, combiner: DecideCombiner): number | null {
  let x = combiner.bias
  for (const name of Object.keys(combiner.weights).sort()) {
    const q = own(rule.questions, name)
    const a = own(answers, name)
    if (!q || !a) return null
    let p: number
    if (q.type === 'yes_no') {
      if (typeof a.p !== 'number') return null
      p = a.p
    } else {
      if (!a.perOrder || a.perOrder.length === 0) return null
      const atoms = choiceAtoms(decideOptions(q), a.perOrder, decideQuestionBand(rule, name))
      p = Math.max(...Object.values(atoms).map((c) => c.p))
    }
    x += combiner.weights[name]! * logit(p)
  }
  return 1 / (1 + Math.exp(-x))
}

export interface DecideRuleOutcome {
  /** `when`, or the combiner's band value when one is pinned. */
  value: Tri
  outcome: 'allow' | 'refuse' | 'escalate'
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | null
  /** How an escalation reaches a person: the rule's `escalate`, when it is `ask` or `review`. */
  via: 'ask' | 'review' | null
  /** The combiner's score, when one decided. */
  score: number | null
  atoms: DecideAtoms
}

/** The atoms of a validated rule's answers, each question through its own band. */
export function decideAtoms(rule: DecideRule, answers: Readonly<Record<string, DecideAnswerInput>>): DecideAtoms {
  const atoms: DecideAtoms = { yes: {}, eq: {} }
  for (const name of Object.keys(rule.questions).sort()) {
    const q = rule.questions[name]!
    const a = own(answers, name)
    const band = decideQuestionBand(rule, name)
    if (q.type === 'yes_no') {
      atoms.yes[name] = a && typeof a.p === 'number' ? bandValue(a.p, band) : 'U'
    } else {
      const c = choiceAtoms(decideOptions(q), a?.perOrder ?? [], band)
      atoms.eq[name] = Object.fromEntries(Object.entries(c).map(([o, v]) => [o, v.value]))
    }
  }
  return atoms
}

/**
 * One rule's outcome: T refuses (`DECIDE_REFUSED`), F allows, U escalates
 * through `escalate` (default `ask`); `escalate: refuse` refuses with
 * `DECIDE_ESCALATED`. `expr` is the rule's parsed `when`
 * ({@link validateDecideRule} returns it).
 */
export function decideRuleOutcome(
  rule: DecideRule,
  expr: DecideExpr,
  answers: Readonly<Record<string, DecideAnswerInput>>,
  combiner?: DecideCombiner | null,
): DecideRuleOutcome {
  const atoms = decideAtoms(rule, answers)
  let value: Tri
  let score: number | null = null
  if (combiner) {
    score = combinerScore(rule, answers, combiner)
    value = score === null ? 'U' : bandValue(score, combiner.band)
  } else {
    value = evalWhen(expr, atoms)
  }
  if (value === 'T') return { value, outcome: 'refuse', code: 'DECIDE_REFUSED', via: null, score, atoms }
  if (value === 'F') return { value, outcome: 'allow', code: null, via: null, score, atoms }
  const escalate = rule.escalate ?? 'ask'
  if (escalate === 'refuse') return { value, outcome: 'refuse', code: 'DECIDE_ESCALATED', via: null, score, atoms }
  return { value, outcome: 'escalate', code: 'DECIDE_ESCALATED', via: escalate, score, atoms }
}

// ─── One call, several rules ──────────────────────────────────────────

export interface DecideCandidate {
  ref: string
  on: 'tool_call' | 'response'
  tools?: readonly string[]
  /** The effective rollout: `enforce` only when every condition for it holds. */
  effective: 'enforce' | 'shadow'
}

export interface DecideSelection<C extends DecideCandidate = DecideCandidate> {
  /** At most {@link DECIDE_MAX_RULES_PER_CALL}, enforce first, then in snapshot order. */
  evaluate: C[]
  /** Shadow rules past the limit: not evaluated, logged. */
  skipped: C[]
  /** Set when an enforce rule is past the limit: the call refuses `GOVERNANCE_UNAVAILABLE` before any engine call. */
  unavailable: string | null
}

/**
 * The rules a tool call asks. `candidates` are in snapshot order (SOP order,
 * then line order). A rule matches when it is `on: tool_call` and names the
 * tool exactly.
 */
export function selectDecideRules<C extends DecideCandidate>(candidates: readonly C[], tool: string): DecideSelection<C> {
  const matched = candidates.filter((c) => c.on === 'tool_call' && (c.tools ?? []).includes(tool))
  const ordered = [...matched.filter((c) => c.effective === 'enforce'), ...matched.filter((c) => c.effective !== 'enforce')]
  const beyond = ordered.slice(DECIDE_MAX_RULES_PER_CALL)
  return {
    evaluate: ordered.slice(0, DECIDE_MAX_RULES_PER_CALL),
    skipped: beyond.filter((c) => c.effective !== 'enforce'),
    unavailable: beyond.some((c) => c.effective === 'enforce') ? `more than ${DECIDE_MAX_RULES_PER_CALL} decide rules name ${tool}` : null,
  }
}

/** One evaluated rule's result. `unavailable`: the engine could not answer (an error, a timeout, a failed canary). */
export interface DecideRuleResult {
  ref: string
  effective: 'enforce' | 'shadow'
  outcome: 'allow' | 'refuse' | 'escalate' | 'unavailable'
  code?: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | null
  via?: 'ask' | 'review' | null
}

export interface DecideCallOutcome {
  outcome: 'allow' | 'refuse' | 'escalate'
  code: 'DECIDE_REFUSED' | 'DECIDE_ESCALATED' | 'GOVERNANCE_UNAVAILABLE' | null
  ruleRef: string | null
  via: 'ask' | 'review' | null
  reason: string | null
}

/**
 * The call's outcome from its rules' results, in evaluation order. Only
 * enforce rules count: the first that refuses (or whose engine was
 * unavailable, `GOVERNANCE_UNAVAILABLE`) refuses the call; otherwise the
 * first that escalates escalates it; otherwise the call is allowed. Shadow
 * results never change the call.
 */
export function decideCallOutcome(selection: Pick<DecideSelection, 'unavailable'>, results: readonly DecideRuleResult[]): DecideCallOutcome {
  if (selection.unavailable) return { outcome: 'refuse', code: 'GOVERNANCE_UNAVAILABLE', ruleRef: null, via: null, reason: selection.unavailable }
  const enforcing = results.filter((r) => r.effective === 'enforce')
  const refusal = enforcing.find((r) => r.outcome === 'refuse' || r.outcome === 'unavailable')
  if (refusal) {
    const code = refusal.outcome === 'unavailable' ? 'GOVERNANCE_UNAVAILABLE' : (refusal.code ?? 'DECIDE_REFUSED')
    return { outcome: 'refuse', code, ruleRef: refusal.ref, via: null, reason: null }
  }
  const escalation = enforcing.find((r) => r.outcome === 'escalate')
  if (escalation) return { outcome: 'escalate', code: 'DECIDE_ESCALATED', ruleRef: escalation.ref, via: escalation.via ?? 'ask', reason: null }
  return { outcome: 'allow', code: null, ruleRef: null, via: null, reason: null }
}

// ─── As source ────────────────────────────────────────────────────────

/**
 * This module as JavaScript source, for the hook gates to embed: every
 * constant, the parser's error class and every function above, in a scope of
 * the gate's choosing. A test holds the list to the functions this file
 * declares. A CommonJS build names an exported constant `exports.X` inside a
 * function; the source defines each as a plain `X`, so that prefix is dropped.
 */
export const DECIDE_JS_SOURCE = [
  `const DECIDE_MAX_QUESTIONS = ${DECIDE_MAX_QUESTIONS};`,
  `const DECIDE_MAX_OPTIONS = ${DECIDE_MAX_OPTIONS};`,
  `const DECIDE_MAX_RULES_PER_CALL = ${DECIDE_MAX_RULES_PER_CALL};`,
  `const DECIDE_MAX_WHEN_CHARS = ${DECIDE_MAX_WHEN_CHARS};`,
  `const DECIDE_MIN_ASK_CHARS = ${DECIDE_MIN_ASK_CHARS};`,
  `const DECIDE_MAX_ASK_CHARS = ${DECIDE_MAX_ASK_CHARS};`,
  `const DECIDE_DEFAULT_BAND = ${JSON.stringify(DECIDE_DEFAULT_BAND)};`,
  `const NONE_OF_THESE = ${JSON.stringify(NONE_OF_THESE)};`,
  `const TOOL_TOKEN = ${String(TOOL_TOKEN)};`,
  `const MAX_TOOLS = ${MAX_TOOLS};`,
  `const MAX_TITLE = ${MAX_TITLE};`,
  `const RULE_ID = ${String(RULE_ID)};`,
  `const NAME = ${String(NAME)};`,
  `const KEYWORDS = ${JSON.stringify(KEYWORDS)};`,
  `const DECIDE_APPROVAL_RE = ${String(DECIDE_APPROVAL_RE)};`,
  `const RULE_FIELDS = ${JSON.stringify(RULE_FIELDS)};`,
  `const QUESTION_FIELDS = ${JSON.stringify(QUESTION_FIELDS)};`,
  `const BAND_FIELDS = ${JSON.stringify(BAND_FIELDS)};`,
  ...[
    WhenError,
    isObject,
    has,
    own,
    codePoints,
    unknownField,
    bandShape,
    questionShape,
    ruleShape,
    isWordChar,
    tokenize,
    parseWhen,
    canonicalWhen,
    atomsOf,
    decideOptions,
    decideQuestionBand,
    validateDecideRule,
    parseDecideLine,
    parseDecideLines,
    canonicalJson,
    uniqueSorted,
    decideHashInput,
    decideRuleHash,
    kAnd,
    kOr,
    kNot,
    bandValue,
    choiceOrders,
    choiceAtoms,
    evalWhen,
    logit,
    combinerScore,
    decideAtoms,
    decideRuleOutcome,
    selectDecideRules,
    decideCallOutcome,
  ].map((fn) => fn.toString().replace(/\bexports\./g, '')),
].join('\n')
