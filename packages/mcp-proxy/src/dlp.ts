/**
 * dlp.ts — DLP (Data Loss Prevention) argument scanner.
 *
 * Scans tool arguments (as a JSON string) for patterns that indicate
 * credentials, secrets, PII, or other sensitive data before allowing
 * the tool call to proceed.
 *
 * @module
 */

export interface DlpFinding {
  pattern: string
  description: string
}

export interface DlpScanResult {
  hasFinding: boolean
  findings: DlpFinding[]
}

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
  // PII. The Rust proxy's dlp.rs has carried an SSN pattern from the start;
  // this scanner had none, so a tool result carrying one streamed into the
  // agent's context unremarked. Same shape dlp.rs uses: grouped digits only —
  // a bare 9-digit run matches phone numbers and IDs far too often.
  { regex: /\b\d{3}-\d{2}-\d{4}\b/, description: 'US Social Security Number', redactable: true },
  // High-entropy strings that look like secrets (≥40 chars of hex or base64)
  { regex: /[0-9a-f]{40,}/, description: 'High-entropy hex string (possible secret)', redactable: true },
  // Destructive shell patterns in Bash/command arguments — input-only.
  { regex: /rm\s+-rf?\s+\//, description: 'Destructive rm -rf / command', redactable: false },
  { regex: /DROP\s+TABLE/i, description: 'SQL DROP TABLE statement', redactable: false },
  { regex: /DROP\s+DATABASE/i, description: 'SQL DROP DATABASE statement', redactable: false },
  { regex: /TRUNCATE\s+TABLE/i, description: 'SQL TRUNCATE TABLE statement', redactable: false },
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
  return { redacted, findings }
}

/**
 * Scan tool arguments for DLP findings.
 *
 * @param toolInput - The tool_input object from the MCP tools/call request
 * @returns DLP scan result with any findings
 */
export function scanToolInput(toolInput: unknown): DlpScanResult {
  // Serialize to string for pattern matching
  const serialized = JSON.stringify(toolInput ?? {})
  const findings: DlpFinding[] = []

  // The full set — floor plus workspace patterns — on the input direction too:
  // a workspace pattern that blocked results but not the input that exfiltrates
  // them would be scanning the wrong side.
  for (const { regex, description } of allPatterns()) {
    if (regex.test(serialized)) {
      findings.push({ pattern: regex.source, description })
    }
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
