/**
 * Redaction for the request context captured when a review hold fires.
 *
 * A hold snapshot is the one place in the product where raw tool *arguments*
 * leave the developer's machine. `Write` carries file contents; `Bash` carries
 * whole command lines; both routinely contain credentials that the developer
 * never intended to publish. The proxy's DLP scanner does not help here — it
 * sits on the HTTP path, and this runs inside the harness before any request
 * exists.
 *
 * So the snapshot is redacted and capped **in the hook, before it touches
 * disk** — not in the daemon on the way out. If it were done on the way out,
 * the plaintext would already be sitting in `.intutic/events/`, and a file that
 * exists is a file that gets copied into a bug report.
 *
 * ## Why this is emitted rather than imported
 *
 * The generated hook is a standalone script with no module resolution — it runs
 * as whatever `node` the harness invokes, in whatever directory. So the function
 * below is serialised into it with `String()`. That is also why it must be
 * **entirely self-contained**: no imports, no closure captures, no references to
 * anything outside its own body — `emitRedactor` declares every module-level
 * name these two reach, and a test evaluates the emitted text to prove it.
 *
 * Serialising the function instead of pasting a source string is deliberate.
 * Four separate bugs in this file's history came from backticks and `${`
 * sequences inside emitted code terminating the enclosing template literal.
 * An interpolated *value* is never re-parsed, so that whole class is gone — and
 * the function gets ordinary unit tests instead of being tested through a
 * generated artifact.
 *
 * @module
 */

/** Longest string kept verbatim. Past this the middle is dropped, not the end. */
export const MAX_STRING = 2_000
/** Deepest object nesting walked. Below this, values become a marker. */
export const MAX_DEPTH = 6
/** Most array elements kept. */
export const MAX_ARRAY = 50
/** Hard ceiling on the serialised snapshot. */
export const MAX_SNAPSHOT_BYTES = 32_768

/**
 * Returns a redacted, size-capped copy of `value`.
 *
 * Self-contained by contract — see the module docstring. Do not add imports or
 * outer-scope references to this function; `emitRedactor()` asserts it stays
 * closed over nothing.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  // Keys whose value is a credential regardless of what it looks like. Matched
  // loosely on purpose: `apiKey`, `api_key`, `X-Api-Key` and `apikey` all occur.
  const SECRET_KEY =
    /(pass(word|phrase)?|secret|token|api[-_ ]?key|auth(orization)?|credential|private[-_ ]?key|session[-_ ]?id|cookie)/i

  // Credential *shapes*, for values that arrive under an innocent key — the
  // common case, since most of these appear inside a shell command string.
  const SECRET_VALUE: RegExp[] = [
    /AKIA[0-9A-Z]{16}/g, // AWS access key id
    /ASIA[0-9A-Z]{16}/g, // AWS temporary access key id
    /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
    /sk-[A-Za-z0-9]{32,}/g, // OpenAI and lookalikes
    /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /AIza[0-9A-Za-z_-]{30,}/g, // Google
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    // Bare basic-auth in a URL.
    /\/\/[^/\s:@]+:[^/\s:@]+@/g,
  ]

  // Assignment forms — `--token=…`, `PASSWORD=…`, `"secret": "…"`,
  // `Authorization: Bearer …`. Matched in two steps, name first and value
  // second, for two independent reasons.
  //
  // **Cost.** The single regex this replaces put two unbounded runs either side
  // of the keyword alternation — `[A-Za-z0-9_-]*(token|…)[A-Za-z0-9_-]*` — so
  // every start offset enumerated every split point of the identifier and the
  // whole thing went quadratic. Measured on `'key'.repeat(n)`: 59 KB took 566 ms
  // and 469 KB took 38 *seconds*, synchronously, inside a `PreToolUse` hook. The
  // size caps do not bound it: `scrub` redacts the whole string and truncates to
  // MAX_STRING only afterwards, and MAX_SNAPSHOT_BYTES applies later still. A
  // `Write` carrying a few hundred KB of file content was enough. Matching the
  // name alone is bounded by the identifier run, and the value is walked once,
  // by hand, only after the name has been found interesting — 1.2 MB in ~25 ms.
  //
  // **Reach.** That same mandatory `[A-Za-z_]` before the alternation meant the
  // keyword could only ever be an *infix* of the identifier, never the whole of
  // it. So `MY_API_KEY=` redacted and `PASSWORD=`, `--token=`, `--credential=`,
  // `passphrase=` and `"secret":` did not — all three of the forms the old
  // comment offered as its examples passed through to disk in plaintext.
  const NAME = /\b([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?)/g
  const NAME_IS_SECRET = /pass(word|phrase)?|secret|token|key|credential|auth(orization)?/i
  const VALUE_END = /[\s"',;]/

  const redactAssignments = (s: string): string => {
    let out = ''
    let copied = 0
    let m: RegExpExecArray | null
    NAME.lastIndex = 0
    while ((m = NAME.exec(s)) !== null) {
      // Declining leaves `lastIndex` just past the separator rather than past a
      // consumed value, so a boring name cannot shadow a secret packed into the
      // same unbroken run — `--set=PGPASSWORD=…` still redacts.
      if (!NAME_IS_SECRET.test(m[1] as string)) continue
      let end = NAME.lastIndex
      while (end < s.length && !VALUE_END.test(s[end] as string)) end += 1
      // Too short to be a credential, and short enough that redacting it would
      // cost more context than it protects.
      if (end - NAME.lastIndex < 8) continue
      out += s.slice(copied, NAME.lastIndex) + '[redacted]'
      copied = end
      NAME.lastIndex = end
    }
    // The name and separator survive. A snapshot exists to be reviewed, and
    // `--token=[redacted]` tells the reviewer what was held; a bare
    // `[redacted]` swallowing the key name does not.
    return copied === 0 ? s : out + s.slice(copied)
  }

  const scrub = (s: string): string => {
    let out = s
    for (const re of SECRET_VALUE) out = out.replace(re, '[redacted]')
    out = redactAssignments(out)
    if (out.length > MAX_STRING) {
      // Keep both ends. A command's verb is at the front and its target is at
      // the back; truncating the tail throws away the half that identifies what
      // the hold was about.
      const half = Math.floor(MAX_STRING / 2)
      out = `${out.slice(0, half)}…[${out.length - MAX_STRING} chars elided]…${out.slice(-half)}`
    }
    return out
  }

  if (depth > MAX_DEPTH) return '[depth limit]'
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return scrub(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => redactSecrets(v, depth + 1))
    if (value.length > MAX_ARRAY) kept.push(`[${value.length - MAX_ARRAY} more elided]`)
    return kept
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(v, depth + 1)
    }
    return out
  }
  // Functions, symbols, bigints — nothing a tool input should carry.
  return `[${typeof value}]`
}

/**
 * Emits both functions as standalone JavaScript for the generated hook.
 *
 * The caps are declared ahead of the functions rather than substituted into
 * their bodies, so one definition serves the emitted hook and the unit tests.
 */
export function emitRedactor(): string {
  // Bound under their SOURCE names first, then aliased.
  //
  // `buildContextSnapshot` calls `redactSecrets` by name, and a named function
  // expression only supplies a binding for its own recursion — not for its
  // siblings. Emitting solely as `__intuticSnapshot` produced a body calling a
  // `redactSecrets` that did not exist in the hook, which threw inside the
  // hold-write catch and silently produced no snapshot at all. The structural
  // assertions did not catch it; evaluating the emitted text did, which is why
  // that test exists.
  return [
    '// ── Intutic hold redaction ───────────────────────────────────────────',
    '// Serialised from harness/holdRedaction.ts. Do not edit here.',
    `const MAX_STRING = ${MAX_STRING};`,
    `const MAX_DEPTH = ${MAX_DEPTH};`,
    `const MAX_ARRAY = ${MAX_ARRAY};`,
    `const MAX_SNAPSHOT_BYTES = ${MAX_SNAPSHOT_BYTES};`,
    `const redactSecrets = ${String(redactSecrets)};`,
    `const buildContextSnapshot = ${String(buildContextSnapshot)};`,
    'const __intuticRedact = redactSecrets;',
    'const __intuticSnapshot = buildContextSnapshot;',
  ].join('\n')
}

/**
 * Builds the snapshot the hook writes, redacted and under the byte ceiling.
 *
 * Serialised into the hook by `emitRedactor` and imported directly by the
 * tests, so what the tests exercise is what runs.
 */
export function buildContextSnapshot(input: {
  tool: string
  toolInput: unknown
  cwd: string
  reason: string
}): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    tool: input.tool,
    reason: input.reason,
    cwd: redactSecrets(input.cwd),
    toolInput: redactSecrets(input.toolInput),
  }
  const serialised = JSON.stringify(snapshot)
  if (serialised.length > MAX_SNAPSHOT_BYTES) {
    // Drop the arguments rather than truncating the JSON into something that
    // will not parse. A snapshot that says why it is incomplete is usable; a
    // snapshot that is silently half a document is not.
    //
    // No re-serialise: the replacement is a short string, so the result is
    // necessarily under the cap, and nothing downstream reads a byte count.
    snapshot['toolInput'] = `[elided: ${serialised.length} bytes over the ${MAX_SNAPSHOT_BYTES} cap]`
  }
  return snapshot
}
