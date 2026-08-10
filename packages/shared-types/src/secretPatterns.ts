/**
 * Credential-VALUE patterns, declared once.
 *
 * Three consumers, three engines, one source:
 *   - the hook gate's static floor (`protectedPaths.ts` → emitted JS gates and
 *     bash gates via `grep -E`) — refuses a Write/Edit whose CONTENT carries a
 *     credential-shaped string, before the file exists;
 *   - the pre-commit scan (`tools/cli/src/lib/gitHooks.ts`, `grep -E` over the
 *     staged diff) — the last line before a secret enters git history;
 *   - tests in both packages.
 *
 * Hand-copying these between the gate and the git hook is how the two would
 * drift into enforcing different notions of "credential" — the exact
 * two-copies failure the WASM host-import list had. So the dialect here is
 * the gate table's portable subset (see `assertPortableEre`): JS `RegExp` ∩
 * POSIX ERE, with no `\b`, no lookaround, no `\d`/`\s` — and no interval
 * quantifiers, which that checker forbids because `{n}` behaviour differs
 * across greps. Repetition is therefore EXPANDED (`[A-Z2-7]` sixteen times),
 * built by `.repeat()` below so the count is stated once, not typed sixteen
 * times wrongly.
 *
 * Only HIGH-PRECISION shapes belong here: every pattern gates at `block`, and
 * a false positive teaches the developer to disable the hook — the bypass the
 * rest of the gate exists to stop. Prefixed formats (AKIA…, sk-ant-…, gh?_…,
 * PEM armor) essentially never occur in benign prose in real format; the
 * generic shapes (high-entropy hex, bare base64 runs) deliberately stay out,
 * in the proxy's DLP where redaction — not refusal — is the response.
 */
export interface SecretValuePattern {
  /** Stable id, `secrets.*` family. Appears in block messages and audit lines. */
  id: string
  /** JS RegExp ∩ POSIX ERE source, portable-subset clean. */
  source: string
  /** Shown to the developer the moment they are blocked. */
  description: string
}

/** `cls` repeated `n` times — interval quantifiers are not in the portable subset. */
const rep = (cls: string, n: number): string => cls.repeat(n)

export const SECRET_VALUE_PATTERNS: readonly SecretValuePattern[] = [
  {
    id: 'secrets.aws_access_key',
    // AKIA long-lived, ASIA temporary, ABIA/ACCA/A3T* other classes; base32
    // alphabet [A-Z2-7] per gitleaks — 0,1,8,9 never appear. Same shape the
    // Rust proxy's dlp.rs and the MCP proxy's scanner pin.
    source: '(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)' + rep('[A-Z2-7]', 16),
    description: 'AWS access key ID',
  },
  {
    id: 'secrets.anthropic_api_key',
    // 20 required tail characters, then any more — the portable spelling of {20,}.
    source: 'sk-ant-' + rep('[A-Za-z0-9_-]', 20) + '[A-Za-z0-9_-]*',
    description: 'Anthropic API key',
  },
  {
    id: 'secrets.github_token',
    // All five classic prefixes: PAT (ghp), OAuth (gho), App-user (ghu),
    // App-server (ghs), refresh (ghr).
    source: 'gh[pousr]_' + rep('[A-Za-z0-9]', 36),
    description: 'GitHub token',
  },
  {
    id: 'secrets.private_key_pem',
    source: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    description: 'PEM private key material',
  },
]

/**
 * The alternation of every pattern, for consumers that make one pass —
 * the pre-commit hook's single `grep -E` over the staged diff.
 */
export function secretPatternAlternation(): string {
  return SECRET_VALUE_PATTERNS.map((p) => `(${p.source})`).join('|')
}
