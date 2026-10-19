//! Did the tests pass? — the `[ok]` qualifier on `requires_before:`.
//!
//! `requires_before: action:run_tests[ok] -> action:deploy` is met only when
//! the latest test run in the session succeeded. Unknown counts as not met.
//! This module holds the three pure parts of that rule, which
//! the TypeScript (`shared-types` testOutcome.ts) and Python
//! (`intutic_clawde/gate/test_outcome.py`) ports share through
//! `packages/shared-types/fixtures/test-outcome-vectors.json`:
//!
//! - [`split_qualifier`] and [`qualifier_error`]: the grammar.
//! - [`decide_test_outcome`] and [`extract_exit_code`]: reading a tool result.
//! - [`latest_test_outcome`]: replaying a request's history to the outcome
//!   of its last test run, made stale by any file write after it (Q1).
//!
//! Everything here is linear in its input: the output is read from its last
//! [`TAIL_BYTES`], line by line, each line cut to [`LINE_MAX`], through
//! anchored patterns Rust's regex engine runs in linear time.

use std::sync::OnceLock;

use regex::Regex;

use crate::manifest::{InvocationSource, ToolInvocation};

/// The tokens a `[ok]` qualifier may name.
pub const OUTCOME_TOKENS: &[&str] = &["action:run_tests"];

/// The bytes of a tool's output whose runner summaries are read: the end,
/// where every runner prints its summary.
pub const TAIL_BYTES: usize = 64 * 1024;

/// The longest line a pattern is run against, in bytes.
pub const LINE_MAX: usize = 1024;

/// The longest output whose JSON form is parsed for an exit code.
pub const JSON_MAX_CHARS: usize = 1024 * 1024;

/// An outcome older than this is ignored: a day.
pub const OUTCOME_STATE_TTL_MS: i64 = 86_400_000;

/// The one qualifier the grammar has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Qualifier {
    /// The latest run of the token succeeded.
    Ok,
}

/// `action:run_tests[ok]` → `("action:run_tests", Some(Ok))`; any other
/// token comes back whole, with `None`. Exact: `[OK]` is not the qualifier.
pub fn split_qualifier(token: &str) -> (&str, Option<Qualifier>) {
    if token == "action:run_tests[ok]" {
        return ("action:run_tests", Some(Qualifier::Ok));
    }
    (token, None)
}

/// Why one side of an ordering rule cannot carry the qualifier it carries,
/// or `None` when it is fine (`orderingQualifierError`). A side carries a
/// qualifier when it holds `[` or `]`; only `action:run_tests[ok]`, on the
/// left of the arrow, is one. The error names the side JSON-quoted.
pub fn ordering_qualifier_error(side: &str, left: bool) -> Option<String> {
    if !side.contains('[') && !side.contains(']') {
        return None;
    }
    if left && side == "action:run_tests[ok]" {
        return None;
    }
    Some(format!(
        "{}: [ok] qualifies only action:run_tests, on the left of ->",
        serde_json::to_string(side).unwrap_or_default()
    ))
}

/// The first error of either side of `lhs -> rhs`.
pub fn qualifier_error(lhs: &str, rhs: &str) -> Option<String> {
    ordering_qualifier_error(lhs, true).or_else(|| ordering_qualifier_error(rhs, false))
}

/// `token` cut at its first `[`, so a misplaced qualifier on the right of a
/// rule still names the call it gates. The front-matter reader trims a
/// trailing `]` off the last rule of a `[a -> b[ok]]` list, leaving `b[ok`.
pub fn strip_any_qualifier(token: &str) -> String {
    let t = token.trim();
    match t.find('[') {
        Some(i) => t[..i].to_string(),
        None => t.to_string(),
    }
}

// ─── Reading a result ───────────────────────────────────────────────────

/// What a test run came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Ok,
    Failed,
    Unknown,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Failed => "failed",
            Outcome::Unknown => "unknown",
        }
    }
}

/// [`decide_test_outcome`]'s answer: the outcome and which step decided it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestOutcome {
    pub outcome: Outcome,
    /// `exit_code`, `is_error`, `success_false`, `summary_failed`,
    /// `no_tests`, `exit_zero`, `summary_passed` or `no_signal`.
    pub why: &'static str,
}

/// What a surface reports about one finished tool call.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OutcomeInput {
    pub exit_code: Option<i64>,
    pub is_error: Option<bool>,
    pub success: Option<bool>,
    pub output: String,
}

/// One runner's summary: its counts, and whether it said no tests ran. Go
/// and mocha fold every line into one summary each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub runner: &'static str,
    pub passed: u64,
    /// Failures and errors together.
    pub failed: u64,
    pub no_tests: bool,
}

/// 3.1, in order: a non-zero integer exit code, `isError` or
/// `success: false` fails; a summary with failures fails; no test passing
/// while a summary says none ran fails (`no_tests`); exit 0 passes; a summary
/// with a pass passes; anything else is unknown.
pub fn decide_test_outcome(input: &OutcomeInput) -> TestOutcome {
    let decided = |outcome, why| TestOutcome { outcome, why };
    let exit = input.exit_code;
    if exit.is_some_and(|c| c != 0) {
        return decided(Outcome::Failed, "exit_code");
    }
    if input.is_error == Some(true) {
        return decided(Outcome::Failed, "is_error");
    }
    if input.success == Some(false) {
        return decided(Outcome::Failed, "success_false");
    }
    let mut passed: u64 = 0;
    let mut no_tests = false;
    for s in parse_test_summaries(&input.output) {
        if s.failed > 0 {
            return decided(Outcome::Failed, "summary_failed");
        }
        passed += s.passed;
        no_tests |= s.no_tests;
    }
    if passed == 0 && no_tests {
        return decided(Outcome::Failed, "no_tests");
    }
    if exit == Some(0) {
        return decided(Outcome::Ok, "exit_zero");
    }
    if passed >= 1 {
        return decided(Outcome::Ok, "summary_passed");
    }
    decided(Outcome::Unknown, "no_signal")
}

/// The last `max` bytes of `s`, starting on a character.
fn utf8_tail(s: &str, max: usize) -> &str {
    let mut start = s.len().saturating_sub(max);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// The first `max` bytes of `s`, ending on a character.
fn utf8_head(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static Regex {
            static R: OnceLock<Regex> = OnceLock::new();
            R.get_or_init(|| Regex::new($pat).expect("static pattern"))
        }
    };
}

re!(re_ansi, r"\x1b\[[0-9;?]*[A-Za-z]");
re!(re_exit_code, r"(?i)^exit code:? (-?[0-9]{1,9})$");
re!(re_exit_status, r"^exit status ([0-9]{1,9})$");
re!(
    re_exited_with,
    r"^(?:Process|Command) exited with code (-?[0-9]{1,9})"
);
re!(re_pytest_none, r"^=+ no tests ran");
re!(re_pytest, r"^=+ (.+) in [0-9.]+s.* =+$");
re!(re_jest, r"^Tests:[ \t]+(.+)$");
re!(re_vitest, r"^[ \t]*Tests[ \t]+(.+)$");
re!(re_go_ok, r"^ok[ \t]+[^ \t]+");
re!(re_go_fail, r"^FAIL([ \t]|$)|^--- FAIL:");
re!(
    re_cargo,
    r"^test result: (ok|FAILED)\. ([0-9]{1,9}) passed; ([0-9]{1,9}) failed;"
);
re!(re_mocha_passing, r"^[ \t]*([0-9]{1,9}) passing");
re!(re_mocha_failing, r"^[ \t]*([0-9]{1,9}) failing");
re!(re_rspec, r"^([0-9]{1,9}) examples?, ([0-9]{1,9}) failures?");
re!(re_count, r"^([0-9]{1,9}) ([a-z]+)");

/// The lines of `text`, each cut to [`LINE_MAX`] bytes, then without
/// carriage returns or ANSI sequences.
fn lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|raw| {
            let head = utf8_head(raw, LINE_MAX).replace('\r', "");
            re_ansi().replace_all(&head, "").into_owned()
        })
        .collect()
}

/// An integer JSON value as an exit code: never a boolean, string or
/// fraction.
fn json_integer(v: Option<&serde_json::Value>) -> Option<i64> {
    v.and_then(serde_json::Value::as_i64)
        .filter(|n| n.unsigned_abs() < (1u64 << 53))
}

/// The exit code a run's text reports (`extractExitCode`): a whole-output
/// JSON object's `metadata.exit_code`, else `exit_code`, else `exitCode`;
/// otherwise the first line — of the first 64 KiB, then the last 64 KiB —
/// that is `Exit code N` / `Exit code: N` (any case), `exit status N`, or
/// begins `Process exited with code N` / `Command exited with code N`.
pub fn extract_exit_code(output: &str) -> Option<i64> {
    if output.is_empty() {
        return None;
    }
    let trimmed = output.trim();
    if trimmed.chars().count() <= JSON_MAX_CHARS
        && trimmed.starts_with('{')
        && trimmed.ends_with('}')
    {
        if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(trimmed)
        {
            let meta = o.get("metadata").and_then(|m| m.as_object());
            let code = json_integer(meta.and_then(|m| m.get("exit_code")))
                .or_else(|| json_integer(o.get("exit_code")))
                .or_else(|| json_integer(o.get("exitCode")));
            if code.is_some() {
                return code;
            }
        }
    }
    let head = utf8_head(output, TAIL_BYTES);
    let mut parts = vec![head];
    if head.len() < output.len() {
        parts.push(utf8_tail(&output[head.len()..], TAIL_BYTES));
    }
    for part in parts {
        for raw in lines(part) {
            let line = raw.trim_matches([' ', '\t']);
            let cap = re_exit_code()
                .captures(line)
                .or_else(|| re_exit_status().captures(line))
                .or_else(|| re_exited_with().captures(line));
            if let Some(n) = cap.and_then(|c| c[1].parse::<i64>().ok()) {
                return Some(n);
            }
        }
    }
    None
}

/// `N word` pieces of a summary, split on `,` and `|`: each word's count.
fn counts(text: &str) -> std::collections::HashMap<String, u64> {
    let mut out = std::collections::HashMap::new();
    for piece in text.split([',', '|']) {
        if let Some(c) = re_count().captures(piece.trim_start_matches([' ', '\t'])) {
            *out.entry(c[2].to_string()).or_insert(0) += c[1].parse::<u64>().unwrap_or(0);
        }
    }
    out
}

/// The runner summaries in the last 64 KiB of `output`, in the order they
/// appear (`parseTestSummaries`).
pub fn parse_test_summaries(output: &str) -> Vec<Summary> {
    let mut out: Vec<Summary> = Vec::new();
    let (mut go, mut mocha): (Option<usize>, Option<usize>) = (None, None);
    let summary = |runner, passed, failed, no_tests| Summary {
        runner,
        passed,
        failed,
        no_tests,
    };
    for line in lines(utf8_tail(output, TAIL_BYTES)) {
        let line = line.as_str();
        if re_pytest_none().is_match(line) {
            out.push(summary("pytest", 0, 0, true));
        } else if let Some(m) = re_pytest().captures(line) {
            let c = counts(&m[1]);
            let get = |k: &str| c.get(k).copied();
            if get("passed").is_none()
                && get("failed").is_none()
                && get("error").is_none()
                && get("errors").is_none()
            {
                continue;
            }
            let failed =
                get("failed").unwrap_or(0) + get("error").unwrap_or(0) + get("errors").unwrap_or(0);
            out.push(summary(
                "pytest",
                get("passed").unwrap_or(0),
                failed,
                get("passed") == Some(0),
            ));
        } else if let Some(m) = re_jest().captures(line) {
            let c = counts(&m[1]);
            let get = |k: &str| c.get(k).copied();
            out.push(summary(
                "jest",
                get("passed").unwrap_or(0),
                get("failed").unwrap_or(0),
                get("passed") == Some(0) || get("total") == Some(0),
            ));
        } else if let Some(m) = re_vitest().captures(line) {
            let c = counts(&m[1]);
            let get = |k: &str| c.get(k).copied();
            if get("passed").is_none() && get("failed").is_none() {
                continue;
            }
            out.push(summary(
                "vitest",
                get("passed").unwrap_or(0),
                get("failed").unwrap_or(0),
                get("passed") == Some(0),
            ));
        } else if re_go_ok().is_match(line) {
            let i = *go.get_or_insert_with(|| {
                out.push(summary("go", 0, 0, false));
                out.len() - 1
            });
            out[i].passed += 1;
        } else if re_go_fail().is_match(line) {
            let i = *go.get_or_insert_with(|| {
                out.push(summary("go", 0, 0, false));
                out.len() - 1
            });
            out[i].failed += 1;
        } else if let Some(m) = re_cargo().captures(line) {
            let passed: u64 = m[2].parse().unwrap_or(0);
            let failed: u64 = m[3].parse().unwrap_or(0);
            let failed = if &m[1] == "FAILED" && failed == 0 {
                1
            } else {
                failed
            };
            out.push(summary("cargo", passed, failed, passed == 0));
        } else if let Some(m) = re_mocha_passing().captures(line) {
            let n: u64 = m[1].parse().unwrap_or(0);
            let i = *mocha.get_or_insert_with(|| {
                out.push(summary("mocha", 0, 0, false));
                out.len() - 1
            });
            out[i].passed += n;
            if n == 0 {
                out[i].no_tests = true;
            }
        } else if let Some(m) = re_mocha_failing().captures(line) {
            let n: u64 = m[1].parse().unwrap_or(0);
            let i = *mocha.get_or_insert_with(|| {
                out.push(summary("mocha", 0, 0, false));
                out.len() - 1
            });
            out[i].failed += n;
        } else if let Some(m) = re_rspec().captures(line) {
            let examples: u64 = m[1].parse().unwrap_or(0);
            let failures: u64 = m[2].parse().unwrap_or(0);
            out.push(summary(
                "rspec",
                examples.saturating_sub(failures),
                failures,
                examples == 0,
            ));
        }
    }
    out
}

// ─── The session's record ───────────────────────────────────────────────

/// The latest outcome of one token in a session — the hook gates' state
/// entry shape (`OutcomeEntry` in shared-types testOutcome.ts), stored in
/// `intutic:outcome:{scope}` as its JSON.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OutcomeEntry {
    pub o: Outcome,
    /// Epoch milliseconds.
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// A file changed after the run: a pass no longer counts (Q1).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub changed: bool,
    /// Another call completed after the run: it is not adjacent to the next.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub later: bool,
}

impl OutcomeEntry {
    /// This run's outcome, recorded at `at_ms` (`recordTestOutcome`).
    pub fn record(decision: &TestOutcome, at_ms: i64) -> Self {
        Self {
            o: decision.outcome,
            at: at_ms,
            why: Some(decision.why.to_string()),
            changed: false,
            later: false,
        }
    }

    /// After another call completed (`noteCompletedCall`): no longer
    /// adjacent to what comes next, and stale when that call changed a file.
    pub fn note_completed_call(&mut self, changed_files: bool) {
        self.changed |= changed_files;
        self.later = true;
    }

    /// The JSON the store keeps.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `None` for anything this proxy did not write — which leaves the rule
    /// unmet, like no record at all.
    pub fn decode(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }

    /// The same record, ignoring when it was made.
    pub fn same_state(&self, other: &Self) -> bool {
        self.o == other.o
            && self.why == other.why
            && self.changed == other.changed
            && self.later == other.later
    }
}

/// Why a qualified prerequisite is unmet, or `Met` (`PrerequisiteCase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Case {
    Met,
    None,
    Failed,
    Unknown,
    Changed,
    NotAdjacent,
    NotObservable,
    NoSession,
}

impl Case {
    pub fn as_str(self) -> &'static str {
        match self {
            Case::Met => "met",
            Case::None => "none",
            Case::Failed => "failed",
            Case::Unknown => "unknown",
            Case::Changed => "changed",
            Case::NotAdjacent => "not_adjacent",
            Case::NotObservable => "not_observable",
            Case::NoSession => "no_session",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "met" => Case::Met,
            "none" => Case::None,
            "failed" => Case::Failed,
            "unknown" => Case::Unknown,
            "changed" => Case::Changed,
            "not_adjacent" => Case::NotAdjacent,
            "not_observable" => Case::NotObservable,
            "no_session" => Case::NoSession,
            _ => return None,
        })
    }
}

/// Whether a token's latest outcome meets a qualified rule now
/// (`prerequisiteCase`): `Met` only for an `ok` younger than a day that no
/// file change followed and, for `~>`, no other call. No entry — none, or
/// unreadable — is `None`.
pub fn prerequisite_case(
    entry: Option<&OutcomeEntry>,
    adjacent: bool,
    now_ms: i64,
) -> (Case, Option<String>) {
    let Some(e) = entry.filter(|e| now_ms - e.at < OUTCOME_STATE_TTL_MS && e.at <= now_ms) else {
        return (Case::None, None);
    };
    match e.o {
        Outcome::Failed => (Case::Failed, e.why.clone()),
        Outcome::Unknown => (Case::Unknown, e.why.clone()),
        Outcome::Ok if e.changed => (Case::Changed, None),
        Outcome::Ok if adjacent && e.later => (Case::NotAdjacent, None),
        Outcome::Ok => (Case::Met, None),
    }
}

/// The reason a `PREREQUISITE_UNMET` refusal gives (`prerequisiteUnmetReason`).
/// Byte-stable: every port answers with these words. `harness` names the
/// surface for `not_observable` and `no_session`.
pub fn prerequisite_unmet_reason(
    first: &str,
    then: &str,
    case: Case,
    why: Option<&str>,
    harness: &str,
) -> String {
    let head = format!("{then} needs a passing {first} first; ");
    match case {
        Case::None => format!("{head}none ran in this session"),
        Case::Failed => format!("{head}the last {first} failed ({})", why.unwrap_or("failed")),
        Case::Unknown => format!(
            "{head}the result of the last {first} could not be read; rerun the tests so their summary is visible"
        ),
        Case::Changed => format!("{head}files changed after the last passing {first}; rerun the tests"),
        Case::NotAdjacent => {
            format!("{head}{then} must come directly after it, and another call came between")
        }
        Case::NotObservable => format!(
            "{head}{harness} reports no tool results Intutic can read, so a passing run cannot be observed here"
        ),
        Case::NoSession => format!(
            "{head}{harness} sent no session id, so test results cannot be tied to this session"
        ),
        Case::Met => String::new(),
    }
}

/// The session's record for `token`, judged now: `Ok(())` when met, else the
/// case and its why. `outcomes` is `None` when the record could not be read,
/// which is `none` (rule failures fail closed).
pub fn prerequisite_unmet(
    outcomes: Option<&[(String, OutcomeEntry)]>,
    token: &str,
    adjacent: bool,
    now_ms: i64,
) -> Option<(Case, Option<String>)> {
    let entry = outcomes.and_then(|o| {
        o.iter()
            .find(|(t, _)| t.eq_ignore_ascii_case(token))
            .map(|(_, e)| e)
    });
    let (case, why) = prerequisite_case(entry, adjacent, now_ms);
    (case != Case::Met).then_some((case, why))
}

/// The text of a tool result, for reading: a string as it is, an Anthropic
/// content array's text blocks joined, any other JSON as written.
fn result_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|b| {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
                    .or_else(|| b.as_str().map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Does this call change files? Q1: an `[ok]` is stale after one
/// (`isFileWriteCall`): a path mutation the change manifest records, or a
/// shell command naming one of `actions::FILE_WRITE_SHELL_PHRASES`
/// (`sed -i`, `git checkout`, …) in its `command`, `cmd` or `script`.
pub fn is_file_write(call: &ToolInvocation) -> bool {
    if call.source != InvocationSource::Call {
        return false;
    }
    is_file_write_call(&call.name, &call.input)
}

/// [`is_file_write`] over a tool name and its arguments.
pub fn is_file_write_call(tool: &str, input: &serde_json::Value) -> bool {
    use crate::plugins::anomaly::actions::{tool_is, SHELL_TOOLS};
    if !crate::manifest::change_targets(tool, input).is_empty() {
        return true;
    }
    if !tool_is(tool, SHELL_TOOLS) {
        return false;
    }
    let Some(command) = input.as_object().and_then(|o| {
        ["command", "cmd", "script"]
            .iter()
            .find_map(|k| o.get(*k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
    }) else {
        return false;
    };
    crate::plugins::anomaly::actions::is_file_write_command(command)
}

/// The record of the last `action:run_tests` result in `history`, paired to
/// its call by id, with every call after that result noted on it (a file
/// write makes a pass stale; any call makes it no longer adjacent). `None`
/// when no test result in `history` pairs — a compacted history, or a
/// session that never ran tests — and the stored record then stands.
pub fn latest_test_outcome(history: &[ToolInvocation], now_ms: i64) -> Option<OutcomeEntry> {
    let calls: std::collections::HashMap<&str, &ToolInvocation> = history
        .iter()
        .filter(|i| i.source == InvocationSource::Call)
        .filter_map(|i| i.call_id.as_deref().map(|id| (id, i)))
        .collect();
    let (at, result) = history.iter().enumerate().rev().find(|(_, inv)| {
        inv.source == InvocationSource::Result
            && inv
                .call_id
                .as_deref()
                .and_then(|id| calls.get(id))
                .is_some_and(|call| {
                    crate::plugins::anomaly::actions::classify(&call.name, &call.input)
                        .iter()
                        .any(|t| OUTCOME_TOKENS.contains(&t.as_str()))
                })
    })?;
    let text = result_text(&result.input);
    let decision = decide_test_outcome(&OutcomeInput {
        exit_code: extract_exit_code(&text),
        is_error: result.is_error,
        success: None,
        output: text,
    });
    let mut entry = OutcomeEntry::record(&decision, now_ms);
    for call in history[at + 1..]
        .iter()
        .filter(|i| i.source == InvocationSource::Call)
    {
        entry.note_completed_call(is_file_write(call));
    }
    Some(entry)
}

/// The qualified rules among `requires_before`: `(prerequisite base, gated,
/// adjacent)` for every rule whose left side is `action:run_tests[ok]`.
pub fn qualified_rules(requires_before: &[(String, String, bool)]) -> Vec<(String, String, bool)> {
    requires_before
        .iter()
        .filter_map(|(before, after, adj)| {
            let (base, q) = split_qualifier(before);
            (q == Some(Qualifier::Ok)).then(|| (base.to_string(), after.clone(), *adj))
        })
        .collect()
}

/// 3.1's shared vector files, for the unit tests that hold this crate to
/// them. A missing file fails the test: the vectors are the contract.
#[cfg(test)]
pub(crate) fn lld75_fixture(name: &str) -> Option<serde_json::Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared-types/fixtures")
        .join(name);
    match std::fs::read_to_string(&path) {
        Ok(text) => Some(serde_json::from_str(&text).expect("the vectors parse")),
        Err(e) => panic!("{} must exist: {e}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(output: &str) -> Outcome {
        decide_test_outcome(&OutcomeInput {
            output: output.into(),
            ..Default::default()
        })
        .outcome
    }

    #[test]
    fn the_qualifier_splits_and_misplacements_are_errors() {
        assert_eq!(
            split_qualifier("action:run_tests[ok]"),
            ("action:run_tests", Some(Qualifier::Ok))
        );
        assert_eq!(split_qualifier("action:run_tests[OK]").1, None);
        assert_eq!(
            qualifier_error("action:run_tests[ok]", "action:deploy"),
            None
        );
        for (l, r) in [
            ("action:deploy[ok]", "action:publish"),
            ("action:run_tests[passed]", "action:deploy"),
            ("action:run_tests", "action:deploy[ok]"),
            ("action:run_tests", "action:deploy[ok"),
            ("Bash[ok]", "action:deploy"),
        ] {
            let e = qualifier_error(l, r).expect("an error");
            assert!(e.contains("[ok] qualifies only action:run_tests"), "{e}");
        }
        assert_eq!(strip_any_qualifier("action:deploy[ok]"), "action:deploy");
        assert_eq!(strip_any_qualifier("action:deploy[ok"), "action:deploy");
    }

    #[test]
    fn each_step_of_the_table_decides() {
        let d = |exit_code, is_error, success, output: &str| {
            decide_test_outcome(&OutcomeInput {
                exit_code,
                is_error,
                success,
                output: output.into(),
            })
        };
        assert_eq!(d(Some(1), Some(true), None, "").why, "exit_code");
        assert_eq!(d(None, Some(true), None, "").why, "is_error");
        assert_eq!(d(None, None, Some(false), "").why, "success_false");
        assert_eq!(
            d(
                Some(0),
                None,
                None,
                "Tests:       1 failed, 3 passed, 4 total"
            )
            .why,
            "summary_failed"
        );
        assert_eq!(
            d(Some(0), None, None, "=== no tests ran in 0.01s ===").why,
            "no_tests"
        );
        assert_eq!(d(Some(0), None, None, "done").why, "exit_zero");
        assert_eq!(
            d(None, None, None, "==== 12 passed in 0.31s ====").why,
            "summary_passed"
        );
        assert_eq!(d(None, None, None, "done").why, "no_signal");
    }

    #[test]
    fn a_workspace_run_with_empty_crates_still_passes() {
        assert_eq!(
            ok("test result: ok. 0 passed; 0 failed;\ntest result: ok. 9 passed; 0 failed;"),
            Outcome::Ok
        );
        assert_eq!(ok("test result: ok. 0 passed; 0 failed;"), Outcome::Failed);
        assert_eq!(
            ok("\u{1b}[1mTests:\u{1b}[22m       \u{1b}[32m4 passed\u{1b}[39m, 4 total"),
            Outcome::Ok
        );
    }

    #[test]
    fn the_first_exit_code_line_wins() {
        assert_eq!(extract_exit_code("Exit code 0\nexit status 1"), Some(0));
        assert_eq!(extract_exit_code("Exit Code: 3"), Some(3));
        assert_eq!(extract_exit_code("Exit code 1234567890"), None);
        assert_eq!(extract_exit_code(r#"{"exit_code":true}"#), None);
    }

    fn inv(
        name: &str,
        input: serde_json::Value,
        source: InvocationSource,
        id: &str,
    ) -> ToolInvocation {
        ToolInvocation {
            name: name.into(),
            input,
            source,
            call_id: Some(id.into()),
            is_error: None,
        }
    }

    #[test]
    fn the_last_paired_run_decides_and_later_calls_are_noted() {
        let run = |id: &str| {
            inv(
                "Bash",
                json!({"command": "pytest"}),
                InvocationSource::Call,
                id,
            )
        };
        let res = |id: &str, out: &str| inv("Bash", json!(out), InvocationSource::Result, id);
        let h = vec![
            run("a"),
            res("a", "==== 1 failed in 1s ===="),
            run("b"),
            res("b", "==== 3 passed in 1s ===="),
        ];
        let e = latest_test_outcome(&h, 5).unwrap();
        assert_eq!((e.o, e.changed, e.later), (Outcome::Ok, false, false));

        let mut read = h.clone();
        read.push(inv(
            "Read",
            json!({"file_path": "a"}),
            InvocationSource::Call,
            "r",
        ));
        let e = latest_test_outcome(&read, 5).unwrap();
        assert_eq!((e.changed, e.later), (false, true));

        let mut wrote = h.clone();
        wrote.push(inv(
            "Bash",
            json!({"command": "git pull --rebase"}),
            InvocationSource::Call,
            "w",
        ));
        assert!(
            latest_test_outcome(&wrote, 5).unwrap().changed,
            "a shell write is a write"
        );

        assert!(latest_test_outcome(&[res("zz", "==== 3 passed in 1s ====")], 5).is_none());
    }

    #[test]
    fn a_record_round_trips_and_is_judged_by_age() {
        let mut e = OutcomeEntry::record(
            &TestOutcome {
                outcome: Outcome::Ok,
                why: "exit_zero",
            },
            1_000,
        );
        assert_eq!(OutcomeEntry::decode(&e.encode()), Some(e.clone()));
        assert_eq!(prerequisite_case(Some(&e), false, 2_000).0, Case::Met);
        assert_eq!(
            prerequisite_case(Some(&e), false, 1_000 + OUTCOME_STATE_TTL_MS).0,
            Case::None
        );
        assert_eq!(
            prerequisite_case(Some(&e), false, 500).0,
            Case::None,
            "from the future"
        );
        e.note_completed_call(false);
        assert_eq!(
            prerequisite_case(Some(&e), true, 2_000).0,
            Case::NotAdjacent
        );
        e.note_completed_call(true);
        assert_eq!(prerequisite_case(Some(&e), false, 2_000).0, Case::Changed);
        assert_eq!(OutcomeEntry::decode("ok:1"), None);
        assert_eq!(
            prerequisite_unmet(None, "action:run_tests", false, 1).map(|c| c.0),
            Some(Case::None)
        );
    }

    #[test]
    fn only_the_exact_qualified_token_makes_a_qualified_rule() {
        let rules = vec![
            (
                "action:run_tests[ok]".to_string(),
                "action:deploy".to_string(),
                false,
            ),
            (
                "action:run_tests".to_string(),
                "action:publish".to_string(),
                false,
            ),
            (
                "action:deploy[ok]".to_string(),
                "action:release".to_string(),
                false,
            ),
        ];
        assert_eq!(
            qualified_rules(&rules),
            vec![(
                "action:run_tests".to_string(),
                "action:deploy".to_string(),
                false
            )]
        );
    }
}
