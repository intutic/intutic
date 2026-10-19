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
  HOLD_APPROVAL_HINT_TEMPLATE,
  HOLD_ID_PLACEHOLDER,
  INTERVENTION_MODE_RECORD_TAG,
  OPAQUE_REFUSAL_MESSAGE,
} from '@intutic/shared-types'
import {
  DESTRUCTIVE_COMMAND_PATTERNS,
  NORMALISE_CONTRACT,
  ruleFlags,
  staticFloorPatterns,
  type GuardPattern,
} from './protectedPaths.js'
import {
  ARGUMENTS_SIZE_LIMIT,
  CHAOS_GATE_JS_SOURCE,
  COMMAND_SIZE_LIMIT,
  DECIDE_BUDGET_MARGIN_MS,
  DECIDE_FALLBACK_PREFIX,
  DECIDE_GATE_JS_SOURCE,
  DECIDE_MIN_CALL_MS,
  DECIDE_RECORD_TAG,
  decideBudgetMs,
  decideLogRedactionSources,
  GATE_DEADLINE_MARGIN_MS,
  HOOK_TIMEOUT_SECONDS,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_RECORD_TAG,
  gateDeadlineMs,
  type HookGateHarness,
  MCP_ALLOWLIST_JS_SOURCE,
  MCP_ALLOWLIST_RECORD_TAG,
  MCP_REGISTRY_JS_SOURCE,
  MCP_REGISTRY_RECORD_TAG,
  MCP_SNAPSHOT_UNVERIFIED_JS_SOURCE,
  PHRASES_JS_SOURCE,
  SEQUENCE_JS_SOURCE,
} from '@intutic/shared-types'
import { CHAOS_PY_SOURCE } from '../lib/chaosPy.js'
import { MCP_REGISTRY_PY_SOURCE } from '../lib/mcpRegistryPy.js'
import { PHRASES_PY_SOURCE } from '../lib/phrasesPy.js'
import { SEQUENCE_PY_SOURCE } from '../lib/sequencePy.js'
import {
  REFUSAL_DETAIL_JS_SOURCE,
  RULE_RECORD_JS_SOURCE,
  RULE_RECORD_TAG,
  RULE_SNAPSHOT_FORMAT,
  SCOPE_MATCH_JS_SOURCE,
  TEST_OUTCOME_JS_SOURCE,
  LANE_PHRASES,
  type GateRuleKind,
} from '@intutic/shared-types'
import { TEST_OUTCOME_PY_SOURCE } from '../lib/testOutcomePy.js'
import { SCOPE_MATCH_PY_SOURCE } from '../lib/scopeMatchPy.js'
import { RULE_RECORD_PY_SOURCE } from '../lib/ruleRecordPy.js'
import { REFUSAL_DETAIL_PY_SOURCE } from '../lib/refusalDetailPy.js'

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
 * exit 2 via {@link emitShellFailClosed}; every bash gate refuses a stdin
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
 *
 * v8: the `hold` severity and the `action` subject. A hold
 * rule — a `require_approval` SOP rule the control plane resolves, or a local
 * `review_before:` token the daemon compiles as `sop.local.review_before.*` —
 * refuses the call through the harness's own contract, appends the v1 hold
 * record `drainReviewRequests` already reads, prints the `intutic decision
 * approve <holdId>` hint, and lets the call through instead when the
 * daemon's approved-bypass cache holds an exact, unexpired match for it. One
 * mechanism in the shared bodies; the Claude Code writer's bespoke copy is
 * gone. The `.rules` line format is unchanged — `hold` is just a new value in
 * the severity column — so a v7 JS or bash gate reading a v8 snapshot falls
 * through its severity switch to BLOCK (fail closed, no hold record, no
 * bypass). The v7 Python filter is the one exception: its mapping sent every
 * unrecognised severity to `flags`, i.e. ALLOWED, which is why the v8 filter
 * maps unknown to block and why the daemon regenerates every gate each cycle —
 * the skew window is one sync interval.
 *
 * v9: SSO-group refusals. The snapshot carries the workspace's
 * `sso_group_policy` and the member it was issued to as an `@sso_groups` data
 * line (two columns, so every rule parser skips it; inside the digest, so an
 * edited group list fails the check), and the policy decided for that member
 * as ordinary `sso_group.*` block rules on the tool subject. The one gate-side
 * change: an invalid snapshot keeps its `sso_group.*` block rules instead of
 * dropping them with the rest of the dynamic tier. A v8 gate reading a v9
 * snapshot enforces the same rules and drops them on an invalid one.
 *
 * v10: the hold classifier matches each action needle's words with a gap
 * regex (`SQL_GAP_ERE`, replaced in v12) between them, over the normalised command, instead of
 * as a plain substring of the raw one. `DROP/**\/TABLE`, `DROP -- why` +
 * newline + `TABLE`, an escaped `\n`, a line continuation and (in the JS
 * gates, which read the raw command) a tab or a doubled space all dodged a
 * `review_before: action:db_write` or `action:deploy` hold. Only the emitted
 * classifier changed; the `.rules` format did not, so v9 and v10 gates read
 * each other's snapshots — a v9 gate just holds fewer spellings.
 *
 * v11: the classifier reads every harness's shell tool ({@link
 * ACTION_TOOL_NAMES}, now the proxy's `SHELL_TOOLS`, Gemini CLI's
 * `run_shell_command` included) with the v10 matching. A v10 gate does not
 * classify a command run through those extra tool names. The `.rules` format
 * is unchanged.
 *
 * v12: no regex runs on a command to find words that may be split apart. The
 * hold classifier and `phrase`-subject rules (`destructive.sql_drop`) use the
 * linear phrase matcher (`@intutic/shared-types` phrases.ts, emitted as
 * JavaScript; `phrases.py`, emitted as Python and run by the bash gates'
 * extractor), over the raw command. The v10 regex took seconds on a few
 * hundred kilobytes of `git -- git -- …` in the JS gates, and bash's pattern
 * substitution a minute on a long run of backslashes. A v11 gate reading a v12
 * snapshot reads a `phrase` rule's source — the phrases joined by `|` — as a
 * regex over the command, which still matches their plain spellings.
 *
 * v13: no gate rule runs a backtracking regex on a call, and no gate runs
 * past its own deadline. Rules shaped `A.*B` carry the `s` flag in the
 * `.rules` flags column (`is` with `i`) and run as sequences of steps
 * (`@intutic/shared-types` sequence.ts, `sequence.py`); `grep -E` still runs
 * them as written. A call whose command is over `COMMAND_SIZE_LIMIT` bytes or
 * whose arguments are over `ARGUMENTS_SIZE_LIMIT` is refused as
 * `COMMAND_TOO_LARGE`, and a gate still deciding at its deadline refuses
 * with `GATE_DEADLINE`, ahead of the harnesses that read a
 * hook timeout as an allow. A v12 gate compares the flags column with `i`, so
 * it runs a sequence rule as the regex it also is, case-sensitively.
 *
 * v14: the MCP server registry and refusal codes. The snapshot carries the
 * workspace's registry decisions as an `@mcp_registry` data line (two
 * columns, inside the digest), and the JS and bash gates refuse an
 * `mcp__<server>__<tool>` call to a blocked or held server, to a server the
 * workspace has not approved under `mcpDefaultPolicy: deny`, or to a disabled
 * tool, with the MCP proxy's codes, rule ids and reasons
 * (`evaluateMcpRegistry` in `@intutic/shared-types`). An invalid snapshot
 * keeps the record but not its approvals, as it keeps the SSO-group refusals
 * but not the member's groups. A JSON decision (Cline, Grok Build,
 * Antigravity) now carries `code` and `ruleId` ({@link HOOK_REFUSAL_CODES}).
 * The `.rules` rule format is unchanged; a v13 gate skips the record line as
 * it skips `@sso_groups`, and enforces no registry.
 *
 * v15: the in-process gates (the `'throw'` contract: OpenCode's plugin, Pi's
 * extension, OpenClaw's plugin) run their rules under the same deadline,
 * measured from the start of the call rather than of the process, which
 * started long before. Pi and OpenCode await a tool-call handler with no time
 * limit, and OpenClaw's own hook timeout cannot interrupt synchronous code,
 * so a v14 in-process gate on a slow ` WHERE ` pattern held the agent.
 *
 * v16: the MCP server allowlist moved inside the digest. It was a
 * `#mcpservers` header, which the digest does not cover, so adding a server
 * to it by hand widened the allowlist and left the snapshot valid. It is now
 * an `@mcp_allowlist` data line (tag, severity, comma-joined servers; three
 * columns, so every rule parser skips it), and a snapshot that fails its
 * digest keeps the allowlist but admits no server and refuses at `block`,
 * as it keeps the registry's refusals but not its approvals. The bash gates'
 * registry decision is `intutic_clawde/gate/mcp_registry.py`, emitted
 * verbatim. A v15 gate reading a v16 snapshot enforces no allowlist; the
 * daemon regenerates every gate each sync cycle.
 *
 * v17: an unverified snapshot admits no MCP server. A snapshot whose digest
 * is broken or missing, or that names another workspace, used to keep the
 * registry's refusals and an allowlist that admitted nothing; but a deleted
 * record looks exactly like one never set, and an edit to the registry's
 * blocked list or default policy still widened it. Every gate now refuses
 * every MCP call on such a snapshot as `POLICY_SNAPSHOT_UNVERIFIED`
 * (`mcpSnapshotUnverifiedRefusal` in `@intutic/shared-types`), at `block`
 * in an observe-only workspace too, and the sync daemon restores the last
 * snapshot it verified. The JS and Python readers also read a snapshot with
 * no `#digest` line as unverified, as the bash gates already did. And the
 * compiled floor refuses an edit to a VS Code settings file that sets
 * `chat.useHooks` or `chat.hookFilesLocations` (`HOOK_SETTING_PATTERNS`),
 * which can switch off the GitHub Copilot gate. The `.rules` format is
 * unchanged.
 *
 * v18: each gate's deadline is its own harness's: a second under the hook
 * timeout that harness applies (`HOOK_GATE_TIMEOUTS` and `gateDeadlineMs` in
 * `@intutic/shared-types`), at most 9 s. One 4 s deadline for every gate,
 * sized for Grok Build's 5 s default (connect now writes 10 s), refused legitimate calls on a busy machine in
 * harnesses that wait 10 s or more. The bash gates also screen each subject
 * with one `grep` holding every rule's pattern before testing rule by rule,
 * and take the whitespace-collapsed fields from the extractor as they are:
 * a call at the size limit had forked a hundred `grep`s and spent seconds of
 * a loaded machine before any rule could match. The `.rules` format is
 * unchanged.
 *
 * v19: agent fault injection. When a chaos run's runner sets
 * `INTUTIC_CHAOS_PLAN` and `INTUTIC_CHAOS_EVENTS` in the agent's sandbox, the
 * JS and bash gates report every call (`plan_loaded`, `gate_decision`,
 * `tool_call`) to the events file and inject the plan's `tool.error` and
 * `permission.deny_or_delay` faults into calls they allowed
 * (`@intutic/shared-types` chaosGate.ts; `chaos.py` in the bash gates). A
 * plan that is set but unreadable refuses the call. Without the variables
 * nothing changes; the `.rules` format is unchanged.
 *
 * v20: a chaos run's permission delay no longer waits inside the gate. A
 * v19 gate slept for `delay_s` in `delay` and `hold_then_deny` modes, cut
 * short just under the hook timeout. A v20 gate holds the call the way an
 * approval hold does: refused as held (`HELD` in a JSON decision), and so is
 * the identical retry (the same tool, command and target, the key an
 * approval hold uses) until `delay_s` has passed since the first refusal;
 * then the retry is allowed, or denied with the plan's canary. The hold's
 * state is a file beside the run's other counters (chaosGate.ts). Without a
 * chaos plan nothing changes; the `.rules` format is unchanged.
 *
 * v21: the OPAQUE intervention mode. The snapshot of an OPAQUE workspace
 * carries an `@intervention_mode` data line (tag and `OPAQUE`, two columns,
 * inside the digest; `encodeInterventionModeRecord` in `@intutic/shared-types`),
 * and a gate reading one refuses on workspace policy with
 * `OPAQUE_REFUSAL_MESSAGE` in place of the rule's reason and id: what the agent
 * reads on stderr, in a JSON decision's reason (whose `ruleId` is null) and in
 * a thrown error. The code, exit status and contract are unchanged, and the
 * audit line keeps the full reason. A TRANSPARENT or SILENT_LOG snapshot has no
 * such line and is unchanged. A v20 gate skips the line, as it skips any
 * two-column one, and names the rule.
 *
 * v22: decide rules in the snapshot (snapshot format 2). A snapshot carrying
 * one starts with an `@format` data line (tag and `2`) and holds an
 * `@decide` record per tool-call rule (five columns: tag, fallback line id or
 * `-`, stamped rollout, comma-joined tools, base64 of the rule's record;
 * `decideRecord.ts` in `@intutic/shared-types`), inside the digest. Each rule
 * stamped `enforce` also has a fallback line, an ordinary `block` rule on its
 * tools with an id starting `decide-fallback:`, placed right after the
 * SSO-group rules. The JS gates decode each record, rule and hash checked
 * (`decide.ts`, emitted as source), and carry the ones that decode as
 * `decideRules`; the bash gates keep the records whole for the CLI. Every
 * family evaluates decide rules ({@link GATE_EVALUATES_DECIDE}), so it skips
 * a fallback line, but only when a decoded record names it (the bash gates:
 * an `@decide` record of five columns); a record that does not decode leaves
 * its fallback line in force. The decide tier runs after every deterministic
 * tier allowed the call, and only then (a deterministic refusal asks the
 * engine nothing): the JS gates ask the self-hosted engine in process
 * (`intuticGateWithDecide`, an async wrapper around the synchronous tiers),
 * the bash gates and the n8n gate through `intutic decide check --stdin`,
 * each within its harness's budget (`decideBudgetMs` in gateLimits.ts). A
 * rule refuses with `DECIDE_REFUSED`; one that cannot decide asks a person
 * through the harness's {@link AskContract}, or refuses with
 * `DECIDE_ESCALATED` where there is none; an engine (or CLI) that cannot
 * answer refuses an enforcing rule with `GOVERNANCE_UNAVAILABLE` and lets a
 * shadow rule's call on. Each evaluated call is written to the decide log
 * (`~/.intutic/logs/decide-<date>.jsonl`, `decideLog.ts`): the JS gates write
 * it in process, with the record, redaction and drift stats the CLI writes
 * for the bash and n8n gates; a write that fails changes nothing. The
 * synchronous `intuticGate`, which cannot ask
 * the engine, refuses any call an enforcing decide rule names. An unverified
 * snapshot drops the records with the rest of the dynamic tier. A gate
 * reading a format above 2 reports `snapshot_format_newer` and enforces what
 * it reads. A v21 gate skips the records, as it skips any line under six
 * columns, and refuses each fallback line's tools.
 *
 * v23: rule records, post-tool outcomes and the tier order. A
 * snapshot carrying any `@rule` record (five columns: tag, fallback line id
 * or `-`, kind, stamped rollout, base64 of the canonical payload;
 * `gateRuleRecord.ts` in `@intutic/shared-types`) starts with `@format 3`. Three kinds: `requires_outcome`
 * (`requires_before: action:run_tests[ok] -> X`), `scope_paths` (under
 * `scope_paths_mode: enforce`) and `plan_approval` (`required | strict`). Each
 * enforcing record has a `<kind>-fallback:` line, an ordinary `block` rule
 * placed after the SSO-group rules and the decide fallbacks, which a gate
 * skips only when a record that decodes names it and its family evaluates
 * that kind ({@link GATE_EVALUATES_RULE_RECORDS}); the JS gates decode
 * in process, the bash gates in the extractor's Python. A post-tool
 * invocation (`--event post`, or the writer's own post handler) records a
 * test run's outcome in `~/.intutic/hooks/state/outcomes/<sha256(harness NUL
 * session)[:32]>.json` and always allows: the fail-closed prelude exits 0
 * in post mode. Only the harnesses whose post-tool payload was captured
 * report outcomes ({@link POST_TOOL_OBSERVABLE}); on the others a qualified
 * rule refuses with the "not observable" reason. An `[ok]` outcome goes
 * stale on any later file change in the session. Refusals carry
 * `PREREQUISITE_UNMET`, `OUT_OF_SCOPE`, `PLAN_NOT_APPROVED` and `OFF_PLAN`.
 * The tiers run in one order in every family: deterministic refusals (the
 * floor, the snapshot's block rules, `requires_outcome`, the MCP registry
 * and allowlist), then holds, then trajectory (`scope_paths`,
 * `plan_approval`), then decide; a decide allow never releases a hold. The
 * classifier knows `action:run_tests`, `action:http_post`, `action:migrate`,
 * `action:prod_write`, `action:destroy`, `action:payment` and the
 * `action:force_push` compound. A v22 gate skips the records, refuses each
 * fallback line's calls, and holds lane and revert holds through their
 * `phrase` rules.
 */
export const GATE_VERSION = 23

/**
 * Whether each family of rendered gate evaluates each `@rule` kind. A family
 * that does not keeps the kind's fallback lines in force, so it refuses what
 * the rule covers. The n8n workflow gate has no session, no tool results and
 * no file targets, so it keeps every fallback line.
 */
export const GATE_EVALUATES_RULE_RECORDS: Readonly<Record<'js' | 'bash' | 'n8n', Readonly<Record<GateRuleKind, boolean>>>> = {
  js: { requires_outcome: true, scope_paths: true, plan_approval: true },
  bash: { requires_outcome: true, scope_paths: true, plan_approval: true },
  n8n: { requires_outcome: false, scope_paths: false, plan_approval: false },
}

/**
 * Whether a harness reports tool results a gate can read a test outcome
 * from: only where the post-tool payload was captured from
 * the harness itself and carries an exit code or a structured error flag.
 * The fixtures are `__tests__/fixtures/post-tool/<harness>.json`.
 *
 * - `claude-code`: `PostToolUse` (Bash `tool_response.stdout`/`stderr`, no
 *   exit code) and `PostToolUseFailure` (`error`, first line `Exit code N`);
 *   captured from Claude Code 2.1.233.
 * - `gemini-cli` (the bash gate the antigravity writer installs): `AfterTool`
 *   (`tool_response.llmContent` carrying `Exit Code: N` when non-zero);
 *   captured from Gemini CLI 0.36.0.
 *
 * Every other harness is `false`: no payload was captured, so a qualified
 * `requires_before` there refuses with the "not observable" reason.
 */
export const POST_TOOL_OBSERVABLE: Readonly<Record<HookGateHarness, boolean>> = {
  'claude-code': true,
  'gemini-cli': true,
  cursor: false,
  windsurf: false,
  codex: false,
  'muse-code': false,
  'github-copilot': false,
  cline: false,
  grok: false,
  antigravity: false,
  goose: false,
  openhands: false,
  hermes: false,
  openclaw: false,
  pi: false,
  opencode: false,
}

/**
 * The approved-plans cache the daemon writes (§4.3, `approvedPlans.ts`), in
 * the same directory as the policy snapshot. Its `#expires` header is three
 * sync intervals after it was written; a gate reads a cache that is missing,
 * past it, or fails its digest or workspace check as "no plan approved".
 */
export const APPROVED_PLANS_FILE = 'approved-plans.jsonl'

/**
 * Whether each family of rendered gate evaluates the decide rules a snapshot
 * carries: the JS gates, the bash gates and the n8n workflow gate. A family
 * that does not keeps every decide rule's fallback line in force, so it
 * refuses what the rule covers exactly as a gate that reads no `@decide`
 * records does; it never skips a fallback line it cannot stand in for. Set a
 * family only where its decide tier runs.
 */
export const GATE_EVALUATES_DECIDE: Readonly<Record<'js' | 'bash' | 'n8n', boolean>> = { js: true, bash: true, n8n: true }

/**
 * The refusal codes a hook gate's JSON decision carries, as `code` beside the
 * deciding `ruleId` (null when no rule decided), for the harnesses that read
 * a decision from stdout rather than an exit code: Cline (`cancel`), Grok
 * Build and Antigravity (`decision: deny`). The exit-code harnesses read the
 * same refusal as text on stderr, the rule id in brackets. Held to
 * `packages/shared-types/fixtures/refusal-codes.json` (`hook`) by a test.
 *
 * - `BUILT_IN_RULE`: a rule compiled into the gate (a governance bypass, a
 *   write to a protected path or a skill directory, a secret in content);
 * - `SNAPSHOT`: a block rule from the policy snapshot (an SOP, the
 *   destructive-command tier, a skill-content rule);
 * - `SSO_GROUP`: an `sso_group.*` rule, compiled from the workspace's SSO
 *   group policy for this member;
 * - `HELD`: a hold rule, with `holdId`;
 * - `SERVER_BLOCKED`, `SERVER_HELD`, `SERVER_NOT_APPROVED`, `TOOL_DISABLED`:
 *   the MCP server registry;
 * - `SERVER_NOT_ALLOWED`: the workspace's `mcpAllowedServers` list;
 * - `POLICY_SNAPSHOT_UNVERIFIED`: an MCP call on a snapshot that failed its
 *   integrity check, which admits no MCP server;
 * - `COMMAND_TOO_LARGE`: the call is over the size a gate evaluates;
 * - `GATE_DEADLINE`: the gate did not decide within its harness's deadline
 *   (`gateDeadlineMs` in `@intutic/shared-types`);
 * - `UNREADABLE_CALL`: the payload held no tool call the gate could read;
 * - `GATE_CRASHED`: the gate failed while deciding, or a chaos run's
 *   `INTUTIC_CHAOS_PLAN` is set but unreadable;
 * - `DECIDE_REFUSED`, `DECIDE_ESCALATED`, `GOVERNANCE_UNAVAILABLE`: a decide
 *   rule refused, could not be decided where the harness cannot ask, or its
 *   engine was unavailable while it enforces.
 * - `PREREQUISITE_UNMET`: a `requires_before: action:run_tests[ok] -> X` rule
 *   is not met (no run, a failed or unreadable one, a stale one, no session,
 *   or a harness whose results cannot be observed);
 * - `OUT_OF_SCOPE`: a file change outside `scope_paths` under
 *   `scope_paths_mode: enforce`;
 * - `PLAN_NOT_APPROVED`, `OFF_PLAN`: `plan_approval:` and no approved plan
 *   for the session, or (`strict`) a tool that is not one of its steps.
 *
 * A fault a chaos run injects into an allowed call is not a refusal by
 * governance: its JSON decision carries `code: null` and `ruleId: null`, or
 * `code: 'HELD'` and `ruleId: null` when a permission fault holds the call.
 */
export const HOOK_REFUSAL_CODES = [
  'BUILT_IN_RULE',
  'SNAPSHOT',
  'SSO_GROUP',
  'HELD',
  'PREREQUISITE_UNMET',
  'OUT_OF_SCOPE',
  'OFF_PLAN',
  'PLAN_NOT_APPROVED',
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
  'POLICY_SNAPSHOT_UNVERIFIED',
  'COMMAND_TOO_LARGE',
  'GATE_DEADLINE',
  'UNREADABLE_CALL',
  'GATE_CRASHED',
  'DECIDE_REFUSED',
  'DECIDE_ESCALATED',
  'GOVERNANCE_UNAVAILABLE',
] as const

/**
 * The coarse command → action-token classification the hold tier keys on:
 * `review_before: action:deploy` holds a shell command that contains one of
 * the deploy needles, whatever separates its words (the phrase matcher,
 * `@intutic/shared-types` phrases.ts). Deliberately minimal — a gate that tries to be clever
 * about shell commands is a gate that blocks real work — and it mirrors the
 * proxy's `actions.rs` in both directions: `hookActionParity.test.ts` reads
 * THIS file as text and fails if either side knows a needle the other does
 * not. Keep each entry on one line in this exact `['action:x', [...]]` shape;
 * that is what the test's regex finds.
 */
export const ACTION_NEEDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['action:deploy', ['git push', 'kubectl apply', 'kubectl rollout', 'helm upgrade', 'helm install', 'terraform apply', 'docker push', 'serverless deploy', 'fly deploy', 'vercel deploy', 'gcloud run deploy', 'aws deploy', 'aws s3 sync', 'eb deploy']],
  ['action:publish', ['npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload', 'poetry publish', 'gem push', 'docker manifest push']],
  ['action:release', ['gh release create', 'git tag', 'npm version', 'cargo release', 'goreleaser release', 'semantic-release']],
  ['action:db_write', ['insert into', 'update ', 'delete from', 'drop table', 'drop database', 'drop schema', 'truncate ', 'alter table']],
  ['action:run_tests', ['npm test', 'npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'cargo test', 'go test', 'pytest', 'python -m pytest', 'vitest', 'jest', 'mocha', 'rspec', 'phpunit', 'make test', 'gradle test', 'mvn test', 'dotnet test', 'bazel test', 'tox']],
  ['action:http_post', ['curl -x post', 'curl --request post', 'curl -d ', 'curl --data', 'wget --post', 'http post']],
  ['action:migrate', ['prisma migrate deploy', 'prisma db push', 'alembic upgrade', 'alembic downgrade', 'rails db:migrate', 'rake db:migrate', 'manage.py migrate', 'flyway migrate', 'liquibase update', 'knex migrate:latest', 'sequelize db:migrate']],
  ['action:prod_write', ['--prod', 'rails_env=production', 'node_env=production', '--context prod', '--namespace production', '-n production', '--environment production', '--stage prod']],
  ['action:destroy', ['terraform destroy', 'kubectl delete', 'helm uninstall', 'helm delete', 'drop table', 'drop database', 'drop schema', 'truncate ', 'aws s3 rb', 'aws s3 rm']],
  ['action:payment', ['api.stripe.com/v1/charges', 'api.stripe.com/v1/payment_intents', 'api.stripe.com/v1/transfers', 'api.stripe.com/v1/payouts', 'api.stripe.com/v1/refunds', 'stripe charges create', 'stripe payment_intents create', 'stripe transfers create', 'stripe payouts create', 'api-m.paypal.com/v2/payments', 'api.paypal.com/v1/payments']],
]

/**
 * `action:force_push` is a compound, not a needle list (§5.1): the `git push`
 * phrase AND a whole-word ` --force ` or ` -f ` in the space-padded,
 * whitespace-collapsed, lower-cased command. ` --force-with-lease` does not
 * match.
 */
export const FORCE_PUSH_TOKEN = 'action:force_push'
export const FORCE_PUSH_FLAGS = [' --force ', ' -f '] as const

/**
 * `action:destroy` also covers a recursive, forced `rm` whose target is
 * outside the working tree (absolute, under `~`, or containing `..`; Q3).
 * No phrase can say "outside the tree", so both classifiers run the
 * predicate `removesOutsideTree` of `@intutic/gate` (`actions.ts`) after the
 * needles; `rm -rf build/` stays unclassified.
 */
export const DESTROY_TOKEN = 'action:destroy'

/**
 * The (lower-cased) tool names whose `command` the classifier reads: every
 * harness's shell tool. The same list as the proxy's `SHELL_TOOLS` in
 * `actions.rs` (`hookActionParity.test.ts` holds them equal), so a hold the
 * proxy would classify is one the gate can hold before the call runs.
 * `run_shell_command` is Gemini CLI's, `run_command` Antigravity's and
 * `execute_command` Cline's.
 */
export const ACTION_TOOL_NAMES = [
  'bash',
  'shell',
  'run_command',
  'runcommand',
  'execute_command',
  'run_shell_command',
  'terminal',
  'execute',
  'exec',
] as const

/** Where a gate appends a hold, relative to the workspace root; the daemon's
 *  `drainReviewRequests` reads the same file. */
export const REVIEW_REQUESTS_BASENAME = 'review-requests.jsonl'
export const REVIEW_REQUESTS_LOG = `.intutic/events/${REVIEW_REQUESTS_BASENAME}`
/** Bumped when a hold record's shape changes; the control plane drops any
 *  other version at ingest. */
export const REVIEW_REQUEST_VERSION = 1

/**
 * The rule-record tiers of a bash gate, in Python over the shared
 * ports ({@link TEST_OUTCOME_PY_SOURCE}, {@link SCOPE_MATCH_PY_SOURCE},
 * {@link RULE_RECORD_PY_SOURCE}, {@link REFUSAL_DETAIL_PY_SOURCE}): the
 * fallback lines a decoded record names, the `requires_outcome` check with
 * its state bookkeeping, the trajectory check (`scope_paths`,
 * `plan_approval`), and the post-tool recorder. A decoded record is flat:
 * its payload fields beside `kind`, `fallbackId` and `rollout`. Each check
 * returns "" to continue, or verdict, code, rule id, reason and the
 * retry-scope line (§6.2; empty when the refusal names no paths or tools)
 * joined by tabs, the verdict `block` or `shadow`.
 */
const GATE_RULE_TIERS_PY = String.raw`

def _intutic_records(records_text, kind):
    out = []
    for line in str(records_text or "").split("\n"):
        r = decode_gate_rule_record(line) if line else None
        if r is not None and r["kind"] == kind:
            out.append(r)
    return out


def intutic_rule_skip(records_text, kinds_csv):
    # The fallback line ids a decoded, enforcing record names, one per line,
    # for the kinds this gate evaluates. Any other fallback line stays.
    kinds = [k for k in str(kinds_csv).split(",") if k]
    out = []
    for line in str(records_text or "").split("\n"):
        r = decode_gate_rule_record(line) if line else None
        if r is not None and r["fallbackId"] and r["kind"] in kinds:
            out.append(r["fallbackId"])
    return "\n".join(out)


def _intutic_now_ms():
    import time
    return int(time.time() * 1000)


def _intutic_state_path(harness, session):
    import hashlib, os
    base = os.environ.get("INTUTIC_OUTCOME_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".intutic", "hooks", "state", "outcomes")
    return os.path.join(base, outcome_state_file_name(str(harness), str(session),
                                                      lambda t: hashlib.sha256(t.encode("utf-8")).hexdigest()))


def _intutic_state_read(path):
    # (exists, state): a missing file is an empty state; one that does not
    # read is None, which leaves every qualified rule unmet.
    import os
    if not os.path.exists(path):
        return False, empty_outcome_state()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return True, parse_outcome_state(fh.read())
    except Exception:
        return True, None


def _intutic_state_write(path, state):
    import json, os
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp." + str(os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        pass


def _intutic_verdict(r, code, rid, reason, scope):
    return "\t".join(["block" if r["rollout"] == "enforce" else "shadow", code, rid, " ".join(reason.split()),
                      retry_scope_line("TRANSPARENT", scope) or ""])


def intutic_outcome_check(harness, observable, tool, actions, session, records_text, tool_input_json):
    import json
    try:
        ti = json.loads(tool_input_json or "{}")
    except ValueError:
        ti = {}
    recs = _intutic_records(records_text, "requires_outcome")
    path = _intutic_state_path(harness, session) if session else None
    exists, state = _intutic_state_read(path) if path else (False, empty_outcome_state())
    shadow = ""
    for r in recs:
        then = r["then"]
        if (" " + then + " ") not in str(actions) and then.lower() != str(tool).lower():
            continue
        why = None
        if observable != "1":
            case = "not_observable"
        elif not session:
            case = "no_session"
        else:
            case, why = prerequisite_case(state, r["first"], r["adjacent"], _intutic_now_ms())
        if case == "met":
            continue
        rid = "requires_before." + r["first"] + "[ok]" + ("~>" if r["adjacent"] else "->") + then
        line = _intutic_verdict(r, "PREREQUISITE_UNMET", rid, prerequisite_unmet_reason(r["first"], then, case, why, harness),
                                {"tools": [then], "step": r["first"]})
        if r["rollout"] == "enforce":
            return line
        shadow = shadow or line
    # Bookkeeping, on a call this tier lets through: no outcome is adjacent
    # to what comes next any more, and a call that changes files (a mutation
    # tool, or a shell write such as sed -i or git checkout) makes a pass
    # before it stale (Q1).
    if path and exists and state is not None:
        _intutic_state_write(path, note_completed_call(state, is_file_write_call(tool, ti)))
    return shadow


def intutic_post_record(harness, payload_text):
    # A post-tool payload: a shell call that ran tests records its outcome;
    # a file change marks an earlier [ok] stale. Never refuses.
    import json
    try:
        d = json.loads(payload_text or "{}")
    except ValueError:
        return ""
    if not isinstance(d, dict):
        return ""
    session = str(d.get("session_id") or d.get("sessionId") or "")
    if not session:
        return ""
    tool = str(d.get("tool_name") or d.get("toolName") or "")
    ti = d.get("tool_input") if isinstance(d.get("tool_input"), dict) else {}
    command = ""
    for k in ("command", "cmd", "script", "shell_command"):
        if isinstance(ti.get(k), str) and ti.get(k):
            command = ti[k]
            break
    actions = intutic_actions(tool, command)
    path = _intutic_state_path(harness, session)
    exists, state = _intutic_state_read(path)
    if " action:run_tests " in actions:
        resp = d.get("tool_response")
        output = ""
        if isinstance(resp, dict):
            v = resp.get("llmContent")
            output = v if isinstance(v, str) else json.dumps(v)
            # Gemini CLI prefixes the command's output with "Output: ".
            if output.startswith("Output: "):
                output = output[len("Output: "):]
        elif isinstance(resp, str):
            output = resp
        decision = decide_test_outcome({"exitCode": extract_exit_code(output), "output": output})
        _intutic_state_write(path, record_test_outcome(state if state is not None else empty_outcome_state(),
                                                       "action:run_tests", decision, _intutic_now_ms()))
    elif exists and state is not None and is_file_write_call(tool, ti):
        _intutic_state_write(path, note_completed_call(state, True))
    return ""


def _intutic_real(path):
    import os
    return os.path.realpath(path)


def _intutic_repo_root(cwd):
    import os
    d = _intutic_real(cwd or os.getcwd())
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return _intutic_real(cwd or os.getcwd())
        d = parent


def _intutic_approved_plan(session, workspace_id):
    import hashlib, json, os, datetime
    path = os.environ.get("INTUTIC_APPROVED_PLANS") or os.path.join(
        os.path.expanduser("~"), ".intutic", "hooks", "${APPROVED_PLANS_FILE}")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().split("\n")
    except Exception:
        return None
    digest = ws = expires = ""
    body = []
    for line in lines:
        if line.startswith("#digest "):
            digest = line[8:].strip()
        elif line.startswith("#workspace "):
            ws = line[11:].strip()
        elif line.startswith("#expires "):
            expires = line[9:].strip()
        elif line and not line.startswith("#"):
            body.append(line)
    if hashlib.sha256("\n".join(body).encode("utf-8")).hexdigest()[:32] != digest:
        return None
    if ws and workspace_id and ws != workspace_id:
        return None
    try:
        exp = datetime.datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except Exception:
        return None
    if datetime.datetime.now(datetime.timezone.utc) >= exp:
        return None
    tools = None
    for line in body:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("sessionId") != session or e.get("state") not in ("APPROVED", "EXECUTING"):
            continue
        tools = (tools or []) + [str(t).lower() for t in (e.get("tools") or []) if isinstance(t, str)]
    return None if tools is None else {"tools": tools}


def intutic_trajectory_check(harness, tool, session, records_text, tool_input_json, payload_cwd, workspace_id):
    import json, os
    try:
        ti = json.loads(tool_input_json or "{}")
    except ValueError:
        ti = {}
    shadow = ""
    scopes = _intutic_records(records_text, "scope_paths")
    targets = [t["target"] for t in change_targets(tool, ti)] if scopes else []
    if targets:
        cwd = payload_cwd or os.getcwd()
        root = _intutic_repo_root(cwd)
        rels = []
        for t in targets:
            absolute = _intutic_real(os.path.join(_intutic_real(cwd), t))
            rel = os.path.relpath(absolute, root)
            rels.append((t, None if rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel) else rel.replace(os.sep, "/")))
        for rollout in ("enforce", "shadow"):
            group = [r for r in scopes if r["rollout"] == rollout]
            if not group:
                continue
            union = [s for r in group for s in r["scopePaths"]]
            bad = [t for t, rel in rels if rel is None or not is_within_scope(rel, union)]
            if bad:
                r = group[0]
                line = _intutic_verdict(r, "OUT_OF_SCOPE", "scope_paths." + r["sopTitle"],
                                        ", ".join(bad) + " is outside scope_paths (" + ", ".join(union) + ")", {"paths": bad})
                if rollout == "enforce":
                    return line
                shadow = shadow or line
    plans = _intutic_records(records_text, "plan_approval")
    if plans and not is_plan_exempt_tool(str(tool)):
        for rollout in ("enforce", "shadow"):
            group = [r for r in plans if r["rollout"] == rollout]
            if not group:
                continue
            strict = [r for r in group if r["mode"] == "strict"]
            r = strict[0] if strict else group[0]
            level = r["mode"]
            rid = "plan_approval." + r["sopTitle"]
            line = ""
            if not session:
                line = _intutic_verdict(r, "PLAN_NOT_APPROVED", rid, "plan_approval: " + level + " - " + harness + " sent no session id, so no approved plan can be found for this call", {"tools": [str(tool)]})
            else:
                plan = _intutic_approved_plan(session, workspace_id)
                if plan is None:
                    line = _intutic_verdict(r, "PLAN_NOT_APPROVED", rid, "plan_approval: " + level + " - this session has no APPROVED or EXECUTING plan; get its plan approved, then retry", {"tools": [str(tool)]})
                elif level == "strict" and str(tool).lower() not in plan["tools"]:
                    line = _intutic_verdict(r, "OFF_PLAN", rid, "plan_approval: strict - " + str(tool) + " is not a step of the approved plan", {"tools": [str(tool)]})
            if line and rollout == "enforce":
                return line
            shadow = shadow or line
    return shadow
`

/**
 * The Python the bash gates run, defined once per gate script: the phrase
 * matcher ({@link PHRASES_PY_SOURCE}), the MCP registry decision
 * ({@link MCP_REGISTRY_PY_SOURCE}), the shared rule-record ports (test
 * outcomes, scope match, the `@rule` decoder and refusal detail, emitted
 * from `intutic_clawde/gate/`), and entry points over them.
 *
 * - `intutic_actions(tool, command)` — the hold classifier, called by
 *   {@link SHELL_EXTRACT}'s Python, which already reads the raw tool input:
 *   space-padded action tokens (" action:deploy ") or " ".
 * - `intutic_phrase_rule(source, command)` — a `phrase`-subject rule: its
 *   source is `|`-separated phrases, each matched as words with boundaries.
 * - `intutic_mcp_registry(record_b64, tool)` — the `@mcp_registry` record's
 *   decision on an MCP call.
 * - `intutic_mcp_unverified(tool)` — the refusal of an MCP call on a
 *   snapshot that failed its integrity check.
 * - `intutic_chaos_begin()` and `intutic_chaos_call(...)` — a chaos run's
 *   plan check and per-call record and fault ({@link CHAOS_PY_SOURCE}).
 *
 * The classifier used to be `grep -E` with a gap regex over the normalised
 * command, and bash's own pattern substitution on it took a minute on a long
 * run of backslashes. Python is already required by every bash gate.
 */
export const GATE_PY_LIB = `${PHRASES_PY_SOURCE}

${MCP_REGISTRY_PY_SOURCE}

${TEST_OUTCOME_PY_SOURCE}

${SCOPE_MATCH_PY_SOURCE}

# The lane phrases rule_record.py names (lanes.ts LANE_PHRASES).
LANE_PHRASES = ${JSON.stringify(LANE_PHRASES)}

${RULE_RECORD_PY_SOURCE}

${REFUSAL_DETAIL_PY_SOURCE}

_INTUTIC_ACTION_NEEDLES = ${JSON.stringify(ACTION_NEEDLES)}
_INTUTIC_ACTION_TOOLS = ${JSON.stringify(ACTION_TOOL_NAMES)}
_INTUTIC_FORCE_FLAGS = ${JSON.stringify(FORCE_PUSH_FLAGS)}

_INTUTIC_RM_SEGMENT = re.compile(r"[;&|()\\n]")
_INTUTIC_RM_GAP = re.compile(r"[ \\t\\r\\f\\v]+")


def _intutic_removes_outside_tree(args):
    # removes_outside_tree (intutic_clawde actions.py, gate-js actions.ts):
    # rm -rf / -fr / -r -f / --recursive --force with a target that is
    # absolute, under ~, or contains "..". rm -rf build/ is not one.
    for segment in _INTUTIC_RM_SEGMENT.split(args):
        words = [w for w in _INTUTIC_RM_GAP.split(segment) if w != ""]
        at = next((i for i, w in enumerate(words) if w == "rm" or w.endswith("/rm")), -1)
        if at == -1:
            continue
        recursive = force = False
        flags = True
        targets = []
        for w in words[at + 1:]:
            if flags and w == "--":
                flags = False
            elif flags and w.startswith("--"):
                if w == "--recursive":
                    recursive = True
                if w == "--force":
                    force = True
            elif flags and w.startswith("-") and len(w) > 1:
                lower = w.lower()
                if "r" in lower:
                    recursive = True
                if "f" in lower:
                    force = True
            else:
                targets.append(w.strip("\\"'"))
        if recursive and force and any(t.startswith("/") or t.startswith("~") or ".." in t for t in targets):
            return True
    return False


def intutic_actions(tool, command):
    if str(tool or "").lower() not in _INTUTIC_ACTION_TOOLS:
        return " "
    words = phrase_text(command)
    out = " "
    for action, needles in _INTUTIC_ACTION_NEEDLES:
        if any(has_phrase(words, n) for n in needles):
            out += action + " "
    # A recursive, forced remove outside the working tree is destroy too
    # (Q3); no phrase can say "outside the tree", so it is a predicate.
    if " ${DESTROY_TOKEN} " not in out and _intutic_removes_outside_tree(str(command or "")):
        out += "${DESTROY_TOKEN} "
    # The force-push compound: the git push phrase and a whole-word flag.
    if has_phrase(words, "git push"):
        padded = " " + " ".join(str(command or "").lower().split()) + " "
        if any(f in padded for f in _INTUTIC_FORCE_FLAGS):
            out += "${FORCE_PUSH_TOKEN} "
    return out
${GATE_RULE_TIERS_PY}

def intutic_phrase_rule(source, command):
    words = phrase_text(command)
    return any(has_phrase(words, p, True) for p in source.split("|"))


def intutic_mcp_registry(record_b64, tool):
    # The registry decision for one mcp__<server>__<tool> call, from the
    # snapshot's @mcp_registry record: "code<TAB>ruleId<TAB>reason", or "" to
    # let the call continue.
    call = split_mcp_tool_name(tool)
    registry = decode_registry_record(MCP_REGISTRY_RECORD_TAG + "\\t" + record_b64)
    if call is None or registry is None:
        return ""
    refusal = evaluate_registry(registry, call[0], call[1])
    return "\\t".join(refusal) if refusal else ""


def intutic_mcp_unverified(tool):
    # The refusal of an mcp__<server>__<tool> call on a snapshot that failed
    # its integrity check, as "code<TAB>ruleId<TAB>reason"; "" for a call that
    # is not an MCP call.
    call = split_mcp_tool_name(tool)
    return "\\t".join(unverified_refusal(call[0])) if call else ""


${CHAOS_PY_SOURCE}


def intutic_chaos_begin():
    # Why the chaos run's plan cannot be used, or "" when it can.
    plan, error = chaos_decode(os.environ.get("INTUTIC_CHAOS_PLAN", ""))
    if error:
        return error
    if not os.environ.get("INTUTIC_CHAOS_EVENTS"):
        return "INTUTIC_CHAOS_PLAN is set but INTUTIC_CHAOS_EVENTS is not, so nothing the run does could be reported"
    return ""


def intutic_chaos_call(tool, decision, rule_id, destructive, policy_hit, key=""):
    # Records one call as the gate decided it, before any fault; returns the
    # fault to apply to an allowed call as "kind<TAB>reason" (kind deny or
    # hold), or "". key is the call's digest, which a held call's retry shares.
    plan, error = chaos_decode(os.environ.get("INTUTIC_CHAOS_PLAN", ""))
    events = os.environ.get("INTUTIC_CHAOS_EVENTS", "")
    if error or not events:
        return ""
    call = {"tool": tool, "decision": decision, "ruleId": rule_id or None,
            "destructive": destructive == "1", "policyHit": policy_hit == "1", "key": key}
    fault = chaos_call(plan, events, call, chaos_now())
    if fault is None:
        return ""
    return fault["kind"] + "\\t" + fault["reason"]


_INTUTIC_DECIDE_CODES = {
    "allow": (None,),
    "refuse": ("DECIDE_REFUSED", "DECIDE_ESCALATED", "GOVERNANCE_UNAVAILABLE"),
    "escalate": ("DECIDE_ESCALATED",),
}


def intutic_decide_check(harness, tool, budget_ms, session_id, enforce, tool_input_json):
    # The decide tier of a bash gate: \`intutic decide check --stdin\` on a call
    # an @decide record names. Returns outcome, code, rule id and reason,
    # joined by the unit separator (an empty field where there is none). A
    # missing CLI, a non-zero exit, a timeout or an answer that does not read
    # is unavailable: refused with GOVERNANCE_UNAVAILABLE when a matched
    # record is stamped enforce (enforce "1"), allowed, with the reason, when
    # every one is shadow. The CLI spends the budget, its own start included.
    import json, shutil, subprocess
    sep = chr(31)

    def clean(text):
        return " ".join(str(text).split())

    def unavailable(why):
        if enforce != "1":
            return sep.join(["allow", "", "", clean(why)])
        return sep.join(["refuse", "GOVERNANCE_UNAVAILABLE", "", clean("GOVERNANCE_UNAVAILABLE — " + why)])

    try:
        tool_input = json.loads(tool_input_json or "{}")
    except ValueError:
        tool_input = {}
    exe = shutil.which("intutic")
    if not exe:
        return unavailable("the decide rules on " + tool + " need the intutic CLI, which is not on PATH")
    payload = {"v": 1, "harness": harness, "tool": tool, "toolInput": tool_input, "cwd": os.getcwd(),
               "sessionId": session_id, "budgetMs": int(budget_ms), "lastUserTurn": None}
    try:
        done = subprocess.run([exe, "decide", "check", "--stdin"], input=json.dumps(payload), capture_output=True,
                              text=True, timeout=int(budget_ms) / 1000.0)
    except subprocess.TimeoutExpired:
        return unavailable("intutic decide check did not answer within " + str(budget_ms) + " ms")
    except OSError as err:
        return unavailable("intutic decide check could not run (" + type(err).__name__ + ")")
    if done.returncode != 0:
        return unavailable("intutic decide check exited " + str(done.returncode))
    try:
        out = json.loads(done.stdout)
    except ValueError:
        out = None
    rule_id = out.get("ruleId") if isinstance(out, dict) else None
    if (not isinstance(out, dict) or out.get("v") != 1 or out.get("outcome") not in _INTUTIC_DECIDE_CODES
            or out.get("code") not in _INTUTIC_DECIDE_CODES[out.get("outcome")]
            or not (rule_id is None or (isinstance(rule_id, str) and rule_id.startswith("decide.")))
            or not isinstance(out.get("reason", ""), str)):
        return unavailable("intutic decide check gave an answer this gate does not read")
    return sep.join([out["outcome"], out.get("code") or "", clean(rule_id or ""), clean(out.get("reason") or "")])
`

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
 * The newest snapshot format a v23 gate reads: 3, the `@rule` records' (LLD
 * #75). The shared `SNAPSHOT_FORMAT` names the decide records' 2 until the
 * shared modules move it.
 */
export const GATE_READS_FORMAT = Math.max(SNAPSHOT_FORMAT, RULE_SNAPSHOT_FORMAT)

/**
 * What a gate reports, once per call, on a snapshot in a format newer than it
 * reads (`snapshot_format_newer`); `{n}` is the snapshot's format. It still
 * enforces every line it reads, and a fallback line of a rule it cannot read.
 */
export const FORMAT_NEWER_MESSAGE =
  `Policy snapshot format {n} is newer than this gate reads (${GATE_READS_FORMAT}) — records it does not know are skipped and their fallback lines enforced`

/**
 * How a gate refuses a call.
 *
 * The three values are not stylistic. Claude Code, Cursor and the bash
 * harnesses read the **exit code** (2 = deny; 1 is an error and lets the call
 * through). Cline ignores the exit code and reads a `{"cancel": true}`
 * object on stdout. Grok Build ALSO ignores the exit code, but its
 * confirmed verdict shape is a *different* stdout object —
 * `{"decision":"deny","reason":"..."}` — not `{"cancel":true}`. The two
 * stdout contracts are kept as distinct union members rather than folded into
 * one "stdout-cancel" bucket precisely because a gate that emits the wrong
 * field name looks identical in a code review and enforces nothing: Grok
 * Build does not recognise `cancel`, and Cline does not recognise
 * `decision`. A gate that uses the wrong one is silently inert.
 */
/**
 * `'throw'` is for a gate that runs INSIDE the harness process (OpenCode's
 * plugin hook, Pi's extension, OpenClaw's plugin): the refusal is a thrown
 * Error carrying the BLOCKED message. OpenCode turns it into the tool-error
 * the model reads; the Pi and OpenClaw handlers catch it and return their
 * host's block result. No exit code, no stdout — the same in-process posture
 * the n8n workflow gate takes.
 */
export type BlockContract = 'exit2' | 'stdout-cancel' | 'stdout-decision-deny' | 'throw'

/**
 * How a gate asks a person about a call a decide rule could not decide
 * (`escalate`), beside the {@link BlockContract} it refuses with. Only the
 * shapes each harness documents on its pre-tool path:
 *
 * - `claude-pretooluse`: exit 0 with
 *   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":…}}`;
 * - `copilot-decision`: exit 0 with `permissionDecision: "ask"` and its
 *   reason both at the top level (the Copilot CLI) and under
 *   `hookSpecificOutput` (VS Code);
 * - `cursor-permission`: exit 0 with `{"permission":"ask","user_message":…,"agent_message":…}`,
 *   on the shell and MCP hooks only (Cursor accepts an ask on `preToolUse`
 *   and does not enforce it, so the writer says when the call can ask);
 * - `antigravity-force-ask`: exit 0 with `{"decision":"force_ask","reason":…}`,
 *   which prompts even where the user chose "Always Allow";
 * - `hermes-approve`: exit 0 with `{"action":"approve","message":…,"rule_key":…}`,
 *   Hermes' human approval (never `{"decision":"approve"}`, which Hermes
 *   reads as an allow);
 * - `throw-ask`: an in-process gate throws an error carrying `intuticAsk`,
 *   which the writer turns into its host's approval request;
 * - `none`: the harness cannot ask, or asks and then runs the call (Codex),
 *   so an escalation refuses through the {@link BlockContract} with
 *   `DECIDE_ESCALATED`. An escalation never allows.
 */
export type AskContract =
  | 'none'
  | 'claude-pretooluse'
  | 'copilot-decision'
  | 'cursor-permission'
  | 'antigravity-force-ask'
  | 'hermes-approve'
  | 'throw-ask'

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
        [p.id, p.severity, ruleFlags(p), p.subject ?? 'any', p.reason, p.source].join('\t'),
      )}`,
  )
  return `${name}=(\n${rows.join('\n')}\n)`
}

/**
 * Emits a guard table as a JS array literal, preceded by the sequence-rule
 * matcher its `seq` entries are compiled with (sequence.ts, emitted as source).
 */
function jsGuardTable(name: string, patterns: readonly GuardPattern[]): string {
  const rows = patterns.map(
    (p) =>
      `  { id: ${JSON.stringify(p.id)}, re: new RegExp(${JSON.stringify(p.source)}` +
      `${p.ignoreCase ? ", 'i'" : ''}), ` +
      `seq: ${p.sequence ? `compileSequence(${JSON.stringify(p.source)}, ${!!p.ignoreCase})` : 'null'}, ` +
      `severity: ${JSON.stringify(p.severity)}, ` +
      `subject: ${JSON.stringify(p.subject ?? 'any')}, reason: ${JSON.stringify(p.reason)} },`,
  )
  return (
    `// Sequence rules (flags s): the regex's steps, each searched for once from\n` +
    `// where the previous one ended, so a backtracking engine runs them in\n` +
    `// linear time. Emitted from @intutic/shared-types sequence.ts.\n` +
    `${SEQUENCE_JS_SOURCE}\n` +
    `/** Whether a rule (floor or snapshot) matches one subject string. */\n` +
    `function intuticRuleMatches(rule, subject) {\n` +
    `  return rule.seq ? sequenceMatch(rule.seq, subject) : rule.re.test(subject);\n` +
    `}\n\n` +
    `const ${name} = [\n${rows.join('\n')}\n];`
  )
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
  const base = [p.id, p.severity, ruleFlags(p), p.subject ?? 'any', reason, p.source].join('\t')
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
 *
 * It also starts the gate's deadline, which is the harness's own
 * ({@link gateDeadlineMs}).
 */
export function emitShellFailClosed(harness: HookGateHarness): string {
  const deadlineS = gateDeadlineMs(harness) / 1000
  return `
# ── Intutic fail-closed prelude v${GATE_VERSION} ─────────────────────────────
# Any exit status other than the two deliberate verdicts (0 = allow, 2 = block)
# means this gate crashed rather than decided. The harness would read exit 1 as
# "hook errored" and run the tool anyway, so a crash is converted into a block.
# EXIT rather than ERR: ERR is unreliable across shells for set -u deaths, and
# it fires on benign non-zero intermediates; the final status cannot lie.
# A post-tool invocation (--event post, gate body v23) records a tool's result
# and never refuses: the tool has already run, and some harnesses read a
# post-tool exit 2 as text to feed back to the model. So in post mode every
# exit, a crash and the deadline included, is 0.
INTUTIC_POST_MODE=0
if [ "\${1:-}" = "--event" ] && [ "\${2:-}" = "post" ]; then INTUTIC_POST_MODE=1; fi
intutic_fail_closed() {
  _intutic_exit_rc=$?
  # The trap must not itself die on an unset variable or a failed command —
  # that would replace the exit status it exists to correct.
  set +eu
  trap - EXIT
  [ -n "\${INTUTIC_WATCHDOG_PID:-}" ] && kill "$INTUTIC_WATCHDOG_PID" 2>/dev/null
  if [ "\${INTUTIC_POST_MODE:-0}" = "1" ]; then exit 0; fi
  # A chaos run's record of a call the gate refused, held or crashed on (the
  # gate body records an allowed one where it ends). It cannot change the
  # exit status: everything it prints is discarded.
  if [ "$_intutic_exit_rc" != "0" ] && [ "\${INTUTIC_CHAOS_ACTIVE:-0}" = "1" ] && command -v intutic_chaos_decide >/dev/null 2>&1; then
    intutic_chaos_decide "\${_intutic_chaos_decision:-deny}" >/dev/null 2>&1
  fi
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

# ── Internal deadline ────────────────────────────────────────────────────────
# Most harnesses run a call whose hook outlives their timeout as if the hook had
# allowed it. So this gate refuses at ${deadlineS} s from its own start, inside the
# hook timeout ${harness} applies (gateLimits.ts): a watchdog, detached so it holds none of
# the harness's pipes, stops the gate's children (a grep or python3 still
# matching) and signals it; the trap below refuses. Every built-in rule is
# linear; a workspace's own WHERE pattern need not be.
intutic_deadline() {
  trap - USR1
  if [ "\${INTUTIC_POST_MODE:-0}" = "1" ]; then exit 0; fi
  echo "[Intutic Governance] BLOCKED: GATE_DEADLINE — the gate did not finish evaluating this call within ${deadlineS} s, and refuses it rather than let the hook timeout allow it." >&2
  if command -v log_event >/dev/null 2>&1; then
    log_event "tool_blocked" "\${TOOL:-unknown}" "GATE_DEADLINE — the gate did not finish within ${deadlineS} s" || true
  fi
  exit 2
}
trap intutic_deadline USR1
INTUTIC_GATE_PID=$$
INTUTIC_WATCHDOG_PID="$( { ( sleep ${deadlineS}; pkill -P "$INTUTIC_GATE_PID" 2>/dev/null; kill -USR1 "$INTUTIC_GATE_PID" 2>/dev/null ) </dev/null >/dev/null 2>&1 & } ; echo $! )"
`
}

export interface ShellGateOptions {
  /** Harness id, as it appears in audit lines. */
  harness: HookGateHarness
  /**
   * Name of the shell function the writer defined to record an event.
   * Called as `<fn> <verdict> <tool> <reason>`.
   */
  logFn?: string
  /**
   * Absolute path of the hold record file. Defaults to
   * `<script dir>/../events/review-requests.jsonl`, which is the workspace's
   * `.intutic/events/` for every gate that lives in `.intutic/hooks/`; a
   * writer whose artifact lives elsewhere passes it.
   */
  reviewRequestFile?: string
  /** How this harness asks a person about an escalated decide rule; `none` (the default) refuses. */
  ask?: AskContract
}

/**
 * The bash gate body.
 *
 * Expects in scope: `$TOOL`, `$TARGET` and `$COMMAND` as {@link SHELL_EXTRACT}
 * leaves them, whitespace collapsed to single spaces, and the log function
 * named by {@link ShellGateOptions.logFn}. Refuses with `exit 2` — every bash harness
 * uses the exit-code contract.
 */
/** Single-quotes a path for bash. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The JS classifier, `intuticActions(toolName, command)`. Needs
 * `intuticNormalise` in scope. Exported for the classifier's tests.
 */
export function emitJsActionClassifier(): string {
  return `// The phrase matcher, emitted from @intutic/shared-types phrases.ts. No
// regex runs on a command to find words that may be split apart.
${PHRASES_JS_SOURCE}
const INTUTIC_ACTION_NEEDLES = ${JSON.stringify(ACTION_NEEDLES)};
const INTUTIC_ACTION_TOOLS = ${JSON.stringify(ACTION_TOOL_NAMES)};
const INTUTIC_FORCE_FLAGS = ${JSON.stringify(FORCE_PUSH_FLAGS)};

/**
 * removesOutsideTree (@intutic/gate actions.ts): rm -rf / -fr / -r -f /
 * --recursive --force with a target that is absolute, under ~, or contains
 * "..". Segments split at ; & | ( ) and newlines; linear in the command.
 */
function intuticRemovesOutsideTree(args) {
  var segments = args.split(/[;&|()\\n]/);
  for (var s = 0; s < segments.length; s++) {
    var words = segments[s].split(/[ \\t\\r\\f\\v]+/).filter(function (w) { return w !== ''; });
    var at = -1;
    for (var i = 0; i < words.length; i++) {
      if (words[i] === 'rm' || words[i].slice(-3) === '/rm') { at = i; break; }
    }
    if (at === -1) continue;
    var recursive = false, force = false, flags = true, targets = [];
    for (var j = at + 1; j < words.length; j++) {
      var w = words[j];
      if (flags && w === '--') flags = false;
      else if (flags && w.indexOf('--') === 0) {
        if (w === '--recursive') recursive = true;
        if (w === '--force') force = true;
      } else if (flags && w.charAt(0) === '-' && w.length > 1) {
        var lower = w.toLowerCase();
        if (lower.indexOf('r') !== -1) recursive = true;
        if (lower.indexOf('f') !== -1) force = true;
      } else {
        var a = 0, b = w.length;
        while (a < b && (w.charAt(a) === '"' || w.charAt(a) === "'")) a++;
        while (b > a && (w.charAt(b - 1) === '"' || w.charAt(b - 1) === "'")) b--;
        targets.push(w.slice(a, b));
      }
    }
    for (var t = 0; t < targets.length; t++) {
      if (recursive && force && (targets[t].charAt(0) === '/' || targets[t].charAt(0) === '~' || targets[t].indexOf('..') !== -1)) return true;
    }
  }
  return false;
}

/** Space-padded action tokens for a shell command (" action:deploy "), or " ". */
function intuticActions(toolName, command) {
  if (INTUTIC_ACTION_TOOLS.indexOf(String(toolName || '').toLowerCase()) === -1) return ' ';
  var words = phraseText(command), out = ' ';
  for (var i = 0; i < INTUTIC_ACTION_NEEDLES.length; i++) {
    var needles = INTUTIC_ACTION_NEEDLES[i][1];
    for (var j = 0; j < needles.length; j++) {
      if (hasPhrase(words, needles[j])) { out += INTUTIC_ACTION_NEEDLES[i][0] + ' '; break; }
    }
  }
  // A recursive, forced remove outside the working tree is destroy too (Q3).
  if (out.indexOf(' ${DESTROY_TOKEN} ') === -1 && intuticRemovesOutsideTree(String(command == null ? '' : command))) out += '${DESTROY_TOKEN} ';
  // The force-push compound: the git push phrase and a whole-word flag.
  if (hasPhrase(words, 'git push')) {
    var padded = ' ' + String(command == null ? '' : command).toLowerCase().split(/\\s+/).filter(Boolean).join(' ') + ' ';
    for (var f = 0; f < INTUTIC_FORCE_FLAGS.length; f++) {
      if (padded.indexOf(INTUTIC_FORCE_FLAGS[f]) !== -1) { out += '${FORCE_PUSH_TOKEN} '; break; }
    }
  }
  return out;
}

/** A \`phrase\`-subject rule: its source is |-separated phrases matched as words. */
function intuticPhraseRule(source, words) {
  var phrases = String(source).split('|');
  for (var i = 0; i < phrases.length; i++) if (hasPhrase(words, phrases[i], true)) return true;
  return false;
}`
}

/**
 * What an OPAQUE workspace's agent reads of a refusal on workspace policy,
 * emitted once into every JS-family gate: `intuticShown(snap, reason)` is the
 * reason, or the generic sentence when the snapshot carries the
 * `@intervention_mode` record. The audit line always gets the full reason.
 */
const JS_OPAQUE_HELPERS = `const INTUTIC_OPAQUE_MESSAGE = ${JSON.stringify(OPAQUE_REFUSAL_MESSAGE)};
function intuticShown(snap, reason) {
  return snap && snap.opaque ? INTUTIC_OPAQUE_MESSAGE : reason;
}`

/**
 * The hold tier's JS helpers, emitted once into every JS-family gate.
 *
 * `intuticHold` is the one place a hold happens: bypass lookup, hold record,
 * the approve hint and the audit line. It returns `{ bypassed: true }` when an
 * exact, unexpired approved bypass lets the call through and `{ holdId }` when
 * the caller must refuse. Everything is local — no network on the tool path.
 */
function jsHoldHelpers(reviewRequestFile: string | undefined): string {
  return `${emitJsActionClassifier()}
const INTUTIC_REVIEW_REQUEST_FILE = ${JSON.stringify(reviewRequestFile ?? null)};
${JS_OPAQUE_HELPERS}

// Who may approve a hold, and when the retry passes: the sentence every gate
// and the MCP proxy print (holdMessages.ts in shared-types).
function intuticHoldHint(holdId) {
  return ${JSON.stringify(HOLD_APPROVAL_HINT_TEMPLATE)}.split(${JSON.stringify(HOLD_ID_PLACEHOLDER)}).join(holdId);
}

function intuticReviewRequestFile() {
  var path = require('path');
  if (process.env.INTUTIC_REVIEW_REQUESTS) return process.env.INTUTIC_REVIEW_REQUESTS;
  if (INTUTIC_REVIEW_REQUEST_FILE) return INTUTIC_REVIEW_REQUEST_FILE;
  var self = typeof __filename === 'string' ? __filename : (process.argv[1] || '.');
  return path.resolve(path.dirname(self), '..', 'events', '${REVIEW_REQUESTS_BASENAME}');
}

/**
 * Looks for a valid, unexpired, EXACT-match approved bypass in the cache the
 * daemon polled from GET /api/v1/decisions/approved-bypasses. Returns null on
 * ANY reason not to bypass — missing file, failed digest or workspace check,
 * no matching line, an entry whose expiresAt has passed — and every null
 * falls through to the hold: this can only make enforcement MORE permissive
 * for the one call it matches exactly, never less for any other.
 */
function intuticApprovedBypass(workspaceId, sopRuleId, toolNameNormalized, targetHash) {
  var fs = require('fs'), os = require('os'), path = require('path');
  var file = process.env.INTUTIC_APPROVED_BYPASSES ||
    path.join(os.homedir(), '.intutic', 'hooks', 'approved-bypasses.jsonl');
  var raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) { return null; }
  var lines = raw.split('\\n');
  var digest = '', ws = '', body = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('#digest ') === 0) { digest = line.slice(8).trim(); continue; }
    if (line.indexOf('#workspace ') === 0) { ws = line.slice(11).trim(); continue; }
    if (!line || line.charAt(0) === '#') continue;
    body.push(line);
  }
  try {
    var actual = require('crypto').createHash('sha256').update(body.join('\\n')).digest('hex').slice(0, 32);
    if (actual !== digest) return null;
  } catch (e) { return null; }
  if (ws && ws !== workspaceId) return null;
  var now = Date.now();
  for (var k = 0; k < body.length; k++) {
    var entry;
    try { entry = JSON.parse(body[k]); } catch (e) { continue; }
    if (!entry || entry.workspaceId !== workspaceId || entry.sopRuleId !== sopRuleId) continue;
    if (entry.toolNameNormalized !== toolNameNormalized || entry.targetHash !== targetHash) continue;
    var exp = Date.parse(entry.expiresAt);
    if (!exp || isNaN(exp) || now >= exp) continue;
    return entry;
  }
  return null;
}

function intuticHold(rule, toolName, command, target, toolInput, record, workspaceId, sessionId, opaque) {
  var crypto = require('crypto'), fs = require('fs'), path = require('path');
  // Key material, computed the same way at both ends: the normalised tool
  // name, and sha256 of the normalised command/target pair joined by a NUL so
  // command="a" target="b" cannot collide with command="ab" target="".
  var toolNameNormalized = intuticNormalise(toolName);
  var targetHash = crypto.createHash('sha256')
    .update(intuticNormalise(command) + '\\u0000' + intuticNormalise(target)).digest('hex');
  var bypass = intuticApprovedBypass(workspaceId || '', rule.id, toolNameNormalized, targetHash);
  if (bypass) {
    // Let it through — LOUDLY. A bypass nobody can see used is no better than
    // the observe-only gap it replaces.
    var bypassReason = 'Approved bypass for ' + rule.id + ' — approved by ' + bypass.decidedBy + ' on hold ' + bypass.holdId;
    try { console.error('[Intutic Guardrail] BYPASSED: ' + bypassReason); } catch (e) {}
    try { record('hold_approved_bypass_used', toolName, bypassReason); } catch (e) {}
    return { bypassed: true };
  }
  var holdId = 'hold_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  try {
    var file = intuticReviewRequestFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var rec = {
      v: ${REVIEW_REQUEST_VERSION},
      holdId: holdId,
      reason: rule.id,
      tool: toolName,
      sessionId: sessionId || '',
      workspaceId: workspaceId || '',
      at: new Date().toISOString(),
      toolNameNormalized: toolNameNormalized,
      targetHash: targetHash,
    };
    // The redacted context snapshot, when this writer emitted the redactor
    // (Claude Code does). Redacted here rather than in the daemon: plaintext
    // that reaches .intutic/events/ is plaintext that ends up in a bug report.
    if (typeof __intuticSnapshot === 'function') {
      rec.context = __intuticSnapshot({ tool: toolName, toolInput: toolInput, cwd: process.cwd(), reason: rule.id });
    }
    // Appended, never overwritten: holds cluster.
    fs.appendFileSync(file, JSON.stringify(rec) + '\\n');
  } catch (e) {
    // The hold still refuses even if the record cannot be written — the
    // contract below is what stops the tool. But say so.
    try { console.error('[Intutic Guardrail] could not record the hold: ' + (e && e.message ? e.message : e)); } catch (e2) {}
  }
  var reason = rule.reason + ' [' + rule.id + ']';
  // An OPAQUE workspace's agent reads the generic sentence, not the rule; the
  // hint stays, since it names the hold, not the policy.
  try { console.error('[Intutic Guardrail] HELD: ' + (opaque ? INTUTIC_OPAQUE_MESSAGE : reason) + ' ' + intuticHoldHint(holdId)); } catch (e) {}
  try { record('tool_held', toolName, reason); } catch (e) {}
  return { holdId: holdId };
}`
}

/**
 * The subjects the bash gate screens ({@link emitShellGate}), each with the
 * variable holding its text. Every subject a rule can test with grep is here;
 * `phrase` rules run in Python and are not screened.
 */
const SCREEN_SUBJECTS: ReadonlyArray<readonly [string, string]> = [
  ['tool', 'INTUTIC_NTOOL'],
  ['command', 'INTUTIC_NCOMMAND'],
  ['target', 'INTUTIC_NTARGET'],
  ['content', 'TOOL_INPUT_JSON'],
  ['action', 'INTUTIC_ACTIONS'],
]

/**
 * The bash gate's handling of decide fallback lines. A gate that evaluates
 * decide rules (through the CLI) skips the fallback line an `@decide` record
 * names; one that does not keeps every fallback line, which refuses.
 */
function shellDecideFallbackSkip(evaluatesDecide: boolean): string {
  if (!evaluatesDecide) {
    return `  # A fallback line stands in for a decide rule a gate cannot evaluate. This
  # gate evaluates none, so every fallback line stays in force and refuses
  # its rule's tools, as in a gate that reads no @decide records.

`
  }
  return `  # A fallback line stands in for a decide rule a gate cannot evaluate. This
  # gate hands a decide rule to the CLI, which decodes its record and refuses
  # the call when it does not decode, so it skips the fallback line that an
  # @decide record of five columns names in its second. Any other line with
  # the prefix is enforced.
  if [ \${#INTUTIC_DECIDE_RECORDS[@]} -gt 0 ]; then
    _intutic_skip=$'\\n'
    for _rec in "\${INTUTIC_DECIDE_RECORDS[@]}"; do
      _intutic_tabs="\${_rec//[^$'\\t']/}"
      _intutic_fb="\${_rec#*$'\\t'}"
      _intutic_fb="\${_intutic_fb%%$'\\t'*}"
      if [ \${#_intutic_tabs} -eq 4 ] && [ -n "\${_rec##*$'\\t'}" ]; then
        case "$_intutic_fb" in '${DECIDE_FALLBACK_PREFIX}'*) _intutic_skip+="$_intutic_fb"$'\\n' ;; esac
      fi
    done
    _intutic_kept=()
    if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
      for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
        case "$_intutic_skip" in *$'\\n'"\${_rec%%$'\\t'*}"$'\\n'*) continue ;; esac
        _intutic_kept+=("$_rec")
      done
    fi
    INTUTIC_DYNAMIC=()
    if [ \${#_intutic_kept[@]} -gt 0 ]; then INTUTIC_DYNAMIC=("\${_intutic_kept[@]}"); fi
  fi

`
}

/**
 * The bash gate's handling of `<kind>-fallback:` lines (gate body v23): the
 * extractor's Python decodes the `@rule` records and names the fallback
 * lines of the decoded, enforcing ones whose kind this gate evaluates; those
 * are dropped. Any other fallback line is enforced.
 */
function shellRuleFallbackSkip(kindsCsv: string): string {
  return `  # A <kind>-fallback: line stands in for a rule record a gate cannot
  # evaluate. This gate evaluates ${kindsCsv || 'none'}, so it drops the fallback line a
  # decoded record of those kinds names. A python3 that cannot say keeps them all.
  if [ \${#INTUTIC_RULE_RECORDS[@]} -gt 0 ] && [ -n ${shq(kindsCsv)} ]; then
    _intutic_rskip="$(python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_rule_skip"](sys.stdin.read(), sys.argv[1]))' ${shq(kindsCsv)} <<< "$(printf '%s\\n' "\${INTUTIC_RULE_RECORDS[@]}")" 2>/dev/null || true)"
    if [ -n "$_intutic_rskip" ] && [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
      _intutic_rskip=$'\\n'"$_intutic_rskip"$'\\n'
      _intutic_kept=()
      for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
        case "$_intutic_rskip" in *$'\\n'"\${_rec%%$'\\t'*}"$'\\n'*) continue ;; esac
        _intutic_kept+=("$_rec")
      done
      INTUTIC_DYNAMIC=()
      if [ \${#_intutic_kept[@]} -gt 0 ]; then INTUTIC_DYNAMIC=("\${_intutic_kept[@]}"); fi
    fi
  fi

`
}

/**
 * The bash gate's decide tier, after every deterministic tier allowed the
 * call: a call whose tool an `@decide` record names (column 4) goes to
 * `intutic decide check --stdin` through `intutic_decide_check` in
 * {@link GATE_PY_LIB}, within the harness's budget (decideBudgetMs in gateLimits.ts), capped
 * by what the deadline has left. The CLI decodes the records, so a record that
 * does not decode refuses there.
 */
function shellDecideTier(opts: ShellGateOptions): string {
  const log = opts.logFn ?? 'log_event'
  const ask = opts.ask ?? 'none'
  if (ask !== 'none' && ask !== 'hermes-approve') throw new Error(`gateBody: the ${ask} ask contract is not one a bash gate speaks`)
  const askBlock =
    ask === 'hermes-approve'
      ? `    if [ "$_intutic_dec_out" = "escalate" ]; then
      # Hermes' human approval: {"action":"approve"}. Never {"decision":"approve"},
      # which Hermes reads as an allow.
      intutic_shown "$_intutic_dec_full"
      echo "[Intutic Governance] ASK: \${_intutic_shown}" >&2
      ${log} "tool_flagged" "\${TOOL:-}" "DECIDE_ESCALATED — asked a person: $_intutic_dec_full" || true
      _intutic_chaos_rule="$_intutic_dec_rid"; _intutic_chaos_hit=1
      intutic_chaos_decide hold >/dev/null 2>&1 || true
      _intutic_chaos_done=1
      printf '{"action":"approve","message":"%s"}\\n' "$(intutic_json_escape "$_intutic_shown")"
      exit 0
    fi
`
      : `    # ${opts.harness} cannot ask a person, so an escalation refuses (DECIDE_ESCALATED).
`
  return `# ── Decide tier (gate body v22) ──────────────────────────────────────────────
# Only after every tier above allowed the call, and only for a tool an @decide
# record names in its fourth column: intutic decide check --stdin asks the
# self-hosted engine, within ${decideBudgetMs('bash', opts.harness)} ms less what the deadline has left.
# A CLI that is missing, fails, times out or answers what this gate cannot
# read is unavailable, which refuses unless every record on the tool is
# stamped shadow.
_intutic_decide_match=0
_intutic_decide_enforce=0
if [ -z "\${1:-}" ] && [ \${#INTUTIC_DECIDE_RECORDS[@]} -gt 0 ]; then
  for _rec in "\${INTUTIC_DECIDE_RECORDS[@]}"; do
    IFS=$'\\t' read -r _ _d_fb _d_roll _d_tools _d_rest <<< "$_rec"
    case ",\${_d_tools}," in
      *",\${TOOL:-},"*)
        _intutic_decide_match=1
        [ "$_d_roll" = "enforce" ] && _intutic_decide_enforce=1
        ;;
    esac
  done
fi
if [ "$_intutic_decide_match" = "1" ]; then
  _intutic_decide_budget=$(( ${gateDeadlineMs(opts.harness)} - (SECONDS + 1) * 1000 - ${DECIDE_BUDGET_MARGIN_MS} ))
  [ "$_intutic_decide_budget" -gt ${decideBudgetMs('bash', opts.harness)} ] && _intutic_decide_budget=${decideBudgetMs('bash', opts.harness)}
  if [ "$_intutic_decide_budget" -lt ${DECIDE_MIN_CALL_MS} ]; then
    if [ "$_intutic_decide_enforce" = "1" ]; then
      _intutic_dec="refuse"$'\\x1f'"GOVERNANCE_UNAVAILABLE"$'\\x1f'$'\\x1f'"GOVERNANCE_UNAVAILABLE — no time was left for the decide rules on \${TOOL:-} within the gate deadline"
    else
      _intutic_dec="allow"$'\\x1f'$'\\x1f'$'\\x1f'"no time was left for the decide rules on \${TOOL:-} within the gate deadline"
    fi
  else
    _intutic_dec="$(python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_decide_check"](*sys.argv[1:6], sys.stdin.read()))' ${shq(opts.harness)} "\${TOOL:-}" "$_intutic_decide_budget" "\${SESSION_ID:-}" "$_intutic_decide_enforce" <<< "\${TOOL_INPUT_JSON:-}" 2>/dev/null || true)"
    if [ -z "$_intutic_dec" ]; then
      # python3 could not say (it is required, and checked, before any rule
      # runs): unavailable, as a CLI that did not answer is.
      if [ "$_intutic_decide_enforce" = "1" ]; then
        _intutic_dec="refuse"$'\\x1f'"GOVERNANCE_UNAVAILABLE"$'\\x1f'$'\\x1f'"GOVERNANCE_UNAVAILABLE — the decide check could not run"
      else
        _intutic_dec="allow"$'\\x1f'$'\\x1f'$'\\x1f'"the decide check could not run"
      fi
    fi
  fi
  IFS=$'\\x1f' read -r _intutic_dec_out _intutic_dec_code _intutic_dec_rid _intutic_dec_reason <<< "$_intutic_dec"
  if [ "$_intutic_dec_out" = "allow" ]; then
    # A shadow rule's engine that could not answer: recorded, and the call goes on.
    if [ -n "$_intutic_dec_reason" ]; then
      ${log} "tool_would_block" "\${TOOL:-}" "GOVERNANCE_UNAVAILABLE — $_intutic_dec_reason" || true
    fi
  else
    _intutic_dec_full="$_intutic_dec_reason"
    [ -n "$_intutic_dec_rid" ] && _intutic_dec_full="$_intutic_dec_full [$_intutic_dec_rid]"
${askBlock}    _intutic_chaos_rule="$_intutic_dec_rid"; _intutic_chaos_hit=1
    intutic_shown "$_intutic_dec_full"
    echo "[Intutic Governance] BLOCKED: \${_intutic_shown} (refusal code \${_intutic_dec_code:-DECIDE_ESCALATED})" >&2
    ${log} "tool_blocked" "\${TOOL:-}" "$_intutic_dec_full"
    exit 2
  fi
fi
`
}

export function emitShellGate(opts: ShellGateOptions): string {
  const log = opts.logFn ?? 'log_event'
  const floor = staticFloorPatterns()
  const observable = POST_TOOL_OBSERVABLE[opts.harness] ? '1' : '0'
  const ruleKinds = (Object.keys(GATE_EVALUATES_RULE_RECORDS.bash) as GateRuleKind[]).filter((k) => GATE_EVALUATES_RULE_RECORDS.bash[k]).join(',')
  const pyCall = (fn: string, args: string): string =>
    `python3 -c 'import os, sys\nlib = {}\nexec(os.environ.get("INTUTIC_PY_LIB", ""), lib)\nsys.stdout.write(lib["${fn}"](${args}))'`
  return `
# ── Intutic gate body v${GATE_VERSION} — harness: ${opts.harness} ────────────
# Generated by harness/gateBody.ts. Do not edit here; every harness regenerates.
#
# The harness name and version are stamped so this file identifies itself. Both
# were previously passed in and dropped on the floor: opts.harness was declared
# on the option type, supplied by all thirteen writers, and read nowhere.

# ── Post-tool outcome (gate body v23) ────────────────────────────────────────
# A post-tool invocation (--event post) records a test run's outcome for this
# session, or marks an earlier passing run stale after a file change, and
# always allows: the call has already run. Only where ${opts.harness}'s post-tool
# payload was captured and carries an exit code (POST_TOOL_OBSERVABLE: ${observable}).
if [ "\${INTUTIC_POST_MODE:-0}" = "1" ]; then
  if [ "${observable}" = "1" ]; then
    ${pyCall('intutic_post_record', 'sys.argv[1], sys.stdin.read()')} ${shq(opts.harness)} <<< "\${INPUT:-}" >/dev/null 2>&1 || true
  fi
  exit 0
fi

# ── Agent fault injection (intutic chaos run) ────────────────────────────────
# Only when INTUTIC_CHAOS_PLAN is set: a chaos experiment's runner sets it, with
# INTUTIC_CHAOS_EVENTS, in the sandbox the agent runs in, and this gate inherits
# both. The work is chaos.py in INTUTIC_PY_LIB, the transliteration of
# chaosGate.ts in @intutic/shared-types, which explains the counter files kept
# beside the events file. An allowed call is recorded where this body ends,
# where its fault is applied; a refused, held or crashed one by the exit trap.
# A fault applies only to an allowed call. Scoped to the bare invocation, like
# the envelope refusal below.
INTUTIC_CHAOS_ACTIVE=0
_intutic_chaos_done=0
_intutic_chaos_decision=deny
_intutic_chaos_rule=""
_intutic_chaos_hit=0
_intutic_chaos_destructive=0
# Records this call as decided ($1: allow, deny or hold) and prints the fault
# to apply to an allowed one, as kind and reason, tab-separated. $2 is the
# call's digest, which a held call's retry shares.
intutic_chaos_decide() {
  [ "$INTUTIC_CHAOS_ACTIVE" = "1" ] && [ "$_intutic_chaos_done" = "0" ] || return 0
  python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_chaos_call"](*sys.argv[1:]))' "\${TOOL:-unknown}" "$1" "$_intutic_chaos_rule" "$_intutic_chaos_destructive" "$_intutic_chaos_hit" "\${2:-}" || true
}
# A rule fired without deciding the call (shadow, warn): its id, if none yet.
intutic_chaos_note() {
  [ -n "$_intutic_chaos_rule" ] || _intutic_chaos_rule="$1"
}
if [ -z "\${1:-}" ] && [ -n "\${INTUTIC_CHAOS_PLAN:-}" ]; then
  # A plan that is set but unreadable refuses, as an unreadable payload does:
  # an experiment run without the faults it asked for reports a resilience it
  # never measured.
  _intutic_chaos_err="$(python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_chaos_begin"]())' 2>/dev/null || echo "INTUTIC_CHAOS_PLAN could not be read")"
  if [ -n "$_intutic_chaos_err" ]; then
    _intutic_chaos_err="\${_intutic_chaos_err} — refusing the call rather than running the experiment without the faults it asked for"
    echo "[Intutic Governance] BLOCKED: \${_intutic_chaos_err}" >&2
    ${log} "tool_blocked" "\${TOOL:-unknown}" "\${_intutic_chaos_err}" || true
    exit 2
  fi
  INTUTIC_CHAOS_ACTIVE=1
fi

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

# Refuse a call too large to evaluate inside the hook timeout, before any rule
# reads it (the extractor measured it; see gateLimits.ts). Scoped like the
# envelope refusal above: the post/stop invocations carry no call to gate.
if [ -z "\${1:-}" ] && [ -n "\${INTUTIC_TOO_LARGE:-}" ]; then
  echo "[Intutic Governance] BLOCKED: COMMAND_TOO_LARGE — \${INTUTIC_TOO_LARGE}" >&2
  ${log} "tool_blocked" "\${TOOL:-unknown}" "COMMAND_TOO_LARGE — \${INTUTIC_TOO_LARGE}" || true
  exit 2
fi

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
# The per-server MCP allowlist (the @mcp_allowlist record, inside the digest).
# No record means the workspace set no list, and every server is allowed.
INTUTIC_MCP_ALLOWLIST=0
INTUTIC_MCP_SEVERITY=""
INTUTIC_MCP_SERVERS=""
# The MCP server registry record (base64 JSON, inside the digest).
INTUTIC_MCP_REGISTRY=""
# An OPAQUE workspace (the @intervention_mode record): a refusal on workspace
# policy tells the agent this sentence instead of the rule, and the audit line
# keeps the rule. Kept on a snapshot that fails its digest: it only ever hides
# text, never allows a call.
INTUTIC_OPAQUE=0
INTUTIC_OPAQUE_MESSAGE=${shq(OPAQUE_REFUSAL_MESSAGE)}
# The snapshot format (the @format record; 1 without one), and the decide
# rules' @decide records, kept whole for the decide tier: this gate decodes
# none of them, the CLI does.
INTUTIC_SNAPSHOT_FORMAT=1
INTUTIC_DECIDE_RECORDS=()
# The @rule records (gate body v23), kept whole: the extractor's Python decodes
# them for the rule-record tiers below.
INTUTIC_RULE_RECORDS=()
if [ -f "$INTUTIC_SNAPSHOT_RULES" ]; then
  INTUTIC_SNAPSHOT_STATE="ok"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      '#digest '*)      INTUTIC_SNAPSHOT_DIGEST="\${_line#\\#digest }" ;;
      '#workspace '*)   INTUTIC_SNAPSHOT_WORKSPACE="\${_line#\\#workspace }" ;;
      '#generated '*)   INTUTIC_SNAPSHOT_GENERATED="\${_line#\\#generated }" ;;
      '${MCP_ALLOWLIST_RECORD_TAG}'$'\\t'*)
        # Tag, severity and comma-joined servers, tab-separated — parameter
        # expansion only, no subshell. The writer drops a server name holding
        # whitespace or a comma, so neither separator can appear in one.
        INTUTIC_MCP_ALLOWLIST=1
        _intutic_mcp_rest="\${_line#*$'\\t'}"
        INTUTIC_MCP_SEVERITY="\${_intutic_mcp_rest%%$'\\t'*}"
        INTUTIC_MCP_SERVERS="\${_intutic_mcp_rest#*$'\\t'}"
        ;;
      '${MCP_REGISTRY_RECORD_TAG}'$'\\t'*) INTUTIC_MCP_REGISTRY="\${_line#*$'\\t'}" ;;
      '${INTERVENTION_MODE_RECORD_TAG}'$'\\t''OPAQUE') INTUTIC_OPAQUE=1 ;;
      '${SNAPSHOT_FORMAT_RECORD_TAG}'$'\\t'*)
        case "\${_line#*$'\\t'}" in ''|*[!0-9]*) : ;; *) INTUTIC_SNAPSHOT_FORMAT="\${_line#*$'\\t'}" ;; esac
        ;;
      '${DECIDE_RECORD_TAG}'$'\\t'*) INTUTIC_DECIDE_RECORDS+=("$_line") ;;
      '${RULE_RECORD_TAG}'$'\\t'*) INTUTIC_RULE_RECORDS+=("$_line") ;;
      '#'*|'') : ;;
      *) INTUTIC_DYNAMIC+=("$_line") ;;
    esac
  done < "$INTUTIC_SNAPSHOT_RULES"

${shellDecideFallbackSkip(GATE_EVALUATES_DECIDE.bash)}${shellRuleFallbackSkip(ruleKinds)}${SHELL_SHADOWED_PHRASE_SKIP}  # Integrity, in the order that fails cheapest first.
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
  # The SSO-group refusals survive it: they only ever refuse, and dropping
  # them would make editing the member's group list in this file a way to
  # clear a tool the workspace's group policy refuses.
  if [ "$INTUTIC_SNAPSHOT_STATE" = "invalid" ]; then
    _intutic_kept=()
    if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
      for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
        case "$_rec" in
          sso_group.*$'\\t'block$'\\t'*) _intutic_kept+=("$_rec") ;;
        esac
      done
    fi
    INTUTIC_DYNAMIC=()
    if [ \${#_intutic_kept[@]} -gt 0 ]; then INTUTIC_DYNAMIC=("\${_intutic_kept[@]}"); fi
    # Neither MCP record can be vouched for, and a deleted one looks like one
    # never set: the snapshot admits no MCP server (the refusal below).
    INTUTIC_MCP_REGISTRY=""
    INTUTIC_MCP_ALLOWLIST=0
    # The decide and rule records go with the rest of the dynamic tier.
    INTUTIC_DECIDE_RECORDS=()
    INTUTIC_RULE_RECORDS=()
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
  invalid) ${log} "snapshot_invalid" "\${TOOL:-}" "Policy snapshot failed its digest or workspace check — dynamic rules dropped except SSO-group refusals, and every MCP call refused" || true ;;
  empty)   ${log} "snapshot_empty" "\${TOOL:-}" "Policy snapshot contains no rules — the compile produced nothing" || true ;;
  stale)   ${log} "snapshot_stale" "\${TOOL:-}" "Policy snapshot is \${_intutic_age_days} days old and still enforced" || true ;;
esac
if [ "$INTUTIC_SNAPSHOT_FORMAT" -gt ${GATE_READS_FORMAT} ]; then
  ${log} "snapshot_format_newer" "\${TOOL:-}" "${FORMAT_NEWER_MESSAGE.replace('{n}', '$INTUTIC_SNAPSHOT_FORMAT')}" || true
fi

# Normalise once; every pattern is written against this shape. The extractor
# hands each field over with its whitespace already collapsed to single spaces
# by Python, Unicode whitespace included, which bash cannot match; padding is
# all that is left to do. Bash substitutions over a 256 KiB command to find no
# whitespace left took most of a second on a loaded machine.
INTUTIC_NCOMMAND=" \${COMMAND:-} "
INTUTIC_NTARGET=" \${TARGET:-} "
INTUTIC_NTOOL=" \${TOOL:-} "

# ── Hold tier (gate body v8) ─────────────────────────────────────────────────
# A \`hold\` rule refuses the call and records it for a human; an exact,
# unexpired approved bypass the daemon cached lets the same call through once.
# All local — a file read, a file write and an exit code; no network on the
# tool path.
INTUTIC_REVIEW_REQUEST_FILE="\${INTUTIC_REVIEW_REQUESTS:-}"
if [ -z "$INTUTIC_REVIEW_REQUEST_FILE" ]; then
  INTUTIC_REVIEW_REQUEST_FILE=${opts.reviewRequestFile ? shellQuote(opts.reviewRequestFile) : '"$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)/events/review-requests.jsonl"'}
fi
INTUTIC_APPROVED_BYPASSES="\${INTUTIC_APPROVED_BYPASSES:-$HOME/.intutic/hooks/approved-bypasses.jsonl}"
intutic_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-64
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64
  else printf ''; fi
}
intutic_json_escape() {
  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | tr -d '\\n\\r\\t'
}
# What the agent reads of a refusal on workspace policy, in _intutic_shown: the
# reason ($1), or in an OPAQUE workspace the generic sentence. The audit line
# is always written with the full reason.
intutic_shown() {
  if [ "$INTUTIC_OPAQUE" = "1" ]; then _intutic_shown="$INTUTIC_OPAQUE_MESSAGE"; else _intutic_shown="$1"; fi
}
# Looks for a valid, unexpired, EXACT-match approved bypass. Prints nothing
# and returns 1 on ANY reason not to bypass: missing file, failed digest or
# workspace check, no matching line, or an entry whose expiresAt has passed —
# every one of which falls through to the hold. Key material is computed the
# same way the JS gate and the control plane compute it: the normalised tool
# name, and sha256(normalised command, NUL, normalised target).
intutic_bypass() {
  local rid="$1" tn="$2" th="$3" hdr_digest hdr_ws body actual now line exp
  [ -n "$th" ] || return 1
  [ -r "$INTUTIC_APPROVED_BYPASSES" ] || return 1
  hdr_digest="$(grep -m1 '^#digest ' "$INTUTIC_APPROVED_BYPASSES" | cut -d' ' -f2 || true)"
  hdr_ws="$(grep -m1 '^#workspace ' "$INTUTIC_APPROVED_BYPASSES" | cut -d' ' -f2 || true)"
  body="$(grep -v '^#' "$INTUTIC_APPROVED_BYPASSES" | grep -v '^$' || true)"
  [ -n "$body" ] || return 1
  actual="$(printf '%s' "$body" | intutic_sha256 | cut -c1-32)"
  [ -n "$actual" ] && [ "$actual" = "$hdr_digest" ] || return 1
  if [ -n "$hdr_ws" ] && [ "$hdr_ws" != "\${INTUTIC_WORKSPACE_ID:-}" ]; then return 1; fi
  now="$(date -u +%Y-%m-%dT%H:%M:%S)"
  while IFS= read -r line; do
    case "$line" in *'"workspaceId":"'"\${INTUTIC_WORKSPACE_ID:-}"'"'*) ;; *) continue ;; esac
    case "$line" in *'"sopRuleId":"'"$rid"'"'*) ;; *) continue ;; esac
    case "$line" in *'"toolNameNormalized":"'"$tn"'"'*) ;; *) continue ;; esac
    case "$line" in *'"targetHash":"'"$th"'"'*) ;; *) continue ;; esac
    exp="$(printf '%s' "$line" | sed -n 's/.*"expiresAt":"\\([^"]*\\)".*/\\1/p')"
    [ -n "$exp" ] || continue
    # ISO-8601 UTC timestamps compare lexically; a past expiry fails closed
    # toward the hold, however fresh the file is.
    if [[ "$exp" > "$now" ]]; then
      printf '%s' "$line"; return 0
    fi
  done <<< "$body"
  return 1
}
# Returns 0 when an approved bypass lets the call through (the caller
# continues), 2 when the call is held (the caller refuses).
intutic_hold() {
  local rid="$1" rreason="$2" tn th entry decided_by hold_id at file targeth hint
  tn="$INTUTIC_NTOOL"
  th="$( { printf '%s' "$INTUTIC_NCOMMAND"; printf '\\0'; printf '%s' "$INTUTIC_NTARGET"; } | intutic_sha256 )"
  if entry="$(intutic_bypass "$rid" "$tn" "$th")"; then
    decided_by="$(printf '%s' "$entry" | sed -n 's/.*"decidedBy":"\\([^"]*\\)".*/\\1/p')"
    hold_id="$(printf '%s' "$entry" | sed -n 's/.*"holdId":"\\([^"]*\\)".*/\\1/p')"
    echo "[Intutic Guardrail] BYPASSED: Approved bypass for \${rid} — approved by \${decided_by} on hold \${hold_id}" >&2
    ${log} "hold_approved_bypass_used" "\${TOOL:-}" "Approved bypass for \${rid} — approved by \${decided_by} on hold \${hold_id}" || true
    return 0
  fi
  hold_id="hold_$(printf '%x' "$(date +%s)")_$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  targeth=""
  [ -n "$th" ] && targeth="$(printf ',"targetHash":"%s"' "$th")"
  file="$INTUTIC_REVIEW_REQUEST_FILE"
  # The hold still blocks even if the record cannot be written — the exit code
  # is what stops the tool. But say so: a hold nobody can review is the worst
  # of both outcomes.
  if ! { mkdir -p "$(dirname "$file")" 2>/dev/null && printf '{"v":${REVIEW_REQUEST_VERSION},"holdId":"%s","reason":"%s","tool":"%s","sessionId":"%s","workspaceId":"%s","at":"%s","toolNameNormalized":"%s"%s}\\n' \\
      "$hold_id" "$(intutic_json_escape "$rid")" "$(intutic_json_escape "\${TOOL:-}")" "$(intutic_json_escape "\${SESSION_ID:-}")" \\
      "$(intutic_json_escape "\${INTUTIC_WORKSPACE_ID:-}")" "$at" "$(intutic_json_escape "$tn")" "$targeth" >> "$file" 2>/dev/null; }; then
    echo "[Intutic Guardrail] could not record the hold at \${file}" >&2
  fi
  # Who may approve, and when the retry passes (holdMessages.ts in shared-types).
  hint=${shq(HOLD_APPROVAL_HINT_TEMPLATE)}
  hint="\${hint//\\{holdId\\}/$hold_id}"
  intutic_shown "\${rreason} [\${rid}]"
  echo "[Intutic Guardrail] HELD: \${_intutic_shown} \${hint}" >&2
  ${log} "tool_held" "\${TOOL:-}" "\${rreason} [\${rid}]" || true
  return 2
}

# A rule declares which part of the call it matches. \`any\` means command and
# target — never the tool name, because a pattern like \`\\.claude/settings\\.json\`
# would otherwise be tested against "Write" and quietly match nothing.
#
# Whether a rule fires on this call sets _intutic_fires to 1 or 0; the function
# always returns 0, so it runs under set -e like the rest of the gate. With $2
# "quiet" it records nothing: a chaos run's destructive check probes rules
# without deciding by them.
intutic_rule_fires() {
  local rec="$1" quiet="\${2:-}"
  local rid rsev rflags rsubj rreason rsrc rargb64 s hit
  _intutic_fires=0
  # Seven variables over a six- or seven-field record: a v3 line leaves rargb64
  # empty, which is exactly "no argument condition". The base64 column cannot
  # contain a tab, so the last variable never absorbs a separator.
  IFS=$'\\t' read -r rid rsev rflags rsubj rreason rsrc rargb64 <<< "$rec"
  [ -z "$rsrc" ] && return 0
  local _subs=() _ci=
  case "$rflags" in *i*) _ci=i ;; esac
  # A subject the screen below cleared for this case is left out: no pattern
  # matched it, this rule's included.
  case "$rsubj" in
    tool)    intutic_unscreened tool "$_ci" && _subs=("$INTUTIC_NTOOL") ;;
    command) intutic_unscreened command "$_ci" && _subs=("$INTUTIC_NCOMMAND") ;;
    target)  intutic_unscreened target "$_ci" && _subs=("$INTUTIC_NTARGET") ;;
    # Serialized tool input, un-normalised — same subject the WHERE argPattern
    # machinery matches. The secrets.* floor rules ride this. Guaranteed
    # non-empty by the extractor (it defaults to "{}").
    content) intutic_unscreened content "$_ci" && _subs=("$TOOL_INPUT_JSON") ;;
    # The space-padded action tokens the extractor's classifier derived from
    # the raw command (" action:deploy "), so a hold on \`action:deploy\`
    # matches whole tokens.
    action)  intutic_unscreened action "$_ci" && _subs=("$INTUTIC_ACTIONS") ;;
    # The source is |-separated phrases matched as words against the raw
    # command by the phrase matcher in Python, not a regex: grep is linear,
    # but the gap between the words was not expressible without one that
    # backtracks in the other gates. One python3 run, only for these rules.
    # The command goes in on stdin: as an argument, a long one would exceed
    # the kernel's per-argument limit and the rule would silently not run.
    phrase)
      if python3 -c 'import os, sys, json
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.exit(0 if lib["intutic_phrase_rule"](sys.argv[1], json.load(sys.stdin)) else 1)' "$rsrc" <<< "$INTUTIC_RAW_COMMAND_JSON" 2>/dev/null; then
        _subs=("$INTUTIC_NCOMMAND")
      else
        return 0
      fi
      ;;
    # Each field is tested separately rather than concatenated. Joining them
    # lets a pattern match across the seam — a command ending in "chflags" and
    # an unrelated target starting with "nouchg" would trip the bypass rule
    # together while neither does alone.
    *)
      intutic_unscreened command "$_ci" && _subs+=("$INTUTIC_NCOMMAND")
      intutic_unscreened target "$_ci" && _subs+=("$INTUTIC_NTARGET")
      ;;
  esac
  [ \${#_subs[@]} -gt 0 ] || return 0
  hit=0
  [ "$rsubj" = "phrase" ] && hit=1
  for s in "\${_subs[@]}"; do
    [ "$rsubj" = "phrase" ] && break
    # Flags: i = case-insensitive; s (a sequence rule) changes nothing here —
    # grep matches with an automaton, linear in the text, so the regex runs
    # as written.
    case "$rflags" in
      *i*) printf '%s' "$s" | grep -qiE -- "$rsrc" && hit=1 ;;
      *)   printf '%s' "$s" | grep -qE -- "$rsrc" && hit=1 ;;
    esac
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
    elif [ "$_intutic_arg_rc" != "0" ] && [ -z "$quiet" ]; then
      ${log} "rule_downgraded" "\${TOOL:-}" "argPattern for \${rid} did not compile in python re — rule enforced name-only" || true
    fi
  fi
  _intutic_fires=1
}

intutic_apply() {
  local rec="$1"
  local rid rsev rflags rsubj rreason rsrc rargb64
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
  # The tier order (gate body v23): every refusal first, the holds after the
  # rule records and the MCP checks. A hold is only ever decided on a call
  # nothing deterministic refused.
  case "\${_intutic_pass:-all}" in
    det) [ "$rsev" = "hold" ] && return 0 ;;
    hold) [ "$rsev" = "hold" ] || return 0 ;;
  esac
  intutic_rule_fires "$rec"
  [ "$_intutic_fires" = "1" ] || return 0
  if [ "$rsev" = "shadow" ]; then
    intutic_chaos_note "$rid"
    ${log} "tool_would_block" "\${TOOL:-}" "\${rreason} [\${rid}]" || true
    return 0
  fi
  if [ "$rsev" = "hold" ]; then
    # Not a permanent denial: the action is legitimate, someone asked to see
    # it first. A bypass they approved lets this exact call through once.
    _intutic_chaos_rule="$rid"; _intutic_chaos_hit=1
    if intutic_hold "$rid" "$rreason"; then return 0; fi
    _intutic_chaos_decision=hold
    exit 2
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
    intutic_chaos_note "$rid"
    ${log} "tool_flagged" "\${TOOL:-}" "\${rreason} [\${rid}] verb=\${_intutic_verb}" || true
    return 0
  fi
  # The rule's own reason, not a generic one: hookEvents.resolveSeverity reads
  # this text for "governance-protected" to file the incident CRITICAL.
  local reason="\${rreason} [\${rid}]"
  _intutic_chaos_rule="$rid"; _intutic_chaos_hit=1
  intutic_shown "$reason"
  echo "[Intutic Governance] BLOCKED: \${_intutic_shown}" >&2
  ${log} "tool_blocked" "\${TOOL:-}" "\${reason}"
  exit 2
}

# ── Screening ────────────────────────────────────────────────────────────────
# Rule by rule, the gate forks a grep per rule and subject: about a hundred on
# every call, which on a loaded machine took seconds before any rule could
# match. So each subject is first screened by one grep holding every pattern
# that tests it, the case-insensitive ones apart. A subject none of them
# matches is left out of every rule that tests it, since no one of them could
# match it either. A screen that matches, or one grep cannot run (exit 2),
# clears nothing, and the rules decide as before: the screen saves work and
# never changes a verdict. grep is still the engine, so the screen is linear too.
${SCREEN_SUBJECTS.map(([key]) => `_intutic_screen_${key}=(); _intutic_screen_${key}i=(); _intutic_clear_${key}=; _intutic_clear_${key}i=`).join('\n')}
intutic_screen_add() {
  case "$1$2" in
${SCREEN_SUBJECTS.flatMap(([key]) => [`    ${key}) _intutic_screen_${key}+=(-e "$3") ;;`, `    ${key}i) _intutic_screen_${key}i+=(-e "$3") ;;`]).join('\n')}
  esac
}
for _rec in "\${INTUTIC_FLOOR[@]}" \${INTUTIC_DYNAMIC[@]+"\${INTUTIC_DYNAMIC[@]}"}; do
  IFS=$'\t' read -r _r_id _r_sev _r_flags _r_subj _r_reason _r_src _r_arg <<< "$_rec"
  [ -n "$_r_src" ] || continue
  _r_ci=
  case "$_r_flags" in *i*) _r_ci=i ;; esac
  case "$_r_subj" in
    tool|command|target|content|action) intutic_screen_add "$_r_subj" "$_r_ci" "$_r_src" ;;
    phrase) : ;;
    *) intutic_screen_add command "$_r_ci" "$_r_src"; intutic_screen_add target "$_r_ci" "$_r_src" ;;
  esac
done
# $1 subject, $2 "i" or empty, $3 its text, then the patterns as -e pairs.
intutic_screen() {
  local key="$1" ci="$2" text="$3" rc=0
  shift 3
  if [ "$ci" = "i" ]; then printf '%s' "$text" | grep -qiE "$@" || rc=$?
  else printf '%s' "$text" | grep -qE "$@" || rc=$?
  fi
  [ "$rc" != "1" ] || printf -v "_intutic_clear_$key$ci" '%s' 1
}
${SCREEN_SUBJECTS.flatMap(([key, text]) => [
  `[ \${#_intutic_screen_${key}[@]} -eq 0 ] || intutic_screen ${key} '' "$${text}" "\${_intutic_screen_${key}[@]}"`,
  `[ \${#_intutic_screen_${key}i[@]} -eq 0 ] || intutic_screen ${key} i "$${text}" "\${_intutic_screen_${key}i[@]}"`,
]).join('\n')}
# Whether rules testing subject $1, case $2, still need to: not when screened clear.
intutic_unscreened() {
  local v="_intutic_clear_$1$2"
  [ "\${!v:-}" != "1" ]
}

# A chaos run's no_destructive_attempt probe: whether a destructive.* rule
# matches this call, whether or not it decides it, the escape hatch included.
if [ "$INTUTIC_CHAOS_ACTIVE" = "1" ] && [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
  for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
    case "$_rec" in
      destructive.*)
        intutic_rule_fires "$_rec" quiet
        if [ "$_intutic_fires" = "1" ]; then _intutic_chaos_destructive=1; break; fi
        ;;
    esac
  done
fi

for _rec in "\${INTUTIC_FLOOR[@]}"; do
  intutic_apply "$_rec"
done

_intutic_pass=det
if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
  for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
    intutic_apply "$_rec"
  done
fi

# ── Rule records (gate body v23) ─────────────────────────────────────────────
# A rule record's verdict, as the Python check returns it: verdict, code, rule
# id and reason, tab-separated; empty to continue. shadow records the finding;
# block refuses.
intutic_rule_verdict() {
  [ -n "$1" ] || return 0
  local verdict code rid reason retry
  IFS=$'\t' read -r verdict code rid reason retry <<< "$1"
  if [ "$verdict" = "shadow" ]; then
    intutic_chaos_note "$rid"
    ${log} "tool_would_block" "\${TOOL:-}" "\${reason} [\${rid}]" || true
    return 0
  fi
  _intutic_chaos_rule="$rid"; _intutic_chaos_hit=1
  intutic_shown "\${reason} [\${rid}]"
  echo "[Intutic Governance] BLOCKED: \${_intutic_shown} (refusal code \${code})" >&2
  # Where to retry: the paths or tools the refusal names. An
  # OPAQUE workspace drops it, as it drops the rule.
  if [ -n "$retry" ] && [ "$INTUTIC_OPAQUE" != "1" ]; then echo "$retry" >&2; fi
  ${log} "tool_blocked" "\${TOOL:-}" "\${reason} [\${rid}]"
  exit 2
}
_intutic_rr_text=""
if [ \${#INTUTIC_RULE_RECORDS[@]} -gt 0 ]; then
  _intutic_rr_text="$(printf '%s\n' "\${INTUTIC_RULE_RECORDS[@]}")"
fi
# requires_outcome: a call whose action token (or tool) a qualified
# requires_before gates is refused unless this session's last test run passed,
# and no file changed since (PREREQUISITE_UNMET). The check also keeps the
# session's state: a file change marks a passing run stale. A check that
# cannot run refuses.
case "$_intutic_rr_text" in
  *$'\t'requires_outcome$'\t'*)
    _intutic_rr="$(${pyCall('intutic_outcome_check', '*(sys.argv[1:7] + [sys.stdin.read()])')} ${shq(opts.harness)} ${observable} "\${TOOL:-}" "\${INTUTIC_ACTIONS:- }" "\${SESSION_ID:-}" "$_intutic_rr_text" <<< "\${TOOL_INPUT_JSON:-}" 2>/dev/null || printf 'block\tPREREQUISITE_UNMET\trequires_before\tthe requires_before check could not run')"
    intutic_rule_verdict "$_intutic_rr"
    ;;
esac

# ── Unverified snapshot (gate body v17) ──────────────────────────────────────
# A snapshot that failed its digest or workspace check admits no MCP server:
# neither record in it can be vouched for, and a deleted one looks like one
# never set. Refused at block, in an observe-only workspace too, with the code,
# rule id and reason of mcpSnapshotUnverifiedRefusal (intutic_mcp_unverified
# in GATE_PY_LIB).
if [ "$INTUTIC_SNAPSHOT_STATE" = "invalid" ]; then
  case "\${TOOL:-}" in
    mcp__*__*)
      _intutic_unv="$(python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_mcp_unverified"](sys.argv[1]))' "\${TOOL:-}" 2>/dev/null || true)"
      if [ -n "$_intutic_unv" ]; then
        IFS=$'\\t' read -r _ _intutic_unv_rid _intutic_unv_reason <<< "$_intutic_unv"
      else
        # python3 could not say why (it is required, and checked, before any
        # rule runs): still a refusal, never an allow.
        _intutic_unv_rid="policy_snapshot"
        _intutic_unv_reason="POLICY_SNAPSHOT_UNVERIFIED — the policy snapshot failed its integrity check and admits no MCP server"
      fi
      _intutic_chaos_rule="$_intutic_unv_rid"; _intutic_chaos_hit=1
      echo "[Intutic Governance] BLOCKED: \${_intutic_unv_reason} [\${_intutic_unv_rid}]" >&2
      ${log} "tool_blocked" "\${TOOL:-}" "\${_intutic_unv_reason} [\${_intutic_unv_rid}]"
      exit 2
      ;;
  esac
fi

# ── MCP server registry backstop (gate body v14) ─────────────────────────────
# The workspace's registry decisions from the snapshot's @mcp_registry record,
# applied to every mcp__<server>__<tool> call: a blocked or held server, a
# server not approved under mcpDefaultPolicy deny, a disabled tool. The same
# decision, rule ids and reasons as the MCP proxy, so a server no proxy fronts
# is refused as one it fronts would be. Evaluated in Python (intutic_mcp_registry
# in GATE_PY_LIB), which reads the record's JSON; only for MCP-shaped calls.
if [ -n "$INTUTIC_MCP_REGISTRY" ]; then
  case "\${TOOL:-}" in
    mcp__*__*)
      _intutic_reg="$(python3 -c 'import os, sys
lib = {}
exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
sys.stdout.write(lib["intutic_mcp_registry"](sys.argv[1], sys.argv[2]))' "$INTUTIC_MCP_REGISTRY" "\${TOOL:-}" 2>/dev/null || true)"
      if [ -n "$_intutic_reg" ]; then
        IFS=$'\\t' read -r _ _intutic_reg_rid _intutic_reg_reason <<< "$_intutic_reg"
        _intutic_chaos_rule="$_intutic_reg_rid"; _intutic_chaos_hit=1
        intutic_shown "\${_intutic_reg_reason} [\${_intutic_reg_rid}]"
        echo "[Intutic Governance] BLOCKED: \${_intutic_shown}" >&2
        ${log} "tool_blocked" "\${TOOL:-}" "\${_intutic_reg_reason} [\${_intutic_reg_rid}]"
        exit 2
      fi
      ;;
  esac
fi

# ── MCP per-server allowlist backstop ────────────────────────────────────────
# A dedicated record, not a synthetic GuardPattern rule: "allow only these
# servers" as one regex needs negative lookahead, which POSIX ERE (grep -E)
# does not have. So this is a plain membership test over the @mcp_allowlist
# record, with evaluateMcpAllowlist's code, rule id and reason (the shared
# vectors hold this copy to it). Only for an mcp__<server>__<tool> call, and
# only when the snapshot carries the record.
case "\${TOOL:-}" in
  mcp__*__*)
    if [ "$INTUTIC_MCP_ALLOWLIST" = "1" ]; then
      _intutic_mcp_server="\${TOOL#mcp__}"
      _intutic_mcp_server="\${_intutic_mcp_server%%__*}"
      case ",$INTUTIC_MCP_SERVERS," in
        *",$_intutic_mcp_server,"*)
          : # allowed — the server is in the workspace's list
          ;;
        *)
          _intutic_mcp_reason="MCP server \\"$_intutic_mcp_server\\" is not on the MCP server allowlist for this workspace [mcp_allowlist]"
          if [ "$INTUTIC_MCP_SEVERITY" = "shadow" ]; then
            intutic_chaos_note mcp_allowlist
            ${log} "tool_would_block" "\${TOOL:-}" "$_intutic_mcp_reason" || true
          else
            _intutic_chaos_rule=mcp_allowlist; _intutic_chaos_hit=1
            intutic_shown "$_intutic_mcp_reason"
            echo "[Intutic Governance] BLOCKED: \${_intutic_shown}" >&2
            ${log} "tool_blocked" "\${TOOL:-}" "$_intutic_mcp_reason"
            exit 2
          fi
          ;;
      esac
    fi
    ;;
esac

# ── Holds (gate body v8; after every refusal since v23) ──────────────────────
_intutic_pass=hold
if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
  for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
    intutic_apply "$_rec"
  done
fi

# ── Trajectory: scope_paths and plan_approval (gate body v23) ────────────────
# A file change outside the union of scope_paths (OUT_OF_SCOPE), and a call
# before the session's plan is approved (PLAN_NOT_APPROVED) or, under strict,
# off its steps (OFF_PLAN). After the holds, before the decide tier. A check
# that cannot run refuses.
case "$_intutic_rr_text" in
  *$'\t'scope_paths$'\t'*|*$'\t'plan_approval$'\t'*)
    _intutic_tr="$(${pyCall('intutic_trajectory_check', '*(sys.argv[1:4] + [sys.argv[4], sys.stdin.read(), sys.argv[5], sys.argv[6]])')} ${shq(opts.harness)} "\${TOOL:-}" "\${SESSION_ID:-}" "$_intutic_rr_text" "$PWD" "\${INTUTIC_WORKSPACE_ID:-}" <<< "\${TOOL_INPUT_JSON:-}" 2>/dev/null || printf 'block\tOUT_OF_SCOPE\tscope_paths\tthe scope and plan check could not run')"
    intutic_rule_verdict "$_intutic_tr"
    ;;
esac

${shellDecideTier(opts)}
# ── Agent fault injection: the call is allowed ───────────────────────────────
# Recorded as allowed, then the fault that is due, if any. A permission delay
# never waits here: the call is held, and its identical retry (the same key an
# approval hold uses) passes, or is denied, once the delay has passed.
if [ "$INTUTIC_CHAOS_ACTIVE" = "1" ]; then
  _intutic_chaos_key="$( { printf '%s' "$INTUTIC_NTOOL"; printf '\\0'; printf '%s' "$INTUTIC_NCOMMAND"; printf '\\0'; printf '%s' "$INTUTIC_NTARGET"; } | intutic_sha256 )"
  _intutic_fault="$(intutic_chaos_decide allow "$_intutic_chaos_key")"
  _intutic_chaos_done=1
  if [ -n "$_intutic_fault" ]; then
    _intutic_fault_kind="\${_intutic_fault%%$'\\t'*}"
    _intutic_fault_reason="\${_intutic_fault#*$'\\t'}"
    # The fault's own text, carrying the plan's canary: what the agent reads.
    if [ "$_intutic_fault_kind" = "hold" ]; then
      echo "[Intutic Governance] HELD: \${_intutic_fault_reason}" >&2
    else
      echo "$_intutic_fault_reason" >&2
    fi
    exit 2
  fi
fi
# ── end Intutic gate body ────────────────────────────────────────────────────
`
}

export interface JsGateOptions {
  /** Harness id, as it appears in audit lines; it also picks the gate's deadline. */
  harness: HookGateHarness
  /** How this harness refuses. */
  contract: BlockContract
  /**
   * The harness's decision object may carry only the fields it documents
   * (Google Antigravity), so a refusal names its code in the reason text,
   * `(refusal code SERVER_BLOCKED)`, rather than in `code` and `ruleId`
   * fields. The rule id is already in the reason, in brackets.
   */
  documentedFieldsOnly?: boolean
  /** See {@link ShellGateOptions.reviewRequestFile}. Writers whose artifact
   *  does not live in `.intutic/hooks/` (cline, opencode) pass it. */
  reviewRequestFile?: string
  /** How this harness asks a person about an escalated decide rule; `none` (the default) refuses. */
  ask?: AskContract
}

/**
 * The decide modules every JS-family gate embeds beside
 * {@link jsSnapshotLoader}: the snapshot's decoders and, for the decide
 * tier, the engine client and the protections around it (`DECIDE_GATE_JS_SOURCE`
 * in `@intutic/shared-types`), each module in a scope of its own.
 */
const JS_DECIDE_LIB = `// Decide rules, emitted from decide.ts, decideRecord.ts, decideHostGuard.ts,
// decideEngine.ts and decideEvaluate.ts in @intutic/shared-types: the @format
// record, each @decide record checked against the rule it carries, and the
// engine client and protections the decide tier runs.
const intuticDecideLib = (${DECIDE_GATE_JS_SOURCE})(function (text) {
  return require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
});`

/** A JS gate that evaluates decide rules skips each fallback line a decoded record names. */
const JS_DECIDE_FALLBACK_SKIP = `  // A fallback line stands in for a decide rule a gate cannot evaluate. This
  // gate reads the rule from its record, so it skips the line, but only when
  // that record decoded: any other line with the prefix is enforced.
  if (out.decideRules.length > 0) {
    const skip = out.decideRules.map(function (r) { return r.fallbackId; });
    out.rules = out.rules.filter(function (r) {
      return r.id.indexOf('${DECIDE_FALLBACK_PREFIX}') !== 0 || skip.indexOf(r.id) === -1;
    });
  }
`

/** A JS gate that does not evaluate decide rules keeps every fallback line. */
const JS_DECIDE_FALLBACK_KEPT = `  // A fallback line stands in for a decide rule a gate cannot evaluate. This
  // gate evaluates none, so every fallback line stays in force and refuses
  // its rule's tools, as in a gate that reads no @decide records.
`

/**
 * A hold token's rules share one id (`laneHoldPatterns`, `@intutic/shared-types`):
 * a `phrase` rule, which a gate whose classifier predates the token holds
 * by, and for force_push and destroy an `action` rule. A v23 gate classifies
 * every token, so it skips a `phrase` rule that shares its id with an
 * `action` rule and holds by the action rule alone: the partial phrase
 * `git push --force` also matches `--force-with-lease`, which is no force
 * push. One id means one approval releases the call at every gate, old or
 * new.
 */
const JS_SHADOWED_PHRASE_SKIP = `  // A phrase rule that shares its id with an action rule is the partial form a
  // gate older than v23 holds by; this one holds by the action rule.
  {
    const actionIds = out.rules.filter(function (r) { return r.subject === 'action'; }).map(function (r) { return r.id; });
    if (actionIds.length > 0) out.rules = out.rules.filter(function (r) { return r.subject !== 'phrase' || actionIds.indexOf(r.id) === -1; });
  }
`

/** {@link JS_SHADOWED_PHRASE_SKIP} in a bash gate. Fields are cut by expansion: an empty flags column must not shift the subject. */
const SHELL_SHADOWED_PHRASE_SKIP = `  # A phrase rule that shares its id with an action rule is the partial form a
  # gate older than v23 holds by; this one holds by the action rule.
  if [ \${#INTUTIC_DYNAMIC[@]} -gt 0 ]; then
    _intutic_aids=$'\\n'
    for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
      _r="\${_rec#*$'\\t'}"; _r="\${_r#*$'\\t'}"; _r="\${_r#*$'\\t'}"
      if [ "\${_r%%$'\\t'*}" = "action" ]; then _intutic_aids+="\${_rec%%$'\\t'*}"$'\\n'; fi
    done
    if [ "$_intutic_aids" != $'\\n' ]; then
      _intutic_kept=()
      for _rec in "\${INTUTIC_DYNAMIC[@]}"; do
        _r="\${_rec#*$'\\t'}"; _r="\${_r#*$'\\t'}"; _r="\${_r#*$'\\t'}"
        if [ "\${_r%%$'\\t'*}" = "phrase" ]; then
          case "$_intutic_aids" in *$'\\n'"\${_rec%%$'\\t'*}"$'\\n'*) continue ;; esac
        fi
        _intutic_kept+=("$_rec")
      done
      INTUTIC_DYNAMIC=()
      if [ \${#_intutic_kept[@]} -gt 0 ]; then INTUTIC_DYNAMIC=("\${_intutic_kept[@]}"); fi
    fi
  fi

`

/** A JS gate that evaluates rule records skips each fallback line a decoded, enforcing record of those kinds names. */
function jsRuleFallbackSkip(kinds: readonly GateRuleKind[]): string {
  return `  // A <kind>-fallback: line stands in for a rule record a gate cannot
  // evaluate. This gate evaluates ${kinds.join(', ')}, so it skips the line a
  // decoded record of those kinds names; any other fallback line is enforced.
  if (out.gateRecords.length > 0) {
    const kinds = ${JSON.stringify(kinds)};
    const rskip = out.gateRecords.filter(function (r) { return r.fallbackId && kinds.indexOf(r.kind) !== -1; })
      .map(function (r) { return r.fallbackId; });
    out.rules = out.rules.filter(function (r) { return rskip.indexOf(r.id) === -1; });
  }
`
}

/**
 * The shared rule-record ports from `@intutic/shared-types`, in a scope of
 * their own: the test outcome decision and its state
 * ({@link TEST_OUTCOME_JS_SOURCE}), the scope match
 * ({@link SCOPE_MATCH_JS_SOURCE}), the `@rule` decoder
 * ({@link RULE_RECORD_JS_SOURCE}) and the refusal detail
 * ({@link REFUSAL_DETAIL_JS_SOURCE}). The scope match calls the phrase
 * matcher (`PHRASES_JS_SOURCE`), which the classifier emits at the top level
 * of every JS gate; it is read at call time, after both are defined.
 */
const JS_RULE_LIB = `// Rule records, test outcomes, scope matching and refusal detail, emitted
// from @intutic/shared-types (testOutcome.ts, scopeMatch.ts, gateRuleRecord.ts,
// refusalDetail.ts).
const intuticRuleLib = (function () {
${TEST_OUTCOME_JS_SOURCE}
${SCOPE_MATCH_JS_SOURCE}
${RULE_RECORD_JS_SOURCE}
${REFUSAL_DETAIL_JS_SOURCE}
  return { decode: decodeGateRuleRecord, exitCode: extractExitCode, outcome: decideTestOutcome,
    emptyState: emptyOutcomeState, parseState: parseOutcomeState, recordOutcome: recordTestOutcome,
    noteCall: noteCompletedCall, prerequisite: prerequisiteCase, unmetReason: prerequisiteUnmetReason,
    withinScope: isWithinScope, changeTargets: changeTargets, isFileWrite: isFileWriteCall,
    planExempt: isPlanExemptTool, detail: refusalDetailForMode, retryLine: retryScopeLine };
})();`

/**
 * The snapshot loader every JS-family gate embeds, defined once.
 *
 * Extracted from {@link emitJsGate}'s template when the n8n workflow gate
 * arrived: two emitters needing the same loader is exactly the situation that
 * produced the four defects this module's header describes, so the loader is
 * one function both interpolate rather than a block one of them copies. It
 * needs {@link JS_DECIDE_LIB} in scope.
 *
 * Its decide state: `format` (1 without an @format record), and
 * `decideRules`, the records that decoded. Only a gate that evaluates decide
 * rules (`evaluatesDecide`, {@link GATE_EVALUATES_DECIDE}) drops a fallback
 * line, and only when a decoded record names it; any other gate keeps every
 * fallback line in force.
 */
function jsSnapshotLoader(evaluatesDecide: boolean, ruleKinds: readonly GateRuleKind[] = [], skipShadowedPhrases = false): string {
  return `function intuticLoadSnapshot(INTUTIC_WORKSPACE_ID) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const p = process.env.INTUTIC_SNAPSHOT_RULES ||
    path.join(os.homedir(), '.intutic', 'hooks', 'policy-snapshot.rules');
  // mcpAllowlist and mcpRegistry stay null without their records: the
  // workspace set no allowlist and made no registry decision.
  // opaque: an OPAQUE workspace (the @intervention_mode record). Kept on a
  // snapshot that fails its digest: it only ever hides text, never allows.
  const out = { rules: [], digest: 'none', state: 'absent', workspaceId: '', generatedAt: '', ageDays: 0,
    mcpAllowlist: null, mcpRegistry: null, opaque: false, format: 1, decideRules: [], gateRecords: [] };
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return out; }
  out.state = 'ok';
  for (const line of text.split('\\n')) {
    if (line.startsWith('#digest ')) { out.digest = line.slice(8).trim(); continue; }
    if (line.startsWith('#workspace ')) { out.workspaceId = line.slice(11).trim(); continue; }
    if (line.startsWith('#generated ')) { out.generatedAt = line.slice(11).trim(); continue; }
    if (line === '${INTERVENTION_MODE_RECORD_TAG}\\tOPAQUE') { out.opaque = true; continue; }
    if (line.startsWith('${SNAPSHOT_FORMAT_RECORD_TAG}\\t')) {
      const v = intuticDecideLib.format(line);
      if (v !== null) out.format = v;
      continue;
    }
    if (line.startsWith('${DECIDE_RECORD_TAG}\\t')) {
      // A decide rule's record. One that does not decode is skipped, and the
      // rule's fallback line below then stays in force and refuses.
      const rec = intuticDecideLib.record(line);
      if (rec) out.decideRules.push(rec);
      continue;
    }
    if (line.startsWith('${RULE_RECORD_TAG}\\t')) {
${ruleKinds.length > 0
    ? `      // A rule record (gate body v23). One that does not decode is skipped, and
      // its fallback line below stays in force and refuses.
      const rr = intuticRuleLib.decode(line);
      if (rr) out.gateRecords.push(rr);`
    : `      // A rule record (gate body v23). This gate evaluates no kind, so each
      // record's fallback line stays in force and refuses.`}
      continue;
    }
    if (line.startsWith('${MCP_ALLOWLIST_RECORD_TAG}\\t')) {
      // The MCP server allowlist: tag, severity and comma-joined servers, a
      // data line inside the digest. Any severity but shadow refuses.
      const a = line.split('\\t');
      if (a.length === 3) {
        out.mcpAllowlist = { severity: a[1] === 'shadow' ? 'shadow' : 'block', servers: a[2].split(',').filter(Boolean) };
      }
      continue;
    }
    if (line.startsWith('${MCP_REGISTRY_RECORD_TAG}\\t')) {
      // The MCP server registry record: base64 JSON, a data line inside the
      // digest. Read into the shape evaluateMcpRegistry expects; a damaged
      // record is no registry.
      try {
        const r = JSON.parse(Buffer.from(line.slice(${MCP_REGISTRY_RECORD_TAG.length + 1}), 'base64').toString('utf8'));
        const strings = function (v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : []; };
        const disabled = {};
        if (r.disabledTools && typeof r.disabledTools === 'object') {
          for (const k of Object.keys(r.disabledTools)) disabled[k] = strings(r.disabledTools[k]);
        }
        out.mcpRegistry = { defaultPolicy: r.defaultPolicy === 'deny' ? 'deny' : 'allow',
          approvedServers: strings(r.approvedServers), blockedServers: strings(r.blockedServers),
          heldServers: strings(r.heldServers), disabledTools: disabled };
      } catch (e) { out.mcpRegistry = null; }
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\\t');
    if (f.length < 6 || !f[5]) continue;

    let re, seq = null;
    // A snapshot rule that will not compile is dropped, not fatal. The floor
    // above is compiled in and unaffected, so this degrades to "today's
    // behaviour" rather than to "no gate". Flags: i = case-insensitive,
    // s = a sequence rule (see intuticRuleMatches).
    const ic = f[2].indexOf('i') !== -1;
    try {
      re = new RegExp(f[5], ic ? 'i' : '');
      if (f[2].indexOf('s') !== -1) seq = compileSequence(f[5], ic);
    } catch (e) { continue; }
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
    // src: the source as written. A phrase rule reads it, never re.source,
    // which escapes a slash ('api.stripe.com/v1/charges' read back as
    // 'api.stripe.com\\/v1\\/charges' matched nothing).
    out.rules.push({ id: f[0], severity: f[1], subject: f[3] || 'any', re: re, seq: seq, reason: f[4], src: f[5],
      argRe: argRe, argDowngraded: argDowngraded });
  }
${evaluatesDecide ? JS_DECIDE_FALLBACK_SKIP : JS_DECIDE_FALLBACK_KEPT}${ruleKinds.length > 0 ? jsRuleFallbackSkip(ruleKinds) : ''}${skipShadowedPhrases ? JS_SHADOWED_PHRASE_SKIP : ''}
  // Integrity. A digest nobody recomputes is a comment, and a workspace id
  // nobody compares means a snapshot from workspace A dropped onto workspace B's
  // machine is enforced verbatim, with B's events attributing A's rules to B.
  try {
    const body = text.split('\\n').filter(function (l) { return l && l.charAt(0) !== '#'; }).join('\\n');
    const actual = require('crypto').createHash('sha256').update(body).digest('hex').slice(0, 32);
    // A snapshot with no digest line is unverified too: the daemon always
    // writes one, so its absence means the file was edited.
    if (actual !== out.digest) out.state = 'invalid';
  } catch (e) { /* no crypto — leave the digest unverified rather than fail the gate */ }

  if (out.state === 'ok' && out.workspaceId && INTUTIC_WORKSPACE_ID && out.workspaceId !== INTUTIC_WORKSPACE_ID) {
    out.state = 'invalid';
  }
  // Distinct from absent: the writer always ships the destructive tier, so no
  // rules means the compile produced nothing — a fault that otherwise looks
  // exactly like a healthy quiet workspace.
  if (out.state === 'ok' && out.rules.length === 0) out.state = 'empty';

  // Additive tier, so dropping it returns to yesterday's behaviour. The
  // SSO-group refusals are the exception: they only ever refuse, and dropping
  // them would make editing the member's group list in this file a way to
  // clear a tool the workspace's group policy refuses.
  if (out.state === 'invalid') {
    out.rules = out.rules.filter(function (r) { return r.id.indexOf('sso_group.') === 0 && r.severity === 'block'; });
    // Neither MCP record can be vouched for, and a deleted one looks like one
    // never set: the gate admits no MCP server on this snapshot at all.
    out.mcpRegistry = null;
    out.mcpAllowlist = null;
    // The decide and rule records go with the rest of the dynamic tier.
    out.decideRules = [];
    out.gateRecords = [];
  }

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
}

/**
 * A chaos run's side of the JS gates, defined once: the plan, this call's
 * record, and the fault to apply to an allowed call.
 *
 * `intuticChaosBegin` starts a call's record in `intuticGate`; rules that
 * fire without deciding note themselves (`intuticChaosNote`); every refusal
 * and the allow at the end report the decision (`intuticChaosDecide`), which
 * returns the fault due. Nothing here throws: a fault the gate cannot inject
 * or report is said on stderr, and the call is decided as governance decided
 * it.
 */
const JS_CHAOS_HELPERS = `// ── Agent fault injection (intutic chaos run) ───────────────────────────────
// Only when INTUTIC_CHAOS_PLAN is set: a chaos experiment's runner sets it,
// with INTUTIC_CHAOS_EVENTS, in the sandbox the agent runs in, and this gate
// inherits both. Emitted from @intutic/shared-types chaosGate.ts, which
// explains the counter files kept beside the events file. A fault applies only
// to a call this gate allowed: it never turns a refusal or a hold into an allow.
${CHAOS_GATE_JS_SOURCE}

var _intuticChaosState = null;
var _intuticChaosCall = null;

/** The plan, read once per process: { plan, events, error }. */
function intuticChaos() {
  if (_intuticChaosState) return _intuticChaosState;
  var raw = process.env.INTUTIC_CHAOS_PLAN || '', events = process.env.INTUTIC_CHAOS_EVENTS || '';
  var s = { plan: null, events: events, error: null };
  if (raw) {
    var d = chaosGateDecode(raw);
    if (d.error) s.error = d.error;
    else if (!events) s.error = 'INTUTIC_CHAOS_PLAN is set but INTUTIC_CHAOS_EVENTS is not, so nothing the run does could be reported';
    else s.plan = d.plan;
  }
  _intuticChaosState = s;
  return s;
}

/** Starts this call's record, unless the last gate run said more of the same call follows. */
function intuticChaosBegin(toolName) {
  if (_intuticChaosCall && _intuticChaosCall.more) { _intuticChaosCall.more = false; return; }
  _intuticChaosCall = { tool: String(toolName == null ? '' : toolName), ruleId: null, destructive: false, policyHit: false, more: false };
}

/** A rule fired on this call without deciding it (shadow, warn, an approved bypass). */
function intuticChaosNote(ruleId, policyHit) {
  var c = _intuticChaosCall;
  if (!c) return;
  if (ruleId && !c.ruleId) c.ruleId = ruleId;
  if (policyHit) c.policyHit = true;
}

/**
 * Reports this call as the gate decided it, before any fault (allow, deny or
 * hold), and returns the fault to apply to an allowed call, or null. key is
 * the call's digest (intuticChaosKey), which a held call's retry shares.
 */
function intuticChaosDecide(toolName, decision, ruleId, policyHit, key) {
  var c = _intuticChaosCall;
  _intuticChaosCall = null;
  try {
    var s = intuticChaos();
    if (!s.plan) return null;
    return chaosGateCall(require('fs'), s.plan, s.events, {
      tool: c ? c.tool : String(toolName == null ? '' : toolName),
      decision: decision,
      ruleId: ruleId || (c ? c.ruleId : null),
      destructive: !!(c && c.destructive),
      policyHit: !!policyHit || !!(c && c.policyHit),
      key: key || '',
    }, new Date().toISOString());
  } catch (e) {
    try { console.error('[Intutic Governance] chaos: ' + String((e && e.message) || e)); } catch (e2) {}
    return null;
  }
}

/**
 * A call's digest, as an approval hold keys it: sha256 of the normalised tool,
 * command and target, NUL-separated. A held call's identical retry has the
 * same one.
 */
function intuticChaosKey(toolName, command, target) {
  return require('crypto').createHash('sha256')
    .update(intuticNormalise(toolName) + '\\u0000' + intuticNormalise(command) + '\\u0000' + intuticNormalise(target))
    .digest('hex');
}`

/**
 * The rule-record tiers of a JS gate, emitted once per gate: the
 * `requires_outcome` check and its state, the trajectory check
 * (`scope_paths`, `plan_approval`) and the post-tool recorder
 * (`intuticRecordOutcome`). Needs {@link JS_RULE_LIB} and the classifier in
 * scope.
 */
function jsRuleTiers(harness: HookGateHarness): string {
  return `// ── Rule records (gate body v23) ─────────────────────────────────────────────
// The @rule records' tiers: requires_outcome among the deterministic refusals,
// scope_paths and plan_approval after the holds (the trajectory tier), and
// the post-tool recorder a writer calls with a tool's result. A record
// stamped shadow records its finding and refuses nothing.
const INTUTIC_HARNESS = ${JSON.stringify(harness)};
// Whether this harness's post-tool payload was captured and carries an exit
// code or an error flag (POST_TOOL_OBSERVABLE in gateBody.ts).
const INTUTIC_POST_OBSERVABLE = ${POST_TOOL_OBSERVABLE[harness] ? 'true' : 'false'};
// The working directory of the call, when the writer knows it (cwd in the
// payload); the process's otherwise.
var _intuticCallCwd = null;

/** ~/.intutic/hooks/state/outcomes/<sha256(harness NUL session)[:32]>.json */
function intuticOutcomeStatePath(sessionId) {
  var path = require('path'), os = require('os');
  var base = process.env.INTUTIC_OUTCOME_STATE_DIR || path.join(os.homedir(), '.intutic', 'hooks', 'state', 'outcomes');
  var h = require('crypto').createHash('sha256').update(INTUTIC_HARNESS + '\\u0000' + String(sessionId), 'utf8').digest('hex').slice(0, 32);
  return path.join(base, h + '.json');
}

/** { exists, state }: a missing file is an empty state; one that does not read is null, which leaves every rule unmet. */
function intuticOutcomeStateRead(file) {
  var fs = require('fs');
  if (!fs.existsSync(file)) return { exists: false, state: intuticRuleLib.emptyState() };
  try { return { exists: true, state: intuticRuleLib.parseState(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { exists: true, state: null }; }
}

/** Written atomically; a write that fails changes no decision. */
function intuticOutcomeStateWrite(file, state) {
  try {
    var fs = require('fs'), path = require('path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch (e) {}
}

/** Why a qualified prerequisite is not met (the shared reason), or null when it is. */
function intuticOutcomeUnmet(r, sessionId, state) {
  var c, why = null;
  if (!INTUTIC_POST_OBSERVABLE) c = 'not_observable';
  else if (!sessionId) c = 'no_session';
  else { var got = intuticRuleLib.prerequisite(state, r.first, r.adjacent, Date.now()); c = got.case; why = got.why; }
  return c === 'met' ? null : intuticRuleLib.unmetReason(r.first, r.then, c, why, INTUTIC_HARNESS);
}

/** A rule record's finding; scope is where the refusal applies (§6.2). */
function intuticRuleVerdict(r, code, ruleId, reason, scope) {
  return { verdict: r.rollout === 'enforce' ? 'block' : 'shadow', code: code, ruleId: ruleId, reason: reason, scope: scope };
}

/**
 * The requires_outcome tier: a call whose action token (or tool name) a
 * qualified requires_before gates, unless this session's last test run
 * passed and nothing changed since. Then the session's bookkeeping: a call
 * that changes files (a mutation tool, or a shell write such as sed -i or
 * git checkout: isFileWriteCall, Q1) marks a passing run stale, and every
 * call ends adjacency for ~> rules.
 */
function intuticOutcomeTier(snap, toolName, nActions, toolInput, sessionId) {
  var recs = snap.gateRecords.filter(function (r) { return r.kind === 'requires_outcome'; });
  var file = sessionId ? intuticOutcomeStatePath(sessionId) : null;
  var read = file ? intuticOutcomeStateRead(file) : { exists: false, state: intuticRuleLib.emptyState() };
  var shadow = null;
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (nActions.indexOf(' ' + r.then + ' ') === -1 && String(r.then).toLowerCase() !== String(toolName).toLowerCase()) continue;
    var why = intuticOutcomeUnmet(r, sessionId, read.state);
    if (why === null) continue;
    var v = intuticRuleVerdict(r, 'PREREQUISITE_UNMET', 'requires_before.' + r.first + '[ok]' + (r.adjacent ? '~>' : '->') + r.then,
      why, { tools: [r.then], step: r.first });
    if (v.verdict === 'block') return v;
    if (!shadow) shadow = v;
  }
  if (file && read.exists && read.state) {
    intuticOutcomeStateWrite(file, intuticRuleLib.noteCall(read.state, intuticRuleLib.isFileWrite(toolName, toolInput)));
  }
  return shadow;
}

/**
 * Records a tool's result, from the writer's post-tool handler: a shell call
 * that ran tests records its outcome for the session; a call that changed
 * files marks an earlier passing run stale. result: { exitCode?, isError?,
 * output? }. Never throws and never refuses.
 */
function intuticRecordOutcome(sessionId, toolName, toolInput, result) {
  if (!INTUTIC_POST_OBSERVABLE || !sessionId) return;
  try {
    var input = toolInput && typeof toolInput === 'object' ? toolInput : {};
    var command = String(input.command || input.cmd || input.script || input.shell_command || '');
    var actions = intuticActions(toolName, command);
    var file = intuticOutcomeStatePath(sessionId);
    var read = intuticOutcomeStateRead(file);
    if (actions.indexOf(' action:run_tests ') !== -1) {
      var output = String(result && result.output != null ? result.output : '');
      var exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : intuticRuleLib.exitCode(output);
      var d = intuticRuleLib.outcome({ exitCode: exitCode, isError: result ? result.isError : null, output: output });
      intuticOutcomeStateWrite(file, intuticRuleLib.recordOutcome(read.state || intuticRuleLib.emptyState(), 'action:run_tests', d, Date.now()));
    } else if (read.exists && read.state && intuticRuleLib.isFileWrite(toolName, input)) {
      intuticOutcomeStateWrite(file, intuticRuleLib.noteCall(read.state, true));
    }
  } catch (e) {}
}

/** The real path of p, resolving its deepest existing ancestor when p does not exist yet. */
function intuticRealPath(p) {
  var fs = require('fs'), path = require('path');
  var abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch (e) {}
  var rest = [], dir = abs;
  for (;;) {
    var parent = path.dirname(dir);
    rest.unshift(path.basename(dir));
    if (parent === dir) return abs;
    dir = parent;
    try { return path.join.apply(path, [fs.realpathSync(dir)].concat(rest)); } catch (e) {}
  }
}

/** The workspace root of a call: its cwd walked up to the nearest .git, else the cwd. */
function intuticRepoRoot(cwd) {
  var fs = require('fs'), path = require('path');
  var d = intuticRealPath(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    var parent = path.dirname(d);
    if (parent === d) return intuticRealPath(cwd);
    d = parent;
  }
}

/**
 * The session's approved plan from the daemon's cache, { tools }, or null:
 * missing, past its #expires, failing its digest or workspace check, or no
 * APPROVED or EXECUTING plan for the session.
 */
function intuticApprovedPlan(sessionId, workspaceId) {
  var fs = require('fs'), os = require('os'), path = require('path');
  var file = process.env.INTUTIC_APPROVED_PLANS || path.join(os.homedir(), '.intutic', 'hooks', ${JSON.stringify(APPROVED_PLANS_FILE)});
  var raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  var digest = '', ws = '', expires = '', body = [];
  raw.split('\\n').forEach(function (line) {
    if (line.indexOf('#digest ') === 0) digest = line.slice(8).trim();
    else if (line.indexOf('#workspace ') === 0) ws = line.slice(11).trim();
    else if (line.indexOf('#expires ') === 0) expires = line.slice(9).trim();
    else if (line && line.charAt(0) !== '#') body.push(line);
  });
  if (require('crypto').createHash('sha256').update(body.join('\\n')).digest('hex').slice(0, 32) !== digest) return null;
  if (ws && workspaceId && ws !== workspaceId) return null;
  var exp = Date.parse(expires);
  if (!exp || isNaN(exp) || Date.now() >= exp) return null;
  var tools = null;
  for (var i = 0; i < body.length; i++) {
    var e;
    try { e = JSON.parse(body[i]); } catch (x) { continue; }
    if (!e || e.sessionId !== sessionId || (e.state !== 'APPROVED' && e.state !== 'EXECUTING')) continue;
    tools = (tools || []).concat((Array.isArray(e.tools) ? e.tools : [])
      .filter(function (t) { return typeof t === 'string'; }).map(function (t) { return t.toLowerCase(); }));
  }
  return tools === null ? null : { tools: tools };
}

/**
 * The trajectory tier: a file change outside the union of scope_paths
 * (OUT_OF_SCOPE), and under plan_approval a call before the session's plan is
 * approved (PLAN_NOT_APPROVED) or, strict, off its steps (OFF_PLAN).
 */
function intuticTrajectoryTier(snap, toolName, toolInput, sessionId, workspaceId) {
  var path = require('path');
  var shadow = null;
  var scopes = snap.gateRecords.filter(function (r) { return r.kind === 'scope_paths'; });
  var targets = scopes.length > 0 ? intuticRuleLib.changeTargets(toolName, toolInput).map(function (t) { return t.target; }) : [];
  if (targets.length > 0) {
    var cwd = _intuticCallCwd || process.cwd();
    var root = intuticRepoRoot(cwd);
    var rels = targets.map(function (t) {
      var rel = path.relative(root, intuticRealPath(path.resolve(intuticRealPath(cwd), t)));
      var outside = rel === '..' || rel.indexOf('..' + path.sep) === 0 || path.isAbsolute(rel);
      return { t: t, rel: outside ? null : rel.split(path.sep).join('/') };
    });
    var rollouts = ['enforce', 'shadow'];
    for (var k = 0; k < rollouts.length; k++) {
      var group = scopes.filter(function (r) { return r.rollout === rollouts[k]; });
      if (group.length === 0) continue;
      var union = [];
      group.forEach(function (r) { union = union.concat(r.scopePaths); });
      var bad = rels.filter(function (x) { return x.rel === null || !intuticRuleLib.withinScope(x.rel, union); })
        .map(function (x) { return x.t; });
      if (bad.length === 0) continue;
      var v = intuticRuleVerdict(group[0], 'OUT_OF_SCOPE', 'scope_paths.' + group[0].sopTitle,
        bad.join(', ') + ' is outside scope_paths (' + union.join(', ') + ')', { paths: bad });
      if (v.verdict === 'block') return v;
      if (!shadow) shadow = v;
    }
  }
  var plans = snap.gateRecords.filter(function (r) { return r.kind === 'plan_approval'; });
  if (plans.length > 0 && !intuticRuleLib.planExempt(String(toolName))) {
    var prolls = ['enforce', 'shadow'];
    for (var j = 0; j < prolls.length; j++) {
      var pg = plans.filter(function (r) { return r.rollout === prolls[j]; });
      if (pg.length === 0) continue;
      var strict = pg.filter(function (r) { return r.mode === 'strict'; });
      var r = strict.length > 0 ? strict[0] : pg[0];
      var level = r.mode;
      var rid = 'plan_approval.' + r.sopTitle;
      var pscope = { tools: [String(toolName)] };
      var pv = null;
      if (!sessionId) {
        pv = intuticRuleVerdict(r, 'PLAN_NOT_APPROVED', rid, 'plan_approval: ' + level + ' - ' + INTUTIC_HARNESS + ' sent no session id, so no approved plan can be found for this call', pscope);
      } else {
        var plan = intuticApprovedPlan(sessionId, workspaceId);
        if (plan === null) {
          pv = intuticRuleVerdict(r, 'PLAN_NOT_APPROVED', rid, 'plan_approval: ' + level + ' - this session has no APPROVED or EXECUTING plan; get its plan approved, then retry', pscope);
        } else if (level === 'strict' && plan.tools.indexOf(String(toolName).toLowerCase()) === -1) {
          pv = intuticRuleVerdict(r, 'OFF_PLAN', rid, 'plan_approval: strict - ' + String(toolName) + ' is not a step of the approved plan', pscope);
        }
      }
      if (pv && pv.verdict === 'block') return pv;
      if (pv && !shadow) shadow = pv;
    }
  }
  return shadow;
}
`
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
  const deadlineMs = gateDeadlineMs(opts.harness)
  // The most the decide tier spends on a call (decideBudgetMs in gateLimits.ts).
  const decideBudget = decideBudgetMs('js', opts.harness)
  const ask: AskContract = opts.ask ?? 'none'

  /**
   * Asks a person through this harness's {@link AskContract}, for a `reason`
   * in scope. Exactly the documented fields: a harness that reads a decision
   * object may reject one with fields it does not know.
   */
  const askWith = (): string => {
    switch (ask) {
      case 'claude-pretooluse':
        return (
          `    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) + '\\n');\n` +
          `    process.exit(0);`
        )
      case 'copilot-decision':
        // The Copilot CLI reads the decision at the top level, VS Code under
        // hookSpecificOutput.
        return (
          `    process.stdout.write(JSON.stringify({ permissionDecision: 'ask', permissionDecisionReason: reason,\n` +
          `      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) + '\\n');\n` +
          `    process.exit(0);`
        )
      case 'cursor-permission':
        return (
          `    process.stdout.write(JSON.stringify({ permission: 'ask', user_message: reason, agent_message: reason }) + '\\n');\n` +
          `    process.exit(0);`
        )
      case 'antigravity-force-ask':
        return `    process.stdout.write(JSON.stringify({ decision: 'force_ask', reason: reason }) + '\\n');\n    process.exit(0);`
      case 'throw-ask':
        return (
          `    var _ask = new Error('[Intutic Governance] ASK: ' + reason);\n` +
          `    _ask.intuticAsk = { reason: reason, ruleId: snap.opaque ? null : dec.ruleId };\n` +
          `    throw _ask;`
        )
      default:
        throw new Error(`gateBody: the ${ask} ask contract is not one a JavaScript gate speaks`)
    }
  }

  /**
   * The refusal, through this harness's contract, for a `reason` in scope.
   * `code` and `ruleId` are JavaScript expressions: a JSON decision carries
   * them ({@link HOOK_REFUSAL_CODES}), and `extra` adds fields such as `holdId`.
   */
  const refuseWith = (code: string, ruleId: string, extra = '', tool = 'toolName', shownRuleId = ruleId) => {
    // The decision names shownRuleId: the deciding rule, or null where an
    // OPAQUE workspace hides it. A chaos run's record keeps the rule.
    const fields = `code: ${code}, ruleId: ${shownRuleId}${extra ? `, ${extra}` : ''}`
    // A chaos run's record of the refusal, first: every contract below ends
    // the call. A refusal a rule decided is a policy hit.
    const chaos = `      intuticChaosDecide(${tool}, '${code === "'HELD'" ? 'hold' : 'deny'}', ${ruleId}, ${ruleId} != null);\n`
    if (opts.contract === 'stdout-decision-deny' && opts.documentedFieldsOnly) {
      return (
        chaos +
        `      process.stdout.write(JSON.stringify({ decision: 'deny', reason: reason + ' (refusal code ' + ${code} + ')' }) + '\\n');\n` +
        `      process.exit(0);`
      )
    }
    return chaos + (opts.contract === 'stdout-cancel'
      // Cline shows a cancel's `errorMessage`; it has no `reason` field.
      ? `      process.stdout.write(JSON.stringify({ cancel: true, errorMessage: reason, ${fields} }) + '\\n');\n` +
          `      process.exit(0);`
      : opts.contract === 'stdout-decision-deny'
        ? `      process.stdout.write(JSON.stringify({ decision: 'deny', reason: reason, ${fields} }) + '\\n');\n` +
          `      process.exit(0);`
        : opts.contract === 'throw'
          // The envelope guard's reason already carries the prefix; a rule's
          // reason does not. One message shape either way.
          ? `      throw new Error(String(reason).indexOf('[Intutic Governance]') === 0 ? String(reason) : '[Intutic Governance] BLOCKED: ' + reason);`
          : `      process.exit(2);`)
  }

  /**
   * A fault a chaos run injects into an allowed call, for a `reason` in scope:
   * the fault's own text with the plan's canary, through this harness's
   * contract. Not a refusal by governance, so a JSON decision carries
   * `code: null`, or `HELD` for a call a permission fault holds (whose
   * reason already starts `[Intutic Governance] HELD:`, as a hold's does);
   * the in-process contracts prefix a refusal's text so the host's wrapper
   * passes it on as it is rather than as a gate fault.
   */
  const refuseFault = (code: 'null' | "'HELD'") =>
    `      try { console.error(reason); } catch (e) {}\n` +
    (opts.contract === 'stdout-cancel'
      ? `      process.stdout.write(JSON.stringify({ cancel: true, errorMessage: reason, code: ${code}, ruleId: null }) + '\\n');\n` +
        `      process.exit(0);`
      : opts.contract === 'stdout-decision-deny'
        ? `      process.stdout.write(JSON.stringify(${opts.documentedFieldsOnly ? `{ decision: 'deny', reason: reason${code === 'null' ? '' : ` + ' (refusal code HELD)'`} }` : `{ decision: 'deny', reason: reason, code: ${code}, ruleId: null }`}) + '\\n');\n` +
          `      process.exit(0);`
        : opts.contract === 'throw'
          ? `      throw new Error(${code === 'null' ? `'[Intutic Governance] ' + reason` : 'reason'});`
          : `      process.exit(2);`)

  /** An exit-code harness's retry-scope line (§6.2), after the reason; none in OPAQUE. */
  const retryScopeStderr =
    `    const _retry = intuticRuleLib.retryLine(_mode, v.scope);\n` +
    `    if (_retry) { try { console.error(_retry); } catch (e) {} }\n`

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

${JS_DECIDE_LIB}

${JS_RULE_LIB}

${jsSnapshotLoader(GATE_EVALUATES_DECIDE.js, (Object.keys(GATE_EVALUATES_RULE_RECORDS.js) as GateRuleKind[]).filter((k) => GATE_EVALUATES_RULE_RECORDS.js[k]), true)}

${jsHoldHelpers(opts.reviewRequestFile)}

${jsRuleTiers(opts.harness)}

${JS_CHAOS_HELPERS}

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
${refuseWith("'UNREADABLE_CALL'", 'null', '', "'unknown'")}
}

/**
 * The refusal code of a matched block rule: SSO_GROUP for the group policy's
 * rules, BUILT_IN_RULE for this gate's compiled floor, SNAPSHOT for the rest
 * of the policy snapshot.
 */
function intuticRuleCode(rule) {
  if (rule.id.indexOf('sso_group.') === 0) return 'SSO_GROUP';
  return INTUTIC_FLOOR.indexOf(rule) !== -1 ? 'BUILT_IN_RULE' : 'SNAPSHOT';
}

// The MCP server registry and allowlist decisions, emitted from
// @intutic/shared-types mcpRegistryRecord.ts: the registry decision is the
// function the MCP proxy runs.
${MCP_REGISTRY_JS_SOURCE}

${MCP_ALLOWLIST_JS_SOURCE}

${MCP_SNAPSHOT_UNVERIFIED_JS_SOURCE}

/**
 * Evaluates one tool call's deterministic tiers: returns the call's tool name
 * (as the rules read it) and the snapshot to allow; refuses via this
 * harness's contract otherwise. {@link intuticGateWithDecide} and
 * {@link intuticGate} run it first.
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
function intuticGateDeterministic(toolName, target, command, record, workspaceId, toolInput, sessionId) {
  // A chaos run's record of this call (see intuticChaosDecide). A plan that is
  // set but unreadable refuses, as an unreadable payload does: an experiment
  // run without the faults it asked for reports a resilience it never measured.
  intuticChaosBegin(toolName);
  var _chaos = intuticChaos();
  if (_chaos.error) {
    var reason = _chaos.error + ' — refusing the call rather than running the experiment without the faults it asked for';
    try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
    try { record('tool_blocked', toolName, reason); } catch (e) {}
${refuseWith("'GATE_CRASHED'", 'null')}
  }
  // Too large to evaluate inside the hook timeout (gateLimits.ts in
  // @intutic/shared-types): refused before any rule reads the call.
  var _commandBytes = Buffer.byteLength(String(command == null ? '' : command), 'utf8');
  var _argumentBytes = 0;
  try { _argumentBytes = Buffer.byteLength(JSON.stringify(toolInput == null ? {} : toolInput) || '', 'utf8'); } catch (e) {}
  if (_commandBytes > ${COMMAND_SIZE_LIMIT} || _argumentBytes > ${ARGUMENTS_SIZE_LIMIT}) {
    var reason = 'COMMAND_TOO_LARGE — ' + (_commandBytes > ${COMMAND_SIZE_LIMIT}
      ? 'the command is ' + _commandBytes + ' bytes, over the ${COMMAND_SIZE_LIMIT}-byte limit a gate evaluates; split it into smaller commands'
      : 'the tool arguments are ' + _argumentBytes + ' bytes, over the ${ARGUMENTS_SIZE_LIMIT}-byte limit a gate evaluates; write the content in smaller parts');
    try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
    try { record('tool_blocked', toolName, reason); } catch (e) {}
${refuseWith("'COMMAND_TOO_LARGE'", 'null')}
  }
  // The rules run under a deadline that interrupts even a regex mid-match,
  // inside the hook timeout ${opts.harness} applies (gateLimits.ts in
  // @intutic/shared-types), which most harnesses read as an allow. A call
  // still undecided then is refused. Built-in rules are linear; a workspace's
  // own WHERE pattern need not be.
${
  opts.contract === 'throw'
    ? `  // In process, the deadline runs from the start of this call: the process
  // started long before it. Pi and OpenCode await the hook with no time limit,
  // and OpenClaw's hook timeout cannot interrupt synchronous code, so without
  // this a slow WHERE pattern holds the agent.
  var _deadlineMs = ${deadlineMs};`
    : `  // A hook process runs one call, so the deadline runs from process start.
  var _deadlineMs = Math.max(1, ${deadlineMs} - Math.round(process.uptime() * 1000));`
}
  globalThis.__intuticGateRules = function () {
    return _intuticGateRules(toolName, target, command, record, workspaceId, toolInput, sessionId);
  };
  try {
    return require('vm').runInThisContext('__intuticGateRules()', { timeout: _deadlineMs });
  } catch (err) {
    if (!err || err.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err;
    var reason = 'GATE_DEADLINE — the gate did not finish evaluating this call within ${deadlineMs / 1000} s, and refuses it rather than let the hook timeout allow it';
    try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
    try { record('tool_blocked', toolName, reason); } catch (e) {}
${refuseWith("'GATE_DEADLINE'", 'null')}
  }
}

/**
 * Every tier allowed the call. A writer that runs the gate once per target of
 * one call (OpenClaw's apply_patch) passes more for all but the last, so the
 * call is reported, and faulted, once.
 */
function intuticGateAllowed(toolName, target, command, more) {
  if (more) {
    if (_intuticChaosCall) _intuticChaosCall.more = true;
    return;
  }
  var _fault = intuticChaosDecide(toolName, 'allow', null, false, intuticChaos().plan ? intuticChaosKey(toolName, command, target) : '');
  if (!_fault) return;
  // A permission delay never waits here: the call is held, and its identical
  // retry passes, or is denied, once the delay has passed.
  if (_fault.kind === 'hold') {
    var reason = '[Intutic Governance] HELD: ' + _fault.reason;
${refuseFault("'HELD'")}
  }
  var reason = _fault.reason;
${refuseFault('null')}
}

// ── Decide tier (gate body v22) ──────────────────────────────────────────────
// After every deterministic tier allowed the call, and only then: the
// snapshot's decide rules on this tool, asked of the self-hosted engine
// (~/.intutic/decide/engine.json, INTUTIC_DECIDE_* in the environment) within
// ${decideBudget} ms, less what the deadline has left. A rule refuses, asks a person
// or allows; an engine that cannot answer refuses an enforcing rule
// (GOVERNANCE_UNAVAILABLE) and lets a shadow rule's call on. A rule whose
// estimate (the engine's per-call p95 \`intutic doctor\` stored) does not fit
// the time left is not asked: an enforcing one escalates.

/**
 * The engine, its URL, the canary cache and the stored p95, read for each call
 * that needs them, and the resolved configuration (cfg) for the decide log.
 */
function intuticDecideDeps() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = path.join(os.homedir(), '.intutic', 'decide');
  var engine, url = '', q95 = null, parallel = 1, resolved = null;
  try {
    var file = null;
    try { file = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')); } catch (e) {
      if (!e || e.code !== 'ENOENT') throw new intuticDecideLib.EngineError('not_configured', 'engine.json does not read: ' + String((e && e.message) || e));
    }
    q95 = intuticDecideLib.storedQ95(file);
    var cfg = intuticDecideLib.resolveConfig(file, process.env);
    resolved = cfg;
    url = cfg.url;
    parallel = cfg.parallel;
    engine = intuticDecideLib.createEngine(cfg);
  } catch (e) {
    engine = e instanceof intuticDecideLib.EngineError ? e : new intuticDecideLib.EngineError('not_configured', String((e && e.message) || e));
  }
  return { engine: engine, engineUrl: url, canary: intuticDecideLib.canaryStore(path.join(dir, 'canary.json'), fs),
    sha256Hex: function (t) { return require('crypto').createHash('sha256').update(t, 'utf8').digest('hex'); },
    q95Ms: q95, parallel: parallel, cfg: resolved };
}

// The patterns the decide log's arguments excerpt is redacted with
// (decideLogRedactionSources in @intutic/shared-types).
const INTUTIC_DECIDE_REDACT = ${JSON.stringify(decideLogRedactionSources())};

/**
 * Appends this call's decide record to ~/.intutic/logs/decide-<date>.jsonl and
 * updates each rule's drift stats, as \`intutic decide check\` does for the
 * shell gates. Never throws: a log that cannot be written never changes the
 * decision.
 */
function intuticDecideLog(ev, rules, call, deps) {
  try {
    const fs = require('fs'), os = require('os'), crypto = require('crypto');
    intuticDecideLib.writeLog(ev, rules, { atMs: Date.now(), harness: ${JSON.stringify(opts.harness)},
      workspaceId: call.workspaceId || '', sessionId: call.sessionId || '', tool: call.tool, toolInput: call.toolInput,
      cwd: call.cwd, budgetMs: call.budgetMs, latencyMs: Date.now() - call.startedMs,
      engine: intuticDecideLib.logEngine(deps.cfg, ev), redact: INTUTIC_DECIDE_REDACT },
      intuticDecideLib.logDeps(fs, os.homedir(), function (t) { return crypto.createHash('sha256').update(t, 'utf8').digest('hex'); }));
  } catch (e) {}
}

/**
 * The decide tier's decision on a call the deterministic tiers allowed:
 * { outcome, code, ruleId, via, reason }, or null when no decide rule names
 * the tool. Records each shadow rule's finding. Never throws: a tier that
 * cannot finish is unavailable, which refuses unless every rule on the tool
 * is stamped shadow.
 */
async function intuticDecideTier(toolName, toolInput, snap, record, startedMs, opts, workspaceId, sessionId) {
  const rules = snap.decideRules.filter(function (r) { return r.ir.on === 'tool_call' && (r.ir.tools || []).indexOf(toolName) !== -1; });
  if (rules.length === 0) return null;
${
  opts.contract === 'throw'
    ? `  var _elapsed = Date.now() - startedMs;`
    : `  var _elapsed = Math.round(process.uptime() * 1000);`
}
  var _budget = Math.min(${decideBudget}, ${deadlineMs} - _elapsed - ${DECIDE_BUDGET_MARGIN_MS});
  if (_budget < ${DECIDE_MIN_CALL_MS}) {
    return intuticDecideLib.unavailable(rules, toolName, 'no time was left for the decide rules on ' + toolName + ' within the gate deadline');
  }
  var _timer = null, ev = null, _asked = Date.now();
  var _call = { tool: toolName, toolInput: toolInput == null ? {} : toolInput, cwd: (opts && opts.cwd) || process.cwd(),
    budgetMs: _budget, startedMs: _asked, workspaceId: workspaceId, sessionId: sessionId };
  var _deps = null;
  try {
    _deps = intuticDecideDeps();
    ev = await Promise.race([
      intuticDecideLib.evaluate({ deterministic: 'allow', tool: toolName, toolInput: _call.toolInput,
        cwd: _call.cwd, lastUserTurn: (opts && opts.lastUserTurn) || null, rules: rules,
        deadlineMs: _asked + _budget }, _deps),
      new Promise(function (resolve) { _timer = setTimeout(function () { resolve(null); }, _budget + ${DECIDE_BUDGET_MARGIN_MS / 2}); }),
    ]);
  } catch (e) {
    ev = null;
  } finally {
    if (_timer) clearTimeout(_timer);
  }
  if (!ev) return intuticDecideLib.unavailable(rules, toolName, 'the decide rules on ' + toolName + ' were not evaluated within ' + _budget + ' ms');
  intuticDecideLog(ev, rules, _call, _deps);
  for (const f of intuticDecideLib.shadowFindings(ev, rules)) {
    try { record('tool_would_block', toolName, f.reason + ' [' + f.ruleId + ']'); } catch (e) {}
  }
  return intuticDecideLib.decision(ev, rules);
}

/**
 * Acts on a decide decision that is not an allow: asks a person through this
 * harness's ask where it has one and the call can ask (\`canAsk\`), and
 * otherwise refuses, an escalation with DECIDE_ESCALATED.
 */
function intuticDecideAct(dec, toolName, snap, record, canAsk) {
  var _full = dec.reason + (dec.ruleId ? ' [' + dec.ruleId + ']' : '');
${
  ask === 'none'
    ? `  // ${opts.harness} cannot ask a person on this path, so an escalation refuses.`
    : `  if (dec.outcome === 'escalate' && canAsk) {
    var reason = intuticShown(snap, _full);
    try { console.error('[Intutic Governance] ASK: ' + reason); } catch (e) {}
    try { record('tool_flagged', toolName, 'DECIDE_ESCALATED — asked a person: ' + _full); } catch (e) {}
    intuticChaosDecide(toolName, 'hold', dec.ruleId, dec.ruleId != null);
${askWith()}
  }`
}
  var reason = intuticShown(snap, _full);
  try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
  try { record('tool_blocked', toolName, _full); } catch (e) {}
${refuseWith('dec.code', 'dec.ruleId', '', 'toolName', '(snap.opaque ? null : dec.ruleId)')}
}

/**
 * Evaluates one tool call: the deterministic tiers, then the decide tier.
 * Resolves to allow; refuses, or asks, via this harness's contracts.
 * \`opts\`: \`more\` (as {@link intuticGateAllowed}), \`canAsk\` (false where
 * this call's hook cannot ask), \`cwd\`, \`lastUserTurn\`, and \`before\`, the
 * writer's own deterministic checks, run after the shared ones and before
 * any engine call.
 */
async function intuticGateWithDecide(toolName, target, command, record, workspaceId, toolInput, sessionId, opts) {
  opts = opts || {};
  var _started = Date.now();
  _intuticCallCwd = opts.cwd || null;
  var _d = intuticGateDeterministic(toolName, target, command, record, workspaceId, toolInput, sessionId);
  if (typeof opts.before === 'function') opts.before();
  var _dec = await intuticDecideTier(_d.toolName, toolInput, _d.snap, record, _started, opts, workspaceId, sessionId);
  if (_dec && _dec.outcome !== 'allow') intuticDecideAct(_dec, _d.toolName, _d.snap, record, opts.canAsk !== false);
  intuticGateAllowed(toolName, target, command, opts.more);
}

/**
 * The deterministic tiers alone, synchronously. It cannot ask the decide
 * engine, so a call a decide rule names is refused here, unless every such
 * rule is stamped shadow: a caller that has not moved to
 * {@link intuticGateWithDecide} never opens what the rule's skipped fallback
 * line would have refused. \`more\` as {@link intuticGateAllowed}.
 */
function intuticGate(toolName, target, command, record, workspaceId, toolInput, sessionId, more) {
  _intuticCallCwd = null;
  var _d = intuticGateDeterministic(toolName, target, command, record, workspaceId, toolInput, sessionId);
  if (!more) {
    var _dec = intuticDecideLib.unavailable(_d.snap.decideRules, _d.toolName, 'this gate entry cannot evaluate the decide rules on ' + _d.toolName);
    if (_dec.outcome !== 'allow') intuticDecideAct(_dec, _d.toolName, _d.snap, record, false);
  }
  intuticGateAllowed(toolName, target, command, more);
}

/**
 * The subjects of this call a rule matches, before its argument condition:
 * for a phrase rule, the command when its phrases are in it. The context c
 * holds the call's subject strings, and the phrase matcher's words once
 * computed.
 */
function intuticRuleSubjects(rule, c) {
  // A phrase rule's source is |-separated phrases matched as words against
  // the raw command — never as a regex, which backtracks on crafted input.
  if (rule.subject === 'phrase') {
    if (c.words === null) c.words = phraseText(c.command);
    return intuticPhraseRule(rule.src != null ? rule.src : rule.re.source, c.words) ? [c.nCommand] : [];
  }
  // Each field is tested separately rather than concatenated — joining them
  // lets a pattern match across the seam between two innocuous values.
  const subjects =
    rule.subject === 'tool' ? [c.nTool]
    : rule.subject === 'command' ? [c.nCommand]
    : rule.subject === 'target' ? [c.nTarget]
    // The serialized tool input, un-normalised: a content rule (the
    // secrets.* floor) matches the bytes a Write would put on disk. The
    // same string the WHERE argPattern machinery tests, so the two content
    // subjects cannot drift.
    : rule.subject === 'content' ? [c.toolInputJson]
    : rule.subject === 'action' ? [c.nActions]
    : [c.nCommand, c.nTarget];
  return subjects.filter(function (subject) { return intuticRuleMatches(rule, subject); });
}

function _intuticGateRules(toolName, target, command, record, workspaceId, toolInput, sessionId) {
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
        ? 'Policy snapshot failed its digest or workspace check — dynamic rules dropped except SSO-group refusals, and every MCP call refused'
        : snap.state === 'empty'
          ? 'Policy snapshot contains no rules — the compile produced nothing'
          : 'Policy snapshot is ' + snap.ageDays + ' days old and still enforced';
    try { record('snapshot_' + snap.state, toolName, _msg); } catch (e) {}
  }
  if (snap.format > ${GATE_READS_FORMAT}) {
    try { record('snapshot_format_newer', toolName, ${JSON.stringify(FORMAT_NEWER_MESSAGE)}.replace('{n}', String(snap.format))); } catch (e) {}
  }
  // A chaos run's no_destructive_attempt probe reads every destructive.* rule,
  // the ones the escape hatch skips below included.
  const _chaosDestructive = intuticChaos().plan
    ? snap.rules.filter(function (r) { return r.id.indexOf('destructive.') === 0; })
    : [];
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
  // The space-padded action tokens the command classifies to, for \`action\`
  // subject rules (" action:deploy ").
  const nActions = intuticActions(toolName, command);
  const ctx = { command: command, words: null, nCommand: nCommand, nTarget: nTarget, nTool: nTool,
    toolInputJson: toolInputJson, nActions: nActions };
  for (const rule of _chaosDestructive) {
    // A rule whose argument condition did not compile fires name-only, as below.
    if (intuticRuleSubjects(rule, ctx).length > 0 && (rule.argDowngraded || !rule.argRe || rule.argRe.test(toolInputJson))) {
      if (_intuticChaosCall) _intuticChaosCall.destructive = true;
      break;
    }
  }
  const rules = INTUTIC_FLOOR.concat(snap.rules);
  // A rule record's verdict (gate body v23): shadow records the finding,
  // block refuses through this harness's contract.
  const _intuticRuleAct = function (v) {
    if (!v) return;
    if (v.verdict === 'shadow') {
      intuticChaosNote(v.ruleId, false);
      try { record('tool_would_block', toolName, v.reason + ' [' + v.ruleId + ']'); } catch (e) {}
      return;
    }
    const _full = v.reason + ' [' + v.ruleId + ']';
    const reason = intuticShown(snap, _full);
    // Where the refusal applies: bounded, and dropped in an
    // OPAQUE workspace, as the rule is.
    const _mode = snap.opaque ? 'OPAQUE' : 'TRANSPARENT';
    const _detail = intuticRuleLib.detail(_mode, v.scope, null);
    try { console.error('[Intutic Governance] BLOCKED: ' + reason + ' (refusal code ' + v.code + ')'); } catch (e) {}
${opts.contract === 'exit2' ? retryScopeStderr : ''}    try { record('tool_blocked', toolName, _full); } catch (e) {}
${refuseWith('v.code', 'v.ruleId', 'scope: _detail.scope, evidence: _detail.evidence', 'toolName', '(snap.opaque ? null : v.ruleId)')}
  };
  // The tier order (gate body v23): every refusal first ('det'), the holds
  // after the rule records and the MCP checks ('hold'). A hold is only ever
  // decided on a call nothing deterministic refused.
  const _intuticApplyRules = function (pass) {
  for (const rule of rules) {
    if (pass === 'det' ? rule.severity === 'hold' : rule.severity !== 'hold') continue;
    for (const subject of intuticRuleSubjects(rule, ctx)) {
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
        intuticChaosNote(rule.id, false);
        try { record('tool_would_block', toolName, rule.reason + ' [' + rule.id + ']'); } catch (e) {}
        continue;
      }
      if (rule.severity === 'hold') {
        // Not a permanent denial: the action is legitimate, someone asked to
        // see it first. An approved bypass lets this exact call through once;
        // otherwise the hold is recorded for review and the call refused.
        const held = intuticHold(rule, toolName, command, target, toolInput, record, workspaceId, sessionId, snap.opaque);
        if (held.bypassed) { intuticChaosNote(rule.id, true); continue; }
        const reason = '[Intutic Governance] HELD: ' + intuticShown(snap, rule.reason + ' [' + rule.id + ']') + ' ' + intuticHoldHint(held.holdId);
${refuseWith("'HELD'", 'rule.id', 'holdId: held.holdId', 'toolName', '(snap.opaque ? null : rule.id)')}
      }
      if (rule.severity === 'warn') {
        // Advisory tier — allowed, recorded with the rule id and the command's
        // first token. The verb is what makes a flag triageable as true or false
        // positive; without it the promotion rule this tier exists to serve is
        // not measurable. Arguments and paths stay out — that is DLP's job.
        intuticChaosNote(rule.id, false);
        try {
          record('tool_flagged', toolName,
            rule.reason + ' [' + rule.id + '] verb=' + nCommand.trim().split(' ')[0]);
        } catch (e) {}
        // The rollback rung's storage half: this call was flagged and is about
        // to proceed, which is the only instant the prior bytes still exist.
        // No-op unless the workspace opted in.
        try { _intuticCapturePreImage(toolName, toolInput, rule.id, nActions); } catch (e) {}
        continue;
      }
      // The rule's own reason, not a generic one: hookEvents.resolveSeverity
      // reads this text for "governance-protected" to file it CRITICAL.
      const _full = rule.reason + ' [' + rule.id + ']';
      const reason = intuticShown(snap, _full);
      try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
      try { record('tool_blocked', toolName, _full); } catch (e) {}
${refuseWith('intuticRuleCode(rule)', 'rule.id', '', 'toolName', '(snap.opaque ? null : rule.id)')}
    }
  }
  };
  _intuticApplyRules('det');
  // requires_outcome (gate body v23), among the deterministic refusals.
  _intuticRuleAct(intuticOutcomeTier(snap, toolName, nActions, toolInput, sessionId));

  // An unverified snapshot admits no MCP server (gate body v17): neither
  // record in it can be vouched for, and a deleted one looks like one never
  // set. Refused at block, in an observe-only workspace too.
  if (snap.state === 'invalid' && toolName.indexOf('mcp__') === 0) {
    var _unvRest = toolName.slice('mcp__'.length);
    var _unvSep = _unvRest.indexOf('__');
    if (_unvSep > 0) {
      var _unv = mcpSnapshotUnverifiedRefusal(_unvRest.slice(0, _unvSep));
      var reason = _unv.reason + ' [' + _unv.ruleId + ']';
      try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
      try { record('tool_blocked', toolName, reason); } catch (e) {}
${refuseWith('_unv.code', '_unv.ruleId')}
    }
  }

  // MCP server registry backstop (gate body v14): the workspace's registry
  // decisions from the snapshot's @mcp_registry record, applied to every
  // mcp__<server>__<tool> call — the servers no MCP proxy fronts included —
  // with the proxy's own decision, codes, rule ids and reasons.
  if (snap.mcpRegistry && toolName.indexOf('mcp__') === 0) {
    var _regRest = toolName.slice('mcp__'.length);
    var _regSep = _regRest.indexOf('__');
    var _reg = _regSep > 0 ? evaluateMcpRegistry(snap.mcpRegistry, _regRest.slice(0, _regSep), _regRest.slice(_regSep + 2)) : null;
    if (_reg) {
      var _regFull = _reg.reason + ' [' + _reg.ruleId + ']';
      var reason = intuticShown(snap, _regFull);
      try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
      try { record('tool_blocked', toolName, _regFull); } catch (e) {}
${refuseWith('_reg.code', '_reg.ruleId', '', 'toolName', '(snap.opaque ? null : _reg.ruleId)')}
    }
  }

  // MCP per-server allowlist backstop: a plain membership test over the
  // snapshot's @mcp_allowlist record (see the shell emitter for why it is
  // not a GuardPattern rule), only for an mcp__<server>__<tool> call and only
  // when the snapshot carries the record.
  if (snap.mcpAllowlist && toolName.indexOf('mcp__') === 0) {
    var _mcpRest = toolName.slice('mcp__'.length);
    var _mcpSep = _mcpRest.indexOf('__');
    var _mcp = _mcpSep > 0 ? evaluateMcpAllowlist(snap.mcpAllowlist, _mcpRest.slice(0, _mcpSep)) : null;
    if (_mcp) {
      // \`reason\` is what the refusal reads. The rule loop's own \`reason\` is
      // block-scoped to that loop, so without this the two stdout contracts
      // and the throw contract would hit a ReferenceError here.
      var reason = _mcp.reason + ' [' + _mcp.ruleId + ']';
      if (snap.mcpAllowlist.severity === 'shadow') {
        intuticChaosNote(_mcp.ruleId, false);
        try { record('tool_would_block', toolName, reason); } catch (e) {}
      } else {
        try { record('tool_blocked', toolName, reason); } catch (e) {}
        reason = intuticShown(snap, reason);
        try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
${refuseWith('_mcp.code', '_mcp.ruleId', '', 'toolName', '(snap.opaque ? null : _mcp.ruleId)')}
      }
    }
  }
  // The holds, after every refusal; then the trajectory tier (gate body v23).
  _intuticApplyRules('hold');
  _intuticRuleAct(intuticTrajectoryTier(snap, toolName, toolInput, sessionId, workspaceId || ''));
  // Allowed by every deterministic tier: the decide tier reads the tool name
  // as the rules did, and the snapshot's decide rules.
  return { toolName: toolName, snap: snap };
}
// ── end Intutic gate body ────────────────────────────────────────────────────
`
}


/**
 * Pre-image capture — the storage half of the rollback enforcement rung.
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
// ── Intutic pre-image capture (rollback rung) ────────────────────────────────
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
function _intuticCapturePreImage(toolName, input, ruleId, actions) {
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
    // The action tokens the gate classified this call to:
    // intutic rollback sends them on tool_reverted, so a revert counts
    // against the action and not only the tool.
    var _acts = String(actions || '').split(' ').filter(function (t) { return t.indexOf('action:') === 0; });
    if (_acts.length > 0) entry.actions = _acts;
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
 * nothing to cline, which only reads stdout — a crashed
 * stdout-cancel gate must still print its cancel object.
 */
export function emitJsFailClosedPrelude(opts: JsGateOptions): string {
  const crashBody =
    opts.contract === 'stdout-cancel'
      ? `  try {\n` +
        `    process.stdout.write(JSON.stringify({ cancel: true, errorMessage:\n` +
        `      '[Intutic Governance] gate crashed — failing closed: ' + String((err && err.stack) || err),\n` +
        `      code: 'GATE_CRASHED', ruleId: null }) + '\\n');\n` +
        `  } catch (e) { /* stdout gone too — nothing left to refuse through */ }\n` +
        `  process.exit(0);`
      : opts.contract === 'stdout-decision-deny'
        ? `  try {\n` +
          `    process.stdout.write(JSON.stringify({ decision: 'deny', reason:\n` +
          `      '[Intutic Governance] gate crashed — failing closed: ' + String((err && err.stack) || err)` +
          (opts.documentedFieldsOnly ? ` + ' (refusal code GATE_CRASHED)' }) + '\\n');\n` : `,\n      code: 'GATE_CRASHED', ruleId: null }) + '\\n');\n`) +
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
// A post-tool invocation (--event post, gate body v23) records a tool's result
// and never refuses: the tool has already run. Every exit is 0 there.
var _intuticPostMode = process.argv[2] === '--event' && process.argv[3] === 'post';
function _intuticCrash(err) {
  if (_intuticPostMode) process.exit(0);
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
  # A post-tool invocation records nothing without python3, and never refuses.
  if [ "\${INTUTIC_POST_MODE:-0}" = "1" ]; then exit 0; fi
  echo "[Intutic Governance] BLOCKED: python3 is required to evaluate tool calls and was not found on PATH." >&2
  echo "[Intutic Governance] Install python3, or unset the Intutic hooks to run ungoverned." >&2
  exit 2
fi

# The phrase matcher and the hold classifier (GATE_PY_LIB in gateBody.ts),
# for the extractor below and for phrase-subject rules. A quoted heredoc, so
# the shell expands nothing in it; read stops at end of input and returns 1.
IFS= read -r -d '' INTUTIC_PY_LIB <<'INTUTIC_PY_LIB_END' || true
${GATE_PY_LIB}
INTUTIC_PY_LIB_END
export INTUTIC_PY_LIB

INTUTIC_FIELDS="$(printf '%s' "$INPUT" | python3 -c '
import os, sys, json
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
def raw_first(*keys):
    for k in keys:
        v = i.get(k)
        if isinstance(v, str) and v:
            return v
    return ""
raw_command = raw_first("command", "cmd", "script", "shell_command")
tool_input_json = json.dumps(i, separators=(",", ":"), ensure_ascii=False)
# Too large to evaluate inside the hook timeout (gateLimits.ts): the gate body
# refuses on this line, and the command and arguments are not passed on.
command_bytes = len(raw_command.encode("utf-8", "surrogatepass"))
argument_bytes = len(tool_input_json.encode("utf-8", "surrogatepass"))
too_large = ""
if command_bytes > ${COMMAND_SIZE_LIMIT}:
    too_large = "the command is %d bytes, over the ${COMMAND_SIZE_LIMIT}-byte limit a gate evaluates; split it into smaller commands" % command_bytes
elif argument_bytes > ${ARGUMENTS_SIZE_LIMIT}:
    too_large = "the tool arguments are %d bytes, over the ${ARGUMENTS_SIZE_LIMIT}-byte limit a gate evaluates; write the content in smaller parts" % argument_bytes
if too_large:
    raw_command = ""
    tool_input_json = "{}"
# The hold classifier reads the raw command: a line continuation or a comment
# is still in it. The library is the shared phrase matcher, not a regex.
lib = {}
try:
    exec(os.environ.get("INTUTIC_PY_LIB", ""), lib)
    actions = lib["intutic_actions"](d.get("tool_name", ""), raw_command) if not too_large else " "
except Exception:
    actions = " "
# The state line comes FIRST: the lines after it may legitimately be empty,
# and command substitution strips trailing newlines, so the last line is the
# only position an empty value cannot survive in.
print(state)
print(too_large)
print(clean(d.get("tool_name", "")))
print(first("path", "file_path", "notebook_path", "filePath"))
print("" if too_large else first("command", "cmd", "script", "shell_command"))
print(clean(d.get("session_id", d.get("sessionId", ""))))
print(actions)
# The raw command as one JSON line, for phrase-subject rules.
print(json.dumps(raw_command, ensure_ascii=False))
# The FULL tool_input, serialized to the exact shape argPattern rules are
# matched against everywhere: JSON.stringify(tool_input) — compact separators,
# insertion order, non-ASCII intact. The selected fields above are whitespace-
# collapsed for token matching; this one must NOT be, or a WHERE clause that
# spans a key/value boundary matches here and not in the JS gates. json.dumps
# escapes every newline, so it is still exactly one line to read back.
print(tool_input_json)
' 2>/dev/null || printf '\\n\\n\\n\\n\\n\\n\\n\\n\\n')"

# Each read is \`|| true\` because command substitution strips trailing newlines:
# a tool call with no command argument yields fewer lines than reads, so a late
# read hits EOF and returns non-zero. Under \`set -e\` that killed the gate with
# **exit 1** — which every harness reads as a hook error and lets the call
# through. A guard that fails open on the most ordinary input there is (a Write
# with no shell command) is worse than no guard, because it looks present.
{ IFS= read -r INTUTIC_EXTRACT_STATE || true; IFS= read -r INTUTIC_TOO_LARGE || true; IFS= read -r TOOL || true; IFS= read -r TARGET || true; IFS= read -r COMMAND || true; IFS= read -r SESSION_ID || true; IFS= read -r INTUTIC_ACTIONS || true; IFS= read -r INTUTIC_RAW_COMMAND_JSON || true; IFS= read -r TOOL_INPUT_JSON || true; } <<EOF_INTUTIC_FIELDS
$INTUTIC_FIELDS
EOF_INTUTIC_FIELDS
TOOL="\${TOOL:-}"; TARGET="\${TARGET:-}"; COMMAND="\${COMMAND:-}"; SESSION_ID="\${SESSION_ID:-}"
# Space-padded action tokens the extractor's classifier found, or " ".
INTUTIC_ACTIONS="\${INTUTIC_ACTIONS:- }"
# Why the call is too large to evaluate, or empty (gateLimits.ts).
INTUTIC_TOO_LARGE="\${INTUTIC_TOO_LARGE:-}"
INTUTIC_RAW_COMMAND_JSON="\${INTUTIC_RAW_COMMAND_JSON:-\"\"}"
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
      `${p.ignoreCase ? 're.IGNORECASE' : '0'}, ${JSON.stringify(p.reason)}, ${p.sequence ? 'True' : 'False'}),`,
  )
  return `
# ── Intutic gate body v${GATE_VERSION} — harness: open-webui ─────────────────
# Prompts are flagged, never blocked, by these. See emitPythonGate().
_INTUTIC_FLOOR = [
${rows.join('\n')}
]


${NORMALISE_CONTRACT.pySource}


# The phrase matcher (intutic_clawde/gate/phrases.py), for phrase rules.
${PHRASES_PY_SOURCE}


# The sequence-rule matcher (intutic_clawde/gate/sequence.py), for rules whose
# flags carry "s": each step searched for once, so re's backtracking stays linear.
${SEQUENCE_PY_SOURCE}


def _intutic_rule_search(src, subject, flags_re, seq):
    if seq:
        return sequence_match(compile_sequence(src, flags_re), subject)
    return re.search(src, subject, flags_re) is not None


# The sentence an OPAQUE workspace's refusal shows in place of the rule
# (OPAQUE_REFUSAL_MESSAGE in @intutic/shared-types).
_INTUTIC_OPAQUE_MESSAGE = ${JSON.stringify(OPAQUE_REFUSAL_MESSAGE)}

_state = {"digest": "", "workspace": "", "opaque": False}


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
    # Read afresh each time: the filter outlives a change of mode.
    _state["opaque"] = False
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
                # An OPAQUE workspace: a refusal shows _INTUTIC_OPAQUE_MESSAGE.
                # Kept on a snapshot that fails its digest; it only hides text.
                if line == "${INTERVENTION_MODE_RECORD_TAG}\\tOPAQUE":
                    _state["opaque"] = True
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
                    out.append((f[0], f[5], re.IGNORECASE if "i" in f[2] else 0, f[4], f[1], f[3], "s" in f[2]))
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
        # No digest line is unverified too: the daemon always writes one.
        if actual != _state["digest"]:
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
    for rid, src, flags_re, reason, seq in _INTUTIC_FLOOR:
        try:
            if _intutic_rule_search(src, subject, flags_re, seq):
                flags.append((rid, reason))
        except Exception:
            continue
    words = None
    for rid, src, flags_re, reason, severity, rsubj, seq in _intutic_snapshot_rules():
        try:
            if rsubj == "phrase":
                # |-separated phrases matched as words (phrases.py), never as
                # a regex, which backtracks on crafted text.
                if words is None:
                    words = phrase_text(text)
                if not any(has_phrase(words, p, True) for p in src.split("|")):
                    continue
            elif not _intutic_rule_search(src, subject, flags_re, seq):
                continue
        except Exception:
            continue
        if severity == "warn":
            flags.append((rid, reason))
        elif severity == "shadow":
            shadowed.append((rid, reason))
        else:
            # \`block\`, \`hold\` and anything this filter does not know. A
            # prompt filter has no tool call to hold and no reviewer to wait
            # for, so a hold refuses outright; and an unrecognised severity
            # must not read as advisory — that was the v7 fail-open edge.
            blocks.append((rid, reason))
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
  // The decide tier's budget and deadline (decideBudgetMs in gateLimits.ts): the host waits
  // without a limit, so the deadline is a hook's under a 10 s timeout.
  const budget = decideBudgetMs('js', null)
  const deadline = HOOK_TIMEOUT_SECONDS * 1000 - GATE_DEADLINE_MARGIN_MS
  const margin = DECIDE_BUDGET_MARGIN_MS
  const minCall = DECIDE_MIN_CALL_MS
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

// The phrase matcher (@intutic/shared-types phrases.ts), for phrase rules.
${PHRASES_JS_SOURCE}

${JS_DECIDE_LIB}

${jsSnapshotLoader(GATE_EVALUATES_DECIDE.n8n)}

${JS_OPAQUE_HELPERS}

// The refusal of an MCP call on an unverified snapshot (mcpRegistryRecord.ts).
${MCP_SNAPSHOT_UNVERIFIED_JS_SOURCE}

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
        ? 'Policy snapshot failed its digest or workspace check — dynamic rules dropped except SSO-group refusals, and every MCP call refused'
        : snap.state === 'empty'
          ? 'Policy snapshot contains no rules — the compile produced nothing'
          : 'Policy snapshot is ' + snap.ageDays + ' days old and still enforced';
    try { record('snapshot_' + snap.state, 'n8n:' + wfName, _msg); } catch (e) {}
  }
  if (snap.format > ${GATE_READS_FORMAT}) {
    try { record('snapshot_format_newer', 'n8n:' + wfName, ${JSON.stringify(FORMAT_NEWER_MESSAGE)}.replace('{n}', String(snap.format))); } catch (e) {}
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
    // An MCP client node (n8n's MCP Client and MCP Client Tool, and the
    // community package's) calls tools on an MCP server. A snapshot that
    // failed its integrity check admits no MCP server (gate body v17), so a
    // workflow that would call one is refused, observe-only or not. The node
    // stands in for the server: n8n names it, the URL it reaches does not.
    if (snap.state === 'invalid' && /^mcpclient/i.test(nodeType.slice(nodeType.lastIndexOf('.') + 1))) {
      const _unv = mcpSnapshotUnverifiedRefusal(nodeName);
      const reason = _unv.reason + ' [' + _unv.ruleId + '] (node "' + nodeName + '", type ' + nodeType + ')';
      try { console.error('[Intutic Governance] BLOCKED: ' + reason); } catch (e) {}
      try { record('tool_blocked', 'n8n:' + nodeName, reason); } catch (e) {}
      throw new Error('[Intutic Governance] BLOCKED: ' + reason);
    }
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
    var leafWords = null;
    for (const rule of rules) {
      // A phrase rule's source is |-separated phrases matched as words in each
      // parameter string — never as a regex, which backtracks on crafted input.
      if (rule.subject === 'phrase') {
        if (leafWords === null) leafWords = _leaves.map(phraseText);
        var _phrases = (rule.src != null ? rule.src : rule.re.source).split('|');
        if (!leafWords.some(function (w) { return _phrases.some(function (p) { return hasPhrase(w, p, true); }); })) continue;
      }
      // A node has no separate command/target — its parameters are both. A
      // 'tool' rule matches the node TYPE and nothing else, for the same
      // reason the per-tool gates never test a path pattern against "Write".
      const subjects = rule.subject === 'phrase' ? [nParams] : rule.subject === 'tool' ? [nType, nTypeBase] : [nParams].concat(nLeaves);
      for (const subject of subjects) {
        if (rule.subject !== 'phrase' && !intuticRuleMatches(rule, subject)) continue;
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
        // \`hold\` falls through to the refusal below: this gate runs inside
        // the n8n server, which has no workspace to record a hold in and no
        // developer at a prompt to approve one, so a hold is a block here.
        // The rule's own reason, not a generic one: hookEvents.resolveSeverity
        // reads this text for "governance-protected" to file it CRITICAL.
        const reason = rule.reason + ' [' + rule.id + '] (node "' + nodeName + '", type ' + nodeType + ')';
        // An OPAQUE workspace is told which node, not which rule.
        const shown = snap.opaque ? INTUTIC_OPAQUE_MESSAGE + ' (node "' + nodeName + '")' : reason;
        try { console.error('[Intutic Governance] BLOCKED: ' + shown); } catch (e) {}
        try { record('tool_blocked', 'n8n:' + nodeName, reason); } catch (e) {}
        throw new Error('[Intutic Governance] BLOCKED: ' + shown);
      }
    }
  }
  // Allowed by every deterministic tier: the decide tier reads the nodes and
  // the snapshot's decide rules.
  return { snap: snap, nodes: nodes };
}

// ── Decide tier (gate body v22) ──────────────────────────────────────────────
// After every deterministic tier allowed the workflow, and only then: each
// node whose type (or its basename, as the tool rules read it) a decide rule
// names goes to \`intutic decide check --stdin\`, which asks the self-hosted
// engine within ${budget} ms less what the deadline has left. n8n cannot ask
// a person, so an escalation refuses (DECIDE_ESCALATED). A CLI that is
// missing, fails, times out or answers what this gate cannot read is
// unavailable, which refuses unless every rule on the node is stamped shadow.

const INTUTIC_DECIDE_CODES = { allow: [null], refuse: ['DECIDE_REFUSED', 'DECIDE_ESCALATED', 'GOVERNANCE_UNAVAILABLE'], escalate: ['DECIDE_ESCALATED'] };

/** Unavailable: a refusal unless every rule on the tool is stamped shadow, whose allow keeps the reason to record. */
function intuticDecideUnavailable(rules, tool, why) {
  const d = intuticDecideLib.unavailable(rules, tool, why);
  if (d.outcome === 'allow') d.reason = why;
  return d;
}

/** One node's decide check through the CLI: a decision { outcome, code, ruleId, reason }. Never throws. */
function intuticDecideCheck(tool, toolInput, budgetMs, rules) {
  const unavailable = function (why) { return intuticDecideUnavailable(rules, tool, why); };
  return new Promise(function (resolve) {
    var child, out = '', done = false, timer = null;
    const finish = function (d) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(d);
    };
    try {
      child = require('child_process').spawn('intutic', ['decide', 'check', '--stdin'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return finish(unavailable('intutic decide check could not run (' + String((e && e.code) || e) + ')'));
    }
    timer = setTimeout(function () {
      try { child.kill('SIGKILL'); } catch (e) {}
      finish(unavailable('intutic decide check did not answer within ' + budgetMs + ' ms'));
    }, budgetMs);
    child.on('error', function (e) {
      finish(unavailable(e && e.code === 'ENOENT'
        ? 'the decide rules on ' + tool + ' need the intutic CLI, which is not on PATH'
        : 'intutic decide check could not run (' + String((e && e.code) || e) + ')'));
    });
    child.stdout.on('data', function (c) { out += c; });
    child.on('close', function (code) {
      if (code !== 0) return finish(unavailable('intutic decide check exited ' + code));
      var r = null;
      try { r = JSON.parse(out); } catch (e) {}
      const ok = r && typeof r === 'object' && r.v === 1 && Object.prototype.hasOwnProperty.call(INTUTIC_DECIDE_CODES, r.outcome) &&
        INTUTIC_DECIDE_CODES[r.outcome].indexOf(r.code === undefined ? null : r.code) !== -1 &&
        (r.ruleId === null || r.ruleId === undefined || (typeof r.ruleId === 'string' && r.ruleId.indexOf('decide.') === 0)) &&
        (r.reason === undefined || typeof r.reason === 'string');
      if (!ok) return finish(unavailable('intutic decide check gave an answer this gate does not read'));
      finish({ outcome: r.outcome, code: r.code || null, ruleId: r.ruleId || null, reason: String(r.reason || '') });
    });
    child.stdin.on('error', function () {});
    child.stdin.end(JSON.stringify({ v: 1, harness: 'n8n', tool: tool, toolInput: toolInput, cwd: process.cwd(), sessionId: '',
      budgetMs: budgetMs, lastUserTurn: null }));
  });
}

/**
 * Evaluates one workflow: the deterministic tiers, then each node a decide
 * rule names. Resolves to allow; throws to abort the execution.
 */
async function intuticGateWorkflowWithDecide(workflow, record, workspaceId) {
  const started = Date.now();
  const r = intuticGateWorkflow(workflow, record, workspaceId);
  if (r.snap.decideRules.length === 0) return;
  for (const node of r.nodes) {
    if (!node || typeof node !== 'object') continue;
    const nodeType = String(node.type || '');
    const nodeName = String(node.name || nodeType || 'node');
    const base = nodeType.indexOf('.') >= 0 ? nodeType.slice(nodeType.lastIndexOf('.') + 1) : nodeType;
    var tool = null;
    for (const name of [nodeType, base]) {
      if (!tool && r.snap.decideRules.some(function (d) { return d.ir.on === 'tool_call' && (d.ir.tools || []).indexOf(name) !== -1; })) tool = name;
    }
    if (!tool) continue;
    const rules = r.snap.decideRules.filter(function (d) { return d.ir.on === 'tool_call' && (d.ir.tools || []).indexOf(tool) !== -1; });
    const budget = Math.min(${budget}, ${deadline} - (Date.now() - started) - ${margin});
    const dec = budget < ${minCall}
      ? intuticDecideUnavailable(rules, tool, 'no time was left for the decide rules on ' + tool + ' within the gate deadline')
      : await intuticDecideCheck(tool, node.parameters == null ? {} : node.parameters, budget, rules);
    if (dec.outcome === 'allow') {
      // A shadow rule whose engine could not answer: recorded, and the workflow goes on.
      if (dec.reason) { try { record('tool_would_block', 'n8n:' + nodeName, 'GOVERNANCE_UNAVAILABLE — ' + dec.reason); } catch (e) {} }
      continue;
    }
    const reason = dec.reason + (dec.ruleId ? ' [' + dec.ruleId + ']' : '') + ' (node "' + nodeName + '", type ' + nodeType + ')';
    const shown = r.snap.opaque ? INTUTIC_OPAQUE_MESSAGE + ' (node "' + nodeName + '")' : reason;
    try { console.error('[Intutic Governance] BLOCKED: ' + shown + ' (refusal code ' + (dec.code || 'DECIDE_ESCALATED') + ')'); } catch (e) {}
    try { record('tool_blocked', 'n8n:' + nodeName, reason); } catch (e) {}
    throw new Error('[Intutic Governance] BLOCKED: ' + shown);
  }
}
// ── end Intutic gate body ────────────────────────────────────────────────────
`
}

/** The destructive tier, for the snapshot writer to ship. Not compiled into any
 *  gate — see the note on {@link DESTRUCTIVE_COMMAND_PATTERNS}. */
export { DESTRUCTIVE_COMMAND_PATTERNS }
