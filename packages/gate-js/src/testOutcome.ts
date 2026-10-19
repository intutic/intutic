/**
 * Did the tests pass? The deciding function behind the qualified ordering
 * rule `requires_before: action:run_tests[ok] -> action:deploy`, and the
 * per-session state the gates keep of it.
 *
 * {@link decideTestOutcome} reads what a surface saw of one test run (an exit
 * code, an error flag, a success flag, the output) and says `ok`, `failed` or
 * `unknown`, in this order:
 *
 * 1. an integer exit code other than 0, `isError === true` or
 *    `success === false`: failed;
 * 2. any runner summary in the output that reports failures or errors: failed;
 * 3. a summary that says no tests ran (`no tests ran`, `0 passed`, `0 total`,
 *    `0 passing`, `0 examples`) while no summary counts a pass: failed
 *    (`no_tests`);
 * 4. exit code 0: ok;
 * 5. no exit code, and at least one summary counts a pass: ok;
 * 6. anything else: unknown.
 *
 * Unknown leaves a qualified rule unmet, as a failure does: a result that
 * cannot be read is not a pass.
 *
 * {@link extractExitCode} reads an exit code out of text, for a surface that
 * reports only text (Codex's JSON shell output, Claude Code's `Exit code N`
 * error results, `exit status N`, `Process exited with code N`).
 *
 * Runner summaries are read line by line from the last
 * {@link TEST_OUTPUT_TAIL_BYTES} bytes of the output, each line cut to
 * {@link TEST_OUTPUT_LINE_BYTES} bytes, carriage returns and ANSI colour
 * sequences removed. Every pattern is anchored and has no nested quantifier;
 * a summary's counts are read by splitting it, not by a regex, so the whole
 * read is linear in the output.
 *
 * The outcome state ({@link OutcomeState}) is what a gate keeps per session:
 * the latest outcome per outcome token, with when it was recorded, whether a
 * file changed after it (a pass describes the code it ran
 * against, so a later write makes it stale), and whether any other call
 * completed after it (for `~>`).
 *
 * Self-contained (no imports, no module state the emitted source does not
 * carry) so `@intutic/gate` keeps a byte-identical copy and the JavaScript
 * hook gates embed {@link TEST_OUTCOME_JS_SOURCE}. The Python port is
 * `intutic_clawde/gate/test_outcome.py`, the Rust one
 * `packages/proxy/src/plugins/anomaly/outcome.rs`; all of them run
 * `fixtures/test-outcome-vectors.json`.
 *
 * @module
 */

/** The tokens a `[ok]` qualifier may stand on. */
export const OUTCOME_TOKENS = ['action:run_tests'] as const
/** The qualifiers there are. */
export const OUTCOME_QUALIFIERS = ['ok'] as const
/** The one qualified token there is. */
export const QUALIFIED_TOKEN_RE = /^action:run_tests\[ok\]$/
/** How much of a run's output the summaries are read from: its last 64 KiB. */
export const TEST_OUTPUT_TAIL_BYTES = 65536
/** Each line is cut to this many bytes before it is matched. */
export const TEST_OUTPUT_LINE_BYTES = 1024
/** The longest output whose JSON form is parsed for an exit code. */
export const TEST_OUTPUT_JSON_MAX_CHARS = 1048576
/** An outcome older than this is ignored: a day. */
export const OUTCOME_STATE_TTL_MS = 86400000

export type TestOutcome = 'ok' | 'failed' | 'unknown'

/** Why {@link decideTestOutcome} said what it said, by the step that decided. */
export type TestOutcomeWhy =
  | 'exit_code'
  | 'is_error'
  | 'success_false'
  | 'summary_failed'
  | 'no_tests'
  | 'exit_zero'
  | 'summary_passed'
  | 'no_signal'

export interface TestOutcomeInput {
  exitCode?: number | null
  isError?: boolean | null
  success?: boolean | null
  output?: string | null
}

export interface TestOutcomeDecision {
  outcome: TestOutcome
  why: TestOutcomeWhy
}

/** One runner's summary: its counts, and whether it said no tests ran. */
export interface TestRunnerSummary {
  runner: 'pytest' | 'jest' | 'vitest' | 'go' | 'cargo' | 'mocha' | 'rspec'
  passed: number
  /** Failures and errors together. */
  failed: number
  noTests: boolean
}

/** The last `maxBytes` bytes of `s` as UTF-8, starting on a character. */
function testOutcomeUtf8Tail(s: string, maxBytes: number): string {
  let bytes = 0
  let i = s.length
  while (i > 0) {
    const c = s.charCodeAt(i - 1)
    let n = 3
    let w = 1
    if (c < 0x80) n = 1
    else if (c < 0x800) n = 2
    else if (c >= 0xdc00 && c <= 0xdfff && i > 1) {
      const h = s.charCodeAt(i - 2)
      if (h >= 0xd800 && h <= 0xdbff) {
        n = 4
        w = 2
      }
    }
    if (bytes + n > maxBytes) break
    bytes += n
    i -= w
  }
  return s.slice(i)
}

/** The first `maxBytes` bytes of `s` as UTF-8, ending on a character. */
function testOutcomeUtf8Head(s: string, maxBytes: number): string {
  let bytes = 0
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    let n = 3
    let w = 1
    if (c < 0x80) n = 1
    else if (c < 0x800) n = 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const l = s.charCodeAt(i + 1)
      if (l >= 0xdc00 && l <= 0xdfff) {
        n = 4
        w = 2
      }
    }
    if (bytes + n > maxBytes) break
    bytes += n
    i += w
  }
  return s.slice(0, i)
}

/** The lines of `text`, each without carriage returns or ANSI sequences and cut to {@link TEST_OUTPUT_LINE_BYTES} bytes. */
function testOutcomeLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    const line = testOutcomeUtf8Head(raw, 1024).replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    out.push(line)
  }
  return out
}

/** A JSON integer exit code, or null. */
function testOutcomeIntegerOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null
}

/**
 * The exit code a run's text reports, or null. A whole-output JSON object
 * with `metadata.exit_code`, else `exit_code`, else `exitCode`; otherwise the
 * first line, of the first 64 KiB then the last 64 KiB, that is
 * `Exit code N` / `Exit code: N` (any case), `exit status N`, or begins
 * `Process exited with code N` / `Command exited with code N`.
 */
export function extractExitCode(output: string | null | undefined): number | null {
  if (typeof output !== 'string' || output === '') return null
  const trimmed = output.trim()
  if (trimmed.length <= 1048576 && trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>
        const meta = o.metadata
        if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
          const m = testOutcomeIntegerOrNull((meta as Record<string, unknown>).exit_code)
          if (m !== null) return m
        }
        const a = testOutcomeIntegerOrNull(o.exit_code)
        if (a !== null) return a
        const b = testOutcomeIntegerOrNull(o.exitCode)
        if (b !== null) return b
      }
    } catch {
      // Not JSON: read the lines.
    }
  }
  const head = testOutcomeUtf8Head(output, 65536)
  const parts = head.length === output.length ? [head] : [head, testOutcomeUtf8Tail(output.slice(head.length), 65536)]
  for (const part of parts) {
    for (const raw of testOutcomeLines(part)) {
      const line = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
      let m = /^exit code:? (-?[0-9]{1,9})$/i.exec(line)
      if (!m) m = /^exit status ([0-9]{1,9})$/.exec(line)
      if (!m) m = /^(?:Process|Command) exited with code (-?[0-9]{1,9})/.exec(line)
      if (m) return Number(m[1])
    }
  }
  return null
}

/** `N word` pieces of a summary, split on `,` and `|`: the count of each word. */
function testOutcomeCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const piece of text.split(/[,|]/)) {
    const m = /^([0-9]{1,9}) ([a-z]+)/.exec(piece.replace(/^[ \t]+/, ''))
    if (m) counts[m[2]!] = (counts[m[2]!] ?? 0) + Number(m[1])
  }
  return counts
}

/** The runner summaries in the last 64 KiB of `output`, in the order they appear (go and mocha folded into one each). */
export function parseTestSummaries(output: string | null | undefined): TestRunnerSummary[] {
  if (typeof output !== 'string' || output === '') return []
  const out: TestRunnerSummary[] = []
  let go: TestRunnerSummary | null = null
  let mocha: TestRunnerSummary | null = null
  for (const line of testOutcomeLines(testOutcomeUtf8Tail(output, 65536))) {
    let m: RegExpExecArray | null
    if (/^=+ no tests ran/.test(line)) {
      out.push({ runner: 'pytest', passed: 0, failed: 0, noTests: true })
    } else if ((m = /^=+ (.+) in [0-9.]+s.* =+$/.exec(line))) {
      const c = testOutcomeCounts(m[1]!)
      if (c.passed === undefined && c.failed === undefined && c.error === undefined && c.errors === undefined) continue
      out.push({ runner: 'pytest', passed: c.passed ?? 0, failed: (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0), noTests: c.passed === 0 })
    } else if ((m = /^Tests:[ \t]+(.+)$/.exec(line))) {
      const c = testOutcomeCounts(m[1]!)
      out.push({ runner: 'jest', passed: c.passed ?? 0, failed: c.failed ?? 0, noTests: c.passed === 0 || c.total === 0 })
    } else if ((m = /^[ \t]*Tests[ \t]+(.+)$/.exec(line))) {
      const c = testOutcomeCounts(m[1]!)
      if (c.passed === undefined && c.failed === undefined) continue
      out.push({ runner: 'vitest', passed: c.passed ?? 0, failed: c.failed ?? 0, noTests: c.passed === 0 })
    } else if (/^ok[ \t]+[^ \t]+/.test(line)) {
      if (go === null) out.push((go = { runner: 'go', passed: 0, failed: 0, noTests: false }))
      go.passed += 1
    } else if (/^FAIL([ \t]|$)/.test(line) || /^--- FAIL:/.test(line)) {
      if (go === null) out.push((go = { runner: 'go', passed: 0, failed: 0, noTests: false }))
      go.failed += 1
    } else if ((m = /^test result: (ok|FAILED)\. ([0-9]{1,9}) passed; ([0-9]{1,9}) failed;/.exec(line))) {
      const passed = Number(m[2])
      const failed = Number(m[3])
      out.push({ runner: 'cargo', passed, failed: m[1] === 'FAILED' && failed === 0 ? 1 : failed, noTests: passed === 0 })
    } else if ((m = /^[ \t]*([0-9]{1,9}) passing/.exec(line))) {
      if (mocha === null) out.push((mocha = { runner: 'mocha', passed: 0, failed: 0, noTests: false }))
      mocha.passed += Number(m[1])
      if (Number(m[1]) === 0) mocha.noTests = true
    } else if ((m = /^[ \t]*([0-9]{1,9}) failing/.exec(line))) {
      if (mocha === null) out.push((mocha = { runner: 'mocha', passed: 0, failed: 0, noTests: false }))
      mocha.failed += Number(m[1])
    } else if ((m = /^([0-9]{1,9}) examples?, ([0-9]{1,9}) failures?/.exec(line))) {
      const examples = Number(m[1])
      const failures = Number(m[2])
      out.push({ runner: 'rspec', passed: Math.max(0, examples - failures), failed: failures, noTests: examples === 0 })
    }
  }
  return out
}

/** The outcome of one test run. See the module doc for the steps. */
export function decideTestOutcome(input: TestOutcomeInput): TestOutcomeDecision {
  const exit = typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode) ? input.exitCode : null
  if (exit !== null && exit !== 0) return { outcome: 'failed', why: 'exit_code' }
  if (input.isError === true) return { outcome: 'failed', why: 'is_error' }
  if (input.success === false) return { outcome: 'failed', why: 'success_false' }
  const summaries = parseTestSummaries(input.output)
  let passed = 0
  let noTests = false
  for (const s of summaries) {
    if (s.failed > 0) return { outcome: 'failed', why: 'summary_failed' }
    passed += s.passed
    if (s.noTests) noTests = true
  }
  if (passed === 0 && noTests) return { outcome: 'failed', why: 'no_tests' }
  if (exit === 0) return { outcome: 'ok', why: 'exit_zero' }
  if (passed >= 1) return { outcome: 'ok', why: 'summary_passed' }
  return { outcome: 'unknown', why: 'no_signal' }
}

// ---------------------------------------------------------------------------
// The qualifier
// ---------------------------------------------------------------------------

/**
 * Why one side of an ordering rule cannot carry the qualifier it carries, or
 * null when it is fine. A side carries a qualifier when it holds `[` or `]`;
 * only `action:run_tests[ok]`, on the left of the arrow, is one. The error
 * names the side as written, quoted as the parser quotes it.
 */
export function orderingQualifierError(side: string, left: boolean): string | null {
  if (side.indexOf('[') === -1 && side.indexOf(']') === -1) return null
  if (left && side === 'action:run_tests[ok]') return null
  return JSON.stringify(side) + ': [ok] qualifies only action:run_tests, on the left of ->'
}

/** `action:run_tests[ok]` as `{ token: 'action:run_tests', qualifier: 'ok' }`; any other token unqualified. */
export function splitQualifier(token: string): { token: string; qualifier: 'ok' | null } {
  return token === 'action:run_tests[ok]' ? { token: 'action:run_tests', qualifier: 'ok' } : { token, qualifier: null }
}

// ---------------------------------------------------------------------------
// The per-session state
// ---------------------------------------------------------------------------

/** The latest outcome of one token in a session. */
export interface OutcomeEntry {
  o: TestOutcome
  /** Epoch milliseconds. */
  at: number
  /** Why `o` is what it is ({@link TestOutcomeWhy}). */
  why?: string
  /** A file changed after the run: a pass no longer counts. */
  changed?: true
  /** Another call completed after the run: it is not adjacent to the next one. */
  later?: true
}

/** `~/.intutic/hooks/state/outcomes/<key>.json`, and a gate SDK's memory. */
export interface OutcomeState {
  v: 1
  outcomes: Record<string, OutcomeEntry>
}

/** A state with nothing in it. */
export function emptyOutcomeState(): OutcomeState {
  return { v: 1, outcomes: {} }
}

/** The state file's name for one session: the first 32 hex of sha256(harness NUL sessionId), and `.json`. */
export function outcomeStateFileName(harness: string, sessionId: string, sha256Hex: (text: string) => string): string {
  return sha256Hex(harness + '\0' + sessionId).slice(0, 32) + '.json'
}

/** A state file's text as a state, or null when it is not one: a damaged file is no state, which leaves every rule unmet. */
export function parseOutcomeState(text: string): OutcomeState | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const s = v as Record<string, unknown>
  if (s.v !== 1 || s.outcomes === null || typeof s.outcomes !== 'object' || Array.isArray(s.outcomes)) return null
  const outcomes: Record<string, OutcomeEntry> = {}
  for (const key of Object.keys(s.outcomes as object)) {
    const e = (s.outcomes as Record<string, unknown>)[key]
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return null
    const r = e as Record<string, unknown>
    if ((r.o !== 'ok' && r.o !== 'failed' && r.o !== 'unknown') || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
    if (r.why !== undefined && typeof r.why !== 'string') return null
    if (r.changed !== undefined && r.changed !== true) return null
    if (r.later !== undefined && r.later !== true) return null
    outcomes[key] = r as unknown as OutcomeEntry
  }
  return { v: 1, outcomes }
}

/** `state` with `token`'s outcome replaced by this run's. */
export function recordTestOutcome(state: OutcomeState, token: string, decision: TestOutcomeDecision, atMs: number): OutcomeState {
  const outcomes: Record<string, OutcomeEntry> = {}
  for (const k of Object.keys(state.outcomes)) outcomes[k] = state.outcomes[k]!
  outcomes[token] = { o: decision.outcome, at: atMs, why: decision.why }
  return { v: 1, outcomes }
}

/**
 * `state` after another call completed: every entry is no longer adjacent to
 * what comes next, and when the call changed a file (`changedFiles`), a pass
 * before it no longer counts.
 */
export function noteCompletedCall(state: OutcomeState, changedFiles: boolean): OutcomeState {
  const outcomes: Record<string, OutcomeEntry> = {}
  for (const k of Object.keys(state.outcomes)) {
    const e = state.outcomes[k]!
    const next: OutcomeEntry = { o: e.o, at: e.at }
    if (e.why !== undefined) next.why = e.why
    if (e.changed || changedFiles) next.changed = true
    next.later = true
    outcomes[k] = next
  }
  return { v: 1, outcomes }
}

/** Why a qualified prerequisite is unmet, or `met`. */
export type PrerequisiteCase = 'met' | 'none' | 'failed' | 'unknown' | 'changed' | 'not_adjacent' | 'not_observable' | 'no_session'

/**
 * Whether `token`'s latest outcome in `state` meets a qualified rule now:
 * `met` only for an `ok` younger than {@link OUTCOME_STATE_TTL_MS} that no
 * file change followed (and, for `~>`, that no other call followed). A null
 * state (none, or unreadable) is `none`.
 */
export function prerequisiteCase(state: OutcomeState | null, token: string, adjacent: boolean, nowMs: number): { case: PrerequisiteCase; why: string | null } {
  const e = state === null ? undefined : state.outcomes[token]
  if (e === undefined || !(nowMs - e.at < 86400000) || e.at > nowMs) return { case: 'none', why: null }
  if (e.o === 'failed') return { case: 'failed', why: e.why ?? null }
  if (e.o === 'unknown') return { case: 'unknown', why: e.why ?? null }
  if (e.changed) return { case: 'changed', why: null }
  if (adjacent && e.later) return { case: 'not_adjacent', why: null }
  return { case: 'met', why: null }
}

/**
 * The reason a refusal (`PREREQUISITE_UNMET`) gives, for every case but
 * `met`. `harness` names the surface for `not_observable` and `no_session`.
 * Byte-stable: every port answers with these exact words.
 */
export function prerequisiteUnmetReason(first: string, then: string, c: PrerequisiteCase, why: string | null, harness: string): string {
  const head = then + ' needs a passing ' + first + ' first; '
  switch (c) {
    case 'none':
      return head + 'none ran in this session'
    case 'failed':
      return head + 'the last ' + first + ' failed (' + (why ?? 'failed') + ')'
    case 'unknown':
      return head + 'the result of the last ' + first + ' could not be read; rerun the tests so their summary is visible'
    case 'changed':
      return head + 'files changed after the last passing ' + first + '; rerun the tests'
    case 'not_adjacent':
      return head + then + ' must come directly after it, and another call came between'
    case 'not_observable':
      return head + harness + ' reports no tool results Intutic can read, so a passing run cannot be observed here'
    case 'no_session':
      return head + harness + ' sent no session id, so test results cannot be tied to this session'
    default:
      return ''
  }
}

/**
 * The functions above as JavaScript source, for the hook gates to embed: the
 * gates run this exact code. A CommonJS build names an exported function
 * `exports.X` inside another; the source defines each as a plain `X`, so that
 * prefix is dropped.
 */
export const TEST_OUTCOME_JS_SOURCE = [
  testOutcomeUtf8Tail,
  testOutcomeUtf8Head,
  testOutcomeLines,
  testOutcomeIntegerOrNull,
  extractExitCode,
  testOutcomeCounts,
  parseTestSummaries,
  decideTestOutcome,
  orderingQualifierError,
  splitQualifier,
  emptyOutcomeState,
  outcomeStateFileName,
  parseOutcomeState,
  recordTestOutcome,
  noteCompletedCall,
  prerequisiteCase,
  prerequisiteUnmetReason,
]
  .map((fn) => fn.toString().replace(/\bexports\./g, ''))
  .join('\n')
