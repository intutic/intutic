//! Customer calls to decision models, governed like LLM calls.
//!
//! An app asks a decision model narrow questions about a state ("approve this
//! refund?", "which queue takes this ticket?") and gets a probability per
//! question back. Two wire formats carry these calls: System One
//! (`POST /v1/systemone`: TypeSafe, Fastino, self-hosted Kev, Laya or LiteLLM)
//! and OpenAI Decisions (`POST /v1/decisions`). `crate::protocol` parses both
//! into one normalised shape; this module governs the call:
//!
//! - **Before the call**, in order: DLP on the state (`state` or `input`),
//!   which redacts or refuses exactly as it does for a prompt; the egress
//!   policy on the upstream host; and the version pin, which refuses a moving
//!   alias such as `jev-latest`, or a model with no version, unless
//!   `decision_traffic.allow_unpinned` is set (in `shadow` mode it logs
//!   `would_refuse_unpinned` and forwards); then a standalone proxy's own
//!   daily cap. The workspace and key budgets and the model allowlist run
//!   earlier, in `proxy::handle_proxy`, as for any LLM call.
//! - **After the call**: a question whose top probability is under its floor
//!   (`decision_traffic.floors`) is named in `x-intutic-decision-abstain`, and
//!   a call marked consequential (`x-intutic-decision-consequential: 1` on the
//!   request, or a model in `consequential_models`) gets
//!   `x-intutic-decision-requires-human: 1`. The body is never rewritten.
//! - **Metering**: a forwarded call publishes one trace, so it is one Governed
//!   Request, priced from the offline bundle (`metering::decision_call_cost`).
//! - **The decision-traffic log**: one record per call, refused or forwarded,
//!   in `~/.intutic/logs/decision-traffic-YYYY-MM-DD.jsonl` (UTC date, mode
//!   0600) on a local proxy, and on the call's trace. It is named apart from
//!   the governance decisions log, which records a workspace's own rulings.
//!   Files are kept for 30 days, as the decide log is: the first write of each
//!   day deletes the ones past that ([`prune_logs`]).
//!
//! This is the customer's traffic, sent where the customer sends it. The
//! hosted-host guard that keeps Intutic's own decide engine self-hosted
//! (`decide::guard`) does not apply here.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::{DecisionTrafficConfig, DecisionTrafficMode};
use crate::credential::RequestCredential;
use crate::egress_policy::{EgressDecision, EgressPolicy};
use crate::metering::VirtualKeyRecord;
use crate::protocol::{Answer, DecisionFormat, DecisionQuestion, DecisionRequest};
use crate::proxy::AppState;

/// Request header: the app marks this call as consequential.
pub const CONSEQUENTIAL_HEADER: &str = "x-intutic-decision-consequential";
/// Response header: the questions answered below their floor, comma separated.
pub const ABSTAIN_HEADER: &str = "x-intutic-decision-abstain";
/// Response header: a person must act before the app does.
pub const REQUIRES_HUMAN_HEADER: &str = "x-intutic-decision-requires-human";

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

/// What a model name says about the weights that will answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pin {
    /// A version token follows the family name: `jev-1.14.0`, `kev-4b`.
    Pinned,
    /// `latest`, `stable`, `current` or `default` at the end of the name.
    MovingAlias,
    /// No token after the family name carries a digit: `jev-preview`, `jev`.
    NoVersion,
}

static MOVING_ALIAS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(^|[-:/@])(latest|stable|current|default)$").expect("alias pattern")
});

/// Whether `model` names fixed weights. A version token is any part of the
/// name after the first (split on `-`, `:`, `/`, `@` and `_`) that holds a
/// digit.
pub fn model_pin(model: &str) -> Pin {
    let model = model.trim();
    if MOVING_ALIAS.is_match(model) {
        return Pin::MovingAlias;
    }
    let versioned = model
        .split(['-', ':', '/', '@', '_'])
        .skip(1)
        .any(|t| t.bytes().any(|b| b.is_ascii_digit()));
    if versioned {
        Pin::Pinned
    } else {
        Pin::NoVersion
    }
}

// ---------------------------------------------------------------------------
// Upstream
// ---------------------------------------------------------------------------

/// Where a decision call goes, and whose API that is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecisionRoute {
    /// The full URL, path included.
    pub url: String,
    pub host: String,
    /// `typesafe`, `fastino`, `openai`, or `other` (a self-hosted server or
    /// a gateway).
    pub provider: &'static str,
}

/// The decision-model providers this proxy forwards customer calls to: the
/// `kind: 'decision'` entries of the shared provider registry
/// (`packages/shared-types/src/providers.ts`), whose `{id}_config` key a call
/// made with a virtual key is sent with.
pub const DECISION_PROVIDERS: &[&str] = &["typesafe", "fastino"];

/// The provider a host belongs to.
pub fn provider_for_host(host: &str) -> &'static str {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let under = |domain: &str| h == domain || h.ends_with(&format!(".{domain}"));
    if under("typesafe.ai") {
        "typesafe"
    } else if under("fastino.ai") {
        "fastino"
    } else if under("openai.com") {
        "openai"
    } else {
        "other"
    }
}

/// The upstream for a call. First that applies:
/// 1. the `Host` the call was addressed to, when it names an AI provider
///    host (an intercepted HTTPS call keeps its destination);
/// 2. `decision_traffic.systemone_upstream` / `decisions_upstream`;
/// 3. `UPSTREAM_URL`, the one gateway for every provider;
/// 4. TypeSafe's API for System One, OpenAI's for Decisions.
///
/// `var` is the environment lookup, passed in for tests.
pub fn route(
    format: DecisionFormat,
    cfg: &DecisionTrafficConfig,
    host_name: &str,
    var: impl Fn(&str) -> Option<String>,
) -> DecisionRoute {
    let configured = match format {
        DecisionFormat::SystemOne => cfg.systemone_upstream.clone(),
        DecisionFormat::Decisions => cfg.decisions_upstream.clone(),
    };
    let base = if !host_name.is_empty() && crate::hostname_filter::is_ai_provider_host(host_name) {
        format!("https://{host_name}")
    } else {
        configured
            .filter(|u| !u.trim().is_empty())
            .or_else(|| var("UPSTREAM_URL").filter(|u| !u.trim().is_empty()))
            .unwrap_or_else(|| {
                match format {
                    DecisionFormat::SystemOne => "https://api.typesafe.ai",
                    DecisionFormat::Decisions => "https://api.openai.com",
                }
                .to_string()
            })
    };
    let base = base.trim().trim_end_matches('/');
    let url = format!("{base}{}", format.path());
    let host = reqwest::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    DecisionRoute {
        provider: provider_for_host(&host),
        url,
        host,
    }
}

/// The egress verdict on the upstream: `Err` refuses the call (the policy
/// denies the host, or the URL has none), `Ok(true)` forwards it while
/// logging that enforcement would refuse it.
pub fn egress_check(policy: &EgressPolicy, url: &str) -> Result<bool, String> {
    match policy.decide_url(url) {
        None => Err(format!("the decision upstream {url} has no host")),
        Some(EgressDecision::Deny) => Err(format!(
            "the egress policy does not allow the decision upstream {}",
            reqwest::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default()
        )),
        Some(EgressDecision::WouldDeny) => Ok(true),
        Some(EgressDecision::Mitm | EgressDecision::Allow) => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// After the call
// ---------------------------------------------------------------------------

/// The floor each question is held to (its own, else `*`), and the questions
/// whose top probability is under it, in question order. A question with no
/// probability (a refusal, a box, an unreadable answer) is under any floor.
pub fn floors_below(
    questions: &[DecisionQuestion],
    answers: &BTreeMap<String, Answer>,
    floors: &BTreeMap<String, f64>,
) -> (BTreeMap<String, f64>, Vec<String>) {
    let mut applied = BTreeMap::new();
    let mut below = Vec::new();
    for q in questions {
        let Some(floor) = floors.get(&q.name).or_else(|| floors.get("*")).copied() else {
            continue;
        };
        applied.insert(q.name.clone(), floor);
        let top = answers.get(&q.name).and_then(Answer::top_probability);
        if top.is_none_or(|p| p < floor) {
            below.push(q.name.clone());
        }
    }
    (applied, below)
}

/// Whether the call needs a person before the app acts on it.
pub fn is_consequential(headers: &HeaderMap, model: &str, cfg: &DecisionTrafficConfig) -> bool {
    let marked = headers
        .get(CONSEQUENTIAL_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true"));
    marked
        || cfg
            .consequential_models
            .iter()
            .any(|m| m.trim().eq_ignore_ascii_case(model.trim()))
}

/// The abstain header's value: question names, comma separated, each with
/// any byte outside `[A-Za-z0-9._~-]` percent-encoded so a name cannot break
/// the list or the header.
pub fn abstain_header_value(names: &[String]) -> String {
    names
        .iter()
        .map(|n| {
            n.bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-') {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(",")
}

// ---------------------------------------------------------------------------
// The decision-traffic log
// ---------------------------------------------------------------------------

/// What happened to a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Forwarded,
    RefusedDlp,
    RefusedEgress,
    RefusedUnpinned,
    RefusedBudget,
}

/// What DLP did to the state.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DlpSummary {
    /// `none`, `redact` or `refuse`.
    pub action: &'static str,
    /// The patterns that matched.
    pub detectors: Vec<String>,
}

/// One decision call, as the decision-traffic log and the call's trace hold
/// it. The raw state is never kept: its hash and size are.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTrafficRecord {
    pub v: u8,
    pub at: String,
    pub trace_id: String,
    pub workspace_id: String,
    pub virtual_key_id: String,
    pub format: DecisionFormat,
    pub provider: String,
    pub upstream_host: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_version: Option<String>,
    pub pinned: bool,
    /// `sha256:<hex>` of the state bytes as they were sent (after redaction).
    pub state_hash: String,
    pub state_bytes: usize,
    pub dlp: DlpSummary,
    pub questions: Vec<DecisionQuestion>,
    /// Per question: p(yes), or a probability per option; `null` unanswered.
    pub probabilities: BTreeMap<String, Answer>,
    /// The floor each question was held to.
    pub floors: BTreeMap<String, f64>,
    pub below_floor: Vec<String>,
    pub consequential: bool,
    pub action: Action,
    /// The status the app received.
    pub status: u16,
    pub latency_ms: u64,
    /// What enforcement would have refused: `would_refuse_unpinned`,
    /// `would_refuse_egress`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shadow: Vec<&'static str>,
}

/// Records past this size in one day's file are dropped, not rotated.
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

/// How many days a decision-traffic log is kept: the decide log's retention.
pub const LOG_RETENTION_DAYS: i64 = 30;

/// The UTC day a decision-traffic log's file name carries, or `None` when the
/// name is not one.
fn log_file_day(name: &str) -> Option<chrono::NaiveDate> {
    let day = name
        .strip_prefix("decision-traffic-")?
        .strip_suffix(".jsonl")?;
    if day.len() != 10 {
        return None;
    }
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
}

/// Deletes the decision-traffic logs under `dir` older than
/// [`LOG_RETENTION_DAYS`] at `now`, by the decide log's rule: a file's day
/// ends at the next UTC midnight, and the file goes once that end is
/// `LOG_RETENTION_DAYS` days past. Other files are left alone. Returns the
/// names deleted; never fails.
pub fn prune_logs(dir: &std::path::Path, now: chrono::DateTime<chrono::Utc>) -> Vec<String> {
    let cutoff = now - chrono::Duration::days(LOG_RETENTION_DAYS);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(day) = log_file_day(&name) else {
            continue;
        };
        let end = (day + chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .map(|t| t.and_utc());
        if end.is_some_and(|end| end <= cutoff) && std::fs::remove_file(entry.path()).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// The day's log file under `dir` (`decision-traffic-YYYY-MM-DD.jsonl`, UTC).
pub fn log_path(dir: &std::path::Path, now: chrono::DateTime<chrono::Utc>) -> std::path::PathBuf {
    dir.join(format!("decision-traffic-{}.jsonl", now.format("%Y-%m-%d")))
}

/// Appends `record` to the day's log under `dir`, in one write, creating the
/// file with mode 0600. The day's first write deletes the logs past
/// retention ([`prune_logs`]).
pub fn append_log(dir: &std::path::Path, record: &DecisionTrafficRecord) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let now = chrono::Utc::now();
    let path = log_path(dir, now);
    if !path.exists() {
        let removed = prune_logs(dir, now);
        if !removed.is_empty() {
            tracing::debug!(files = ?removed, "Deleted decision-traffic logs past retention");
        }
    }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= MAX_LOG_BYTES) {
        return Ok(());
    }
    let mut line = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(&line)
}

/// Writes the record to this machine's log. A shared gateway keeps it on the
/// call's trace only: its disk is no one's machine.
fn write_log(record: &DecisionTrafficRecord) {
    if crate::proxy::is_shared_gateway_env() {
        return;
    }
    let dir = crate::paths::intutic_dir().join("logs");
    if let Err(e) = append_log(&dir, record) {
        tracing::warn!(error = %e, "decision-traffic log not written");
    }
}

fn state_hash(state: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(state.as_bytes())))
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/// The request, as `proxy::handle_proxy` has it once the caller is
/// authenticated and the budgets have passed.
pub(crate) struct Call<'a> {
    pub state: &'a AppState,
    pub format: DecisionFormat,
    pub headers: &'a HeaderMap,
    pub credential: &'a RequestCredential,
    pub key_record: Option<&'a VirtualKeyRecord>,
    pub workspace_id: &'a str,
    pub key_prefix: &'a str,
    pub session_id: &'a str,
    /// The `x-intutic-harness` the app named, else `decision-traffic`.
    pub harness_type: &'a str,
    pub body: Value,
    /// The PII policy the request direction is scanned with; `None` when
    /// nothing scans it (`dlp::direction_scan`).
    pub input_dlp: Option<Option<Arc<crate::dlp::PiiPolicy>>>,
    pub started: Instant,
    pub tpm_key_id: Option<&'a str>,
    pub loop_run_id: Option<String>,
}

fn error(status: StatusCode, error_type: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error": { "type": error_type, "message": message } });
    (status, axum::Json(body)).into_response()
}

fn host_name(headers: &HeaderMap) -> &str {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    host.split(':').next().unwrap_or(host)
}

/// The record for a call before anything is known of its outcome.
fn record_for(
    format: DecisionFormat,
    request: &DecisionRequest,
    route: &DecisionRoute,
    workspace_id: &str,
    key_prefix: &str,
    consequential: bool,
) -> DecisionTrafficRecord {
    DecisionTrafficRecord {
        v: 1,
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        trace_id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        virtual_key_id: key_prefix.to_string(),
        format,
        provider: route.provider.to_string(),
        upstream_host: route.host.clone(),
        model: request.model.clone(),
        model_version: None,
        pinned: model_pin(&request.model) == Pin::Pinned,
        state_hash: state_hash(&request.state),
        state_bytes: request.state.len(),
        dlp: DlpSummary {
            action: "none",
            detectors: Vec::new(),
        },
        questions: request.questions.clone(),
        probabilities: BTreeMap::new(),
        floors: BTreeMap::new(),
        below_floor: Vec::new(),
        consequential,
        action: Action::Forwarded,
        status: 0,
        latency_ms: 0,
        shadow: Vec::new(),
    }
}

/// The pre-call budget estimate for a decision call: its body's size as
/// input tokens (four bytes each), priced as the call will be. A decision
/// model generates no text, so no output is estimated.
pub(crate) fn estimated_cost(
    cfg: &DecisionTrafficConfig,
    format: DecisionFormat,
    headers: &HeaderMap,
    model: &str,
    body_bytes: usize,
) -> f64 {
    let route = route(format, cfg, host_name(headers), |n| std::env::var(n).ok());
    let tokens = u32::try_from(body_bytes / 4).unwrap_or(u32::MAX).max(1);
    crate::metering::decision_call_cost(route.provider, model, tokens, 0)
}

/// Logs a decision call `handle_proxy` refused before reaching [`handle`]
/// (a spend budget). A body that does not parse is not logged: it never
/// was a decision call.
#[allow(clippy::too_many_arguments)]
pub(crate) fn note_refusal(
    state: &AppState,
    format: DecisionFormat,
    headers: &HeaderMap,
    body: &Value,
    workspace_id: &str,
    key_prefix: &str,
    action: Action,
    status: StatusCode,
    started: Instant,
) {
    let Ok(request) = format.parse_request(body) else {
        return;
    };
    let cfg = &state.config.intutic_settings.decision_traffic;
    let route = route(format, cfg, host_name(headers), |n| std::env::var(n).ok());
    let mut record = record_for(
        format,
        &request,
        &route,
        workspace_id,
        key_prefix,
        is_consequential(headers, &request.model, cfg),
    );
    record.action = action;
    record.status = status.as_u16();
    record.latency_ms = started.elapsed().as_millis() as u64;
    write_log(&record);
}

/// Headers never forwarded upstream: the caller's credential (replaced or
/// passed through below), hop-by-hop headers, and Intutic's own.
fn forwardable(name: &str) -> bool {
    !(matches!(
        name,
        "host"
            | "authorization"
            | "x-api-key"
            | "content-length"
            // The answer is read for its probabilities, so it must arrive
            // uncompressed; the app gets it uncompressed too.
            | "accept-encoding"
            | "connection"
            | "transfer-encoding"
            | "keep-alive"
            | "upgrade"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "cookie"
            | "x-workspace-id"
            | "x-session-id"
    ) || name.starts_with("x-intutic-"))
}

/// The upstream credential for a call made with a virtual key: the
/// workspace's provisioned key for the provider, else the operator's
/// environment key unless the workspace must bring its own. A self-hosted
/// or gateway upstream (`other`) gets none.
async fn provider_credential(
    state: &AppState,
    provider: &str,
    workspace_id: &str,
    require_provisioned: bool,
) -> Option<String> {
    match provider {
        "openai" => {
            crate::proxy::openai_credential(&state.store, workspace_id, require_provisioned).await
        }
        "typesafe" | "fastino" => {
            let field = format!("{provider}_config");
            let stored = state
                .store
                .workspace_credential(workspace_id, &[field.as_str()])
                .await
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.get("apiKey").and_then(Value::as_str).map(str::to_string))
                .filter(|k| !k.is_empty());
            if stored.is_some() || require_provisioned {
                return stored;
            }
            let env = if provider == "typesafe" {
                "TYPESAFE_API_KEY"
            } else {
                "FASTINO_API_KEY"
            };
            std::env::var(env).ok().filter(|k| !k.is_empty())
        }
        _ => None,
    }
}

/// Governs one decision call and forwards it.
pub(crate) async fn handle(call: Call<'_>) -> Response {
    let Call {
        state,
        format,
        headers,
        credential,
        key_record,
        workspace_id,
        key_prefix,
        session_id,
        harness_type,
        mut body,
        input_dlp,
        started,
        tpm_key_id,
        loop_run_id,
    } = call;
    let cfg = &state.config.intutic_settings.decision_traffic;

    let mut request = match format.parse_request(&body) {
        Ok(r) => r,
        Err(reason) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                &format!("Not a {} decision request: {reason}", format.as_str()),
            )
        }
    };
    let route = route(format, cfg, host_name(headers), |n| std::env::var(n).ok());
    let consequential = is_consequential(headers, &request.model, cfg);
    let mut record = record_for(
        format,
        &request,
        &route,
        workspace_id,
        key_prefix,
        consequential,
    );
    let refuse = |mut record: DecisionTrafficRecord,
                  action: Action,
                  status: StatusCode,
                  code: &str,
                  message: &str| {
        record.action = action;
        record.status = status.as_u16();
        record.latency_ms = started.elapsed().as_millis() as u64;
        tracing::warn!(
            workspace_id = %workspace_id,
            model = %record.model,
            action = ?action,
            "decision call refused: {message}"
        );
        write_log(&record);
        error(status, code, message)
    };

    // ── DLP on the state ────────────────────────────────────────────────
    if let Some(pii) = &input_dlp {
        if let Some(value) = body.get_mut(format.state_field()) {
            let findings = crate::dlp::scan_and_redact_json(value, pii.as_deref());
            if !findings.is_empty() {
                let mut detectors: Vec<String> =
                    findings.iter().map(|f| f.pattern_name.clone()).collect();
                detectors.sort();
                detectors.dedup();
                record.dlp.detectors = detectors;
                if findings.iter().any(|f| f.action == "block") {
                    record.dlp.action = "refuse";
                    crate::metrics::record_policy_refusal("decision_dlp", "kill");
                    return refuse(
                        record,
                        Action::RefusedDlp,
                        StatusCode::BAD_REQUEST,
                        "dlp_policy_violation",
                        "Request body contains content blocked by DLP policy (e.g., private keys). Remove the sensitive content and retry.",
                    );
                }
                if findings.iter().any(|f| f.action == "redact") {
                    record.dlp.action = "redact";
                    request.state = crate::protocol::state_text(value);
                    record.state_hash = state_hash(&request.state);
                    record.state_bytes = request.state.len();
                }
            }
        }
    }

    // ── Egress policy on the upstream ───────────────────────────────────
    match egress_check(&crate::egress_policy::global_policy(), &route.url) {
        Err(reason) => {
            crate::egress_policy::record_denied();
            crate::metrics::record_policy_refusal("decision_egress", "kill");
            return refuse(
                record,
                Action::RefusedEgress,
                StatusCode::FORBIDDEN,
                "policy_denied",
                &format!("Request blocked: {reason}."),
            );
        }
        Ok(true) => {
            crate::egress_policy::record_would_deny();
            record.shadow.push("would_refuse_egress");
        }
        Ok(false) => {}
    }

    // ── Version pin ─────────────────────────────────────────────────────
    let pin = model_pin(&request.model);
    if pin != Pin::Pinned && !cfg.allow_unpinned {
        if cfg.mode == DecisionTrafficMode::Enforce {
            crate::metrics::record_policy_refusal("decision_unpinned", "kill");
            let why = if pin == Pin::MovingAlias {
                "is a moving alias"
            } else {
                "names no version"
            };
            return refuse(
                record,
                Action::RefusedUnpinned,
                StatusCode::FORBIDDEN,
                "policy_denied",
                &format!(
                    "Request blocked: the decision model {:?} {why}, so the weights that answer can change without notice. \
                     Name a pinned version, or set decision_traffic.allow_unpinned.",
                    request.model
                ),
            );
        }
        record.shadow.push("would_refuse_unpinned");
    }

    let bytes = match serde_json::to_vec(&body) {
        Ok(b) => b,
        Err(e) => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                &format!("The decision request could not be re-encoded: {e}"),
            )
        }
    };

    // ── The machine's own daily cap (a standalone proxy) ────────────────
    // The workspace and key budgets ran in `handle_proxy`; this is the cap
    // the budget gate holds an LLM call to, with the same 20% margin.
    if crate::proxy::machine_budget_applies() {
        let remaining = (crate::local_spend::get_max_daily_budget()
            - crate::local_spend::get_local_spend())
        .max(0.0);
        let tokens = u32::try_from(bytes.len() / 4).unwrap_or(u32::MAX);
        let estimate =
            crate::metering::decision_call_cost(route.provider, &request.model, tokens, 0) * 1.2;
        if estimate > remaining {
            if crate::proxy::local_budget_enforced() {
                return refuse(
                    record,
                    Action::RefusedBudget,
                    StatusCode::TOO_MANY_REQUESTS,
                    "OVERAGE_HARD_CAP_EXCEEDED",
                    &format!(
                        "Daily spend cap exceeded: estimated cost ${estimate:.6} exceeds remaining budget ${remaining:.6}"
                    ),
                );
            }
            tracing::warn!(
                workspace_id = %workspace_id,
                "Offline budget cap exceeded but INTUTIC_LOCAL_BUDGET_ENFORCE=0 — allowing a decision call"
            );
        }
    }

    // ── Credential and headers ──────────────────────────────────────────
    let mut forward = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if forwardable(name.as_str()) {
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
                reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
            ) {
                forward.append(n, v);
            }
        }
    }
    match credential {
        // The caller's own provider key goes to its upstream unchanged.
        RequestCredential::ProviderKey => {
            for name in ["authorization", "x-api-key"] {
                if let Some(v) = headers.get(name) {
                    if let Ok(v) = reqwest::header::HeaderValue::from_bytes(v.as_bytes()) {
                        forward.insert(name, v);
                    }
                }
            }
        }
        // A virtual key never leaves the proxy.
        RequestCredential::VirtualKey(_) => {
            let require_provisioned = crate::gateway::provisioned_key_required_for(
                key_record.and_then(|k| k.byok_required),
            );
            match provider_credential(state, route.provider, workspace_id, require_provisioned)
                .await
            {
                Some(key) => {
                    if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
                    {
                        forward.insert("authorization", v);
                    }
                }
                None if route.provider != "other" => {
                    let (code, hint) = if require_provisioned {
                        (
                            "byok_required",
                            "Provision one in the dashboard under Settings → Provider Keys.",
                        )
                    } else {
                        ("no_upstream_credential", "Provision one in the dashboard under Settings → Provider Keys, or set the provider's key on a self-hosted proxy.")
                    };
                    return error(
                        StatusCode::PAYMENT_REQUIRED,
                        code,
                        &format!(
                            "No {} API key is available for this workspace, and an Intutic virtual key is never sent to a provider. {hint}",
                            route.provider
                        ),
                    );
                }
                None => {}
            }
        }
    }
    forward.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );

    // ── Forward ─────────────────────────────────────────────────────────
    let upstream = state
        .http_client
        .post(&route.url)
        .headers(forward)
        .body(bytes)
        .send()
        .await;
    let upstream = match upstream {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(upstream = %route.host, error = %e, "decision upstream unreachable");
            record.status = StatusCode::BAD_GATEWAY.as_u16();
            record.latency_ms = started.elapsed().as_millis() as u64;
            write_log(&record);
            return error(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                &format!("The decision upstream {} could not be reached.", route.host),
            );
        }
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let reply = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(upstream = %route.host, error = %e, "decision upstream reply unreadable");
            record.status = StatusCode::BAD_GATEWAY.as_u16();
            record.latency_ms = started.elapsed().as_millis() as u64;
            write_log(&record);
            return error(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                &format!(
                    "The decision upstream {} sent no readable reply.",
                    route.host
                ),
            );
        }
    };

    // ── After the call ──────────────────────────────────────────────────
    let parsed = format.parse_response(&serde_json::from_slice(&reply).unwrap_or(Value::Null));
    let mut response = Response::builder().status(status.as_u16());
    if let Some(h) = response.headers_mut() {
        for (name, value) in &upstream_headers {
            let n = name.as_str();
            if !matches!(
                n,
                "content-length" | "transfer-encoding" | "connection" | "keep-alive"
            ) {
                if let (Ok(n), Ok(v)) = (
                    axum::http::HeaderName::from_bytes(n.as_bytes()),
                    HeaderValue::from_bytes(value.as_bytes()),
                ) {
                    h.append(n, v);
                }
            }
        }
        if status.is_success() {
            let (applied, below) = floors_below(&request.questions, &parsed.answers, &cfg.floors);
            record.floors = applied;
            if !below.is_empty() {
                if let Ok(v) = HeaderValue::from_str(&abstain_header_value(&below)) {
                    h.insert(ABSTAIN_HEADER, v);
                }
            }
            record.below_floor = below;
            if consequential {
                h.insert(REQUIRES_HUMAN_HEADER, HeaderValue::from_static("1"));
            }
        }
    }
    record.model_version = parsed.model_version.clone();
    record.probabilities = parsed.answers.clone();
    record.status = status.as_u16();
    record.latency_ms = started.elapsed().as_millis() as u64;

    // ── Metering: one trace, one Governed Request ───────────────────────
    let cost = crate::metering::decision_call_cost(
        route.provider,
        &request.model,
        parsed.input_tokens,
        parsed.output_tokens,
    );
    let trace = crate::telemetry::ExecutionTrace {
        decision_traffic: Some(record.clone()),
        trace_id: record.trace_id.clone(),
        session_id: session_id.to_string(),
        proxy_instance_id: crate::proxy::proxy_instance_id().to_string(),
        workspace_id: workspace_id.to_string(),
        virtual_key_id: key_prefix.to_string(),
        model: request.model.clone(),
        provider: route.provider.to_string(),
        raw_input_tokens: parsed.input_tokens,
        compressed_input_tokens: parsed.input_tokens,
        tool_result_bytes_saved: 0,
        wasm_shadow_reports: Vec::new(),
        sop_shadow_reports: Vec::new(),
        routing_shadow_model: None,
        response_integrity: None,
        quality_fault: None,
        upstream_error: None,
        upstream_attempts: Vec::new(),
        upstream_fallback: None,
        output_tokens: parsed.output_tokens,
        raw_cost_usd: cost,
        actual_cost_usd: cost,
        cache_hit: false,
        cache_read_input_tokens: None,
        cache_creation_input_tokens: None,
        reasoning_tokens: None,
        latency_ms: u32::try_from(record.latency_ms).unwrap_or(u32::MAX),
        verdict: "allowed".to_string(),
        harness_type: harness_type.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        requested_model: request.model.clone(),
        actual_model_routed: request.model.clone(),
        task_type: "decision".to_string(),
        tools: Vec::new(),
        change_manifest: Vec::new(),
        reconstruction_quality: 100,
        token_anomaly: false,
        break_glass: false,
        break_glass_request_id: None,
        loop_run_id,
        findings: Vec::new(),
        response_injection_findings: Vec::new(),
        context_snapshot: None,
        graph: crate::telemetry::GraphTrace::default(),
    };
    crate::proxy::accrue_spend(
        &state.store,
        cost,
        "",
        false,
        trace.loop_run_id.as_deref(),
        tpm_key_id,
        &trace,
    )
    .await;
    let store = Arc::clone(&state.store);
    tokio::spawn(async move {
        if let Err(e) = store.publish_trace(&trace).await {
            tracing::warn!("Failed to publish decision trace: {}", e);
        }
    });
    write_log(&record);

    response
        .body(Body::from(reply))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::QuestionType;

    #[test]
    fn the_pin_refuses_moving_aliases_and_unversioned_names() {
        for m in [
            "jev-latest",
            "JEV-LATEST",
            "kev:stable",
            "x/current",
            "m@default",
            "latest",
        ] {
            assert_eq!(model_pin(m), Pin::MovingAlias, "{m}");
        }
        for m in ["jev-preview", "jev", "laya/english", "typesafe/jev-preview"] {
            assert_eq!(model_pin(m), Pin::NoVersion, "{m}");
        }
        for m in [
            "jev-1.14.0",
            "jev-1.13",
            "kev-4b",
            "gpt-6-luna",
            "typesafe/jev-1.14.0",
            "m@2026-10-06",
        ] {
            assert_eq!(model_pin(m), Pin::Pinned, "{m}");
        }
        // "latest" inside a name is not the alias at its end.
        assert_eq!(model_pin("latestmodel-2"), Pin::Pinned);
    }

    #[test]
    fn the_upstream_follows_config_then_upstream_url_then_the_vendor() {
        let none = |_: &str| None;
        let gw =
            |n: &str| (n == "UPSTREAM_URL").then(|| "http://litellm.internal:4000/".to_string());
        let mut cfg = DecisionTrafficConfig::default();
        let r = route(DecisionFormat::SystemOne, &cfg, "", none);
        assert_eq!(r.url, "https://api.typesafe.ai/v1/systemone");
        assert_eq!(r.provider, "typesafe");
        let r = route(DecisionFormat::Decisions, &cfg, "localhost", none);
        assert_eq!(r.url, "https://api.openai.com/v1/decisions");
        assert_eq!(r.provider, "openai");
        let r = route(DecisionFormat::SystemOne, &cfg, "", gw);
        assert_eq!(r.url, "http://litellm.internal:4000/v1/systemone");
        assert_eq!(r.provider, "other");
        cfg.systemone_upstream = Some("https://eu.api.fastino.ai".into());
        let r = route(DecisionFormat::SystemOne, &cfg, "", gw);
        assert_eq!(r.url, "https://eu.api.fastino.ai/v1/systemone");
        assert_eq!(
            (r.provider, r.host.as_str()),
            ("fastino", "eu.api.fastino.ai")
        );
        // An intercepted call keeps the provider host it was addressed to.
        let r = route(DecisionFormat::Decisions, &cfg, "api.openai.com", gw);
        assert_eq!(r.url, "https://api.openai.com/v1/decisions");
    }

    #[test]
    fn egress_refuses_a_denied_upstream_and_logs_a_monitored_one() {
        let enforce = EgressPolicy::from_entries(
            crate::egress_policy::EgressMode::Enforce,
            ["decide.corp.example".to_string()],
        );
        assert_eq!(
            egress_check(&enforce, "https://decide.corp.example/v1/systemone"),
            Ok(false)
        );
        assert_eq!(
            egress_check(&enforce, "https://api.openai.com/v1/decisions"),
            Ok(false)
        );
        assert!(egress_check(&enforce, "https://api.typesafe.ai/v1/systemone").is_err());
        let monitor = EgressPolicy::from_entries(crate::egress_policy::EgressMode::Monitor, []);
        assert_eq!(
            egress_check(&monitor, "https://api.typesafe.ai/v1/systemone"),
            Ok(true)
        );
        let off = EgressPolicy::default();
        assert_eq!(
            egress_check(&off, "https://api.typesafe.ai/v1/systemone"),
            Ok(false)
        );
    }

    fn q(name: &str) -> DecisionQuestion {
        DecisionQuestion {
            name: name.into(),
            qtype: QuestionType::YesNo,
            options: None,
        }
    }

    #[test]
    fn floors_name_exactly_the_questions_under_them() {
        let questions = [q("approve"), q("fraud"), q("refund"), q("free")];
        let answers: BTreeMap<String, Answer> = [
            ("approve".to_string(), Answer::YesProbability(0.62)),
            ("fraud".to_string(), Answer::YesProbability(0.05)),
            ("refund".to_string(), Answer::Unanswered),
            ("free".to_string(), Answer::YesProbability(0.5)),
        ]
        .into();
        let floors: BTreeMap<String, f64> =
            [("approve".to_string(), 0.8), ("*".to_string(), 0.9)].into();
        let (applied, below) = floors_below(&questions, &answers, &floors);
        assert_eq!(applied.get("approve"), Some(&0.8));
        assert_eq!(applied.get("free"), Some(&0.9));
        // fraud leans no at 0.95, over its 0.9 floor.
        assert_eq!(below, ["approve", "refund", "free"]);
        let (applied, below) = floors_below(&questions, &answers, &BTreeMap::new());
        assert!(applied.is_empty() && below.is_empty());
    }

    #[test]
    fn consequential_comes_from_the_header_or_the_model_list() {
        let mut cfg = DecisionTrafficConfig::default();
        let mut h = HeaderMap::new();
        assert!(!is_consequential(&h, "jev-1.14.0", &cfg));
        h.insert(CONSEQUENTIAL_HEADER, HeaderValue::from_static("1"));
        assert!(is_consequential(&h, "jev-1.14.0", &cfg));
        h.insert(CONSEQUENTIAL_HEADER, HeaderValue::from_static("0"));
        assert!(!is_consequential(&h, "jev-1.14.0", &cfg));
        cfg.consequential_models = vec!["JEV-1.14.0".into()];
        assert!(is_consequential(&h, "jev-1.14.0", &cfg));
    }

    #[test]
    fn the_abstain_header_encodes_what_would_break_it() {
        assert_eq!(
            abstain_header_value(&["approve".into(), "a,b".into(), "née".into()]),
            "approve,a%2Cb,n%C3%A9e"
        );
    }

    #[test]
    fn the_log_is_one_line_per_call_in_a_private_file() {
        let dir = std::env::temp_dir().join(format!("dt-log-{}", uuid::Uuid::new_v4()));
        let request = DecisionRequest {
            model: "jev-1.14.0".into(),
            state: "s".into(),
            questions: vec![q("approve")],
        };
        let route = route(
            DecisionFormat::SystemOne,
            &DecisionTrafficConfig::default(),
            "",
            |_| None,
        );
        let record = record_for(
            DecisionFormat::SystemOne,
            &request,
            &route,
            "ws",
            "vk_ab",
            false,
        );
        append_log(&dir, &record).expect("written");
        append_log(&dir, &record).expect("written");
        let path = log_path(&dir, chrono::Utc::now());
        let text = std::fs::read_to_string(&path).expect("read");
        assert_eq!(text.lines().count(), 2);
        let line: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(line["format"], "systemone");
        assert_eq!(line["stateHash"], state_hash("s"));
        assert_eq!(line["action"], "forwarded");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// The day's first write deletes the logs past retention; later writes
    /// that day leave the directory alone.
    #[test]
    fn the_days_first_write_prunes_old_logs() {
        let dir = std::env::temp_dir().join(format!("dt-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("decision-traffic-2020-01-01.jsonl");
        let other = dir.join("decide-2020-01-01.jsonl");
        std::fs::write(&old, "{}\n").unwrap();
        std::fs::write(&other, "{}\n").unwrap();
        let request = DecisionRequest {
            model: "jev-1.14.0".into(),
            state: "s".into(),
            questions: vec![q("approve")],
        };
        let route = route(
            DecisionFormat::SystemOne,
            &DecisionTrafficConfig::default(),
            "",
            |_| None,
        );
        let record = record_for(
            DecisionFormat::SystemOne,
            &request,
            &route,
            "ws",
            "vk_ab",
            false,
        );
        append_log(&dir, &record).expect("written");
        assert!(
            !old.exists(),
            "a log past retention survived the day's first write"
        );
        assert!(other.exists(), "another log was deleted");
        std::fs::write(&old, "{}\n").unwrap();
        append_log(&dir, &record).expect("written");
        assert!(old.exists(), "a later write pruned again");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
