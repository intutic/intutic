/**
 * The gate evaluator, emitted once per language instead of written thirteen
 * times.
 *
 * # Why this file exists
 *
 * Every harness writer used to hand-author its own copy of the decision logic
 * inside a TypeScript template literal. Four production defects came directly
 * out of that arrangement, and each one silently removed enforcement while every
 * test stayed green:
 *
 * - `claudeCodeHooks` emitted `...UNIVERSAL_PROTECTED_PATHS,` as *literal source
 *   text* into a script that never imported it. Node threw `ReferenceError`
 *   before the gate decided anything — and a Claude Code PreToolUse hook exiting
 *   1 is a hook *error*, not a block, so the call proceeded.
 * - `INTUITIC_` for `INTUTIC_`: the gate died on an unbound variable under
 *   `set -u`, exiting 1 rather than 2 — again, not a block.
 * - Five bash writers wrote `\"` where `\\"` was needed. Bash ate the quotes,
 *   the audit line stopped being parseable JSON, and `drainHookEvents` drops
 *   malformed lines and then *wipes the log* on a successful drain. The record
 *   of a block was destroyed rather than delayed.
 * - `gooseHooks`/`openhandsHooks` never extracted a command at all, so neither
 *   had a shell-bypass guard — for their entire life.
 *
 * The common cause is not carelessness. It is that shell and JavaScript embedded
 * in a template literal have three levels of escaping and no compiler checking
 * any of them. Emitting from one place does not make the escaping easier; it
 * makes there be one of it, with one set of tests.
 *
 * # The contract with a writer
 *
 * # One editing hazard, since it bit four times
 *
 * A backtick inside a comment in an emitted body ends the TypeScript template
 * literal it lives in, and the rest of the gate becomes TypeScript. `tsc` does
 * catch it — but as a syntax error dozens of lines away, which reads as
 * unrelated damage. Use plain quotes in comments inside the emitted strings.
 *
 * A lint for this was tried and removed: a line-based scan cannot cheaply tell
 * a comment inside a template literal from one outside it, and it produced 26
 * false positives on this file's own prose. The compiler is the right detector;
 * this note is the right documentation.
 *
 * A writer supplies the harness-specific parts — how to read the tool call, how
 * to record an event, how to refuse — and interpolates the bodies below. See
 * {@link ShellGateOptions} and {@link JsGateOptions} for exactly what must be in
 * scope.
 *
 * @module
 */
import {
  DESTRUCTIVE_COMMAND_PATTERNS,
  NORMALISE_CONTRACT,
  staticFloorPatterns,
  type GuardPattern,
} from './protectedPaths.js'

/**
 * Bumped when the emitted evaluator changes shape.
 *
 * Stamped into the header of every emitted gate and into the policy snapshot, so
 * the version a machine is actually running can be read off the artifact rather
 * than inferred. The previous docstring claimed it "rides on every audit line",
 * which was simply untrue — nothing emitted it anywhere, and a constant whose
 * comment describes behaviour it does not have is worse than no constant.
 *
 * v4: the `.rules` projection grew an `argPatternB64` column and every emitted
 * evaluator learned to condition a matched rule on the serialized tool input
 * (` WHERE ` SOP rules). Nothing *triggers* on this number: the daemon
 * regenerates every gate unconditionally each sync cycle, the snapshot writer
 * stamps it into `policy-snapshot.json` for support conversations, and
 * `gateLivenessService` records it off events when a gate reports one. A v3
 * gate reading a v4 snapshot and a v4 gate reading a v3 snapshot both degrade
 * to v3 behaviour — see the encoding note on {@link RULES_COLUMNS}.
 */
export const GATE_VERSION = 4

/**
 * How old a snapshot may be before a gate reports it as stale.
 *
 * Alerting only — a stale snapshot is still enforced, deliberately. If rules
 * expired into permissiveness, "stop the daemon and wait" would be a supported
 * way to disarm governance. Seven days is far longer than the sync interval, so
 * this fires on "the daemon has been dead for a week", not on "it is Sunday".
 */
export const SNAPSHOT_STALE_AFTER_DAYS = 7

/**
 * How a gate refuses a call.
 *
 * The two values are not stylistic. Claude Code, Cursor and the bash harnesses
 * read the **exit code** (2 = deny; 1 is an error and lets the call through).
 * Cline and Roo Code ignore the exit code and read a **JSON object on stdout**.
 * A gate that uses the wrong one looks identical in review and enforces nothing.
 */
export type BlockContract = 'exit2' | 'stdout-cancel'

/** Single-quotes a string for shell, safely. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/**
 * Emits a guard table as a bash array of tab-separated records.
 *
 * Tab-separated rather than parallel arrays so that a rule cannot half-exist:
 * with four arrays kept in step by index, dropping one entry shifts every
 * severity by one and the table still "works".
 */
function shellGuardTable(name: string, patterns: readonly GuardPattern[]): string {
  const rows = patterns.map(
    (p) =>
      `  ${shq(
        [p.id, p.severity, p.ignoreCase ? 'i' : '-', p.subject ?? 'any', p.reason, p.source].join('\t'),
      )}`,
  )
  return `${name}=(\n${rows.join('\n')}\n)`
}

/** Emits a guard table as a JS array literal. */
function jsGuardTable(name: string, patterns: readonly GuardPattern[]): string {
  const rows = patterns.map(
    (p) =>
      `  { id: ${JSON.stringify(p.id)}, re: new RegExp(${JSON.stringify(p.source)}` +
      `${p.ignoreCase ? ", 'i'" : ''}), severity: ${JSON.stringify(p.severity)}, ` +
      `subject: ${JSON.stringify(p.subject ?? 'any')}, reason: ${JSON.stringify(p.reason)} },`,
  )
  return `const ${name} = [\n${rows.join('\n')}\n];`
}

/**
 * The `.rules` snapshot record layout, defined once so the writer and every
 * reader cannot disagree about column order.
 *
 * `source` may contain any punctuation EXCEPT a tab — `assertPortableEre`
 * rejects literal tabs precisely because this projection is tab-separated —
 * so it is safe mid-record.
 *
 * `argPatternB64` is the ` WHERE ` clause of a SOP rule, **base64-encoded**
 * (standard alphabet, UTF-8 source), and the encoding is not a stylistic
 * choice. An argPattern is an arbitrary JS regex: unlike `source` it is not
 * run through `assertPortableEre`, so it may legally contain tabs, and any
 * escaping convention would be a second dialect every one of the four readers
 * (bash, JS, the Open WebUI filter, and the LangGraph port) had to get
 * byte-identically right. Base64's alphabet ([A-Za-z0-9+/=]) cannot collide
 * with the separator, full stop.
 *
 * The column is OMITTED (not emitted empty) when a rule has no argPattern, so
 * every rule that exists today serialises byte-identically to the v3 layout.
 * Compatibility in both directions:
 *  - a v4 gate reading a v3 file sees six fields and treats every rule as
 *    name-only — exactly v3 behaviour;
 *  - a v3 gate reading a v4 file: the JS and Python readers index `f[5]` and
 *    ignore the extra field; the bash reader's final `read` variable absorbs
 *    `source<TAB>base64`, so that one rule matches nothing rather than
 *    crashing the gate. That last degradation (a WHERE rule inert under a
 *    stale bash gate for one sync cycle, until the daemon — which writes both
 *    the snapshot and the gates — regenerates them) is the cost of never
 *    shifting the six columns every deployed reader already indexes.
 */
export const RULES_COLUMNS = ['id', 'severity', 'flags', 'subject', 'reason', 'source', 'argPatternB64'] as const

/**
 * Serialises one rule into a `.rules` line.
 *
 * The reason travels with the rule rather than being generated at block time.
 * `hookEvents.resolveSeverity` classifies an incident by looking for the literal
 * substrings "governance-protected" and "bypass pattern" in the reason text — so
 * a gate that emits a generic message files a governance-config tamper as MEDIUM
 * instead of CRITICAL, and whatever routes on CRITICAL never sees it. That
 * coupling is asserted in `harnessProtectedPaths.test.ts`.
 */
export function toRulesLine(p: GuardPattern): string {
  const reason = p.reason.replace(/[\t\n\r]/g, ' ')
  const base = [p.id, p.severity, p.ignoreCase ? 'i' : '-', p.subject ?? 'any', reason, p.source].join('\t')
  // Appended only when present — see RULES_COLUMNS for why base64, and why a
  // rule without one must serialise byte-identically to the v3 layout.
  return p.argPattern ? base + '\t' + Buffer.from(p.argPattern, 'utf8').toString('base64') : base
}

export interface ShellGateOptions {
  /** Harness id, as it appears in audit lines. */
  harness: string
  /**
   * Name of the shell function the writer defined to record an event.
   * Called as `<fn> <verdict> <tool> <reason>`.
   */
  logFn?: string
}

/**
 * The bash gate body.
 *
 * Expects in scope: `$TOOL`, `$TARGET`, `$COMMAND`, and the log function named
 * by {@link ShellGateOptions.logFn}. Refuses with `exit 2` — every bash harness
 * uses the exit-code contract.
 */
export function emitShellGate(opts: ShellGateOptions): string {
  const log = opts.logFn ?? 'log_event'
  const floor = staticFloorPatterns()
  return `
# ── Intutic gate body v${GATE_VERSION} — harness: ${opts.harness} ────────────
# Generated by harness/gateBody.ts. Do not edit here; every harness regenerates.
#
# The harness name and version are stamped so this file identifies itself. Both
# were previously passed in and dropped on the floor: opts.harness was declared
# on the option type, supplied by all thirteen writers, and read nowhere.

${NORMALISE_CONTRACT.shell}

# The static floor: compiled in, always enforced, never sourced from disk.
# These are the families with years of evidence behind them, so they block from
# the first run — before any sync has happened.
${shellGuardTable('INTUTIC_FLOOR', floor)}

# The dynamic tier, read from the policy snapshot. Additive only: it can turn an
# allow into a block, never a block into an allow. See policySnapshot.ts.
INTUTIC_SNAPSHOT_RULES="\${INTUTIC_SNAPSHOT_RULES:-$HOME/.intutic/hooks/policy-snapshot.rules}"
INTUTIC_SNAPSHOT_DIGEST="none"
INTUTIC_SNAPSHOT_STATE="absent"
INTUTIC_DYNAMIC=()

# A supported escape hatch, and the reason it exists is not politeness.
#
# The fastest workaround available to a developer wrongly blocked is
# \`chflags nouchg\` on the hook — the exact bypass the floor exists to stop. If
# the only way out is one we treat as an attack, we have manufactured our own
# adversary. So: an escape we can see, that disables the **dynamic tier only**.
# The floor is never disabled by it. Every invocation while it is set emits an
# event, so a machine running ungoverned is visible rather than quiet.
INTUTIC_GUARDS_DISABLED=0
if [ "\${INTUTIC_GUARD_DISABLE:-}" = "1" ]; then
  INTUTIC_GUARDS_DISABLED=1
  ${log} "guards_disabled" "\${TOOL:-}" "INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active" || true
fi

INTUTIC_SNAPSHOT_WORKSPACE=""
INTUTIC_SNAPSHOT_GENERATED=""
if [ -f "$INTUTIC_SNAPSHOT_RULES" ]; then
  INTUTIC_SNAPSHOT_STATE="ok"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      '#digest '*)    INTUTIC_SNAPSHOT_DIGEST="\${_line#\\#digest }" ;;
      '#workspace '*) INTUTIC_SNAPSHOT_WORKSPACE="\${_line#\\#workspace }" ;;
      '#generated '*) INTUTIC_SNAPSHOT_GENERATED="\${_line#\\#generated }" ;;
      '#'*|'') : ;;
      *) INTUTIC_DYNAMIC+=("$_line") ;;
    esac
  done < "$INTUTIC_SNAPSHOT_RULES"

  # Integrity, in the order that fails cheapest first.
  #
  # All three of these were parsed and then ignored. A digest nobody recomputes
  # is not integrity, it is a comment; and a workspace id nobody compares means a
  # snapshot from workspace A dropped onto workspace B's machine is enforced
  # verbatim, with B's audit events attributing A's rules to B.
  _intutic_body="$(grep -v '^#' "$INTUTIC_SNAPSHOT_RULES" | grep -v '^$' || true)"
  _intutic_actual=""
  if command -v shasum >/dev/null 2>&1; then
    _intutic_actual="$(printf '%s' "$_intutic_body" | shasum -a 256 | cut -c1-32)"
  elif command -v sha256sum >/dev/null 2>&1; then
    _intutic_actual="$(printf '%s' "$_intutic_body" | sha256sum | cut -c1-32)"
  fi

  if [ -n "$_intutic_actual" ] && [ "$_intutic_actual" != "$INTUTIC_SNAPSHOT_DIGEST" ]; then
    INTUTIC_SNAPSHOT_STATE="invalid"
  elif [ -n "$INTUTIC_SNAPSHOT_WORKSPACE" ] && [ -n "\${INTUTIC_WORKSPACE_ID:-}" ] \
       && [ "$INTUTIC_SNAPSHOT_WORKSPACE" != "$INTUTIC_WORKSPACE_ID" ]; then
    INTUTIC_SNAPSHOT_STATE="invalid"
  elif [ \${#INTUTIC_DYNAMIC[@]} -eq 0 ]; then
    # Distinct from "absent". The writer always ships the destructive tier, so a
    # rule-less snapshot means the compile produced nothing — a real fault that
    # otherwise looks exactly like a healthy quiet workspace.
    INTUTIC_SNAPSHOT_STATE="empty"
  fi

  # Degrade to the compiled floor. The dynamic tier is additive, so dropping it
  # returns to yesterday's behaviour rather than opening a hole.
  if [ "$INTUTIC_SNAPSHOT_STATE" = "invalid" ]; then
    INTUTIC_DYNAMIC=()
  fi
fi

# Staleness governs alerting, not enforcement: rules stay in force. If they
# expired into permissiveness, "kill the daemon and wait" would be a supported
# way to disarm governance.
if [ "$INTUTIC_SNAPSHOT_STATE" = "ok" ] && [ -n "$INTUTIC_SNAPSHOT_GENERATED" ]; then
  _intutic_age_days="$(python3 -c 'import sys,datetime
try:
    t=datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))
    print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()//86400))
except Exception:
    print(0)' "$INTUTIC_SNAPSHOT_GENERATED" 2>/dev/null || echo 0)"
  if [ "$_intutic_age_days" -gt ${SNAPSHOT_STALE_AFTER_DAYS} ] 2>/dev/null; then
    INTUTIC_SNAPSHOT_STATE="stale"
  fi
fi

case "$INTUTIC_SNAPSHOT_STATE" in
  absent)  ${log} "snapshot_absent" "\${TOOL:-}" "No policy snapshot at $INTUTIC_SNAPSHOT_RULES — built-in protections only" || true ;;
  invalid) ${log} "snapshot_invalid" "\${TOOL:-}" "Policy snapshot failed its digest or workspace check — dynamic rules dropped" || true ;;
  empty)   ${log} "snapshot_empty" "\${TOOL:-}" "Policy snapshot contains no rules — the compile produced nothing" || true ;;
  stale)   ${log} "snapshot_stale" "\${TOOL:-}" "Policy snapshot is \${_intutic_age_days} days old and still enforced" || true ;;
esac

# Normalise once; every pattern is written against this shape.
INTUTIC_NCOMMAND="$(intutic_normalise "\${COMMAND:-}")"
INTUTIC_NTARGET="$(intutic_normalise "\${TARGET:-}")"
INTUTIC_NTOOL="$(intutic_normalise "\${TOOL:-}")"

# A rule declares which part of the call it matches. \`any\` means command and
# target — never the tool name, because a pattern like \`\\.claude/settings\\.json\`
# would otherwise be tested against "Write" and quietly match nothing.
intutic_apply() {
  local rec="$1"
  local rid rsev rflags rsubj rreason rsrc rargb64 s hit
  # Seven variables over a six- or seven-field record: a v3 line leaves rargb64
  # empty, which is exactly "no argument condition". The base64 column cannot
  # contain a tab, so the last variable never absorbs a separator.
  IFS=$'\\t' read -r rid rsev rflags rsubj rreason rsrc rargb64 <<< "$rec"
  [ -z "$rsrc" ] && return 0
  # The escape hatch skips the DESTRUCTIVE family only. It is not a way to turn
  # off a workspace's own BLOCK: SOP rules — those are what the customer asked
  # for, and one environment variable disarming them would make the switch the
  # first thing an agent sets. Keyed on the rule-id family, which the snapshot
  # writer assigns: destructive.* versus sop.*
  if [ "$INTUTIC_GUARDS_DISABLED" = "1" ]; then
    case "$rid" in
      destructive.*) return 0 ;;
    esac
  fi
  local _subs=()
  case "$rsubj" in
    tool)    _subs=("$INTUTIC_NTOOL") ;;
    command) _subs=("$INTUTIC_NCOMMAND") ;;
    target)  _subs=("$INTUTIC_NTARGET") ;;
    # Each field is tested separately rather than concatenated. Joining them
    # lets a pattern match across the seam — a command ending in "chflags" and
    # an unrelated target starting with "nouchg" would trip the bypass rule
    # together while neither does alone.
    *)       _subs=("$INTUTIC_NCOMMAND" "$INTUTIC_NTARGET") ;;
  esac
  hit=0
  for s in "\${_subs[@]}"; do
    if [ "$rflags" = "i" ]; then
      printf '%s' "$s" | grep -qiE -- "$rsrc" && hit=1
    else
      printf '%s' "$s" | grep -qE -- "$rsrc" && hit=1
    fi
  done
  [ "$hit" = "1" ] || return 0
  # The argument condition of a WHERE rule. The tool-name half has matched; the
  # rule fires only if the argPattern also matches the serialized tool input —
  # the same json.dumps(tool_input, separators=(",",":"), ensure_ascii=False)
  # shape matchSopRule and the intutic-clawde gate port pin, produced once by
  # the extractor above. Evaluated by python3 re, not grep: these patterns are
  # authored as JS regexes and routinely use lookahead, which no grep has.
  # Fail-safe direction: a pattern python cannot compile (exit 2) downgrades
  # THIS rule to name-only — today's behaviour, plus a rule_downgraded event —
  # rather than silently dropping the rule, which would fail open.
  if [ -n "$rargb64" ]; then
    _intutic_arg_rc=0
    python3 -c '
import sys, base64, re
try:
    pat = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
except Exception:
    sys.exit(2)
try:
    rx = re.compile(pat)
except re.error:
    sys.exit(2)
sys.exit(0 if rx.search(sys.argv[2]) else 1)
' "$rargb64" "\${TOOL_INPUT_JSON:-}" 2>/dev/null || _intutic_arg_rc=$?
    if [ "$_intutic_arg_rc" = "1" ]; then
      return 0
    elif [ "$_intutic_arg_rc" != "0" ]; then
      ${log} "rule_downgraded" "\${TOOL:-}" "argPattern for \${rid} did not compile in python re — rule enforced name-only" || true
    fi
  fi
  if [ "$rsev" = "shadow" ]; then
    ${log} "tool_would_block" "\${TOOL:-}" "\${rreason} [\${rid}]" || true
    return 0
  fi
  if [ "$rsev" = "warn" ]; then
    # Advisory tier: allowed, and recorded with enough shape to triage.
    #
    # The rule id alone was not enough. The warn tier exists to earn promotion to
    # block from a measured false-positive rate, and you cannot call a flag true
    # or false without seeing something of what was run. So: the first token of
    # the command, and nothing else. That is the verb — curl, git, rm — which is
    # what distinguishes "a real destructive command" from "a false positive on a
    # build script", and it carries no paths, no arguments, no secrets. The full
    # command stays out deliberately; that is what DLP exists to keep out of
    # telemetry.
    _intutic_verb="\${INTUTIC_NCOMMAND# }"
    _intutic_verb="\${_intutic_verb%% *}"
    ${log} "tool_flagged" "\${TOOL:-}" "\${rreason} [\${rid}] verb=\${_intutic_verb}" || true
    return 0
  fi
  # The rule's own reason, not a generic one: hookEvents.resolveSeverity reads
  # this text for "governance-protected" to file the incident CRITICAL.
  local reason="\${rreason} [\${rid}]"
  echo "[Intutic Governance] BLOCKED: \${reason}" >&2
  ${log} "tool_blocked" "\${TOOL:-}" "\${reason}"
  exit 2
}

for _rec in "\${INTUTIC_FLOOR[@]}"; do
  intutic_apply "$_rec"
done

if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
  for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
    intutic_apply "$_rec"
  done
fi
# ── end Intutic gate body ────────────────────────────────────────────────────
`
}

export interface JsGateOptions {
  harness: string
  /** How this harness refuses. */
  contract: BlockContract
}

/**
 * The JavaScript gate body.
 *
 * Emits a self-contained `intuticGate()` that the writer calls. Refuses through
 * whichever mechanism {@link JsGateOptions.contract} names, so a harness that
 * reads stdout rather than the exit code cannot be given the wrong one by
 * accident — it is a parameter, not a copy-paste.
 */
export function emitJsGate(opts: JsGateOptions): string {
  const floor = staticFloorPatterns()

  const refuse =
    opts.contract === 'stdout-cancel'
      ? `      process.stdout.write(JSON.stringify({ cancel: true, reason: reason }) + '\\n');\n` +
        `      process.exit(0);`
      : `      process.exit(2);`

  return `
// ── Intutic gate body v${GATE_VERSION} — harness: ${opts.harness} ────────────
// Generated by harness/gateBody.ts. Do not edit here; every harness regenerates.
//
// The harness name and version are stamped so this file identifies itself. Both
// were previously passed in and dropped on the floor: opts.harness was declared
// on the option type, supplied by all thirteen writers, and read nowhere.

${jsGuardTable('INTUTIC_FLOOR', floor)}

// Emitted from NORMALISE_CONTRACT, not retyped. The previous hand-written copy
// had already drifted from the in-process one on null handling.
${NORMALISE_CONTRACT.jsSource}

function intuticLoadSnapshot(INTUTIC_WORKSPACE_ID) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const p = process.env.INTUTIC_SNAPSHOT_RULES ||
    path.join(os.homedir(), '.intutic', 'hooks', 'policy-snapshot.rules');
  const out = { rules: [], digest: 'none', state: 'absent', workspaceId: '', generatedAt: '', ageDays: 0 };
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  out.state = 'ok';
  for (const line of text.split('\\n')) {
    if (line.startsWith('#digest ')) { out.digest = line.slice(8).trim(); continue; }
    if (line.startsWith('#workspace ')) { out.workspaceId = line.slice(11).trim(); continue; }
    if (line.startsWith('#generated ')) { out.generatedAt = line.slice(11).trim(); continue; }
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\\t');
    if (f.length < 6 || !f[5]) continue;
    let re;
    // A snapshot rule that will not compile is dropped, not fatal. The floor
    // above is compiled in and unaffected, so this degrades to "today's
    // behaviour" rather than to "no gate".
    try { re = new RegExp(f[5], f[2] === 'i' ? 'i' : ''); } catch (e) { continue; }
    // Optional seventh column: the WHERE clause, base64 so an arbitrary regex
    // cannot collide with the tab separator. Absent in v3-format files, which
    // is exactly "no argument condition". An argPattern that does not decode
    // or compile downgrades THIS rule to name-only (argDowngraded) instead of
    // dropping it — dropping a block rule because its narrowing clause is
    // broken would fail open.
    let argRe = null, argDowngraded = false;
    if (f.length > 6 && f[6]) {
      try { argRe = new RegExp(Buffer.from(f[6], 'base64').toString('utf8')); }
      catch (e) { argDowngraded = true; }
    }
    out.rules.push({ id: f[0], severity: f[1], subject: f[3] || 'any', re: re, reason: f[4],
      argRe: argRe, argDowngraded: argDowngraded });
  }

  // Integrity. A digest nobody recomputes is a comment, and a workspace id
  // nobody compares means a snapshot from workspace A dropped onto workspace B's
  // machine is enforced verbatim, with B's events attributing A's rules to B.
  try {
    const body = text.split('\\n').filter(function (l) { return l && l.charAt(0) !== '#'; }).join('\\n');
    const actual = require('crypto').createHash('sha256').update(body).digest('hex').slice(0, 32);
    if (out.digest !== 'none' && actual !== out.digest) out.state = 'invalid';
  } catch (e) { /* no crypto — leave the digest unverified rather than fail the gate */ }

  if (out.state === 'ok' && out.workspaceId && INTUTIC_WORKSPACE_ID && out.workspaceId !== INTUTIC_WORKSPACE_ID) {
    out.state = 'invalid';
  }
  // Distinct from absent: the writer always ships the destructive tier, so no
  // rules means the compile produced nothing — a fault that otherwise looks
  // exactly like a healthy quiet workspace.
  if (out.state === 'ok' && out.rules.length === 0) out.state = 'empty';

  // Additive tier, so dropping it returns to yesterday's behaviour.
  if (out.state === 'invalid') out.rules = [];

  if (out.state === 'ok' && out.generatedAt) {
    const t = Date.parse(out.generatedAt);
    if (!isNaN(t)) {
      out.ageDays = Math.floor((Date.now() - t) / 86400000);
      // Still enforced — staleness governs alerting, not enforcement.
      if (out.ageDays > ${SNAPSHOT_STALE_AFTER_DAYS}) out.state = 'stale';
    }
  }
  return out;
}

/**
 * Evaluates one tool call. Returns normally to allow; refuses via this harness's
 * contract otherwise.
 *
 * Takes its inputs as parameters rather than closing over the writer's locals:
 * the eight JS writers name and shape those differently, and a gate that
 * silently reads the wrong variable is the failure this file exists to prevent.
 * \`record\` is called as (verdict, toolName, reason) — writers whose own logger
 * takes an env argument pass a lambda.
 *
 * \`toolInput\` is the raw tool_input OBJECT (not a string): WHERE rules match
 * their argPattern against JSON.stringify(tool_input) — the compact shape
 * matchSopRule and the intutic-clawde gate port pin — and the gate serializes
 * it itself so no writer can hand it a differently-shaped string.
 */
function intuticGate(toolName, target, command, record, workspaceId, toolInput) {
  // See the shell emitter for why this exists: the alternative escape a blocked
  // developer reaches for is chflags nouchg on the hook itself. Dynamic tier
  // only — the compiled floor below is never disabled by it — and every
  // invocation is recorded.
  // Skips the destructive family only — never the floor, and never a
  // workspace's own BLOCK: SOP rules. See the shell emitter.
  const disabled = process.env.INTUTIC_GUARD_DISABLE === '1';
  if (disabled) {
    try {
      record('guards_disabled', toolName,
        'INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active');
    } catch (e) {}
  }
  const snap = intuticLoadSnapshot(workspaceId || '');

  // Report the snapshot's condition once per invocation. These states were
  // computed and then never read — an operator could not tell "snapshot missing
  // on 400 machines" from "snapshot present and healthy", which is the same
  // blindness the liveness work exists to remove.
  if (snap.state !== 'ok') {
    var _msg = snap.state === 'absent'
      ? 'No policy snapshot — built-in protections only'
      : snap.state === 'invalid'
        ? 'Policy snapshot failed its digest or workspace check — dynamic rules dropped'
        : snap.state === 'empty'
          ? 'Policy snapshot contains no rules — the compile produced nothing'
          : 'Policy snapshot is ' + snap.ageDays + ' days old and still enforced';
    try { record('snapshot_' + snap.state, toolName, _msg); } catch (e) {}
  }
  if (disabled) snap.rules = snap.rules.filter(function (r) { return r.id.indexOf('destructive.') !== 0; });
  // JSON.stringify(tool_input) — no replacer, no spacing — matching matchSopRule.
  // stringify(undefined) is undefined, hence the fallbacks; a throw cannot
  // happen on an object that came out of JSON.parse, but a gate must not bet
  // its exit code on that.
  var toolInputJson = '{}';
  try { toolInputJson = JSON.stringify(toolInput == null ? {} : toolInput) || '{}'; } catch (e) {}
  const nCommand = intuticNormalise(command);
  const nTarget = intuticNormalise(target);
  const nTool = intuticNormalise(toolName);
  const rules = INTUTIC_FLOOR.concat(snap.rules);
  for (const rule of rules) {
    // Each field is tested separately rather than concatenated — joining them
    // lets a pattern match across the seam between two innocuous values.
    const subjects =
      rule.subject === 'tool' ? [nTool]
      : rule.subject === 'command' ? [nCommand]
      : rule.subject === 'target' ? [nTarget]
      : [nCommand, nTarget];
    for (const subject of subjects) {
      if (!rule.re.test(subject)) continue;
      // The argument condition of a WHERE rule: the tool-name half has
      // matched, and the rule fires only if the argPattern also matches the
      // serialized tool input. A pattern that failed to compile at load time
      // enforces name-only — today's behaviour — and says so, rather than
      // silently vanishing (fail open) or crashing the gate (exit 1, which
      // every harness reads as allow).
      if (rule.argDowngraded) {
        try {
          record('rule_downgraded', toolName,
            'argPattern for ' + rule.id + ' did not compile — rule enforced name-only');
        } catch (e) {}
      } else if (rule.argRe && !rule.argRe.test(toolInputJson)) {
        continue;
      }
      if (rule.severity === 'shadow') {
        // Certain rule, deliberately not acted on. Counted apart from warn.
        try { record('tool_would_block', toolName, rule.reason + ' [' + rule.id + ']'); } catch (e) {}
        continue;
      }
      if (rule.severity === 'warn') {
        // Advisory tier — allowed, recorded with the rule id and the command's
        // first token. The verb is what makes a flag triageable as true or false
        // positive; without it the promotion rule this tier exists to serve is
        // not measurable. Arguments and paths stay out — that is DLP's job.
        try {
          record('tool_flagged', toolName,
            rule.reason + ' [' + rule.id + '] verb=' + nCommand.trim().split(' ')[0]);
        } catch (e) {}
        continue;
      }
      // The rule's own reason, not a generic one: hookEvents.resolveSeverity
      // reads this text for "governance-protected" to file it CRITICAL.
      const reason = rule.reason + ' [' + rule.id + ']';
      try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
      try { record('tool_blocked', toolName, reason); } catch (e) {}
${refuse}
    }
  }
}
// ── end Intutic gate body ────────────────────────────────────────────────────
`
}

/**
 * The single `python3` invocation that replaces the three or four each bash gate
 * used to spawn.
 *
 * Process startup dominated the old gates: three `python3` spawns is 75–200ms on
 * the tool path, more than rule evaluation will ever cost. This does the whole
 * extraction in one, and collapses whitespace while it is there — which also
 * makes the three values safe to read back as three lines.
 *
 * **Fails closed if there is no parser.** Without one the gate cannot know what
 * it is being asked to allow, and the old behaviour — empty tool, empty target,
 * allow — was a silent hole. The message names the fix, because a developer who
 * hits this needs to act on it rather than file a bug.
 */
export const SHELL_EXTRACT = `
if ! command -v python3 >/dev/null 2>&1; then
  echo "[Intutic Governance] BLOCKED: python3 is required to evaluate tool calls and was not found on PATH." >&2
  echo "[Intutic Governance] Install python3, or unset the Intutic hooks to run ungoverned." >&2
  exit 2
fi

INTUTIC_FIELDS="$(printf '%s' "$INPUT" | python3 -c '
import sys, json
def clean(v):
    return " ".join(str(v).split()) if isinstance(v, str) else ""
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
i = d.get("tool_input") or {}
if not isinstance(i, dict):
    i = {}
def first(*keys):
    for k in keys:
        v = i.get(k)
        if isinstance(v, str) and v:
            return clean(v)
    return ""
print(clean(d.get("tool_name", "")))
print(first("path", "file_path", "notebook_path", "filePath"))
print(first("command", "cmd", "script", "shell_command"))
print(clean(d.get("session_id", d.get("sessionId", ""))))
# The FULL tool_input, serialized to the exact shape argPattern rules are
# matched against everywhere: JSON.stringify(tool_input) — compact separators,
# insertion order, non-ASCII intact. The selected fields above are whitespace-
# collapsed for token matching; this one must NOT be, or a WHERE clause that
# spans a key/value boundary matches here and not in the JS gates. json.dumps
# escapes every newline, so it is still exactly one line to read back.
print(json.dumps(i, separators=(",", ":"), ensure_ascii=False))
' 2>/dev/null || printf '\\n\\n\\n\\n\\n')"

# Each read is \`|| true\` because command substitution strips trailing newlines:
# a tool call with no command argument yields two lines, not three, so the third
# read hits EOF and returns non-zero. Under \`set -e\` that killed the gate with
# **exit 1** — which every harness reads as a hook error and lets the call
# through. A guard that fails open on the most ordinary input there is (a Write
# with no shell command) is worse than no guard, because it looks present.
{ IFS= read -r TOOL || true; IFS= read -r TARGET || true; IFS= read -r COMMAND || true; IFS= read -r SESSION_ID || true; IFS= read -r TOOL_INPUT_JSON || true; } <<EOF_INTUTIC_FIELDS
$INTUTIC_FIELDS
EOF_INTUTIC_FIELDS
TOOL="\${TOOL:-}"; TARGET="\${TARGET:-}"; COMMAND="\${COMMAND:-}"; SESSION_ID="\${SESSION_ID:-}"
# Empty only when the extractor failed wholesale (malformed stdin). Defaulting
# to the empty OBJECT rather than the empty string keeps the argPattern match
# well-defined either way.
TOOL_INPUT_JSON="\${TOOL_INPUT_JSON:-}"
[ -n "$TOOL_INPUT_JSON" ] || TOOL_INPUT_JSON="{}"
# Aliases for the names the older writers used. Kept so this extractor is a
# drop-in for every bash gate; the canonical names are the unsuffixed ones.
TOOL_NAME="$TOOL"; TARGET_PATH="$TARGET"
`

/**
 * The Python gate, for Open WebUI.
 *
 * Open WebUI filters see a **prompt**, not a tool call — there is no tool name,
 * no path argument and no shell command. So this deliberately does less than the
 * other two emitters, and the difference is the point:
 *
 * - It **can** refuse. `inlet()` used to hardcode `"event": "tool_allowed"` and
 *   return the body unconditionally; it was notification-only, and nothing said
 *   so. Raising from `inlet()` is how an Open WebUI filter blocks, and that path
 *   now exists.
 * - It **does not** block on the compiled floor. A prompt that mentions
 *   `.claude/settings.json` is someone asking about a file, not an agent writing
 *   it, and refusing to discuss a path is the kind of false positive that gets a
 *   governance tool switched off. Those rules flag instead.
 * - It **does** refuse on a snapshot rule whose severity is `block`, so a
 *   workspace that wants a hard stop here can have one without a release.
 *
 * A control that claims more than it delivers is worse than one that claims
 * less, so `enforces` for this harness in `gateRegistry.ts` says exactly this.
 */
export function emitPythonGate(): string {
  const floor = staticFloorPatterns()
  const rows = floor.map(
    (p) =>
      `    (${JSON.stringify(p.id)}, ${JSON.stringify(p.source)}, ` +
      `${p.ignoreCase ? 're.IGNORECASE' : '0'}, ${JSON.stringify(p.reason)}),`,
  )
  return `
# ── Intutic gate body v${GATE_VERSION} — harness: open-webui ─────────────────
# Prompts are flagged, never blocked, by these. See emitPythonGate().
_INTUTIC_FLOOR = [
${rows.join('\n')}
]


${NORMALISE_CONTRACT.pySource}


_state = {"digest": "", "workspace": ""}


def _intutic_snapshot_rules():
    """Reads the policy snapshot the sync daemon writes. Absent is normal."""
    # Dynamic tier only — the floor above is never disabled by this. See the
    # shell emitter in gateBody.ts for why a supported escape hatch is safer
    # than the one a blocked developer would otherwise invent.
    # Destructive family only — never the floor, never the workspace's own
    # BLOCK: SOP rules. See the shell emitter in gateBody.ts.
    _skip_destructive = os.environ.get("INTUTIC_GUARD_DISABLE") == "1"
    p = os.environ.get("INTUTIC_SNAPSHOT_RULES") or os.path.join(
        os.path.expanduser("~"), ".intutic", "hooks", "policy-snapshot.rules"
    )
    out = []
    try:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.rstrip("\\n")
                # The digest and workspace lines are read, not merely skipped —
                # an unverified digest is a comment, and an unchecked workspace
                # id means another workspace's rules enforce here silently.
                if line.startswith("#digest "):
                    _state["digest"] = line[8:].strip()
                    continue
                if line.startswith("#workspace "):
                    _state["workspace"] = line[11:].strip()
                    continue
                if not line or line.startswith("#"):
                    continue
                f = line.split("\\t")
                if len(f) < 6 or not f[5]:
                    continue
                # This filter evaluates a PROMPT, not a tool call, so only
                # rules whose subject is meaningful for prose may apply.
                # A tool-subject rule (BLOCK:Bash compiles to subject "tool")
                # is a pattern over tool NAMES; matched against prompt text it
                # made Open WebUI refuse any prompt containing the word
                # "Bash". Skipped — a prompt has no tool name. f[3] was read
                # by the other three gate families and ignored here, which is
                # how that shipped.
                if f[3] == "tool":
                    continue
                # Likewise a WHERE rule (seventh column, base64 argPattern) is
                # conditioned on tool ARGUMENTS that a prompt does not have.
                # Enforcing its tool pattern against prose would apply a rule
                # its author deliberately narrowed more broadly than written.
                if len(f) > 6 and f[6]:
                    continue
                try:
                    # A rule that will not compile is dropped, not fatal.
                    if _skip_destructive and f[0].startswith("destructive."):
                        continue
                    out.append((f[0], f[5], re.IGNORECASE if f[2] == "i" else 0, f[4], f[1]))
                except Exception:
                    continue
    except Exception:
        pass

    # Integrity, same two checks as the shell and JS gates.
    try:
        with open(p, "r", encoding="utf-8") as fh:
            body = "\\n".join(l.rstrip("\\n") for l in fh
                            if l.strip() and not l.startswith("#"))
        actual = hashlib.sha256(body.encode()).hexdigest()[:32]
        if _state["digest"] and actual != _state["digest"]:
            return []
    except Exception:
        pass
    if _state["workspace"] and WORKSPACE_ID and _state["workspace"] != WORKSPACE_ID:
        return []
    return out


def _intutic_evaluate(text):
    """Returns (blocks, flags) for a prompt. Floor rules can only flag."""
    subject = _intutic_normalise(text)
    blocks, flags, shadowed = [], [], []
    for rid, src, flags_re, reason in _INTUTIC_FLOOR:
        try:
            if re.search(src, subject, flags_re):
                flags.append((rid, reason))
        except Exception:
            continue
    for rid, src, flags_re, reason, severity in _intutic_snapshot_rules():
        try:
            if not re.search(src, subject, flags_re):
                continue
        except Exception:
            continue
        if severity == "block":
            blocks.append((rid, reason))
        elif severity == "shadow":
            shadowed.append((rid, reason))
        else:
            flags.append((rid, reason))
    return blocks, flags, shadowed
# ── end Intutic gate body ────────────────────────────────────────────────────
`
}

/** The destructive tier, for the snapshot writer to ship. Not compiled into any
 *  gate — see the note on {@link DESTRUCTIVE_COMMAND_PATTERNS}. */
export { DESTRUCTIVE_COMMAND_PATTERNS }
