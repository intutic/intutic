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
 *
 * v5: the residual fail-open edges were closed. Every bash gate now converts
 * an accidental crash (exit != 0 and != 2 under `set -euo pipefail`) into
 * exit 2 via {@link SHELL_FAIL_CLOSED}; every bash gate refuses a stdin
 * payload from which neither a tool name nor a tool_input could be extracted
 * (the envelope posture githubCopilotHooks established, now uniform); every
 * JS gate installs `uncaughtException`/`unhandledRejection` handlers as its
 * first statements ({@link emitJsFailClosedPrelude}) so a crash outside the
 * stdin handler refuses through the harness's own contract instead of exiting
 * 1 (which every exit-code harness reads as "hook errored — allow"); and the
 * malformed-envelope refusal is shared across the JS writers via
 * `intuticGuardEnvelope`. The `.rules` format is unchanged — v4 and v5 gates
 * read each other's snapshots byte-identically.
 *
 * v6 (M3): `#mcpservers` header parsing + `mcp__<server>__*` allowlist
 * refusal + Cline `use_mcp_tool` envelope normalization; rule-line format
 * itself is unchanged. This IS a `.rules` shape change, unlike v5 (which only
 * closed fail-open edges) — a new header line means:
 *
 * - a v5 gate reading a v6 snapshot ignores the unknown `#mcpservers` header
 *   (every existing header-parsing loop already falls through unrecognised
 *   `#`-prefixed lines to the comment case) and degrades to v5 behaviour: no
 *   allowlist enforcement, but no crash and no false-block either;
 * - a v6 gate reading a v5 snapshot (no `#mcpservers` header present) also
 *   behaves as unrestricted — the empty-list default — because "header
 *   absent" and "header present with an empty list" are deliberately the same
 *   observable state (`writePolicySnapshot` omits the line rather than
 *   emitting it empty, precisely so a v6 gate cannot tell "no snapshot
 *   configured a list yet" from "this workspace wants zero servers", and
 *   picks the fail-open reading of that ambiguity rather than blocking every
 *   MCP call the first time a v6 gate meets an old snapshot).
 */
export const GATE_VERSION = 6

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

/**
 * The bash fail-closed prelude. Interpolated by every bash writer immediately
 * after `set -euo pipefail`, before anything that can fail has run.
 *
 * The edge it closes: under `set -euo pipefail` any script bug — an unbound
 * variable, a `read` that hits EOF outside its guard, a corrupted snapshot
 * tripping an unguarded command — ends the script with the failing command's
 * status, usually 1. Every harness that runs these gates treats a non-2
 * non-zero exit as "the hook errored" and ALLOWS the call, so an accidental
 * crash was an allow that looked like enforcement.
 *
 * An EXIT trap that inspects the final status, deliberately not `trap ... ERR`:
 *
 * - ERR does not fire on `set -u` unbound-variable deaths or on every `set -e`
 *   exit path, and its firing rules differ between bash versions and whatever
 *   /bin/sh a harness substitutes. EXIT always runs, in every POSIX shell.
 * - An ERR trap also fires on every benign non-zero intermediate — a grep
 *   no-match inside a condition, an arithmetic result of 0 — and turning those
 *   into blocks would make the gate refuse every call, which is exactly as
 *   broken as allowing every call. Inspecting only the FINAL exit status
 *   sidesteps that class entirely: `set -e` semantics are untouched, and a
 *   status the script deliberately produced (0 = allow, 2 = block, including
 *   the python3-missing refusal in SHELL_EXTRACT) passes through unchanged.
 *   Under `set -e` a script bug can never reach the final `exit 0`, so
 *   "status not in {0, 2}" is exactly "the gate crashed".
 *
 * The trap body runs under the script's own `set -eu`, so it disarms both
 * first — a trap that itself dies on an unset variable would exit with that
 * failure's status and reopen the hole it exists to close. `log_event` is
 * defined by the writer AFTER this prelude, so the trap probes for it before
 * calling: a crash earlier than the definition still blocks, just without an
 * audit line (stderr carries the reason either way).
 */
export const SHELL_FAIL_CLOSED = `
# ── Intutic fail-closed prelude v${GATE_VERSION} ─────────────────────────────
# Any exit status other than the two deliberate verdicts (0 = allow, 2 = block)
# means this gate crashed rather than decided. The harness would read exit 1 as
# "hook errored" and run the tool anyway, so a crash is converted into a block.
# EXIT rather than ERR: ERR is unreliable across shells for set -u deaths, and
# it fires on benign non-zero intermediates; the final status cannot lie.
intutic_fail_closed() {
  _intutic_exit_rc=$?
  # The trap must not itself die on an unset variable or a failed command —
  # that would replace the exit status it exists to correct.
  set +eu
  trap - EXIT
  if [ "$_intutic_exit_rc" = "0" ] || [ "$_intutic_exit_rc" = "2" ]; then
    exit "$_intutic_exit_rc"
  fi
  echo "[Intutic Governance] BLOCKED: gate crashed (exit \${_intutic_exit_rc}) — failing closed rather than allowing an unevaluated call." >&2
  if command -v log_event >/dev/null 2>&1; then
    log_event "tool_blocked" "\${TOOL:-unknown}" "gate crashed (exit \${_intutic_exit_rc}) — failing closed" || true
  fi
  exit 2
}
trap intutic_fail_closed EXIT
`

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

# Refuse an unreadable envelope before any rule is consulted.
#
# Unparseable stdin used to degrade to empty extracted fields, which match no
# rule — an ALLOW. Per each harness's contract this hook receives only
# PreToolUse events, so a payload from which neither a tool name nor a
# tool_input could be extracted is anomalous by definition: there is no such
# thing as a legitimate PreToolUse event with no tool call in it. Refusing is
# the posture githubCopilotHooks established for its Preview envelope, applied
# uniformly. INTUTIC_EXTRACT_STATE is set by SHELL_EXTRACT; the refusal lives
# here because log_event is not defined until after extraction runs.
#
# Scoped to the bare invocation: goose and openhands register post/stop
# invocations of this same script WITH arguments, and those events carry no
# tool call legitimately — refusing them would fail a hook that has nothing to
# gate. Every PreToolUse registration invokes the script with no arguments.
if [ -z "\${1:-}" ] && [ "\${INTUTIC_EXTRACT_STATE:-malformed}" != "ok" ]; then
  _intutic_env_reason="unrecognised PreToolUse payload — neither a tool name nor a tool_input could be extracted from stdin; refusing rather than allowing a call the gate cannot read"
  echo "[Intutic Governance] BLOCKED: \${_intutic_env_reason}" >&2
  ${log} "tool_blocked" "unknown" "\${_intutic_env_reason}" || true
  exit 2
fi

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
# M3: the per-server MCP allowlist header. Empty means "not configured" —
# indistinguishable from "header absent", deliberately: writePolicySnapshot
# omits the line entirely rather than shipping it with an empty list, so
# empty-list-means-unrestricted holds all the way to the gate.
INTUTIC_MCP_SEVERITY=""
INTUTIC_MCP_SERVERS=""
if [ -f "$INTUTIC_SNAPSHOT_RULES" ]; then
  INTUTIC_SNAPSHOT_STATE="ok"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      '#digest '*)      INTUTIC_SNAPSHOT_DIGEST="\${_line#\\#digest }" ;;
      '#workspace '*)   INTUTIC_SNAPSHOT_WORKSPACE="\${_line#\\#workspace }" ;;
      '#generated '*)   INTUTIC_SNAPSHOT_GENERATED="\${_line#\\#generated }" ;;
      '#mcpservers '*)
        # \`#mcpservers <severity> <comma-joined-server-names>\` — parameter
        # expansion only, no subshell, matching the other header lines here.
        _intutic_mcp_rest="\${_line#\\#mcpservers }"
        INTUTIC_MCP_SEVERITY="\${_intutic_mcp_rest%% *}"
        INTUTIC_MCP_SERVERS="\${_intutic_mcp_rest#* }"
        ;;
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
  # returns to yesterday's behaviour rather than opening a hole. The MCP
  # allowlist ships through the same file and degrades the same way — an
  # invalid snapshot must not leave a stale allowlist enforcing.
  if [ "$INTUTIC_SNAPSHOT_STATE" = "invalid" ]; then
    INTUTIC_DYNAMIC=()
    INTUTIC_MCP_SEVERITY=""
    INTUTIC_MCP_SERVERS=""
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
    # Serialized tool input, un-normalised — same subject the WHERE argPattern
    # machinery matches. The secrets.* floor rules ride this. Guaranteed
    # non-empty by the extractor (it defaults to "{}").
    content) _subs=("$TOOL_INPUT_JSON") ;;
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

# ── M3: MCP per-server allowlist backstop ────────────────────────────────────
# A DEDICATED header field, not a synthetic GuardPattern rule — see
# policySnapshot.ts's module doc and protectedPaths.ts's assertPortableEre:
# expressing "allow only these servers" as a single regex needs negative
# lookahead, which neither \`grep -E\` (POSIX ERE) nor this file's own
# portable-ERE discipline support. So this is a plain string-membership test
# over the parsed \${#mcpservers} header, independent of intutic_apply/the
# GuardPattern tables entirely.
#
# Only fires when a \`mcp__<server>__<tool>\`-shaped tool name was actually
# called AND the header was present (INTUTIC_MCP_SERVERS non-empty — absent
# header means unrestricted, see the header-parsing block above). Refuses
# through the SAME exit-2 + \${log} idiom every other block in this file uses,
# not a parallel mechanism.
case "\${TOOL:-}" in
  mcp__*__*)
    if [ -n "$INTUTIC_MCP_SERVERS" ]; then
      _intutic_mcp_server="\${TOOL#mcp__}"
      _intutic_mcp_server="\${_intutic_mcp_server%%__*}"
      case ",$INTUTIC_MCP_SERVERS," in
        *",$_intutic_mcp_server,"*)
          : # allowed — the server is in the workspace's list
          ;;
        *)
          _intutic_mcp_reason="MCP server \\"$_intutic_mcp_server\\" is not on the MCP server allowlist for this workspace [mcp_allowlist]"
          if [ "$INTUTIC_MCP_SEVERITY" = "shadow" ]; then
            ${log} "tool_would_block" "\${TOOL:-}" "$_intutic_mcp_reason" || true
          else
            echo "[Intutic Governance] BLOCKED: $_intutic_mcp_reason" >&2
            ${log} "tool_blocked" "\${TOOL:-}" "$_intutic_mcp_reason"
            exit 2
          fi
          ;;
      esac
    fi
    ;;
esac
# ── end Intutic gate body ────────────────────────────────────────────────────
`
}

export interface JsGateOptions {
  harness: string
  /** How this harness refuses. */
  contract: BlockContract
}

/**
 * The snapshot loader every JS-family gate embeds, defined once.
 *
 * Extracted from {@link emitJsGate}'s template when the n8n workflow gate
 * arrived: two emitters needing the same loader is exactly the situation that
 * produced the four defects this module's header describes, so the loader is a
 * constant both interpolate rather than a block one of them copies. The
 * emitted bytes for the per-tool gates are unchanged.
 */
const JS_SNAPSHOT_LOADER = `function intuticLoadSnapshot(INTUTIC_WORKSPACE_ID) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const p = process.env.INTUTIC_SNAPSHOT_RULES ||
    path.join(os.homedir(), '.intutic', 'hooks', 'policy-snapshot.rules');
  // M3: mcpServers/mcpSeverity default to unrestricted (empty list) — the
  // same "header absent means unrestricted" reading writePolicySnapshot's
  // \`#mcpservers\` header is built on.
  const out = { rules: [], digest: 'none', state: 'absent', workspaceId: '', generatedAt: '', ageDays: 0,
    mcpServers: [], mcpSeverity: 'block' };
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  out.state = 'ok';
  for (const line of text.split('\\n')) {
    if (line.startsWith('#digest ')) { out.digest = line.slice(8).trim(); continue; }
    if (line.startsWith('#workspace ')) { out.workspaceId = line.slice(11).trim(); continue; }
    if (line.startsWith('#generated ')) { out.generatedAt = line.slice(11).trim(); continue; }
    if (line.startsWith('#mcpservers ')) {
      // \`#mcpservers <severity> <comma-joined-server-names>\` — same header a
      // v5 gate would silently ignore via the generic '#'-prefix skip below,
      // which is exactly the graceful-degradation contract this format change
      // relies on.
      const rest = line.slice('#mcpservers '.length);
      const sp = rest.indexOf(' ');
      if (sp === -1) { out.mcpSeverity = rest.trim(); out.mcpServers = []; }
      else {
        out.mcpSeverity = rest.slice(0, sp).trim();
        out.mcpServers = rest.slice(sp + 1).trim().split(',').filter(Boolean);
      }
      continue;
    }
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

  // Additive tier, so dropping it returns to yesterday's behaviour. The MCP
  // allowlist ships through the same file and degrades the same way — an
  // invalid snapshot must not leave a stale allowlist enforcing.
  if (out.state === 'invalid') { out.rules = []; out.mcpServers = []; }

  if (out.state === 'ok' && out.generatedAt) {
    const t = Date.parse(out.generatedAt);
    if (!isNaN(t)) {
      out.ageDays = Math.floor((Date.now() - t) / 86400000);
      // Still enforced — staleness governs alerting, not enforcement.
      if (out.ageDays > ${SNAPSHOT_STALE_AFTER_DAYS}) out.state = 'stale';
    }
  }
  return out;
}`

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

${JS_SNAPSHOT_LOADER}

/**
 * Refuses a parsed payload that carries no recognisable tool-call envelope.
 *
 * The shared gate extracts by known field names, and an envelope it does not
 * recognise extracts to EMPTY strings — which match no rule, i.e. the gate
 * degrades to ALLOW. These hooks receive only PreToolUse events per each
 * harness's contract, so a payload from which neither a tool name nor a
 * tool_input can be extracted is anomalous by definition: there is no
 * legitimate PreToolUse event with no tool call in it. Refusing is the posture
 * githubCopilotHooks established for its Preview envelope, now uniform.
 *
 * \`keys\` names the envelope fields THIS writer's extractor actually reads —
 * cursor and windsurf accept flat payloads (fields at the top level, no
 * tool_input wrapper), so their key lists are wider than the canonical four.
 * A guard stricter than the extractor would refuse traffic the gate can
 * evaluate perfectly well, and a false positive here teaches operators to
 * disable the hook.
 */
function intuticGuardEnvelope(ctx, keys, record) {
  if (ctx && typeof ctx === 'object') {
    for (var _gi = 0; _gi < keys.length; _gi++) {
      if (ctx[keys[_gi]] !== undefined) return;
    }
  }
  const reason = '[Intutic Governance] BLOCKED: unrecognised PreToolUse payload — ' +
    'neither a tool name nor a tool_input could be extracted. This hook receives only ' +
    'PreToolUse events, so a payload with no tool call in it is anomalous by definition; ' +
    'refusing rather than allowing a call the gate cannot read.';
  try { console.error(reason); } catch (e) {}
  try { record('tool_blocked', 'unknown', reason); } catch (e) {}
${refuse}
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
  // M3: Cline's \`use_mcp_tool\` envelope, normalized into the
  // \`mcp__<server>__<tool>\` shape every other harness's MCP tool name already
  // takes — BEFORE any rule fires. Cline's own tool-call schema names the
  // server and the tool as separate arguments (\`server_name\`, \`tool_name\`,
  // alongside \`arguments\`) rather than composing them into one tool name, so
  // without this a workspace's own \`mcp__github__.*\`-shaped SOP rule — and
  // the allowlist check below — would silently never fire on a Cline-shaped
  // call. Done once, here, rather than per-harness: any JS writer whose
  // envelope happens to produce \`toolName === 'use_mcp_tool'\` with these
  // fields benefits, not just Cline's.
  if (toolName === 'use_mcp_tool' && toolInput && typeof toolInput === 'object') {
    var _clineServer = toolInput.server_name || toolInput.serverName;
    var _clineTool = toolInput.tool_name || toolInput.toolName;
    if (_clineServer && _clineTool) {
      toolName = 'mcp__' + _clineServer + '__' + _clineTool;
    }
  }
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
      // The serialized tool input, un-normalised: a content rule (the
      // secrets.* floor) matches the bytes a Write would put on disk. The
      // same string the WHERE argPattern machinery tests, so the two content
      // subjects cannot drift.
      : rule.subject === 'content' ? [toolInputJson]
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
        // The rollback rung's storage half: this call was flagged and is about
        // to proceed, which is the only instant the prior bytes still exist.
        // No-op unless the workspace opted in.
        try { _intuticCapturePreImage(toolName, toolInput, rule.id); } catch (e) {}
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

  // M3: MCP per-server allowlist backstop — see the shell emitter for why
  // this is a plain membership test over the parsed \`#mcpservers\` header
  // rather than a synthetic GuardPattern rule (no portable regex can express
  // "allow only these servers" without negative lookahead). Only fires when
  // \`toolName\` is actually \`mcp__<server>__<tool>\`-shaped AND the header was
  // present (\`snap.mcpServers.length > 0\` — an absent header means
  // unrestricted). Refuses through the SAME \`record\`/\`\${refuse}\` path as
  // every other block above, not a parallel mechanism.
  if (snap.mcpServers.length > 0 && toolName.indexOf('mcp__') === 0) {
    var _mcpRest = toolName.slice('mcp__'.length);
    var _mcpSep = _mcpRest.indexOf('__');
    var _mcpServer = _mcpSep >= 0 ? _mcpRest.slice(0, _mcpSep) : '';
    if (_mcpServer && snap.mcpServers.indexOf(_mcpServer) === -1) {
      var _mcpReason = 'MCP server "' + _mcpServer + '" is not on the MCP server allowlist for this workspace [mcp_allowlist]';
      if (snap.mcpSeverity === 'shadow') {
        try { record('tool_would_block', toolName, _mcpReason); } catch (e) {}
      } else {
        try { console.error('[Intutic Governance] BLOCKED: ' + _mcpReason); } catch (e) {}
        try { record('tool_blocked', toolName, _mcpReason); } catch (e) {}
${refuse}
      }
    }
  }
}
// ── end Intutic gate body ────────────────────────────────────────────────────
`
}


/**
 * Pre-image capture — the storage half of the rollback enforcement rung (TD-328).
 *
 * ## Why this exists and why it is here
 *
 * The enforcement ladder jumps from Reask (weak) to Kill (destructive). The
 * missing rung is **Revert**: undo a flagged action's effect instead of ending
 * the session over it. Reverting needs a pre-image, and nothing in the system
 * had one — `ChangeEntry` records `tool`, `op`, `target` and deliberately
 * **never the content being written**, so a manifest can say *what* changed
 * and not *to what*.
 *
 * It belongs in the PreToolUse gate and nowhere else. The proxy sees tool calls
 * the model *proposed*, before the harness runs them; only the hook fires in
 * the instant between "this call was flagged and allowed" and "the file
 * changed". That instant is the only place the prior bytes still exist.
 *
 * ## What is captured, and what is refused
 *
 * Only the `warn` tier — a call a guard flagged and let proceed. Blocked calls
 * changed nothing, so there is nothing to restore; clean calls were never
 * interesting. That keeps the volume proportional to flags rather than to
 * edits.
 *
 * **Off unless asked for, and that is not this codebase's usual default.**
 * Every other guard here is on by default because being wrong costs a false
 * positive. This one stores the *contents* of the user's files on their disk,
 * so being wrong costs a copy of their work nobody consented to. It follows
 * the `mirror_sample_rate: 0.0` precedent: a capability with a real external
 * cost is opted into, not defaulted on. `.intutic/rollback/` is gitignored by
 * the same writer that creates it.
 *
 * Three ceilings, each refusing rather than truncating — a partial pre-image
 * restores a file to a state it was never in, which is worse than no rollback:
 *   * `MAX_PREIMAGE_BYTES` per file
 *   * `MAX_PREIMAGE_ENTRIES` retained, oldest evicted
 *   * only paths inside the workspace root, resolved — a capture of
 *     `../../.ssh/id_rsa` would be an exfiltration primitive wearing a
 *     governance badge.
 */
export function emitPreImageCapture(): string {
  return `
// ── Intutic pre-image capture (rollback rung, TD-328) ────────────────────────
const _INTUTIC_ROLLBACK_DIR = path.join(process.cwd(), '.intutic', 'rollback');
const _INTUTIC_MAX_PREIMAGE_BYTES = 2 * 1024 * 1024;
const _INTUTIC_MAX_PREIMAGE_ENTRIES = 50;

/** Opt-in. Absent file or absent flag means OFF — see the emitter's docstring. */
function _intuticRollbackEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.intutic', 'config.json'), 'utf-8'));
    return cfg && cfg.captureRollbackPreImages === true;
  } catch (e) { return false; }
}

/** The file path a tool call targets, or null when it targets none. */
function _intuticTargetPath(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Copies the CURRENT contents of a flagged call's target aside.
 *
 * Silent on every failure: a capture that cannot happen must never turn an
 * allowed call into a blocked one. The gate's job is governance; this is a
 * convenience layered on top of it, and inverting that would make the feature
 * a new way to break the user's workflow.
 */
function _intuticCapturePreImage(toolName, input, ruleId) {
  try {
    if (!_intuticRollbackEnabled()) return;
    const rel = _intuticTargetPath(input);
    if (!rel) return;

    const root = fs.realpathSync(process.cwd());
    // BOTH sides resolved, or the check silently disables capture wherever the
    // workspace path contains a symlink — which on macOS is the default for
    // /tmp and common for home directories. Comparing a realpath'd root
    // against an unresolved target compares /private/var/... with /var/...,
    // so containment fails, the function returns, and nothing is captured
    // while everything reports success. The file may not exist yet, so the
    // deepest EXISTING ancestor is what gets resolved.
    let abs = path.resolve(root, rel);
    try {
      abs = fs.realpathSync(abs);
    } catch (e) {
      let dir = path.dirname(abs);
      const base = [path.basename(abs)];
      for (;;) {
        try { dir = fs.realpathSync(dir); break; } catch (e2) {
          const parent = path.dirname(dir);
          if (parent === dir) break;
          base.unshift(path.basename(dir));
          dir = parent;
        }
      }
      abs = path.join(dir, ...base);
    }
    // Inside the workspace. Without this a crafted '../../.ssh/id_rsa' would
    // have the gate copy a secret into a directory the agent can read back —
    // an exfiltration primitive wearing a governance badge.
    if (abs !== root && !abs.startsWith(root + path.sep)) return;

    // A file that does not exist yet has no pre-image; restoring it means
    // deleting it, which the manifest records as a creation.
    let content = null, existed = false;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return;
      if (st.size > _INTUTIC_MAX_PREIMAGE_BYTES) return; // refuse, never truncate
      content = fs.readFileSync(abs);
      existed = true;
    } catch (e) { existed = false; }

    fs.mkdirSync(_INTUTIC_ROLLBACK_DIR, { recursive: true });
    // The directory holds copies of the user's files; it must never be
    // committed. Written every time because the directory may be new.
    try {
      fs.writeFileSync(path.join(_INTUTIC_ROLLBACK_DIR, '.gitignore'), '*\\n', 'utf-8');
    } catch (e) {}

    const id = crypto.randomBytes(8).toString('hex');
    if (existed) fs.writeFileSync(path.join(_INTUTIC_ROLLBACK_DIR, id + '.blob'), content);

    const entry = {
      id: id,
      capturedAt: new Date().toISOString(),
      tool: toolName,
      target: abs,
      existed: existed,
      bytes: existed ? content.length : 0,
      ruleId: ruleId || '',
      workspaceId: _intuticWsId,
    };
    fs.appendFileSync(
      path.join(_INTUTIC_ROLLBACK_DIR, 'manifest.jsonl'),
      JSON.stringify(entry) + '\\n',
      { flag: 'a' }
    );

    // Evict oldest beyond the ceiling, blob and line together — a manifest
    // line whose blob was reaped restores nothing while claiming it can.
    try {
      const lines = fs.readFileSync(path.join(_INTUTIC_ROLLBACK_DIR, 'manifest.jsonl'), 'utf-8')
        .split('\\n').filter(Boolean);
      if (lines.length > _INTUTIC_MAX_PREIMAGE_ENTRIES) {
        const drop = lines.slice(0, lines.length - _INTUTIC_MAX_PREIMAGE_ENTRIES);
        for (const l of drop) {
          try { fs.unlinkSync(path.join(_INTUTIC_ROLLBACK_DIR, JSON.parse(l).id + '.blob')); } catch (e) {}
        }
        fs.writeFileSync(
          path.join(_INTUTIC_ROLLBACK_DIR, 'manifest.jsonl'),
          lines.slice(lines.length - _INTUTIC_MAX_PREIMAGE_ENTRIES).join('\\n') + '\\n',
          'utf-8'
        );
      }
    } catch (e) {}
  } catch (e) { /* never block on a capture failure */ }
}
// ── end pre-image capture ────────────────────────────────────────────────────
`
}

/**
 * The JS fail-closed prelude — the FIRST statements of every emitted JS gate.
 *
 * The edge it closes: each writer's stdin handler wraps its work in a
 * try/catch that fails closed, but a crash OUTSIDE that handler — a
 * module-load failure, an unhandled promise rejection from an async path —
 * ended the process with Node's default exit 1. Every exit-code harness reads
 * a non-2 non-zero exit as "the hook errored" and ALLOWS the call, and the
 * stdout-cancel harnesses saw no cancel object, which is also an allow. So a
 * gate that crashed was indistinguishable from a gate that approved.
 *
 * Interpolated by the writer as the first executable code in the script —
 * before any `require` (after `'use strict'` where the writer has one, since a
 * directive must lead the file to take effect) — so everything that runs is
 * covered. The one thing it cannot cover is a SyntaxError in the emitted file
 * itself: Node rejects the whole module before any statement executes,
 * handlers included. That residue is pinned by the behaviour tests running
 * every emitted gate for real.
 *
 * Refuses through the harness's contract, like everything else: exit 2 means
 * nothing to cline or roo-code, whose harnesses only read stdout — a crashed
 * stdout-cancel gate must still print its cancel object.
 */
export function emitJsFailClosedPrelude(opts: JsGateOptions): string {
  const crashBody =
    opts.contract === 'stdout-cancel'
      ? `  try {\n` +
        `    process.stdout.write(JSON.stringify({ cancel: true, reason:\n` +
        `      '[Intutic Governance] gate crashed — failing closed: ' + String((err && err.stack) || err) }) + '\\n');\n` +
        `  } catch (e) { /* stdout gone too — nothing left to refuse through */ }\n` +
        `  process.exit(0);`
      : `  try {\n` +
        `    process.stderr.write('[Intutic Governance] BLOCKED: gate crashed — failing closed: ' +\n` +
        `      String((err && err.stack) || err) + '\\n');\n` +
        `  } catch (e) { /* stderr gone too — the exit code still blocks */ }\n` +
        `  process.exit(2);`
  return `// ── Intutic fail-closed prelude v${GATE_VERSION} — harness: ${opts.harness} ──
// FIRST statements on purpose, before any require: the stdin handler's catch
// fails closed, but a crash outside it — a module-load failure, an unhandled
// promise rejection — used to exit 1, which every exit-code harness reads as
// "hook errored" and ALLOWS, and which prints no cancel object for the
// stdout-cancel harnesses, also an allow. Everything that executes after this
// line is covered; a SyntaxError in this file itself is the one thing that is
// not, because no statement in a file that does not parse ever runs.
function _intuticCrash(err) {
${crashBody}
}
process.on('uncaughtException', _intuticCrash);
process.on('unhandledRejection', _intuticCrash);`
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
state = "ok"
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
    state = "malformed"
if not isinstance(d, dict):
    d = {}
    state = "malformed"
# The envelope check githubCopilotHooks established, applied to the bash
# family: a payload carrying none of the tool fields in any known spelling is
# one the gate cannot evaluate, and extracting empty fields from it would
# match no rule — an allow. Reported as a STATE and decided in the gate body,
# because log_event is not defined yet at extraction time.
if state == "ok" and not any(
    k in d for k in ("tool_name", "toolName", "tool_input", "toolInput")
):
    state = "malformed"
i = d.get("tool_input") or {}
if not isinstance(i, dict):
    i = {}
def first(*keys):
    for k in keys:
        v = i.get(k)
        if isinstance(v, str) and v:
            return clean(v)
    return ""
# The state line comes FIRST: the lines after it may legitimately be empty,
# and command substitution strips trailing newlines, so the last line is the
# only position an empty value cannot survive in.
print(state)
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
' 2>/dev/null || printf '\\n\\n\\n\\n\\n\\n')"

# Each read is \`|| true\` because command substitution strips trailing newlines:
# a tool call with no command argument yields fewer lines than reads, so a late
# read hits EOF and returns non-zero. Under \`set -e\` that killed the gate with
# **exit 1** — which every harness reads as a hook error and lets the call
# through. A guard that fails open on the most ordinary input there is (a Write
# with no shell command) is worse than no guard, because it looks present.
{ IFS= read -r INTUTIC_EXTRACT_STATE || true; IFS= read -r TOOL || true; IFS= read -r TARGET || true; IFS= read -r COMMAND || true; IFS= read -r SESSION_ID || true; IFS= read -r TOOL_INPUT_JSON || true; } <<EOF_INTUTIC_FIELDS
$INTUTIC_FIELDS
EOF_INTUTIC_FIELDS
TOOL="\${TOOL:-}"; TARGET="\${TARGET:-}"; COMMAND="\${COMMAND:-}"; SESSION_ID="\${SESSION_ID:-}"
# Empty means the extractor itself died (the fallback printf above): treat it
# exactly like a payload the parser rejected. The gate body refuses on any
# value other than "ok" — see the envelope refusal in emitShellGate.
INTUTIC_EXTRACT_STATE="\${INTUTIC_EXTRACT_STATE:-}"
[ -n "$INTUTIC_EXTRACT_STATE" ] || INTUTIC_EXTRACT_STATE="malformed"
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

/**
 * The n8n workflow gate.
 *
 * A different unit of evaluation than every other JS gate, and the difference
 * is the whole design. n8n's only blocking mechanism is deployment-level:
 * `EXTERNAL_HOOK_FILES=/path/to/hook.js` names a module whose
 * `workflow.preExecute` functions run once per WORKFLOW execution and receive
 * the full Workflow object — every node with its parameters — not one tool
 * call. A hook that throws aborts the execution; that throw is the refusal.
 *
 * So the emitted evaluator walks the workflow's nodes and maps each onto the
 * shape the shared rules were written for:
 *
 * - the node's **type** (`n8n-nodes-base.executeCommand`, …) stands in for the
 *   tool name — `subject: 'tool'` rules match it;
 * - the node's **serialized parameters** (compact `JSON.stringify`, the same
 *   shape `matchSopRule` pins) stand in for the command/target — `command`,
 *   `target` and `any` rules match the normalised serialization, and a WHERE
 *   rule's argPattern matches the raw serialization, exactly as it matches
 *   `JSON.stringify(tool_input)` in the per-tool gates.
 *
 * Granularity is honest here: one refusal aborts the whole execution, not one
 * node, because that is all preExecute can do. The BLOCKED message names the
 * offending node and rule so the operator knows which node to fix.
 *
 * Refuses by THROWING — there is no exit code and no stdout contract in-process.
 * An internal fault also throws, which n8n treats the same way: fail closed.
 *
 * Verified during the v5 fail-open audit and deliberately left alone: the
 * writer's preExecute wrapper has no try/catch around this gate (see the
 * comment at the module.exports site in n8nHooks.ts), so a fault inside the
 * evaluator aborts the execution exactly as a BLOCKED throw does. This is the
 * one family whose crash posture was already closed; installing process-level
 * exit handlers here would be actively wrong, since the gate runs inside the
 * n8n server process, not a per-call subprocess. Pinned by the "internal
 * fault" case in the n8n block of generatedGateFailClosed.test.ts.
 */
export function emitN8nWorkflowGate(): string {
  const floor = staticFloorPatterns()
  return `
// ── Intutic gate body v${GATE_VERSION} — harness: n8n (workflow-level) ───────
// Generated by harness/gateBody.ts. Do not edit here; every harness regenerates.
//
// Contract: js-throw. This runs inside the n8n process as a workflow.preExecute
// hook (EXTERNAL_HOOK_FILES); throwing is what aborts the execution. See
// emitN8nWorkflowGate() for why the unit is a workflow, not a tool call.

${jsGuardTable('INTUTIC_FLOOR', floor)}

// Emitted from NORMALISE_CONTRACT, not retyped. The previous hand-written copy
// had already drifted from the in-process one on null handling.
${NORMALISE_CONTRACT.jsSource}

${JS_SNAPSHOT_LOADER}

/**
 * Evaluates one workflow. Returns normally to allow; throws to abort the
 * execution. \`record\` is called as (verdict, toolName, reason), the same
 * contract every JS writer's logger speaks.
 */
function intuticGateWorkflow(workflow, record, workspaceId) {
  // The escape hatch skips the destructive family only — never the compiled
  // floor, and never a workspace's own BLOCK: SOP rules. See the shell emitter
  // in gateBody.ts for why a visible escape is safer than the one a blocked
  // operator would otherwise invent.
  const disabled = process.env.INTUTIC_GUARD_DISABLE === '1';
  const wfName = (workflow && (workflow.name || workflow.id)) ? String(workflow.name || workflow.id) : 'workflow';
  if (disabled) {
    try {
      record('guards_disabled', 'n8n:' + wfName,
        'INTUTIC_GUARD_DISABLE=1 — policy-snapshot rules skipped; built-in protections still active');
    } catch (e) {}
  }
  const snap = intuticLoadSnapshot(workspaceId || '');
  if (snap.state !== 'ok') {
    var _msg = snap.state === 'absent'
      ? 'No policy snapshot — built-in protections only'
      : snap.state === 'invalid'
        ? 'Policy snapshot failed its digest or workspace check — dynamic rules dropped'
        : snap.state === 'empty'
          ? 'Policy snapshot contains no rules — the compile produced nothing'
          : 'Policy snapshot is ' + snap.ageDays + ' days old and still enforced';
    try { record('snapshot_' + snap.state, 'n8n:' + wfName, _msg); } catch (e) {}
  }
  if (disabled) snap.rules = snap.rules.filter(function (r) { return r.id.indexOf('destructive.') !== 0; });
  const rules = INTUTIC_FLOOR.concat(snap.rules);

  // BOTH shapes, verified live, and the difference is load-bearing: the docs'
  // external-hooks example passes a workflow whose \`nodes\` is an ARRAY, but
  // what \`workflow.preExecute\` actually receives in a running n8n (probed
  // against the current image with an argument-dumping hook) is a Workflow
  // class instance whose \`nodes\` is an OBJECT keyed by node name. The first
  // version of this gate handled only the array, iterated zero nodes on every
  // real execution, and allowed an offending workflow straight through while
  // every fixture-driven test — written to the docs' array shape — stayed
  // green. A shape neither branch recognises falls through to zero nodes and
  // is REFUSED below rather than allowed.
  var nodes = [];
  var nodesRecognised = false;
  if (workflow && Array.isArray(workflow.nodes)) {
    nodes = workflow.nodes; nodesRecognised = true;
  } else if (workflow && workflow.nodes && typeof workflow.nodes === 'object') {
    nodes = Object.values(workflow.nodes); nodesRecognised = true;
  }
  // Nothing to evaluate that we can SEE is nothing: fine. A workflow whose
  // nodes we cannot read at all is not fine — refusing is the only posture
  // that fails closed if n8n changes the shape again.
  if (!nodesRecognised) {
    try { record('tool_blocked', 'n8n:' + wfName, 'unrecognised workflow.nodes shape — failing closed'); } catch (e) {}
    throw new Error('[Intutic Governance] BLOCKED: unrecognised workflow shape — the governance gate cannot read the workflow nodes (n8n contract change?). Failing closed.');
  }
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const nodeType = String(node.type || '');
    const nodeName = String(node.name || nodeType || 'node');
    // Compact stringify, insertion order, non-ASCII intact — the same shape
    // matchSopRule and every per-tool gate pin for argPattern matching.
    var paramsJson = '{}';
    try { paramsJson = JSON.stringify(node.parameters == null ? {} : node.parameters) || '{}'; } catch (e) {}
    const nType = intuticNormalise(nodeType);
    // The padded BASENAME too, and this is load-bearing: writePolicySnapshot
    // space-pads source patterns (/ (shell|executeCommand) /), and the
    // per-tool gates match them against space-padded tool names. An n8n node
    // type is dot-namespaced ("n8n-nodes-base.executeCommand"), so against
    // the padded full type the pattern's leading space can never sit before
    // "executeCommand" — a real product snapshot matched ZERO node types in a
    // live server while the unit tests, whose fixture wrote unpadded
    // patterns, stayed green. Both candidates are tested: the padded full
    // type (for unpadded/fixture-style patterns, which match unanchored) and
    // the padded basename (for the product writer's padded patterns).
    const nTypeBase = intuticNormalise(nodeType.indexOf('.') >= 0 ? nodeType.slice(nodeType.lastIndexOf('.') + 1) : nodeType);
    const nParams = intuticNormalise(paramsJson);
    // Every string LEAF of the parameters, tested individually alongside the
    // whole serialization. Not redundancy: the shared patterns are written
    // against a normalised command, whose padding gives them their edges — in
    // the serialized JSON a command's last character is followed by a quote,
    // so a pattern like the destructive rm rule (which requires a boundary
    // after the path) matches the extracted string and NOT the JSON. Testing
    // each leaf restores exactly the shape the rules were written for, and
    // each is tested separately for the same anti-seam reason as ever.
    var _leaves = [];
    (function _walk(v) {
      if (typeof v === 'string') { _leaves.push(v); return; }
      if (Array.isArray(v)) { for (const x of v) _walk(x); return; }
      if (v && typeof v === 'object') { for (const k in v) _walk(v[k]); }
    })(node.parameters == null ? {} : node.parameters);
    const nLeaves = _leaves.map(intuticNormalise);
    for (const rule of rules) {
      // A node has no separate command/target — its parameters are both. A
      // 'tool' rule matches the node TYPE and nothing else, for the same
      // reason the per-tool gates never test a path pattern against "Write".
      const subjects = rule.subject === 'tool' ? [nType, nTypeBase] : [nParams].concat(nLeaves);
      for (const subject of subjects) {
        if (!rule.re.test(subject)) continue;
        if (rule.argDowngraded) {
          try {
            record('rule_downgraded', 'n8n:' + nodeName,
              'argPattern for ' + rule.id + ' did not compile — rule enforced name-only');
          } catch (e) {}
        } else if (rule.argRe && !rule.argRe.test(paramsJson)) {
          continue;
        }
        if (rule.severity === 'shadow') {
          try { record('tool_would_block', 'n8n:' + nodeName, rule.reason + ' [' + rule.id + ']'); } catch (e) {}
          continue;
        }
        if (rule.severity === 'warn') {
          // Advisory tier — allowed, recorded with the rule id and the node
          // type. The type is what makes a flag triageable; parameters stay
          // out of telemetry deliberately — that is DLP's job.
          try { record('tool_flagged', 'n8n:' + nodeName, rule.reason + ' [' + rule.id + '] node=' + nodeType); } catch (e) {}
          continue;
        }
        // The rule's own reason, not a generic one: hookEvents.resolveSeverity
        // reads this text for "governance-protected" to file it CRITICAL.
        const reason = rule.reason + ' [' + rule.id + '] (node "' + nodeName + '", type ' + nodeType + ')';
        try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
        try { record('tool_blocked', 'n8n:' + nodeName, reason); } catch (e) {}
        throw new Error('[Intutic Governance] BLOCKED: ' + reason);
      }
    }
  }
}
// ── end Intutic gate body ────────────────────────────────────────────────────
`
}

/** The destructive tier, for the snapshot writer to ship. Not compiled into any
 *  gate — see the note on {@link DESTRUCTIVE_COMMAND_PATTERNS}. */
export { DESTRUCTIVE_COMMAND_PATTERNS }
