/**
 * injection.ts — Prompt-injection pattern scanning over MCP tool-call traffic.
 *
 * Direct TypeScript port of `packages/proxy/src/injection.rs`'s five named
 * regex patterns. Rust's `regex` crate and JS `RegExp` agree on everything
 * these patterns use (case-insensitive alternation, `\b`, `\s+`, no
 * backreferences or lookaround), so the pattern SOURCE TEXT is unchanged —
 * only the syntax wrapper (Rust raw string → JS regex literal) differs.
 *
 * This is deliberately not a classifier — see injection.rs's module doc for
 * the full argument. Pattern matching only, priced at a handful of regex
 * tests, catching the well-known phrasings and nothing else. False positives
 * are the real cost (people legitimately tell an agent to "ignore my last
 * message"), which is why the patterns stay narrow and a single match steers
 * rather than kills.
 *
 * @module
 */

interface InjectionPattern {
  name: string
  regex: RegExp
}

/**
 * Ported verbatim from `packages/proxy/src/injection.rs`'s `PATTERNS` const
 * (confirmed by reading that file directly — names and pattern text below
 * are not inferred). None of these patterns has the wide bounded-repetition
 * shape (`{20,300}`, etc.) that caused the unrelated `RegexSet` performance
 * regression documented in `dlp.rs` — the widest quantifier here is `\s+`
 * and a handful of short alternations — so a plain sequential scan (no
 * RegexSet-equivalent needed) is both correct and linear-time on untrusted
 * input.
 */
const PATTERNS: readonly InjectionPattern[] = [
  {
    name: 'override-instructions',
    regex:
      /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|earlier|above|preceding)\s+(instruction|direction|prompt|rule|command)s?\b/i,
  },
  {
    name: 'reveal-system-prompt',
    regex:
      /\b(reveal|repeat|print|show|output|display)\s+(me\s+)?(your|the)\s+(system\s+prompt|initial\s+instructions|original\s+instructions)\b/i,
  },
  {
    name: 'role-reassignment',
    regex: /\byou\s+are\s+now\s+(a|an|in)\b|\bfrom\s+now\s+on,?\s+you\s+(are|will|must)\b/i,
  },
  {
    name: 'guardrail-bypass',
    regex: /\b(developer|debug|god)\s+mode\b|\bDAN\s+mode\b|\bwithout\s+any\s+(restrictions|filters|guardrails)\b/i,
  },
  {
    name: 'instruction-boundary-forgery',
    // Rust's `(^|\n)` with no `(?m)` flag matches only the start of the WHOLE
    // haystack or a literal newline character — never "start of any line" the
    // way `^` would under a multiline flag. JS `^` without the `m` flag has
    // the identical "start of whole string" semantics, and the pattern
    // already spells out `(^|\n)` explicitly, so no `m` flag is added here —
    // adding one would change behavior (every line start would match) rather
    // than preserve it.
    regex: /(^|\n)\s*(\[\/?(INST|SYSTEM)\]|<\|?(im_start|system)\|?>|###\s*system\b)/i,
  },
]

/**
 * Ported from `detectors.rs`'s `INJECTION_KILL_THRESHOLD` (confirmed: `const
 * INJECTION_KILL_THRESHOLD: usize = 2;`) — the Rust `PromptInjectionDetector`
 * escalates to `reask` once findings reach this count, OR immediately on any
 * untrusted-content source. `scanText`/`injectionSeverity` below reuse the
 * same threshold for MCP's `injection_detected` event severity, mirroring
 * that escalation rule rather than reimplementing a new one.
 */
const KILL_THRESHOLD = 2

/**
 * Names of the injection patterns present in `text`, deduplicated. Empty
 * when nothing matched (the overwhelmingly common case).
 */
export function scanText(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  for (const { name, regex } of PATTERNS) {
    if (regex.test(text)) found.push(name)
  }
  return found
}

/** Where a piece of scanned MCP traffic came from. */
export type InjectionSource = 'tool_result' | 'tool_description' | 'tool_input'

export type InjectionSeverity = 'low' | 'high'

/**
 * Sources this proxy treats as untrusted content the agent fetched or was
 * handed, rather than the calling agent's own request — the same
 * distinction `detectors.rs`'s `from_untrusted_content` draws between
 * `tool_result`/`tool_description` and `user_prompt`. MCP has no
 * `user_prompt`/`system_prompt` concept of its own; `tool_input` (the
 * request direction, the calling agent's own tool arguments) is this
 * proxy's closest analogue to the Rust detector's trusted `user_prompt`
 * source, so it is deliberately excluded here.
 */
const UNTRUSTED_SOURCES: ReadonlySet<InjectionSource> = new Set(['tool_result', 'tool_description'])

/**
 * Mirrors `PromptInjectionDetector::detect`'s escalation rule (detectors.rs):
 * severity escalates to `high` when findings reach the kill threshold (≥2
 * distinct techniques) OR the source is untrusted content — otherwise `low`.
 * Note this is an EVENT-severity mirror only; it does not by itself decide
 * `allow`/`block` — see `mcpInjectionAction` (interceptor.ts / proxy.ts) for
 * the actual disposition, which follows this package's own warn/block
 * config rather than the Rust detector's reask/steer ladder (MCP's headless
 * proxy has no reask loop of its own at the injection layer — Phase 2's
 * anomaly reask ladder is the analogue for that).
 */
export function injectionSeverity(findings: readonly string[], source: InjectionSource): InjectionSeverity {
  if (findings.length >= KILL_THRESHOLD || UNTRUSTED_SOURCES.has(source)) return 'high'
  return 'low'
}
