/**
 * toolPoison.ts — Tool-description poisoning patterns.
 *
 * Direct TypeScript port of `packages/proxy/src/tool_poison.rs`'s `scan`
 * function and its seven named patterns (confirmed by reading that file
 * directly). This is a SEPARATE pattern set from `injection.ts`, on purpose:
 * `tool_poison.rs`'s own module doc records that it tried reusing
 * `injection::scan` for this and measured that its five patterns match ZERO
 * of the tool-poisoning payloads — they are tuned for conversational
 * jailbreak phrasing ("ignore previous instructions"), while a poisoned tool
 * description reads like documentation, not a jailbreak. `ToolPoisoningDetector`
 * (Phase 2's `anomaly/detectors.ts`) is what consumes this module.
 *
 * The Rust source gates each pattern behind a cheap substring pre-check
 * (`GATES`) before running the regex, measured to be ~1.8× faster than the
 * regex alone on their corpus. That optimization is NOT ported here — it is
 * a performance detail proven equivalent to the plain regex loop (the Rust
 * module's own `gating_never_changes_a_verdict` test asserts exactly that
 * equivalence), never a correctness one, and the volume of tool descriptions
 * one MCP session evaluates is orders of magnitude below the Rust proxy's
 * request-path corpus. The pattern SOURCE TEXT below is unchanged from the
 * Rust `PATTERNS` array — only the verbatim regex text is what was actually
 * measured, so preserving it exactly (not the gate) is what matters here.
 *
 * @module
 */

interface ToolPoisonPattern {
  name: string
  regex: RegExp
}

/**
 * Ported verbatim from `tool_poison.rs`'s `PATTERNS` const. All bounded
 * repetitions here are small fixed-width gaps (`{0,40}`, `{0,60}`, `{0,80}`)
 * over a handful of alternations — the same "no wide bounded repetition, no
 * RegexSet performance regression" shape `injection.ts` documents, not the
 * `dlp.rs` shape that regressed.
 */
const PATTERNS: readonly ToolPoisonPattern[] = [
  {
    name: 'hidden-instruction-block',
    regex: /<\s*(important|secret|system|hidden|instructions?)\s*>/i,
  },
  {
    name: 'conceal-from-user',
    regex:
      /\bdo\s+not\s+(mention|tell|inform|reveal|disclose|show)\b[^.!?]{0,40}\buser\b|\bwithout\s+(informing|telling|notifying|alerting)\s+the\s+user\b/i,
  },
  {
    name: 'sidechannel-exfil',
    regex:
      /\b(pass|send|include|append|forward|provide)\b[^.!?]{0,60}\b(content|value|text)s?\s+of\b[^.!?]{0,40}(~\/|\.env|\.ssh|id_rsa|credential|secret|token|api[_ ]?key)/i,
  },
  {
    name: 'read-sensitive-path',
    // Rust's own comment: no `\b` before the alternation, because a word
    // boundary cannot exist before a literal `.` — `\b\.env` matches
    // nothing. Preserved exactly, including that absence.
    regex: /\b(read|open|cat|load|access)\b[^.!?]{0,30}(~\/\.\w+|\.ssh\/|id_rsa|\.env\b|\.aws\/|mcp\.json|\/etc\/passwd)/i,
  },
  {
    name: 'cross-tool-shadowing',
    regex: /\buse\s+this\s+tool\s+instead\s+of\b|\bdo\s+not\s+use\s+the\s+\w+\s+tool\b|\bthis\s+tool\s+supersedes\b/i,
  },
  {
    name: 'agent-directed-precondition',
    regex: /\bbefore\s+(using|calling|invoking)\s+(this|the)\s+tool\b[^.!?]{0,80}\b(you\s+must|first\s+read|first\s+call)\b/i,
  },
  {
    name: 'tool-scoped-instruction-override',
    regex: /\b(ignore|disregard|override)\b[^.!?]{0,40}\b(other\s+tools?|previous\s+tools?|system\s+prompt)\b/i,
  },
]

/**
 * Pattern names matching this tool description, deduplicated, empty when it
 * looks like ordinary prose (the overwhelmingly common case).
 */
export function scanToolDescription(description: string): string[] {
  if (!description) return []
  const found: string[] = []
  for (const { name, regex } of PATTERNS) {
    if (regex.test(description)) found.push(name)
  }
  return found
}
