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
 * Compiled DLP patterns. Each entry has a regex and a human-readable description.
 */
const DLP_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  // API keys / tokens
  { regex: /sk-[A-Za-z0-9]{20,}/, description: 'OpenAI API key pattern' },
  { regex: /sk-ant-[A-Za-z0-9\-_]{20,}/, description: 'Anthropic API key pattern' },
  { regex: /AIza[A-Za-z0-9\-_]{35}/, description: 'Google API key pattern' },
  { regex: /ghp_[A-Za-z0-9]{36}/, description: 'GitHub personal access token' },
  { regex: /ghs_[A-Za-z0-9]{36}/, description: 'GitHub server token' },
  { regex: /xoxb-[A-Za-z0-9\-]{50,}/, description: 'Slack bot token' },
  { regex: /xoxp-[A-Za-z0-9\-]{50,}/, description: 'Slack user token' },
  { regex: /AKIA[A-Z0-9]{16}/, description: 'AWS Access Key ID' },
  // High-entropy strings that look like secrets (≥40 chars of hex or base64)
  { regex: /[0-9a-f]{40,}/, description: 'High-entropy hex string (possible secret)' },
  // Destructive shell patterns in Bash/command arguments
  { regex: /rm\s+-rf?\s+\//, description: 'Destructive rm -rf / command' },
  { regex: /DROP\s+TABLE/i, description: 'SQL DROP TABLE statement' },
  { regex: /DROP\s+DATABASE/i, description: 'SQL DROP DATABASE statement' },
  { regex: /TRUNCATE\s+TABLE/i, description: 'SQL TRUNCATE TABLE statement' },
  // Private key material
  { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----/, description: 'PEM private key material' },
  { regex: /-----BEGIN\s+EC\s+PRIVATE KEY-----/, description: 'EC private key material' },
]

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

  for (const { regex, description } of DLP_PATTERNS) {
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
