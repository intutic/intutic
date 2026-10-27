//! The decide log, as the gateway writes it, and the drift alarm it feeds.
//!
//! A port of `packages/shared-types/src/decideLog.ts`: the same
//! `decide.decision` record, the same redaction of the arguments excerpt,
//! the same 8 KB line cap and the same drift stats, so a line the gateway
//! writes reads exactly as a gate's. Both ports, and the Python one, run
//! `packages/shared-types/fixtures/decide-log-vectors.json`.
//!
//! - One line per evaluated tool call or response, appended with a single
//!   write to `~/.intutic/logs/decide-YYYY-MM-DD.jsonl` (the UTC date), mode
//!   0600 in a 0700 directory. The day's first write deletes the files older
//!   than [`DECIDE_LOG_RETENTION_DAYS`].
//! - A response's record names no tool (`"tool": ""`); its arguments excerpt
//!   is the response's text, redacted and cut the same way, and its state
//!   hash is of the response state the engine was sent.
//! - Each answered rule keeps its last [`DECIDE_STATS_KEEP`] decisions in
//!   `~/.intutic/decide/stats/<ruleHash>.json`, the file the gates keep, and
//!   `decide.drift` is written when they move away from the eval run the
//!   rule's pin came from.
//!
//! Lines are written in canonical JSON (keys sorted, numbers as JavaScript
//! writes them). A write that fails never changes a decision: the caller logs
//! it and carries on.

use super::engine::{
    build_response_state, build_tool_call_state, canonical_json, utf8_prefix,
    Answer as EngineAnswer, ToolCallStateInput,
};
use super::evaluate::{CanaryState, Evaluation, RuleEntry, RuleReport};
use super::{
    band_value, choice_atoms, DecideRule, Expr, Outcome, QuestionType, Rollout, Tri, DECIDE_REFUSED,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The longest line the log holds, in UTF-8 bytes.
pub const DECIDE_LOG_LINE_MAX_BYTES: usize = 8192;
/// The longest arguments excerpt, in UTF-8 bytes, cut on a character boundary.
pub const DECIDE_ARGS_EXCERPT_MAX_BYTES: usize = 2048;
/// Days a decide log file is kept.
pub const DECIDE_LOG_RETENTION_DAYS: i64 = 30;
/// Decisions kept per rule for the drift alarm.
pub const DECIDE_STATS_KEEP: usize = 200;
/// Fewer kept decisions than this never raise drift.
pub const DECIDE_DRIFT_MIN_DECISIONS: usize = 20;
/// An escalation rate this far (absolute) from the eval run's is drift.
pub const DECIDE_DRIFT_ESCALATION_DELTA: f64 = 0.15;
/// At most one `decide.drift` per rule in this window.
pub const DECIDE_DRIFT_INTERVAL_MS: f64 = 86_400_000.0;
/// What a redacted match is replaced with.
pub const DECIDE_REDACTED: &str = "[REDACTED]";

const DAY_MS: i64 = 86_400_000;

// ─── Files and text ───────────────────────────────────────────────────

/// `decide-YYYY-MM-DD.jsonl` for the UTC date of `at_ms`; `kind` is
/// `decide`, or `decide-state` for raw states.
pub fn log_file_name(at_ms: i64, kind: &str) -> String {
    let day = chrono::DateTime::from_timestamp_millis(at_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d");
    format!("{kind}-{day}.jsonl")
}

/// The UTC midnight (epoch milliseconds) a decide log file name carries, or
/// `None` when the name is not one.
pub fn log_file_date(name: &str) -> Option<i64> {
    let rest = name.strip_prefix("decide-")?;
    let rest = rest.strip_prefix("state-").unwrap_or(rest);
    let day = rest.strip_suffix(".jsonl")?;
    let b = day.as_bytes();
    let shape = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    if !shape {
        return None;
    }
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

/// Deletes the decide log files under `dir` (raw-state files too) whose UTC
/// day ended more than [`DECIDE_LOG_RETENTION_DAYS`] days before `now_ms`.
/// Returns the names deleted; never fails.
pub fn prune_logs(dir: &Path, now_ms: i64) -> Vec<String> {
    let cutoff = now_ms - DECIDE_LOG_RETENTION_DAYS * DAY_MS;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(day) = log_file_date(&name) else {
            continue;
        };
        // A file's day ends at the next midnight; it is old once that end is past the cutoff.
        if day + DAY_MS <= cutoff && std::fs::remove_file(entry.path()).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// The patterns an arguments excerpt is redacted with: the gate's
/// credential-value patterns, then the PII detectors' regexes, as
/// `decideLogRedaction.ts` lists them. Assembled at run time so no
/// credential-shaped literal sits in this file.
pub fn redaction_sources() -> Vec<String> {
    let n = |class: &str, count: usize| class.repeat(count);
    vec![
        format!("(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA){}", n("[A-Z2-7]", 16)),
        format!("sk-ant-{}[A-Za-z0-9_-]*", n("[A-Za-z0-9_-]", 20)),
        format!("gh[pousr]_{}", n("[A-Za-z0-9]", 36)),
        format!("-----BEGIN [A-Z ]*{}-----", ["PRIVATE", "KEY"].join(" ")),
        format!("sk-or-v1-{}[A-Za-z0-9]*", n("[A-Za-z0-9]", 20)),
        format!("vk_{}", n("[a-f0-9]", 32)),
        format!("gwk_{}", n("[a-f0-9]", 64)),
        format!("sk_live_{}", n("[A-Za-z0-9]", 24)),
        "[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}|[0-9]{4}[ -][0-9]{6}[ -][0-9]{4,5}|[0-9]{13,19}"
            .to_string(),
        "[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}".to_string(),
        "[0-9]{3}-[0-9]{2}-[0-9]{4}".to_string(),
        r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}".to_string(),
        concat!(
            r"\+[1-9][0-9]{0,2}(?:[ .-]?\([0-9]{1,4}\)|[ .-]?[0-9]{1,4}){2,7}",
            r"|(?:1[ .-])?(?:\([2-9][0-9]{2}\) ?|[2-9][0-9]{2}[ .-])[2-9][0-9]{2}[ .-][0-9]{4}"
        )
        .to_string(),
    ]
}

fn compile(sources: &[String]) -> Vec<Regex> {
    sources.iter().filter_map(|s| Regex::new(s).ok()).collect()
}

fn default_regexes() -> &'static [Regex] {
    static R: OnceLock<Vec<Regex>> = OnceLock::new();
    R.get_or_init(|| compile(&redaction_sources()))
}

fn redact_with(text: &str, regexes: &[Regex]) -> String {
    let mut out = text.to_string();
    for re in regexes {
        out = re
            .replace_all(&out, regex::NoExpand(DECIDE_REDACTED))
            .into_owned();
    }
    out
}

/// `text` with every match of each source replaced by [`DECIDE_REDACTED`],
/// the sources applied in order. A source that does not compile is skipped.
pub fn redact(text: &str, sources: &[String]) -> String {
    redact_with(text, &compile(sources))
}

fn excerpt_with(input: &Value, regexes: &[Regex], max_bytes: usize) -> String {
    let json = if input.is_null() {
        "{}".to_string()
    } else {
        canonical_json(input)
    };
    utf8_prefix(&redact_with(&json, regexes), max_bytes).to_string()
}

/// The arguments as canonical JSON (`{}` for none), redacted with
/// `sources`, then cut to `max_bytes`.
pub fn args_excerpt(input: &Value, sources: &[String], max_bytes: usize) -> String {
    excerpt_with(input, &compile(sources), max_bytes)
}

// ─── The decision record ──────────────────────────────────────────────

/// What a record is about.
#[derive(Debug, Clone, Copy)]
pub enum LogSubject<'a> {
    ToolCall {
        tool: &'a str,
        tool_input: &'a Value,
        cwd: &'a str,
        last_user_turn: Option<&'a str>,
    },
    Response {
        content: &'a str,
        /// The response limit the state was built under.
        max_state_bytes: usize,
    },
}

/// The engine as a record names it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LogEngine {
    pub adapter: String,
    /// `host:port` of the engine URL; never its path, query or key.
    pub host: String,
    pub model: Option<String>,
    pub digest: Option<String>,
    pub digest_strength: Option<&'static str>,
    pub canary: Option<&'static str>,
}

impl LogEngine {
    fn to_value(&self) -> Value {
        json!({
            "adapter": self.adapter, "host": self.host, "model": self.model,
            "digest": self.digest, "digestStrength": self.digest_strength, "canary": self.canary,
        })
    }
}

/// `host:port` of an engine URL, as the log records it; empty when it does not parse.
pub fn engine_host(url: &str) -> String {
    let Ok(u) = reqwest::Url::parse(url) else {
        return String::new();
    };
    let host = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// One evaluation's context.
#[derive(Debug, Clone)]
pub struct LogContext<'a> {
    pub at_ms: i64,
    pub harness: &'a str,
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub subject: LogSubject<'a>,
    pub budget_ms: u64,
    pub latency_ms: u64,
    pub engine: LogEngine,
    /// The subject's reversibility class (`irreversible`, `reversible_wide`,
    /// `reversible_contained`), or `None`: calibrations and
    /// dashboards stratify by consequence with it.
    pub lane: Option<&'static str>,
    /// The subject's role-level revert or rejection rate from the workspace's
    /// revert history, or `None`.
    pub revert_rate: Option<f64>,
}

fn iso(at_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn tri(t: Tri) -> &'static str {
    match t {
        Tri::T => "T",
        Tri::F => "F",
        Tri::U => "U",
    }
}

fn rollout_str(r: Rollout) -> &'static str {
    match r {
        Rollout::Enforce => "enforce",
        Rollout::Shadow => "shadow",
    }
}

/// An outcome as the log and the stats spell it.
pub fn outcome_str(o: Outcome) -> &'static str {
    match o {
        Outcome::Allow => "allow",
        Outcome::Refuse => "refuse",
        Outcome::Escalate => "escalate",
        Outcome::Unavailable => "unavailable",
    }
}

/// The `q == o` atoms a `when` names, in order of appearance.
fn eq_atoms(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Eq(q, o) => {
            let key = format!("{q} == {o}");
            if !out.contains(&key) {
                out.push(key);
            }
        }
        Expr::Not(a) => eq_atoms(a, out),
        Expr::And(a, b) | Expr::Or(a, b) => {
            eq_atoms(a, out);
            eq_atoms(b, out);
        }
        Expr::Yes(_) => {}
    }
}

fn log_answer(rule: &DecideRule, name: &str, a: &EngineAnswer) -> Option<Value> {
    let q = rule.questions.get(name)?;
    let band = rule.question_band(name);
    let pair = json!([band.no_below, band.yes_at]);
    match q.kind {
        QuestionType::YesNo => {
            let value = a.p.map_or("U", |p| tri(band_value(p, band)));
            Some(json!({"type": "yes_no", "p": a.p, "pRaw": a.p, "value": value, "band": pair}))
        }
        QuestionType::Choice => {
            let atoms = choice_atoms(&q.asked_options(), &a.per_order, band);
            let mut used = Vec::new();
            eq_atoms(&rule.expr, &mut used);
            let prefix = format!("{name} == ");
            let p: Map<String, Value> =
                atoms.iter().map(|(o, c)| (o.clone(), json!(c.p))).collect();
            let spread: Map<String, Value> = atoms
                .iter()
                .map(|(o, c)| (o.clone(), json!(c.spread)))
                .collect();
            let named: Map<String, Value> = used
                .iter()
                .filter_map(|k| k.strip_prefix(&prefix).map(|o| (k, o)))
                .map(|(k, o)| {
                    let v = atoms.get(o).map_or("U", |c| tri(c.value));
                    (k.clone(), json!(v))
                })
                .collect();
            Some(json!({"type": "choice", "p": p, "spread": spread, "atoms": named, "band": pair}))
        }
    }
}

fn when_value(r: &RuleReport) -> Value {
    match r.outcome {
        Outcome::Unavailable => Value::Null,
        Outcome::Allow => json!("F"),
        _ if r.code == Some(DECIDE_REFUSED) => json!("T"),
        _ => json!("U"),
    }
}

/// sha256 of the exact state the engine was sent for `entry`, `sha256:<hex>`;
/// `None` when the state does not build (it was too large).
fn state_hash(entry: &RuleEntry, subject: &LogSubject<'_>) -> Option<String> {
    let state = match *subject {
        LogSubject::ToolCall {
            tool,
            tool_input,
            cwd,
            last_user_turn,
        } => build_tool_call_state(&ToolCallStateInput {
            rule_id: &entry.rule.id,
            sop_title: &entry.sop_title,
            rule_text: &entry.rule_text,
            tool,
            cwd,
            tool_input,
            last_user_turn: if entry.rule.context.iter().any(|c| c == "last_user_turn") {
                last_user_turn
            } else {
                None
            },
        }),
        LogSubject::Response {
            content,
            max_state_bytes,
        } => build_response_state(&entry.rule_text, content, max_state_bytes),
    }
    .ok()?;
    Some(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(state.as_bytes()))
    ))
}

/// The `decide.decision` record of one evaluation. `rules` are the entries
/// it was evaluated over; each rule's state is rebuilt from its entry and the
/// subject (it is deterministic) and hashed.
pub fn decision_record(eval: &Evaluation, rules: &[RuleEntry], ctx: &LogContext<'_>) -> Value {
    let logged: Vec<Value> = eval
        .rules
        .iter()
        .map(|rep| {
            let entry = rules.iter().find(|r| r.rule_ref == rep.rule_ref);
            let state = entry.and_then(|e| state_hash(e, &ctx.subject));
            let answers = match (entry, &rep.answers) {
                (Some(e), Some(answers)) => Value::Object(
                    answers
                        .iter()
                        .filter_map(|(name, a)| Some((name.clone(), log_answer(&e.rule, name, a)?)))
                        .collect(),
                ),
                _ => Value::Null,
            };
            json!({
                "ref": rep.rule_ref,
                "ruleHash": rep.rule_hash,
                "rollout": entry.map_or("shadow", |e| rollout_str(e.rollout)),
                "effective": rollout_str(rep.effective),
                "why": rep.why,
                "stateHash": state,
                "modelDigest": rep.model_digest,
                "answers": answers,
                "when": when_value(rep),
                "outcome": outcome_str(rep.outcome),
                "escalate": entry.map_or("ask", |e| e.rule.escalate.as_str()),
                "error": rep.error,
            })
        })
        .collect();
    let (tool, excerpt) = match ctx.subject {
        LogSubject::ToolCall {
            tool, tool_input, ..
        } => (
            tool,
            excerpt_with(tool_input, default_regexes(), DECIDE_ARGS_EXCERPT_MAX_BYTES),
        ),
        LogSubject::Response { content, .. } => (
            "",
            excerpt_with(
                &Value::String(content.to_string()),
                default_regexes(),
                DECIDE_ARGS_EXCERPT_MAX_BYTES,
            ),
        ),
    };
    json!({
        "v": 1,
        "event": "decide.decision",
        "at": iso(ctx.at_ms),
        "harness": ctx.harness,
        "workspaceId": ctx.workspace_id,
        "sessionId": ctx.session_id,
        "tool": tool,
        "stateHash": logged.first().map_or(Value::Null, |r| r["stateHash"].clone()),
        "argsExcerpt": excerpt,
        "engine": ctx.engine.to_value(),
        "budgetMs": ctx.budget_ms,
        "latencyMs": ctx.latency_ms,
        "outcome": outcome_str(eval.call.outcome),
        "code": eval.call.code,
        "rules": logged,
        "skipped": eval.skipped,
        "lane": ctx.lane,
        "revertRate": ctx.revert_rate,
    })
}

/// An event other than a decision, in the same envelope.
pub fn event_record(event: &str, ctx: &LogContext<'_>, body: Value) -> Value {
    let mut out = json!({
        "v": 1, "event": event, "at": iso(ctx.at_ms), "harness": ctx.harness,
        "workspaceId": ctx.workspace_id, "sessionId": ctx.session_id,
    });
    if let (Some(o), Value::Object(b)) = (out.as_object_mut(), body) {
        o.extend(b);
    }
    out
}

/// The record as one line (with its newline) of at most `max` bytes. Over
/// it, the arguments excerpt is shortened first, by halves down to nothing;
/// then each choice answer keeps only its atoms; then the answers go.
/// Whatever was cut, `truncated` says so.
pub fn log_line(record: &Value, max: usize) -> String {
    let fits = |r: &Value| {
        let line = format!("{}\n", canonical_json(r));
        (line.len() <= max).then_some(line)
    };
    if let Some(line) = fits(record) {
        return line;
    }
    let mut r = record.clone();
    if let Some(o) = r.as_object_mut() {
        o.insert("truncated".into(), Value::Bool(true));
    }
    if let Some(mut excerpt) = r
        .get("argsExcerpt")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        while !excerpt.is_empty() {
            excerpt = utf8_prefix(&excerpt, excerpt.len() / 2).to_string();
            r["argsExcerpt"] = Value::String(excerpt.clone());
            if let Some(line) = fits(&r) {
                return line;
            }
        }
        r["argsExcerpt"] = Value::String(String::new());
    }
    if let Some(rules) = r.get("rules").and_then(Value::as_array).cloned() {
        let slim: Vec<Value> = rules
            .into_iter()
            .map(|mut rule| {
                if let Some(o) = rule.as_object_mut() {
                    let answers = match o.get("answers").and_then(Value::as_object) {
                        Some(a) => Value::Object(
                            a.iter()
                                .map(|(n, x)| {
                                    let kept = if x.get("type").and_then(Value::as_str)
                                        == Some("choice")
                                    {
                                        json!({"type": "choice", "atoms": x.get("atoms"), "band": x.get("band")})
                                    } else {
                                        x.clone()
                                    };
                                    (n.clone(), kept)
                                })
                                .collect(),
                        ),
                        None => Value::Null,
                    };
                    o.insert("answers".into(), answers);
                }
                rule
            })
            .collect();
        r["rules"] = Value::Array(slim.clone());
        if let Some(line) = fits(&r) {
            return line;
        }
        let bare: Vec<Value> = slim
            .into_iter()
            .map(|mut rule| {
                if let Some(o) = rule.as_object_mut() {
                    o.insert("answers".into(), Value::Null);
                }
                rule
            })
            .collect();
        r["rules"] = Value::Array(bare);
        if let Some(line) = fits(&r) {
            return line;
        }
    }
    // Nothing smaller is a record; the envelope alone always fits.
    let mut envelope = Map::new();
    envelope.insert("v".into(), json!(1));
    for k in ["event", "at"] {
        if let Some(v) = record.get(k) {
            envelope.insert(k.into(), v.clone());
        }
    }
    envelope.insert("truncated".into(), Value::Bool(true));
    format!("{}\n", canonical_json(&Value::Object(envelope)))
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Appends one line to `dir/file` with a single write to a file opened for
/// append, mode 0600 in a 0700 directory. The day's first write (the file
/// does not exist yet) deletes the files past retention.
pub fn append_line(dir: &Path, file: &str, line: &str, now_ms: i64) -> std::io::Result<()> {
    create_private_dir(dir)?;
    let path = dir.join(file);
    if !path.exists() {
        let removed = prune_logs(dir, now_ms);
        if !removed.is_empty() {
            tracing::debug!(files = ?removed, "Deleted decide logs past retention");
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(line.as_bytes())
}

// ─── Drift ────────────────────────────────────────────────────────────

/// One kept decision: the rule's own outcome and each question's probability.
#[derive(Debug, Clone, PartialEq)]
pub struct StatsDecision {
    pub at_ms: f64,
    /// `allow`, `refuse` or `escalate`.
    pub outcome: String,
    pub p: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub rule_hash: String,
    pub decisions: Vec<StatsDecision>,
    /// When `decide.drift` last fired for this rule.
    pub last_drift_at_ms: Option<f64>,
}

/// What an eval run measured, as drift compares against it.
#[derive(Debug, Clone, PartialEq)]
pub struct Baseline {
    pub eval_run_id: String,
    pub escalation_rate: f64,
    /// Per question: the 10th and 90th percentile of its probability.
    pub questions: BTreeMap<String, (f64, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Drift {
    /// `escalation_rate` or `median_p`.
    pub measure: &'static str,
    pub question: Option<String>,
    pub value: f64,
    /// The run's escalation rate, or its `[p10, p90]`.
    pub expected: Value,
    pub threshold: Option<f64>,
    pub n: usize,
}

/// The probability a question's answer is tracked by: p(yes), or the top
/// option's averaged probability for a choice.
pub fn tracked_p(rule: &DecideRule, name: &str, a: &EngineAnswer) -> Option<f64> {
    let q = rule.questions.get(name)?;
    match q.kind {
        QuestionType::YesNo => a.p,
        QuestionType::Choice => {
            choice_atoms(&q.asked_options(), &a.per_order, rule.question_band(name))
                .values()
                .map(|c| c.p)
                .reduce(f64::max)
        }
    }
}

/// `stats` with `d` appended and only the last [`DECIDE_STATS_KEEP`] kept.
pub fn record_stats(stats: Option<Stats>, rule_hash: &str, d: StatsDecision) -> Stats {
    let mut s = match stats {
        Some(s) if s.rule_hash == rule_hash => s,
        _ => Stats {
            rule_hash: rule_hash.to_string(),
            decisions: Vec::new(),
            last_drift_at_ms: None,
        },
    };
    s.decisions.push(d);
    let extra = s.decisions.len().saturating_sub(DECIDE_STATS_KEEP);
    if extra > 0 {
        s.decisions = s.decisions.split_off(extra);
    }
    s
}

fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() / 2;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}

/// Whether the kept decisions have drifted from the eval run. `None` below
/// [`DECIDE_DRIFT_MIN_DECISIONS`], inside [`DECIDE_DRIFT_INTERVAL_MS`] of
/// the last drift, or when nothing moved. The escalation rate is checked
/// first, then each question in name order.
pub fn check_drift(stats: &Stats, run: &Baseline, now_ms: f64) -> Option<Drift> {
    let n = stats.decisions.len();
    if n < DECIDE_DRIFT_MIN_DECISIONS {
        return None;
    }
    if stats
        .last_drift_at_ms
        .is_some_and(|last| now_ms - last < DECIDE_DRIFT_INTERVAL_MS)
    {
        return None;
    }
    let escalations = stats
        .decisions
        .iter()
        .filter(|d| d.outcome == "escalate")
        .count();
    let rate = escalations as f64 / n as f64;
    if (rate - run.escalation_rate).abs() > DECIDE_DRIFT_ESCALATION_DELTA {
        return Some(Drift {
            measure: "escalation_rate",
            question: None,
            value: rate,
            expected: json!(run.escalation_rate),
            threshold: Some(DECIDE_DRIFT_ESCALATION_DELTA),
            n,
        });
    }
    for (name, (p10, p90)) in &run.questions {
        let ps: Vec<f64> = stats
            .decisions
            .iter()
            .filter_map(|d| d.p.get(name).copied())
            .collect();
        if ps.len() < DECIDE_DRIFT_MIN_DECISIONS {
            continue;
        }
        let m = median(&ps);
        if m < *p10 || m > *p90 {
            return Some(Drift {
                measure: "median_p",
                question: Some(name.clone()),
                value: m,
                expected: json!([p10, p90]),
                threshold: None,
                n: ps.len(),
            });
        }
    }
    None
}

fn stats_of(v: &Value, rule_hash: &str) -> Option<Stats> {
    if v.get("v").and_then(Value::as_u64) != Some(1)
        || v.get("ruleHash").and_then(Value::as_str) != Some(rule_hash)
    {
        return None;
    }
    let decisions = v
        .get("decisions")?
        .as_array()?
        .iter()
        .filter_map(|d| {
            let outcome = d.get("outcome")?.as_str()?;
            if !matches!(outcome, "allow" | "refuse" | "escalate") {
                return None;
            }
            let p = d
                .get("p")?
                .as_object()?
                .iter()
                .filter_map(|(k, x)| Some((k.clone(), x.as_f64()?)))
                .collect();
            Some(StatsDecision {
                at_ms: d.get("atMs")?.as_f64()?,
                outcome: outcome.to_string(),
                p,
            })
        })
        .collect();
    Some(Stats {
        rule_hash: rule_hash.to_string(),
        decisions,
        last_drift_at_ms: v.get("lastDriftAtMs").and_then(Value::as_f64),
    })
}

/// A rule's stats file, `dir/<ruleHash>.json`. A file that does not read is no stats.
pub fn read_stats(dir: &Path, rule_hash: &str) -> Option<Stats> {
    let text = std::fs::read_to_string(dir.join(format!("{rule_hash}.json"))).ok()?;
    stats_of(&serde_json::from_str(&text).ok()?, rule_hash)
}

/// Writes a rule's stats file whole, by a rename, mode 0600.
pub fn write_stats(dir: &Path, stats: &Stats) -> std::io::Result<()> {
    create_private_dir(dir)?;
    let doc = json!({
        "v": 1,
        "ruleHash": stats.rule_hash,
        "decisions": stats.decisions.iter().map(|d| json!({"atMs": d.at_ms, "outcome": d.outcome, "p": d.p})).collect::<Vec<_>>(),
        "lastDriftAtMs": stats.last_drift_at_ms,
    });
    let tmp = dir.join(format!(
        "{}.json.{}.{}.tmp",
        stats.rule_hash,
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(&tmp)?
        .write_all(format!("{}\n", canonical_json(&doc)).as_bytes())?;
    std::fs::rename(&tmp, dir.join(format!("{}.json", stats.rule_hash))).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The drift baseline of the eval run stored at
/// `decide_dir/evals/<ruleHash>/runs/<evalRunId>.json`, or `None` when there
/// is none, it does not read, or either name is not a plain file name.
pub fn read_eval_run_baseline(
    decide_dir: &Path,
    rule_hash: &str,
    eval_run_id: &str,
) -> Option<Baseline> {
    let hex = !rule_hash.is_empty()
        && rule_hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    let plain = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let run_ok = eval_run_id.bytes().next().is_some_and(plain)
        && eval_run_id.bytes().all(|c| plain(c) || c == b'.');
    if !hex || !run_ok {
        return None;
    }
    let path = decide_dir
        .join("evals")
        .join(rule_hash)
        .join("runs")
        .join(format!("{eval_run_id}.json"));
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let b = doc.get("baseline")?;
    let questions = b
        .get("questions")?
        .as_object()?
        .iter()
        .filter_map(|(k, q)| {
            Some((
                k.clone(),
                (q.get("p10")?.as_f64()?, q.get("p90")?.as_f64()?),
            ))
        })
        .collect();
    Some(Baseline {
        eval_run_id: b
            .get("evalRunId")
            .and_then(Value::as_str)
            .unwrap_or(eval_run_id)
            .to_string(),
        escalation_rate: b.get("escalationRate")?.as_f64()?,
        questions,
    })
}

// ─── One evaluation, written ──────────────────────────────────────────

/// Where the log and the stats go.
#[derive(Debug, Clone)]
pub struct LogDirs {
    /// `~/.intutic/logs`.
    pub logs: PathBuf,
    /// `~/.intutic/decide/stats`.
    pub stats: PathBuf,
    /// `~/.intutic/decide`, whose `evals/` holds the eval runs drift reads.
    pub decide: PathBuf,
}

impl LogDirs {
    /// Under `~/.intutic`.
    pub fn default_dirs() -> Self {
        let intutic = crate::paths::intutic_dir();
        Self {
            logs: intutic.join("logs"),
            stats: intutic.join("decide").join("stats"),
            decide: intutic.join("decide"),
        }
    }
}

/// What one evaluation wrote.
#[derive(Debug, Default)]
pub struct Written {
    /// Every line, in order, written or not.
    pub lines: Vec<String>,
    pub drifts: Vec<Drift>,
    /// The first write that failed.
    pub error: Option<std::io::Error>,
}

/// Writes one evaluation: its `decide.decision` line, a
/// `decide.canary_failed`, `decide.unavailable` or `decide.not_evaluated`
/// line when one applies, then each answered rule's stats, and a
/// `decide.drift` line for each rule that drifted from the eval run of the
/// pin it ran under. Nothing for an evaluation that asked nothing. A write
/// that fails is recorded and the rest still runs: the lines are returned
/// whole either way.
pub fn write_call_log(
    eval: &Evaluation,
    rules: &[RuleEntry],
    ctx: &LogContext<'_>,
    dirs: &LogDirs,
) -> Written {
    let mut out = Written::default();
    if eval.rules.is_empty() && eval.skipped.is_empty() && eval.call.outcome == Outcome::Allow {
        return out;
    }
    let file = log_file_name(ctx.at_ms, "decide");
    let append = |out: &mut Written, record: &Value| {
        let line = log_line(record, DECIDE_LOG_LINE_MAX_BYTES);
        if let Err(e) = append_line(&dirs.logs, &file, &line, ctx.at_ms) {
            out.error.get_or_insert(e);
        }
        out.lines.push(line);
    };
    append(&mut out, &decision_record(eval, rules, ctx));
    if eval.canary == Some(CanaryState::Failed) {
        append(
            &mut out,
            &event_record(
                "decide.canary_failed",
                ctx,
                json!({"engineHost": ctx.engine.host, "modelDigest": ctx.engine.digest}),
            ),
        );
    }
    let unavailable: Vec<Value> = eval
        .rules
        .iter()
        .filter(|r| r.outcome == Outcome::Unavailable)
        .map(
            |r| json!({"ref": r.rule_ref, "effective": rollout_str(r.effective), "error": r.error}),
        )
        .collect();
    if !unavailable.is_empty() {
        let tool = match ctx.subject {
            LogSubject::ToolCall { tool, .. } => tool,
            LogSubject::Response { .. } => "",
        };
        append(
            &mut out,
            &event_record(
                "decide.unavailable",
                ctx,
                json!({"tool": tool, "rules": unavailable}),
            ),
        );
    }
    let not_evaluated: Vec<Value> = eval
        .rules
        .iter()
        .filter(|r| r.why.as_deref() == Some("not_evaluated"))
        .map(|r| json!({"ref": r.rule_ref, "ruleHash": r.rule_hash}))
        .collect();
    if !not_evaluated.is_empty() {
        append(
            &mut out,
            &event_record(
                "decide.not_evaluated",
                ctx,
                json!({"modelDigest": ctx.engine.digest, "rules": not_evaluated}),
            ),
        );
    }

    for rep in &eval.rules {
        let Some(entry) = rules.iter().find(|r| r.rule_ref == rep.rule_ref) else {
            continue;
        };
        let Some(answers) = &rep.answers else {
            continue;
        };
        if rep.outcome == Outcome::Unavailable {
            continue;
        }
        let p: BTreeMap<String, f64> = answers
            .iter()
            .filter_map(|(name, a)| Some((name.clone(), tracked_p(&entry.rule, name, a)?)))
            .collect();
        let at = ctx.at_ms as f64;
        let mut stats = record_stats(
            read_stats(&dirs.stats, &rep.rule_hash),
            &rep.rule_hash,
            StatsDecision {
                at_ms: at,
                outcome: outcome_str(rep.outcome).to_string(),
                p,
            },
        );
        let pin = entry
            .pins
            .iter()
            .find(|x| Some(x.model_digest.as_str()) == rep.model_digest.as_deref());
        let run =
            pin.and_then(|x| read_eval_run_baseline(&dirs.decide, &rep.rule_hash, &x.eval_run_id));
        if let (Some(pin), Some(drift)) = (pin, run.and_then(|r| check_drift(&stats, &r, at))) {
            stats.last_drift_at_ms = Some(at);
            append(
                &mut out,
                &event_record(
                    "decide.drift",
                    ctx,
                    json!({
                        "ruleRef": rep.rule_ref, "ruleHash": rep.rule_hash, "modelDigest": rep.model_digest,
                        "evalRunId": pin.eval_run_id, "measure": drift.measure, "question": drift.question,
                        "value": drift.value, "expected": drift.expected, "threshold": drift.threshold, "n": drift.n,
                    }),
                ),
            );
            out.drifts.push(drift);
        }
        if let Err(e) = write_stats(&dirs.stats, &stats) {
            out.error.get_or_insert(e);
        }
    }
    out
}

// ─── Upload ───────────────────────────────────────────────────────────

/// How long one upload may take.
pub const DECIDE_UPLOAD_TIMEOUT_MS: u64 = 10_000;

/// The body of `POST /api/v1/decide/events` for `lines`, as the sync
/// daemon's upload sends them: each line's object, without its arguments
/// excerpt unless `with_args`; and `source: gateway`, which names who
/// decided.
pub fn upload_body(lines: &[String], with_args: bool) -> Value {
    let events: Vec<Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim_end()).ok())
        .filter(Value::is_object)
        .map(|mut row| {
            if !with_args {
                if let Some(o) = row.as_object_mut() {
                    o.remove("argsExcerpt");
                }
            }
            row
        })
        .collect();
    json!({ "events": events, "source": "gateway" })
}

/// Sends `body` to `{control_plane_url}/api/v1/decide/events` with the
/// request's virtual key. `Err` says why it did not land; nothing retries it.
#[cfg(feature = "control-plane")]
pub async fn upload(
    client: &reqwest::Client,
    control_plane_url: &str,
    virtual_key: &crate::credential::VirtualKey,
    body: &Value,
) -> Result<(), String> {
    let base = control_plane_url.trim_end_matches('/');
    let resp = virtual_key
        .authorize(client.post(format!("{base}/api/v1/decide/events")))
        .json(body)
        .timeout(std::time::Duration::from_millis(DECIDE_UPLOAD_TIMEOUT_MS))
        .send()
        .await
        .map_err(|e| format!("the decide log upload failed: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("the decide log upload returned {}", resp.status()))
    }
}

/// A build without the `control-plane` feature has nowhere to send the lines.
#[cfg(not(feature = "control-plane"))]
pub async fn upload(
    _client: &reqwest::Client,
    _control_plane_url: &str,
    _virtual_key: &crate::credential::VirtualKey,
    _body: &Value,
) -> Result<(), String> {
    Err("this build has no control-plane client".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `packages/shared-types/fixtures/decide-log-vectors.json`, which the
    /// TypeScript and Python ports run too.
    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../shared-types/fixtures/decide-log-vectors.json"
        ))
        .expect("the vectors parse")
    }

    #[test]
    fn the_redaction_sources_are_the_vectors() {
        let v = vectors();
        let want: Vec<String> = v["redactionSources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(redaction_sources(), want);
        // Every one compiles here, as in the other ports.
        assert_eq!(default_regexes().len(), want.len());
    }

    #[test]
    fn file_names_follow_the_vectors() {
        for c in vectors()["fileNames"].as_array().unwrap() {
            let at = c["atMs"].as_i64().unwrap();
            let name = c["name"].as_str().unwrap();
            assert_eq!(log_file_name(at, c["kind"].as_str().unwrap()), name);
            let day = log_file_date(name).expect("a log file name");
            assert_eq!(day, at - at.rem_euclid(DAY_MS), "{name}");
        }
        assert_eq!(log_file_date("decide-2026-1-01.jsonl"), None);
        assert_eq!(log_file_date("decision-traffic-2026-10-01.jsonl"), None);
        assert_eq!(log_file_date("decide-2026-13-01.jsonl"), None);
    }

    #[test]
    fn excerpts_follow_the_vectors() {
        let v = vectors();
        let sources: Vec<String> = v["redactionSources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        for c in v["excerpt"].as_array().unwrap() {
            let max = c["maxBytes"].as_u64().unwrap() as usize;
            assert_eq!(
                args_excerpt(&c["toolInput"], &sources, max),
                c["excerpt"].as_str().unwrap(),
                "{}",
                c["name"]
            );
        }
    }

    #[test]
    fn drift_follows_the_vectors() {
        for c in vectors()["drift"].as_array().unwrap() {
            let b = &c["baseline"];
            let run = Baseline {
                eval_run_id: b["evalRunId"].as_str().unwrap().to_string(),
                escalation_rate: b["escalationRate"].as_f64().unwrap(),
                questions: b["questions"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, q)| {
                        (
                            k.clone(),
                            (q["p10"].as_f64().unwrap(), q["p90"].as_f64().unwrap()),
                        )
                    })
                    .collect(),
            };
            let mut stats: Option<Stats> = None;
            let mut fires = Vec::new();
            for (i, d) in c["stream"].as_array().unwrap().iter().enumerate() {
                let decision = StatsDecision {
                    at_ms: d["atMs"].as_f64().unwrap(),
                    outcome: d["outcome"].as_str().unwrap().to_string(),
                    p: d["p"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, x)| (k.clone(), x.as_f64().unwrap()))
                        .collect(),
                };
                let at = decision.at_ms;
                let mut s = record_stats(stats.take(), "r", decision);
                if let Some(drift) = check_drift(&s, &run, at) {
                    s.last_drift_at_ms = Some(at);
                    fires.push(json!({"index": i, "measure": drift.measure, "question": drift.question, "n": drift.n}));
                }
                stats = Some(s);
            }
            assert_eq!(Value::Array(fires), c["fires"], "{}", c["name"]);
            if let Some(kept) = c.get("kept").and_then(Value::as_u64) {
                assert_eq!(stats.unwrap().decisions.len() as u64, kept, "{}", c["name"]);
            }
        }
    }

    #[test]
    fn redaction_replaces_credentials_and_skips_a_bad_pattern() {
        // Assembled at run time: no credential-shaped literal sits in this file.
        let key = ["AKIA", "B2C3D4E5F6G7H2J3"].concat();
        let ant = ["sk-ant-", "api03-", "abcdefghijklmnop"].concat();
        let text = redact(&format!("aws {key} and {ant} end"), &redaction_sources());
        assert_eq!(
            text,
            format!("aws {DECIDE_REDACTED} and {DECIDE_REDACTED} end")
        );
        assert_eq!(
            redact("abc", &["(".to_string(), "b".to_string()]),
            format!("a{DECIDE_REDACTED}c")
        );
    }

    #[test]
    fn the_line_cap_shortens_the_excerpt_then_the_answers() {
        let record = json!({"v": 1, "event": "decide.decision", "at": "x", "argsExcerpt": "a".repeat(20_000), "rules": []});
        let line = log_line(&record, DECIDE_LOG_LINE_MAX_BYTES);
        assert!(line.len() <= DECIDE_LOG_LINE_MAX_BYTES);
        let back: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(back["truncated"], true);
        assert!(!back["argsExcerpt"].as_str().unwrap().is_empty());
        assert_eq!(back["rules"], json!([]));

        let options: Map<String, Value> = (0..300)
            .map(|i| (format!("option_{i}"), json!(0.001)))
            .collect();
        let rule = json!({"ref": "r", "answers": {"dest": {"type": "choice", "p": options, "spread": options, "atoms": {"dest == a": "F"}, "band": [0.15, 0.85]}}});
        let back: Value = serde_json::from_str(&log_line(
            &json!({"v": 1, "event": "decide.decision", "argsExcerpt": "", "rules": [rule]}),
            DECIDE_LOG_LINE_MAX_BYTES,
        ))
        .unwrap();
        assert_eq!(back["truncated"], true);
        assert_eq!(
            back["rules"][0]["answers"]["dest"],
            json!({"type": "choice", "atoms": {"dest == a": "F"}, "band": [0.15, 0.85]})
        );
        assert_eq!(
            log_line(&json!({"v": 1, "a": "b"}), 100),
            "{\"a\":\"b\",\"v\":1}\n"
        );
    }

    #[test]
    fn the_days_first_write_prunes_files_past_thirty_days() {
        let dir = std::env::temp_dir().join(format!("intutic-decide-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "decide-2026-09-01.jsonl",
            "decide-state-2026-09-01.jsonl",
            "decide-2026-10-01.jsonl",
            "decide-upload.cursor",
            "decision-traffic-2026-09-01.jsonl",
            "traces-2026-09-01.jsonl",
        ] {
            std::fs::write(dir.join(name), "{}\n").unwrap();
        }
        // 2026-10-31T12:00Z.
        let now = log_file_date("decide-2026-10-31.jsonl").unwrap() + DAY_MS / 2;
        append_line(&dir, &log_file_name(now, "decide"), "{\"v\":1}\n", now).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "decide-2026-10-01.jsonl",
                "decide-2026-10-31.jsonl",
                "decide-upload.cursor",
                "decision-traffic-2026-09-01.jsonl",
                "traces-2026-09-01.jsonl",
            ]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join("decide-2026-10-31.jsonl"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A later write the same day prunes nothing more.
        std::fs::write(dir.join("decide-2026-09-02.jsonl"), "{}\n").unwrap();
        append_line(&dir, &log_file_name(now, "decide"), "{\"v\":1}\n", now).unwrap();
        assert!(dir.join("decide-2026-09-02.jsonl").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stats_round_trip_and_keep_the_last_two_hundred() {
        let dir =
            std::env::temp_dir().join(format!("intutic-decide-stats-{}", uuid::Uuid::new_v4()));
        let mut stats = None;
        for i in 0..205 {
            stats = Some(record_stats(
                stats,
                "ab",
                StatsDecision {
                    at_ms: i as f64,
                    outcome: "allow".into(),
                    p: BTreeMap::from([("q".to_string(), 0.25)]),
                },
            ));
        }
        let stats = stats.unwrap();
        assert_eq!(stats.decisions.len(), DECIDE_STATS_KEEP);
        assert_eq!(stats.decisions[0].at_ms, 5.0);
        write_stats(&dir, &stats).unwrap();
        assert_eq!(read_stats(&dir, "ab"), Some(stats));
        // Another rule's file is not this rule's stats.
        assert_eq!(read_stats(&dir, "cd"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_upload_body_drops_the_excerpt_unless_asked() {
        let lines = vec![
            "{\"argsExcerpt\":\"x\",\"event\":\"decide.decision\",\"v\":1}\n".to_string(),
            "not json\n".to_string(),
        ];
        assert_eq!(
            upload_body(&lines, false),
            json!({"events": [{"event": "decide.decision", "v": 1}], "source": "gateway"})
        );
        assert_eq!(upload_body(&lines, true)["events"][0]["argsExcerpt"], "x");
    }

    #[test]
    fn the_engine_host_is_host_and_port_only() {
        assert_eq!(
            engine_host("http://127.0.0.1:11434/v1?x=1"),
            "127.0.0.1:11434"
        );
        assert_eq!(engine_host("https://models.internal/v1"), "models.internal");
        assert_eq!(engine_host("not a url"), "");
    }
}
