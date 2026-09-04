/**
 * Guardrail renderers and their parsers (LLD #71).
 *
 * Two artifacts come out of the IR, and both are read by code this package
 * does not own:
 *
 * - **Hook rules** become `{toolPattern, argPattern, reason}` — the shape
 *   `services/sync-daemon/src/lib/policySnapshot.ts` turns into a
 *   `policy-snapshot.rules` line and the emitted gate scripts match with
 *   `new RegExp(toolPattern)` / `new RegExp(argPattern)` against the tool name
 *   and `JSON.stringify(tool_input)`. The tool pattern must be portable ERE
 *   (the daemon's `assertPortableEre` refuses `\s`, `(?`, anchors, …); the
 *   argument pattern is exempt from that but must mean the same thing to JS
 *   `RegExp` and Python `re`, because the bash gates delegate it to `python3`.
 * - **Front-matter lines** become the YAML-ish block `packages/proxy/src/sops.rs`
 *   parses with `parse_front_matter`. `parseFrontMatterEnforcing` below is a
 *   line-for-line mirror of that parser's split semantics so a render can be
 *   re-parsed and compared to the IR it came from — and so the cargo fixture
 *   test can prove the Rust side reads the same fields.
 *
 * Every renderer is byte-stable: the same IR always yields the same bytes, so
 * a rendered artifact is content-addressable and a reviewer diffing two
 * versions sees only what changed.
 *
 * @module
 */

import {
  type GuardrailIr,
  type HookRuleIr,
  type FrontMatterIr,
  isFrontMatterIr,
} from './guardrailIr.js'

// ─── Hook rules ────────────────────────────────────────────────────────

export interface HookRuleCitation {
  /** Verbatim quote from the cited passage. */
  quote: string
  /** Deep link to the upstream document, or null when the provider has none. */
  sourceUrl: string | null
}

export interface RenderedHookRule {
  toolPattern: string
  argPattern?: string
  reason: string
}

/** Longest reason the gates print and the hook-events route accepts with margin (its cap is 512). */
export const MAX_REASON_CHARS = 300

/** Longest quote embedded in a reason; truncated with an ellipsis beyond it. */
export const MAX_QUOTE_IN_REASON = 200

/**
 * Escape a literal for a regex that both JS `RegExp` (no flags) and Python
 * `re` compile identically: every non-alphanumeric ASCII character is
 * backslash-escaped, alphanumerics never are (`\d`-style escapes would mean
 * something else). Non-ASCII characters are left alone — neither engine
 * treats them as syntax.
 */
export function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[^A-Za-z0-9_\u0080-\uFFFF]/g, (c) => `\\${c}`)
}

/**
 * The tool half of a hook rule. Tokens are alternated inside one group; the
 * only character a token may contain that is regex syntax is `.`, and it is
 * escaped. Anchored, because two of the three consumers (`matchSopRule` and
 * the MCP proxy's `matchRule`) test the pattern unanchored against the bare
 * tool name — `Bash` would match `BashHistory` there. The daemon strips the
 * anchors and wraps the pattern for whole-token matching itself, so all three
 * read it as "exactly this tool".
 */
export function renderToolPattern(tools: readonly string[]): string {
  const escaped = [...new Set(tools)].sort().map((t) => t.replace(/[\\.]/g, (c) => `\\${c}`))
  return escaped.length === 1 ? `^${escaped[0]!}$` : `^(${escaped.join('|')})$`
}

/**
 * The argument half: one positive lookahead per required literal, one
 * negative lookahead per forbidden literal, over the whole serialised input.
 * `[\s\S]*` rather than `.*` so a multi-line argument (a heredoc in a Bash
 * command) is still searched end to end. Undefined when there is nothing to
 * say about the arguments.
 */
export function renderArgPattern(contains: readonly string[] = [], notContains: readonly string[] = []): string | undefined {
  const positive = [...new Set(contains)].sort().map((l) => `(?=[\\s\\S]*${escapeRegexLiteral(l)})`)
  const negative = [...new Set(notContains)].sort().map((l) => `(?![\\s\\S]*${escapeRegexLiteral(l)})`)
  const all = [...positive, ...negative]
  return all.length === 0 ? undefined : all.join('')
}

/**
 * A whole SOP file around rendered front-matter lines: the shape the control
 * plane projects a front-matter guardrail into `GET /api/v1/workspace/
 * sops-policy` with, and the shape the parity fixtures under
 * `fixtures/guardrail-ir/` are generated in — one function, so the cargo
 * fixture test covers the projection byte for byte. `source:` and `cite:`
 * are informational lines the proxy ignores; `mode: shadow` is the one it
 * reads.
 */
export interface GuardrailSopFileInput {
  /** The enforcing lines, as `renderFrontMatterLines` produced them. */
  lines: string
  title: string
  /** Markdown body under the H1; the cited passage usually goes here as a quote. */
  body: string
  sourceUrl?: string | null
  /** The passage hash the rule stands on. */
  cite?: string | null
  shadow: boolean
}

export function renderGuardrailSopFile(input: GuardrailSopFileInput): string {
  const extra: string[] = []
  if (input.sourceUrl) extra.push(`source: ${scrubReason(input.sourceUrl)}`)
  if (input.cite) extra.push(`cite: ${scrubReason(input.cite)}`)
  if (input.shadow) extra.push('mode: shadow')
  return `---\n${[input.lines, ...extra].join('\n')}\n---\n# ${scrubReason(input.title)}\n\n${input.body}\n`
}

/** Tabs and newlines would break the `.rules` projection; collapse them. */
export function scrubReason(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * The reason a developer sees on stderr when the rule fires:
 * `<title> — policy: "<quote>" (<url>)`. The citation travels into the block
 * message itself, which is the whole point of a grounded guardrail.
 */
export function renderHookReason(title: string, citation: HookRuleCitation): string {
  const cleanTitle = scrubReason(title)
  const suffix = citation.sourceUrl ? ` (${scrubReason(citation.sourceUrl)})` : ''
  const frame = `${cleanTitle} — policy: ""${suffix}`
  const room = Math.max(0, Math.min(MAX_QUOTE_IN_REASON, MAX_REASON_CHARS - frame.length))
  let quote = scrubReason(citation.quote)
  if (quote.length > room) quote = room > 1 ? `${quote.slice(0, room - 1)}…` : ''
  return `${cleanTitle} — policy: "${quote}"${suffix}`.slice(0, MAX_REASON_CHARS)
}

export function renderHookRule(ir: HookRuleIr, citation: HookRuleCitation): RenderedHookRule {
  const argPattern = renderArgPattern(ir.argContains, ir.argNotContains)
  return {
    toolPattern: renderToolPattern(ir.tools),
    ...(argPattern ? { argPattern } : {}),
    reason: renderHookReason(ir.title, citation),
  }
}

// ─── Front matter: render ──────────────────────────────────────────────

const FRONT_MATTER_KEY_ORDER = ['roles', 'deny_tools', 'review_before', 'requires_before', 'forbid_after', 'max_calls', 'forbid_with'] as const

/**
 * The front-matter lines for a set of IRs — no fences, no `mode:`; the
 * projection that ships them adds those. One line per rule for the pair
 * keys (the Rust parser splits `requires_before:`/`forbid_after:`/`max_calls:`
 * on commas but `forbid_with:` deliberately not, so one-per-line is the only
 * shape that is right for all four), and one comma-joined line for the list
 * keys. Deterministic: sorted, deduplicated, fixed key order.
 */
export function renderFrontMatterLines(irs: readonly FrontMatterIr[]): string {
  const lines: string[] = []
  const roles = new Set<string>()
  const denyTools = new Set<string>()
  const reviewBefore = new Set<string>()
  const requiresBefore = new Set<string>()
  const forbidAfter = new Set<string>()
  const maxCalls = new Map<string, number>()
  const forbidWith = new Set<string>()

  for (const ir of irs) {
    for (const r of ir.roles ?? []) roles.add(r.toLowerCase())
    switch (ir.kind) {
      case 'deny_tools':
        for (const t of ir.tools) denyTools.add(t)
        break
      case 'review_before':
        for (const t of ir.tokens) reviewBefore.add(t)
        break
      case 'requires_before':
        requiresBefore.add(`${ir.first} -> ${ir.then}`)
        break
      case 'forbid_after':
        forbidAfter.add(`${ir.first} -> ${ir.then}`)
        break
      case 'max_calls': {
        // Two bounds on one token: the tighter one is the policy.
        const prior = maxCalls.get(ir.token)
        maxCalls.set(ir.token, prior === undefined ? ir.limit : Math.min(prior, ir.limit))
        break
      }
      case 'forbid_with':
        forbidWith.add(`${ir.taint}, ${ir.token}`)
        break
    }
  }

  for (const key of FRONT_MATTER_KEY_ORDER) {
    switch (key) {
      case 'roles':
        if (roles.size) lines.push(`roles: ${[...roles].sort().join(', ')}`)
        break
      case 'deny_tools':
        if (denyTools.size) lines.push(`deny_tools: ${[...denyTools].sort().join(', ')}`)
        break
      case 'review_before':
        if (reviewBefore.size) lines.push(`review_before: ${[...reviewBefore].sort().join(', ')}`)
        break
      case 'requires_before':
        for (const rule of [...requiresBefore].sort()) lines.push(`requires_before: ${rule}`)
        break
      case 'forbid_after':
        for (const rule of [...forbidAfter].sort()) lines.push(`forbid_after: ${rule}`)
        break
      case 'max_calls':
        for (const token of [...maxCalls.keys()].sort()) lines.push(`max_calls: ${token} <= ${maxCalls.get(token)}`)
        break
      case 'forbid_with':
        for (const rule of [...forbidWith].sort()) lines.push(`forbid_with: ${rule}`)
        break
    }
  }
  return lines.join('\n')
}

// ─── Front matter: parse (mirror of packages/proxy/src/sops.rs) ───────

export interface ParsedFrontMatter {
  roles: string[]
  allowHarnesses: string[]
  denyTools: string[]
  planSteps: string[]
  scopePaths: string[]
  reviewBefore: string[]
  /** `[first, then, adjacent]` — `adjacent` is true for `~>`. */
  requiresBefore: Array<[string, string, boolean]>
  forbidAfter: Array<[string, string, boolean]>
  maxCalls: Array<[string, number]>
  forbidWith: Array<[string, string]>
  mode: 'shadow' | 'enforce'
  /** Rules that failed to parse, in the Rust parser's own wording. */
  errors: string[]
}

/**
 * Split a document into the text between its `---` fences and the body,
 * with the Rust parser's fallback contract: no fence, or an unterminated
 * one, means the whole document is body and there is no front matter.
 */
export function splitFrontMatter(raw: string): { front: string; body: string } {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('---')) return { front: '', body: raw.trim() }
  const rest = trimmed.slice(3)
  const end = rest.indexOf('\n---')
  if (end === -1) return { front: '', body: raw.trim() }
  return { front: rest.slice(0, end), body: rest.slice(end + '\n---'.length).trim() }
}

const QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'"])
const QUOTE_AND_BRACKET_CHARS: ReadonlySet<string> = new Set(['"', "'", '[', ']'])

/**
 * Strip any run of `chars` from both ends, in linear time. A regex spelled
 * `/["']+$/` is quadratic on a long run of quotes that does not reach the end
 * of the string (the same trap `policySnapshot.ts`'s `stripEnd` documents).
 */
function trimChars(s: string, chars: ReadonlySet<string>): string {
  let start = 0
  let end = s.length
  while (start < end && chars.has(s[start]!)) start++
  while (end > start && chars.has(s[end - 1]!)) end--
  return s.slice(start, end)
}

/** `trim_matches(['"', '\'', '[', ']'])` — strips any run of those from both ends. */
function trimQuotesAndBrackets(s: string): string {
  return trimChars(s, QUOTE_AND_BRACKET_CHARS)
}

function keyValues(front: string, key: string): string[] {
  const out: string[] = []
  for (const line of front.split('\n')) {
    const t = line.trim()
    if (t.startsWith(key)) out.push(t.slice(key.length))
  }
  return out
}

/** The `list("key:", lower)` closure: split on commas, trim, strip quotes/brackets, drop empties. */
function listKey(front: string, key: string, lower: boolean): string[] {
  const out: string[] = []
  for (const value of keyValues(front, key)) {
    for (const raw of value.split(',')) {
      const t = trimQuotesAndBrackets(raw.trim())
      if (t) out.push(lower ? t.toLowerCase() : t)
    }
  }
  return out
}

function parseOrdering(raw: string): { ok: true; rule: [string, string, boolean] } | { ok: false; error: string } {
  let lhs: string
  let rhs: string
  let adjacent: boolean
  const tight = raw.indexOf('~>')
  const loose = raw.indexOf('->')
  if (tight !== -1) {
    lhs = raw.slice(0, tight)
    rhs = raw.slice(tight + 2)
    adjacent = true
  } else if (loose !== -1) {
    lhs = raw.slice(0, loose)
    rhs = raw.slice(loose + 2)
    adjacent = false
  } else {
    return { ok: false, error: `${JSON.stringify(raw)}: expected \`A -> B\` or \`A ~> B\`` }
  }
  lhs = lhs.trim()
  rhs = rhs.trim()
  if (!lhs || !rhs) return { ok: false, error: `${JSON.stringify(raw)}: both sides must be non-empty` }
  for (const side of [lhs, rhs]) {
    if (side.split(/\s+/).length > 1) {
      return { ok: false, error: `${JSON.stringify(side)} looks like a shell command. Ordering rules name tools or actions, never commands` }
    }
  }
  return { ok: true, rule: [lhs, rhs, adjacent] }
}

function parseRules(front: string, key: string): { ok: Array<[string, string, boolean]>; errors: string[] } {
  const ok: Array<[string, string, boolean]> = []
  const errors: string[] = []
  for (const value of keyValues(front, key)) {
    for (const piece of value.split(',')) {
      const raw = trimQuotesAndBrackets(piece.trim()).trim()
      if (!raw) continue
      const parsed = parseOrdering(raw)
      if (parsed.ok) ok.push(parsed.rule)
      else errors.push(`${key} ${parsed.error}`)
    }
  }
  return { ok, errors }
}

function parseCountBound(raw: string): { ok: true; rule: [string, number] } | { ok: false; error: string } {
  const at = raw.indexOf('<=')
  if (at === -1) return { ok: false, error: `${JSON.stringify(raw)}: expected \`A <= N\`` }
  const token = raw.slice(0, at).trim()
  const rhs = raw.slice(at + 2).trim()
  if (!token) return { ok: false, error: `${JSON.stringify(raw)}: the tool or action must be named` }
  if (token.split(/\s+/).length > 1) {
    return { ok: false, error: `${JSON.stringify(token)} looks like a shell command. Count bounds name tools or actions, never commands` }
  }
  if (!/^\d+$/.test(rhs)) return { ok: false, error: `${JSON.stringify(raw)}: ${JSON.stringify(rhs)} is not a whole number` }
  return { ok: true, rule: [token, Number(rhs)] }
}

function parseCooccurrence(raw: string): { ok: true; rule: [string, string] } | { ok: false; error: string } {
  const at = raw.indexOf(',')
  if (at === -1) return { ok: false, error: `${JSON.stringify(raw)}: expected \`taint(), token\`` }
  const taint = raw.slice(0, at).trim().toLowerCase()
  const token = raw.slice(at + 1).trim()
  if (taint !== 'secrets()' && taint !== 'pii()') {
    return { ok: false, error: `${JSON.stringify(raw.slice(0, at).trim())}: the left side must be \`secrets()\` or \`pii()\`` }
  }
  if (!token) return { ok: false, error: `${JSON.stringify(raw)}: the right side must name a tool or action` }
  if (token.split(/\s+/).length > 1) {
    return { ok: false, error: `${JSON.stringify(token)} is not a single tool or action token. Write one rule per line` }
  }
  return { ok: true, rule: [taint, token] }
}

function parseItems<T>(
  front: string,
  key: string,
  splitOnComma: boolean,
  f: (raw: string) => { ok: true; rule: T } | { ok: false; error: string },
): { ok: T[]; errors: string[] } {
  const ok: T[] = []
  const errors: string[] = []
  for (const value of keyValues(front, key)) {
    const pieces = splitOnComma ? value.split(',') : [value]
    for (const piece of pieces) {
      const raw = trimQuotesAndBrackets(piece.trim()).trim()
      if (!raw) continue
      const parsed = f(raw)
      if (parsed.ok) ok.push(parsed.rule)
      else errors.push(`${key} ${parsed.error}`)
    }
  }
  return { ok, errors }
}

function parseMode(front: string): 'shadow' | 'enforce' {
  const first = keyValues(front, 'mode:')[0]
  if (first === undefined) return 'enforce'
  return trimChars(first.trim(), QUOTE_CHARS).toLowerCase() === 'shadow' ? 'shadow' : 'enforce'
}

/**
 * Parse the text between the fences exactly as `parse_front_matter` in
 * sops.rs does: a key is a line prefix, list keys split on commas and strip
 * quotes/brackets, `requires_before`/`forbid_after` parse `A -> B`,
 * `max_calls` parses `A <= N` (comma-split), `forbid_with` parses
 * `taint(), token` (never comma-split), unknown keys are ignored, and an
 * unparseable rule is reported rather than dropped.
 */
export function parseFrontMatterEnforcing(front: string): ParsedFrontMatter {
  const requires = parseRules(front, 'requires_before:')
  const forbids = parseRules(front, 'forbid_after:')
  const counts = parseItems(front, 'max_calls:', true, parseCountBound)
  const cooccur = parseItems(front, 'forbid_with:', false, parseCooccurrence)
  return {
    roles: listKey(front, 'roles:', true),
    allowHarnesses: listKey(front, 'allow_harnesses:', true),
    denyTools: listKey(front, 'deny_tools:', false),
    planSteps: listKey(front, 'plan_steps:', false),
    scopePaths: listKey(front, 'scope_paths:', false),
    reviewBefore: listKey(front, 'review_before:', false),
    requiresBefore: requires.ok,
    forbidAfter: forbids.ok,
    maxCalls: counts.ok,
    forbidWith: cooccur.ok,
    mode: parseMode(front),
    errors: [...requires.errors, ...forbids.errors, ...counts.errors, ...cooccur.errors],
  }
}

/** Mirror of `is_enforceable`: does this front matter declare anything the proxy can act on? */
export function isEnforceableFrontMatter(fm: ParsedFrontMatter): boolean {
  return (
    fm.denyTools.length > 0 ||
    fm.allowHarnesses.length > 0 ||
    fm.planSteps.length > 0 ||
    fm.scopePaths.length > 0 ||
    fm.reviewBefore.length > 0 ||
    fm.requiresBefore.length > 0 ||
    fm.forbidAfter.length > 0 ||
    fm.maxCalls.length > 0 ||
    fm.forbidWith.length > 0
  )
}

/**
 * The IRs a parsed front matter expresses — the inverse of
 * {@link renderFrontMatterLines} for the six generated keys. Allowlist keys
 * (`allow_harnesses`, `plan_steps`, `scope_paths`) have no IR and are not
 * returned; adjacency (`~>`) rules are returned as plain ordering rules,
 * which is the only shape the IR offers.
 */
export function frontMatterToIrs(fm: ParsedFrontMatter): FrontMatterIr[] {
  const roles = fm.roles.length ? { roles: [...fm.roles] } : {}
  const irs: FrontMatterIr[] = []
  if (fm.denyTools.length) irs.push({ kind: 'deny_tools', tools: [...fm.denyTools], ...roles })
  if (fm.reviewBefore.length) irs.push({ kind: 'review_before', tokens: [...fm.reviewBefore], ...roles })
  for (const [first, then] of fm.requiresBefore) irs.push({ kind: 'requires_before', first, then, ...roles })
  for (const [first, then] of fm.forbidAfter) irs.push({ kind: 'forbid_after', first, then, ...roles })
  for (const [token, limit] of fm.maxCalls) irs.push({ kind: 'max_calls', token, limit, ...roles })
  for (const [taint, token] of fm.forbidWith) {
    irs.push({ kind: 'forbid_with', taint: taint as 'secrets()' | 'pii()', token, ...roles })
  }
  return irs
}

/** Render a mixed IR list's front-matter half; non-front-matter kinds are ignored. */
export function frontMatterIrsOf(irs: readonly GuardrailIr[]): FrontMatterIr[] {
  return irs.filter(isFrontMatterIr)
}
