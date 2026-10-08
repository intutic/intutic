/**
 * dlp.ts — DLP (Data Loss Prevention) argument scanner.
 *
 * Scans tool arguments for patterns that indicate credentials, secrets, PII,
 * or destructive commands before allowing the tool call to proceed.
 *
 * PII is the checksum-validated detectors in `dlpPii.ts`, shared with the
 * Rust proxy: card numbers, IBANs and SSNs on by default, email addresses and
 * phone numbers off. `INTUTIC_MCP_DLP_DETECTORS` sets each one's action.
 * Arguments are never rewritten, so any enabled detector — `redact` or
 * `block` — blocks the call on the way in; on results both redact.
 *
 * @module
 */

import { PII_DETECTORS, findPii, resolvePiiActions } from './dlpPii.js'
import type { PiiDetector } from './dlpPii.js'
import { createStderrLogger } from './stderrLog.js'

export interface DlpFinding {
  pattern: string
  description: string
}

export interface DlpScanResult {
  hasFinding: boolean
  findings: DlpFinding[]
}

/**
 * What may separate two SQL keywords: whitespace, a two-character escaped
 * newline, tab or carriage return, a block comment, or a `--` comment that runs
 * to a newline. `DROP\s+TABLE` let through either kind of comment between the
 * words, and, matched against the JSON-encoded arguments, a newline too (it is
 * the two characters `\n` there). Byte-identical to `SQL_GAP` in the proxy's
 * `actions.rs` (a test compares them), where the comment explains why the gap
 * is matched rather than stripped from the text.
 */
const SQL_GAP = String.raw`(?:\s|\\[ntr]|/\*(?:[^*]|\*+[^*/])*\*+/|--(?:[^\n\\]|\\[^n\n])*(?:\n|\\n))+`

const sqlStatement = (...keywords: string[]): RegExp => new RegExp(keywords.join(SQL_GAP), 'i')

/**
 * Compiled DLP patterns.
 *
 * `redactable` separates VALUE patterns (a credential-shaped string that can
 * be replaced with a placeholder wherever it appears) from COMMAND patterns
 * (a destructive instruction, meaningful only as a reason to refuse an
 * input). The distinction exists for the response direction: redacting
 * "DROP TABLE" out of a tool RESULT would rewrite data the tool legitimately
 * returned (a schema dump mentions DROP TABLE), while redacting a key out of
 * a result protects the agent's context without changing what the result
 * means. Command patterns therefore never apply to results.
 */
const DLP_PATTERNS: Array<{ regex: RegExp; description: string; redactable: boolean }> = [
  // API keys / tokens
  { regex: /sk-[A-Za-z0-9]{20,}/, description: 'OpenAI API key pattern', redactable: true },
  { regex: /sk-ant-[A-Za-z0-9\-_]{20,}/, description: 'Anthropic API key pattern', redactable: true },
  { regex: /AIza[A-Za-z0-9\-_]{35}/, description: 'Google API key pattern', redactable: true },
  { regex: /ghp_[A-Za-z0-9]{36}/, description: 'GitHub personal access token', redactable: true },
  { regex: /ghs_[A-Za-z0-9]{36}/, description: 'GitHub server token', redactable: true },
  // `-` is last in these classes, where it is already a literal — the escape
  // was a no-op. It stays a class member either way; see the Slack cases in
  // __tests__/dlp.test.ts, which pin the hyphen-spanning token shape.
  { regex: /xoxb-[A-Za-z0-9-]{50,}/, description: 'Slack bot token', redactable: true },
  { regex: /xoxp-[A-Za-z0-9-]{50,}/, description: 'Slack user token', redactable: true },
  { regex: /AKIA[A-Z0-9]{16}/, description: 'AWS Access Key ID', redactable: true },
  // High-entropy strings that look like secrets (≥40 chars of hex or base64)
  { regex: /[0-9a-f]{40,}/, description: 'High-entropy hex string (possible secret)', redactable: true },
  // Destructive commands — input-only, and matched against each decoded
  // argument string (see scanToolInput). A text rule: it does not parse SQL,
  // so a quoted mention (`SELECT 'drop table'`) is blocked too, because quoting
  // is also how a shell command carries the real thing (`psql -c 'DROP TABLE x'`).
  { regex: /rm\s+-rf?\s+\//, description: 'Destructive rm -rf / command', redactable: false },
  { regex: sqlStatement('DROP', 'TABLE'), description: 'SQL DROP TABLE statement', redactable: false },
  { regex: sqlStatement('DROP', 'DATABASE'), description: 'SQL DROP DATABASE statement', redactable: false },
  { regex: sqlStatement('TRUNCATE', 'TABLE'), description: 'SQL TRUNCATE TABLE statement', redactable: false },
  // Private key material
  { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/, description: 'PEM private key material', redactable: true },
  { regex: /-----BEGIN\s+EC\s+PRIVATE KEY-----/, description: 'EC private key material', redactable: true },
]

/**
 * Control-plane-supplied patterns, compiled. The daemon has fetched and
 * cached `dlpPatterns` since the policy cache existed, and this scanner never
 * read them — a workspace's custom patterns were a setting wired to nothing.
 * The hardcoded floor above stays regardless: an unreachable control plane
 * must degrade to the floor, never to no scanning.
 */
let dynamicPatterns: Array<{ regex: RegExp; description: string; redactable: boolean }> = []

/**
 * Replace the dynamic pattern set from control-plane regex sources.
 * Invalid sources are dropped loudly by count — a pattern that does not
 * compile enforces nothing, and silence there is how it stays broken.
 * Returns the number dropped so the caller can log it.
 */
export function setDynamicPatterns(sources: readonly string[]): number {
  const compiled: typeof dynamicPatterns = []
  let dropped = 0
  for (const src of sources) {
    try {
      compiled.push({
        regex: new RegExp(src),
        description: `Workspace DLP pattern: ${src}`,
        redactable: true,
      })
    } catch {
      dropped += 1
    }
  }
  dynamicPatterns = compiled
  return dropped
}

function allPatterns(): Array<{ regex: RegExp; description: string; redactable: boolean }> {
  return dynamicPatterns.length ? [...DLP_PATTERNS, ...dynamicPatterns] : DLP_PATTERNS
}

let enabledPii: readonly PiiDetector[] = []

/**
 * Set the PII detectors' actions from an `INTUTIC_MCP_DLP_DETECTORS` value.
 * Runs once at load from the environment; exported for tests. Returns the
 * problems it ignored, which are also logged.
 */
export function configurePii(raw: string | undefined): string[] {
  const { actions, problems } = resolvePiiActions(raw)
  enabledPii = PII_DETECTORS.filter((d) => actions.get(d.id) !== 'off')
  if (problems.length) createStderrLogger('mcp-proxy-dlp').warn({ problems }, 'DLP: PII detector settings ignored')
  return problems
}

configurePii(process.env['INTUTIC_MCP_DLP_DETECTORS'])

/**
 * Redact every redactable-pattern match in a string.
 *
 * Used on the RESPONSE direction (tool results, resource reads), where the
 * action already happened and blocking protects nothing — redaction keeps the
 * secret out of the agent's context, which is the only thing still at stake.
 * Command patterns are skipped by design; see DLP_PATTERNS.
 */
export function redactText(text: string): { redacted: string; findings: DlpFinding[] } {
  const findings: DlpFinding[] = []
  let redacted = text
  for (const { regex, description, redactable } of allPatterns()) {
    if (!redactable) continue
    const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
    if (global.test(redacted)) {
      findings.push({ pattern: regex.source, description })
      redacted = redacted.replace(global, '[REDACTED_SECRET]')
    }
  }
  // PII after the secret patterns, with the Rust proxy's placeholder for the
  // category. Spans are replaced back to front so earlier ones stay valid.
  for (const det of enabledPii) {
    const spans = findPii(det, redacted)
    if (!spans.length) continue
    findings.push({ pattern: det.id, description: det.description })
    for (const [start, end] of spans.reverse()) {
      redacted = redacted.slice(0, start) + '[REDACTED_PII]' + redacted.slice(end)
    }
  }
  return { redacted, findings }
}

/** Every string in the arguments, object keys included, as the tool receives it. */
function argumentStrings(value: unknown): string[] {
  const out: string[] = []
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const v = pending.pop()
    if (typeof v === 'string') {
      out.push(v)
    } else if (Array.isArray(v)) {
      for (const item of v) pending.push(item)
    } else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        out.push(key)
        pending.push(item)
      }
    }
  }
  return out
}

/**
 * Scan tool arguments for DLP findings.
 *
 * Value patterns (credentials, PII, workspace patterns) match the serialized
 * arguments. Command patterns match each decoded string instead: in the JSON a
 * newline is the two characters `\n`, so a command split across lines no
 * longer had whitespace between its words.
 *
 * @param toolInput - The tool_input object from the MCP tools/call request
 * @returns DLP scan result with any findings
 */
export function scanToolInput(toolInput: unknown): DlpScanResult {
  const serialized = JSON.stringify(toolInput ?? {})
  const strings = argumentStrings(toolInput)
  const findings: DlpFinding[] = []

  // The full set — floor plus workspace patterns — on the input direction too:
  // a workspace pattern that blocked results but not the input that exfiltrates
  // them would be scanning the wrong side.
  for (const { regex, description, redactable } of allPatterns()) {
    const hit = redactable ? regex.test(serialized) : strings.some((s) => regex.test(s))
    if (hit) {
      findings.push({ pattern: regex.source, description })
    }
  }
  for (const det of enabledPii) {
    if (findPii(det, serialized).length) findings.push({ pattern: det.id, description: det.description })
  }

  return { hasFinding: findings.length > 0, findings }
}

/**
 * Format DLP findings into a human-readable block reason.
 */
export function formatDlpBlockReason(findings: DlpFinding[]): string {
  const list = findings.map((f) => `• ${f.description}`).join('\n')
  return `Tool call blocked by Intutic DLP scanner. Sensitive data detected:\n${list}`
}
