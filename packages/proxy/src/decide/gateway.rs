//! The gateway's decide stage.
//!
//! The proxy reads the decide engine's configuration once, at startup
//! ([`install_from_env`]): `~/.intutic/decide/engine.json`, overridden by the
//! `INTUTIC_DECIDE_*` variables ([`super::engine::resolve_config`]), behind the
//! self-hosted host guard. With no model the engine is not configured, and an
//! enforcing rule then refuses, as it does for any engine that cannot answer.
//!
//! Per request, [`GatewayRules::from_sops`] reads the decide rules of the SOPs
//! in force for the agent's role:
//!
//! - `on: tool_call` rules are asked about each tool call in a model's
//!   response, once the deterministic response gates (deny list, SSO groups,
//!   SQL guard, hook rules) have allowed it. On a stream the call's block is
//!   held whole until the rules decide (`plugins::sql_guard::StreamHold`).
//!   The gateway has no ask, so an escalation refuses (`DECIDE_ESCALATED`).
//! - `on: response` rules judge the response's text once it is complete, with
//!   the local judge's verdicts: refuse is `VIOLATION`, escalate `AMBIGUOUS`,
//!   and either is written into the response as a note, as the judge writes
//!   its synthesis ([`ResponseVerdict::note`]).
//! - An unreadable `decide:` line refuses every response while it is in force:
//!   a `VIOLATION` whose note is the parse error. Under SILENT_LOG it is only
//!   logged, as the snapshot writer stamps its fallback line shadow.
//!
//! A rule enforces only under its effective rollout
//! ([`super::evaluate::effective_rollout`]): its author wrote `enforce`,
//! `intutic decide disable` is not in force, nothing the control plane served
//! stamps it shadow, the workspace is not SILENT_LOG, and one of its pins is
//! for the model digest the engine reports. Every other rule runs as shadow:
//! it is asked and logged, and changes nothing.
//!
//! Where the pins come from depends on where the SOPs came from:
//!
//! - SOPs read from the SOP directory: the pins a passing
//!   `intutic decide eval` earned, `~/.intutic/decide/evals/<ruleHash>/*.json`.
//! - SOPs a gateway that requires virtual keys fetched for a workspace: the
//!   decide rules the control plane's policy resolve serves for it
//!   ([`fetch_served`]), each with its pins (the active calibrations) and its
//!   shadow stamp, as the sync daemon writes them into a connected machine's
//!   snapshot. A served rule whose `ruleHash` is not the hash this gateway
//!   computes keeps no pins, and a rule the resolve does not serve has none.
//!
//! Every evaluation is written to the decide log ([`super::log`]) under the
//! proxy's home, with the gates' record and drift stats. On a gateway that
//! requires virtual keys, each evaluation's lines are also sent to the
//! control plane when the key's workspace has `decideLogUploadEnabled` on.
//! Neither the log nor the upload can delay or fail a call.
//!
//! This is a pipeline stage, not a plugin: a plugin's `evaluate` does no I/O.

use super::engine::{
    resolve_config, DecideEngine, DecideEngineError, DECIDE_MAX_RESPONSE_STATE_BYTES,
};
use super::evaluate::{
    evaluate_call, evaluate_response, CanaryFileStore, Deterministic, EvaluateInput, Evaluation,
    Pin, ResponseInput, RuleEntry,
};
use super::log::{engine_host, write_call_log, LogContext, LogDirs, LogEngine, LogSubject};
use super::{parse_line, rule_hash, DecideDecl, DecideRule, On, Outcome, Rollout};
use crate::refusal::InterventionMode;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// How long one call's (or one response's) decide rules may take, unless
/// `INTUTIC_DECIDE_BUDGET_MS` says otherwise: the SDKs' default.
pub const DECIDE_DEFAULT_BUDGET_MS: u64 = 7_300;
const MAX_BUDGET_MS: u64 = 600_000;
/// The longest a SOP title is shown, as the snapshot writer bounds it.
const SOP_TITLE_MAX_CHARS: usize = 80;
const PIN_FIELDS: [&str; 6] = [
    "band",
    "combiner",
    "evalRunId",
    "modelDigest",
    "source",
    "temperature",
];

// ─── The engine, read at startup ──────────────────────────────────────

/// The decide engine this gateway asks, or why it has none.
pub struct GatewayEngine {
    engine: Result<Arc<DecideEngine>, DecideEngineError>,
    /// The engine's URL, which keys the canary cache; empty when unresolved.
    url: String,
    max_response_state_bytes: usize,
    budget_ms: u64,
}

impl GatewayEngine {
    /// The engine from `file` (an `engine.json`; a missing file is no file)
    /// and `env`, which overrides it. A file that does not read or parse, a
    /// setting out of range, no model, or a host the guard refuses leaves the
    /// engine unavailable with that error.
    pub fn resolve(file: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let budget_ms = env("INTUTIC_DECIDE_BUDGET_MS")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| (1..=MAX_BUDGET_MS).contains(n))
            .unwrap_or(DECIDE_DEFAULT_BUDGET_MS);
        let cfg = read_engine_file(file).and_then(|doc| resolve_config(doc.as_ref(), env));
        let (url, max) = match &cfg {
            Ok(c) => (
                c.url.clone(),
                c.max_response_state_bytes
                    .unwrap_or(DECIDE_MAX_RESPONSE_STATE_BYTES),
            ),
            Err(_) => (String::new(), DECIDE_MAX_RESPONSE_STATE_BYTES),
        };
        Self {
            engine: cfg.and_then(DecideEngine::new).map(Arc::new),
            url,
            max_response_state_bytes: max,
            budget_ms,
        }
    }

    /// The engine, or the error that stands in for it.
    pub fn engine(&self) -> Result<&DecideEngine, DecideEngineError> {
        self.engine.as_deref().map_err(Clone::clone)
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn max_response_state_bytes(&self) -> usize {
        self.max_response_state_bytes
    }

    fn deadline(&self) -> tokio::time::Instant {
        tokio::time::Instant::now() + Duration::from_millis(self.budget_ms)
    }
}

/// `~/.intutic/decide/engine.json`, which `intutic decide configure` writes.
pub fn engine_file() -> PathBuf {
    decide_dir().join("engine.json")
}

fn decide_dir() -> PathBuf {
    crate::paths::intutic_dir().join("decide")
}

fn read_engine_file(path: Option<&Path>) -> Result<Option<Value>, DecideEngineError> {
    let Some(path) = path else {
        return Ok(None);
    };
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| DecideEngineError::NotConfigured),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(DecideEngineError::NotConfigured),
    }
}

static INSTALLED: RwLock<Option<Arc<GatewayEngine>>> = RwLock::new(None);

/// Makes `engine` the one every request asks.
pub fn install(engine: GatewayEngine) -> Arc<GatewayEngine> {
    let engine = Arc::new(engine);
    *INSTALLED.write().unwrap_or_else(|e| e.into_inner()) = Some(engine.clone());
    engine
}

/// Reads the engine's configuration (`engine.json`, then the environment),
/// installs it and says what it found. Called at startup.
pub fn install_from_env() -> Arc<GatewayEngine> {
    let engine = install(GatewayEngine::resolve(Some(&engine_file()), &|name| {
        std::env::var(name).ok()
    }));
    match engine.engine() {
        Ok(e) => {
            let cfg = e.config();
            tracing::info!(
                url = %cfg.url,
                adapter = cfg.adapter.as_str(),
                model = %cfg.model,
                budget_ms = engine.budget_ms,
                "Decide engine configured: the gateway evaluates its SOPs' decide rules"
            );
        }
        Err(err) => tracing::info!(
            reason = err.code(),
            "Decide engine not configured: an enforcing decide rule refuses with GOVERNANCE_UNAVAILABLE"
        ),
    }
    engine
}

/// The installed engine, read from the configuration on first use when
/// startup installed none.
pub fn current() -> Arc<GatewayEngine> {
    if let Some(e) = INSTALLED.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return e.clone();
    }
    install_from_env()
}

// ─── A request's rules ────────────────────────────────────────────────

/// A `decide:` line that does not read.
#[derive(Debug, Clone, PartialEq)]
pub struct UnreadableRule {
    /// The SOP's title.
    pub sop: String,
    pub id: Option<String>,
    pub error: String,
}

/// The decide rules a request's response is held to.
#[derive(Debug, Clone, Default)]
pub struct GatewayRules {
    /// Both kinds, in SOP order, then line order.
    rules: Vec<RuleEntry>,
    unreadable: Vec<UnreadableRule>,
    mode: InterventionMode,
    /// Where each evaluation is written, and whether it is uploaded.
    log: Option<Arc<GatewayLog>>,
    /// The node's role and the workspace's revert history, for the `lane`
    /// and `revertRate` a decision line records.
    lane_context: Option<Arc<LaneContext>>,
}

/// What a decision line needs to say how consequential its subject was.
#[derive(Debug, Clone, Default)]
pub struct LaneContext {
    pub role: String,
    /// The raw `v2:revert:{workspace}` value, when the sweep has published one.
    pub revert_rates: Option<String>,
}

/// The strongest reversibility class among a tool call's action tokens, and
/// the highest role-level revert rate recorded for any of them.
///
/// Recorded only. A decide `allow` never releases a hold: lane and revert
/// holds are `review_before:` entries the request path's review gate holds
/// on whatever the decide outcome, and are released only by a person.
/// Nothing here, and no decide outcome, adds or removes one.
pub fn lane_of_call(
    tool: &str,
    args: &Value,
    context: Option<&LaneContext>,
) -> (Option<&'static str>, Option<f64>) {
    let tokens = crate::plugins::anomaly::actions::classify(tool, args);
    let lane = tokens
        .iter()
        .filter_map(|t| crate::plugins::anomaly::actions::token_class(t))
        .max()
        .map(crate::plugins::anomaly::actions::LaneClass::as_str);
    let rate = context
        .and_then(|c| c.revert_rates.as_deref().map(|r| (c.role.as_str(), r)))
        .and_then(|(role, rates)| {
            tokens
                .iter()
                .filter_map(|t| crate::key_context::revert_rate_of(rates, role, t))
                .fold(None, |acc: Option<f64>, r| {
                    Some(acc.map_or(r, |a| a.max(r)))
                })
        });
    (lane, rate)
}

/// The request a gateway's decide log lines are about, and where they go.
#[derive(Debug)]
pub struct GatewayLog {
    pub harness: String,
    pub workspace_id: String,
    pub session_id: String,
    pub dirs: LogDirs,
    /// Set on a gateway that requires virtual keys, when the workspace uploads its decide log.
    pub upload: Option<GatewayUpload>,
}

/// Where a gateway sends its decide log lines.
pub struct GatewayUpload {
    pub client: Arc<reqwest::Client>,
    pub control_plane_url: String,
    /// The request's own key: the lines go to its workspace.
    pub virtual_key: crate::credential::VirtualKey,
    /// `decideLogUploadArgs`: send the arguments excerpt too.
    pub with_args: bool,
}

impl std::fmt::Debug for GatewayUpload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayUpload")
            .field("control_plane_url", &self.control_plane_url)
            .field("with_args", &self.with_args)
            .finish_non_exhaustive()
    }
}

// ─── Served rules (a gateway that requires virtual keys) ──────────────

/// What the control plane's policy resolve serves for one rule hash.
#[derive(Debug, Clone, Default, PartialEq)]
struct ServedRule {
    pins: Vec<Pin>,
    /// A served copy is stamped shadow: a `mode: shadow` SOP, a shadow
    /// guardrail, or the server's kill switch.
    shadow: bool,
    /// Each served copy's `(sopId, sopTitle)`, so the rule's ref is the
    /// server's `<sopId>#<rule id>`, as the gates and the review queue key it.
    sops: Vec<(String, String)>,
}

/// The decide rules a workspace's policy resolve serves (`decideRules`),
/// keyed by the hash this gateway computes for each one's line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServedDecide {
    by_hash: HashMap<String, ServedRule>,
}

impl ServedDecide {
    /// From a `GET /api/v1/policy/resolve` body. A line that does not read is
    /// skipped (the SOP's own copy refuses); a served `ruleHash` that is not
    /// this gateway's hash for the line keeps no pins, as the sync daemon
    /// reads it; an invalid pin is dropped.
    pub fn from_resolve(body: &Value) -> Self {
        let mut out = Self::default();
        let Some(served) = body.get("decideRules").and_then(Value::as_array) else {
            return out;
        };
        for r in served {
            let line = match r.get("ir") {
                Some(Value::String(s)) => s.clone(),
                Some(v @ Value::Object(_)) => v.to_string(),
                _ => continue,
            };
            let DecideDecl::Rule(rule) = parse_line(&line) else {
                continue;
            };
            let own = rule_hash(&rule);
            let matches = r
                .get("ruleHash")
                .and_then(Value::as_str)
                .is_none_or(|h| h == own);
            let entry = out.by_hash.entry(own).or_default();
            if matches {
                for pin in r
                    .get("pins")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(read_pin)
                {
                    if !entry.pins.contains(&pin) {
                        entry.pins.push(pin);
                    }
                }
            }
            entry.shadow |= r.get("rollout").and_then(Value::as_str) == Some("shadow");
            if let Some(sop_id) = r
                .get("sopId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let title = r
                    .get("sopTitle")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                entry.sops.push((sop_id.to_string(), title.to_string()));
            }
        }
        out
    }

    /// The pins served for `hash`, and whether a served copy is stamped shadow.
    fn get(&self, hash: &str) -> (Vec<Pin>, bool) {
        self.by_hash
            .get(hash)
            .map_or((Vec::new(), false), |r| (r.pins.clone(), r.shadow))
    }

    /// The served SOP id for `hash` in the SOP titled `title`: the copy with
    /// that title, or the only copy when one is served.
    fn sop_id(&self, hash: &str, title: &str) -> Option<&str> {
        let sops = &self.by_hash.get(hash)?.sops;
        sops.iter()
            .find(|(_, t)| t == title)
            .or(if sops.len() == 1 { sops.first() } else { None })
            .map(|(id, _)| id.as_str())
    }
}

/// How long a workspace's served rules are reused: the workspace SOP cache's TTL.
const SERVED_CACHE_TTL: Duration = Duration::from_secs(30);
/// How long the policy resolve may take: the workspace SOP fetch's timeout.
const SERVED_FETCH_TIMEOUT: Duration = Duration::from_millis(2000);

struct ServedCached {
    served: ServedDecide,
    read_at: Instant,
    version: Option<u64>,
}

fn served_cache() -> &'static Mutex<HashMap<String, ServedCached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ServedCached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A workspace's served decide rules, from `GET
/// {control_plane_url}/api/v1/policy/resolve?workspaceId=…` with the
/// request's virtual key, cached for 30 seconds while the workspace's policy
/// version holds, as the workspace SOP fetch is. A failed fetch is not
/// cached and serves nothing: every rule then has no pins and runs as shadow.
pub async fn fetch_served(
    client: &reqwest::Client,
    control_plane_url: &str,
    workspace_id: &str,
    virtual_key: &crate::credential::VirtualKey,
    policy_version: Option<u64>,
) -> ServedDecide {
    {
        let cache = served_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = cache.get(workspace_id) {
            let moved =
                matches!((policy_version, c.version), (Some(now), Some(then)) if now != then);
            if c.read_at.elapsed() < SERVED_CACHE_TTL && !moved {
                return c.served.clone();
            }
        }
    }
    let url = format!(
        "{}/api/v1/policy/resolve",
        control_plane_url.trim_end_matches('/')
    );
    let fetched: Result<Value, String> = async {
        let resp = virtual_key
            .authorize(client.get(&url).query(&[("workspaceId", workspace_id)]))
            .timeout(SERVED_FETCH_TIMEOUT)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("status {}", resp.status()));
        }
        resp.json::<Value>().await.map_err(|e| e.to_string())
    }
    .await;
    match fetched {
        Ok(body) => {
            let served = ServedDecide::from_resolve(&body);
            let mut cache = served_cache().lock().unwrap_or_else(|p| p.into_inner());
            cache.retain(|_, c| c.read_at.elapsed() < SERVED_CACHE_TTL);
            cache.insert(
                workspace_id.to_string(),
                ServedCached {
                    served: served.clone(),
                    read_at: Instant::now(),
                    version: policy_version,
                },
            );
            served
        }
        Err(error) => {
            tracing::warn!(
                workspace_id,
                error = %error,
                "The policy resolve did not answer: the workspace's decide rules run as shadow on this request"
            );
            ServedDecide::default()
        }
    }
}

/// Why a tool call in a response is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallRefusal {
    pub tool: String,
    /// `decide.<ruleRef>`, or `decide` when no single rule decided.
    pub rule_id: String,
    /// `DECIDE_REFUSED`, `DECIDE_ESCALATED` or `GOVERNANCE_UNAVAILABLE`.
    pub code: String,
    pub reason: String,
}

/// The local judge's verdicts, as a response's decide rules reach them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Violation,
    Ambiguous,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Violation => "VIOLATION",
            Verdict::Ambiguous => "AMBIGUOUS",
        }
    }
}

/// A response the decide rules did not allow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseVerdict {
    pub verdict: Verdict,
    /// `decide.<ruleRef>`, or `decide` when no single rule decided.
    pub rule_id: String,
    /// `DECIDE_REFUSED`, `DECIDE_ESCALATED` or `GOVERNANCE_UNAVAILABLE`.
    pub code: String,
    pub reason: String,
    mode: InterventionMode,
}

impl ResponseVerdict {
    /// The block written into the response, after its text. Under OPAQUE it
    /// names no rule.
    pub fn note(&self) -> String {
        let full = format!("{} [{}, {}]", self.reason, self.code, self.rule_id);
        format!(
            "\n\n--- Intutic Decide (gateway): {} ---\n\n{}\n\n",
            self.verdict.as_str(),
            self.mode.agent_text(&full)
        )
    }
}

/// The first `# ` heading of a SOP's body, else its title, bounded.
fn sop_title(sop: &crate::sops::Sop) -> String {
    let heading = sop
        .body
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .unwrap_or(&sop.title);
    let clean: String = heading
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(SOP_TITLE_MAX_CHARS)
        .collect();
    clean.trim().to_string()
}

/// The SOP's id in a rule ref: `local:<file>` or `local:<folder>:<file>` for
/// a SOP read from the SOP directory, the SOP's title for one the workspace
/// served.
fn sop_id(sop: &crate::sops::Sop, local: bool) -> String {
    if !local {
        return sop.title.clone();
    }
    match sop.title.split_once('/') {
        Some((folder, stem)) => format!("local:{folder}:{stem}.md"),
        None => format!("local:{}.md", sop.title),
    }
}

/// A pin as a record carries it, read as strictly as every other reader
/// reads one: an unknown field or an unknown source refuses it.
fn read_pin(v: &Value) -> Option<Pin> {
    let obj = v.as_object()?;
    if obj.keys().any(|k| !PIN_FIELDS.contains(&k.as_str())) {
        return None;
    }
    if !matches!(
        obj.get("source").and_then(Value::as_str),
        Some("local" | "server")
    ) {
        return None;
    }
    let pin = Pin::from_value(v)?;
    match (obj.get("band"), pin.band) {
        (None, _) => Some(pin),
        (Some(_), Some(b))
            if b.yes_at > 0.5 && b.yes_at < 1.0 && b.no_below > 0.0 && b.no_below < b.yes_at =>
        {
            Some(pin)
        }
        _ => None,
    }
}

/// The pins `dir/evals/<ruleHash>/` holds, in file name order. A file that
/// is not a pin is skipped: the rule runs as shadow without it.
fn read_pins(dir: &Path, hash: &str) -> Vec<Pin> {
    let Ok(entries) = std::fs::read_dir(dir.join("evals").join(hash)) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter_map(|v| read_pin(&v))
        .collect()
}

/// The writer's stamp: `enforce` only for a rule written `enforce` that no
/// local disable, served shadow stamp, SILENT_LOG or missing pin holds back.
fn stamp(
    rule: &DecideRule,
    pins: &[Pin],
    disabled: bool,
    server_shadow: bool,
    mode: InterventionMode,
) -> (Rollout, &'static str) {
    if rule.rollout != Rollout::Enforce {
        (Rollout::Shadow, "rule")
    } else if disabled {
        (Rollout::Shadow, "local-disable")
    } else if server_shadow {
        (Rollout::Shadow, "server-shadow")
    } else if mode == InterventionMode::SilentLog {
        (Rollout::Shadow, "silent-log")
    } else if pins.is_empty() {
        (Rollout::Shadow, "no-pins")
    } else {
        (Rollout::Enforce, "rule")
    }
}

fn rule_id(rule_ref: Option<&str>) -> String {
    match rule_ref {
        Some(r) => format!("decide.{r}"),
        None => "decide".to_string(),
    }
}

impl GatewayRules {
    /// The decide rules of `sops` that apply to `role`. `local` says the SOPs
    /// were read from the SOP directory rather than served for a workspace.
    /// `served` is the workspace's policy resolve on a gateway that requires
    /// virtual keys: the pins and shadow stamps come from it alone. `None`
    /// reads the pins `intutic decide eval` left in `~/.intutic/decide/evals`.
    pub fn from_sops(
        sops: &[crate::sops::Sop],
        role: &str,
        mode: InterventionMode,
        local: bool,
        served: Option<&ServedDecide>,
    ) -> Self {
        Self::from_sops_in(sops, role, mode, local, &decide_dir(), served)
    }

    /// As [`GatewayRules::from_sops`], with pins and the disable marker read
    /// from `dir` instead of `~/.intutic/decide`.
    pub fn from_sops_in(
        sops: &[crate::sops::Sop],
        role: &str,
        mode: InterventionMode,
        local: bool,
        dir: &Path,
        served: Option<&ServedDecide>,
    ) -> Self {
        let mut out = GatewayRules {
            mode,
            ..Self::default()
        };
        let applying: Vec<&crate::sops::Sop> = sops
            .iter()
            .filter(|s| !s.decide_rules.is_empty() && s.applies_to(role))
            .collect();
        if applying.is_empty() {
            return out;
        }
        let disabled = dir.join("disabled").exists();
        for sop in applying {
            let title = sop_title(sop);
            let id = sop_id(sop, local);
            for decl in &sop.decide_rules {
                match decl {
                    DecideDecl::Rule(rule) => {
                        let hash = rule_hash(rule);
                        let (pins, server_shadow) = match served {
                            Some(served) => served.get(&hash),
                            None => (read_pins(dir, &hash), false),
                        };
                        let (rollout, stamped_by) =
                            stamp(rule, &pins, disabled, server_shadow, mode);
                        out.rules.push(RuleEntry {
                            // A served rule's ref is the server's `<sopId>#<id>`;
                            // the title stands in only where nothing is served.
                            rule_ref: format!(
                                "{}#{}",
                                served
                                    .and_then(|s| s.sop_id(&hash, &sop.title))
                                    .unwrap_or(&id),
                                rule.id
                            ),
                            rule_hash: hash,
                            rollout,
                            stamped_by: stamped_by.to_string(),
                            rule: (**rule).clone(),
                            sop_title: title.clone(),
                            rule_text: sop.body.clone(),
                            pins,
                        });
                    }
                    DecideDecl::Unreadable { id, error } => out.unreadable.push(UnreadableRule {
                        sop: title.clone(),
                        id: id.clone(),
                        error: error.clone(),
                    }),
                }
            }
        }
        out
    }

    /// Writes every evaluation to the decide log `log` names, and uploads it
    /// when `log.upload` is set.
    pub fn with_log(mut self, log: GatewayLog) -> Self {
        self.log = Some(Arc::new(log));
        self
    }

    /// Records each tool-call decision's `lane` and `revertRate` from `context`.
    pub fn with_lane_context(mut self, context: LaneContext) -> Self {
        self.lane_context = Some(Arc::new(context));
        self
    }

    /// The rules, with their stamps and pins.
    pub fn entries(&self) -> &[RuleEntry] {
        &self.rules
    }

    /// No rule and no unreadable line.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty() && self.unreadable.is_empty()
    }

    /// The tools some `on: tool_call` rule names: their blocks are held on a
    /// stream until the rules decide.
    pub fn tools(&self) -> BTreeSet<String> {
        self.rules
            .iter()
            .filter(|r| r.rule.on == On::ToolCall)
            .flat_map(|r| r.rule.tools.iter().cloned())
            .collect()
    }

    /// Whether an `on: tool_call` rule is stamped `enforce`.
    pub fn has_enforcing_tool_rules(&self) -> bool {
        self.rules
            .iter()
            .any(|r| r.rule.on == On::ToolCall && r.rollout == Rollout::Enforce)
    }

    /// Whether a complete response is judged: by an `on: response` rule, or
    /// by an unreadable line, which refuses it.
    pub fn judges_responses(&self) -> bool {
        !self.unreadable.is_empty() || self.rules.iter().any(|r| r.rule.on == On::Response)
    }

    /// The `on: tool_call` rules on one call the deterministic gates allowed:
    /// `None` to release it, else why it is refused. An escalation refuses,
    /// because the gateway has no ask.
    pub async fn check_tool_call(&self, tool: &str, args: &Value) -> Option<ToolCallRefusal> {
        if !self
            .rules
            .iter()
            .any(|r| r.rule.on == On::ToolCall && r.rule.tools.iter().any(|t| t == tool))
        {
            return None;
        }
        let engine = current();
        let input = EvaluateInput {
            deterministic: Deterministic::Allow,
            tool,
            tool_input: args,
            cwd: "",
            last_user_turn: None,
            rules: &self.rules,
            deadline: engine.deadline(),
        };
        let canary = CanaryFileStore::new(CanaryFileStore::default_path());
        let (at_ms, started) = (now_ms(), Instant::now());
        let eval = evaluate_call(&input, engine.engine(), engine.url(), &canary).await;
        log_evaluation(&format!("tool call {tool}"), &eval);
        self.record(
            &eval,
            LogSubject::ToolCall {
                tool,
                tool_input: args,
                cwd: "",
                last_user_turn: None,
            },
            at_ms,
            started,
            &engine,
        );
        let call = eval.call;
        let (code, reason) = match call.outcome {
            Outcome::Allow | Outcome::Unavailable => return None,
            Outcome::Refuse => {
                let code = call.code.unwrap_or_else(|| super::DECIDE_REFUSED.into());
                let reason = match code.as_str() {
                    super::GOVERNANCE_UNAVAILABLE => call.reason.unwrap_or_else(|| {
                        "The decide engine could not answer for an enforcing decide rule.".into()
                    }),
                    super::DECIDE_ESCALATED => {
                        "A decide rule could not decide this call, and escalates by refusing."
                            .into()
                    }
                    _ => "A decide rule refused this call.".into(),
                };
                (code, reason)
            }
            Outcome::Escalate => (
                super::DECIDE_ESCALATED.to_string(),
                "A decide rule could not decide this call, and the gateway cannot ask a person, so it refuses."
                    .to_string(),
            ),
        };
        Some(ToolCallRefusal {
            tool: tool.to_string(),
            rule_id: rule_id(call.rule_ref.as_deref()),
            code,
            reason,
        })
    }

    /// The `on: response` rules (and any unreadable line) on a complete
    /// response's text: `None` when it stands, else the verdict to note.
    pub async fn check_response(&self, content: &str) -> Option<ResponseVerdict> {
        if let Some(u) = self.unreadable.first() {
            let rule = u.id.as_deref().unwrap_or("on a decide line");
            tracing::warn!(
                sop = %u.sop,
                rule,
                error = %u.error,
                silent_log = self.mode == InterventionMode::SilentLog,
                "An unreadable decide rule refuses the response"
            );
            if self.mode != InterventionMode::SilentLog {
                return Some(ResponseVerdict {
                    verdict: Verdict::Violation,
                    rule_id: rule_id(None),
                    code: super::DECIDE_REFUSED.to_string(),
                    reason: format!(
                        "Decide rule {rule} ({}) does not read, so every response it would judge is refused until it is fixed: {}",
                        u.sop, u.error
                    ),
                    mode: self.mode,
                });
            }
        }
        if !self.rules.iter().any(|r| r.rule.on == On::Response) {
            return None;
        }
        let engine = current();
        let input = ResponseInput {
            content,
            max_state_bytes: engine.max_response_state_bytes(),
            rules: &self.rules,
            deadline: engine.deadline(),
        };
        let canary = CanaryFileStore::new(CanaryFileStore::default_path());
        let (at_ms, started) = (now_ms(), Instant::now());
        let eval = evaluate_response(&input, engine.engine(), engine.url(), &canary).await;
        log_evaluation("response", &eval);
        self.record(
            &eval,
            LogSubject::Response {
                content,
                max_state_bytes: engine.max_response_state_bytes(),
            },
            at_ms,
            started,
            &engine,
        );
        let call = eval.call;
        let (verdict, code, reason) = match call.outcome {
            Outcome::Allow | Outcome::Unavailable => return None,
            Outcome::Refuse => {
                let code = call.code.unwrap_or_else(|| super::DECIDE_REFUSED.into());
                let reason = match code.as_str() {
                    super::GOVERNANCE_UNAVAILABLE => call.reason.unwrap_or_else(|| {
                        "The decide engine could not answer for an enforcing decide rule, so the response is refused.".into()
                    }),
                    super::DECIDE_ESCALATED => {
                        "A decide rule could not decide this response, and escalates by refusing it.".into()
                    }
                    _ => "A decide rule refused this response.".into(),
                };
                (Verdict::Violation, code, reason)
            }
            Outcome::Escalate => (
                Verdict::Ambiguous,
                super::DECIDE_ESCALATED.to_string(),
                "A decide rule could not decide this response; it needs a person.".to_string(),
            ),
        };
        Some(ResponseVerdict {
            verdict,
            rule_id: rule_id(call.rule_ref.as_deref()),
            code,
            reason,
            mode: self.mode,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

impl GatewayRules {
    /// Writes one evaluation to the decide log and, when the workspace
    /// uploads it, sends its lines from a task of their own. A write that
    /// fails is logged; nothing here can change the decision or wait on the
    /// control plane.
    fn record(
        &self,
        eval: &Evaluation,
        subject: LogSubject<'_>,
        at_ms: i64,
        started: Instant,
        engine: &GatewayEngine,
    ) {
        let Some(log) = &self.log else {
            return;
        };
        let cfg = engine.engine().ok().map(DecideEngine::config);
        let identity = eval.engine.as_ref();
        let (lane, revert_rate) = match &subject {
            LogSubject::ToolCall {
                tool, tool_input, ..
            } => lane_of_call(tool, tool_input, self.lane_context.as_deref()),
            LogSubject::Response { .. } => (None, None),
        };
        let ctx = LogContext {
            lane,
            revert_rate,
            at_ms,
            harness: &log.harness,
            workspace_id: &log.workspace_id,
            session_id: &log.session_id,
            subject,
            budget_ms: engine.budget_ms,
            latency_ms: started.elapsed().as_millis() as u64,
            engine: LogEngine {
                adapter: cfg
                    .map(|c| c.adapter.as_str().to_string())
                    .unwrap_or_default(),
                host: cfg.map(|c| engine_host(&c.url)).unwrap_or_default(),
                model: identity
                    .map(|i| i.model.clone())
                    .or_else(|| cfg.map(|c| c.model.clone())),
                digest: identity.map(|i| i.model_digest.clone()),
                digest_strength: identity.map(|i| i.digest_strength.as_str()),
                canary: eval.canary.map(|c| c.as_str()),
            },
        };
        let written = write_call_log(eval, &self.rules, &ctx, &log.dirs);
        if let Some(e) = &written.error {
            tracing::warn!(error = %e, "The decide log was not written");
        }
        for d in &written.drifts {
            tracing::warn!(
                measure = d.measure,
                question = d.question.as_deref().unwrap_or(""),
                value = d.value,
                n = d.n,
                "decide.drift: a rule's decisions moved away from its eval run"
            );
        }
        let Some(up) = &log.upload else {
            return;
        };
        if written.lines.is_empty() {
            return;
        }
        let body = super::log::upload_body(&written.lines, up.with_args);
        let client = up.client.clone();
        let url = up.control_plane_url.clone();
        let key = up.virtual_key.clone();
        tokio::spawn(async move {
            if let Err(error) = super::log::upload(&client, &url, &key, &body).await {
                tracing::warn!(error = %error, "Decide log lines were not uploaded");
            }
        });
    }
}

/// One line per evaluated rule, and one per shadow rule past the limit. The
/// answers' probabilities, never the state.
fn log_evaluation(subject: &str, eval: &Evaluation) {
    for r in &eval.rules {
        let answers: Vec<String> = r
            .answers
            .iter()
            .flatten()
            .map(|(name, a)| match a.p {
                Some(p) => format!("{name}={p:.3}"),
                None => format!("{name}=choice"),
            })
            .collect();
        tracing::info!(
            subject,
            rule = %r.rule_ref,
            rule_hash = %r.rule_hash,
            effective = if r.effective == Rollout::Enforce { "enforce" } else { "shadow" },
            why = r.why.as_deref().unwrap_or(""),
            outcome = ?r.outcome,
            code = r.code.unwrap_or(""),
            error = r.error.unwrap_or(""),
            model_digest = r.model_digest.as_deref().unwrap_or(""),
            answers = %answers.join(","),
            "decide.decision"
        );
    }
    for skipped in &eval.skipped {
        tracing::info!(subject, rule = %skipped, "decide.skipped: past the 4-rule limit, shadow");
    }
    if eval.call.outcome != Outcome::Allow {
        tracing::warn!(
            subject,
            outcome = ?eval.call.outcome,
            code = eval.call.code.as_deref().unwrap_or(""),
            rule = eval.call.rule_ref.as_deref().unwrap_or(""),
            reason = eval.call.reason.as_deref().unwrap_or(""),
            "Decide rules did not allow"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "intutic-decide-gateway-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn no_file_and_no_model_is_not_configured() {
        let e = GatewayEngine::resolve(None, &env_of(&[]));
        assert_eq!(e.engine().err(), Some(DecideEngineError::NotConfigured));
        assert_eq!(e.budget_ms, DECIDE_DEFAULT_BUDGET_MS);
    }

    #[test]
    fn the_file_is_read_and_the_environment_overrides_it() {
        let dir = temp_dir("file");
        let path = dir.join("engine.json");
        std::fs::write(
            &path,
            r#"{"url":"http://127.0.0.1:9","adapter":"logprobs","model":"from-file","timeoutMs":900}"#,
        )
        .unwrap();
        let e = GatewayEngine::resolve(Some(&path), &env_of(&[]));
        let cfg = e.engine().expect("configured").config().clone();
        assert_eq!(cfg.model, "from-file");
        assert_eq!(cfg.timeout_ms, 900);
        assert_eq!(e.url(), "http://127.0.0.1:9");
        let e = GatewayEngine::resolve(
            Some(&path),
            &env_of(&[
                ("INTUTIC_DECIDE_MODEL", "from-env"),
                ("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES", "64"),
                ("INTUTIC_DECIDE_BUDGET_MS", "1200"),
            ]),
        );
        assert_eq!(e.engine().expect("configured").config().model, "from-env");
        assert_eq!(e.max_response_state_bytes(), 64);
        assert_eq!(e.budget_ms, 1200);
        // A missing file is no file.
        let e = GatewayEngine::resolve(Some(&dir.join("missing.json")), &env_of(&[]));
        assert_eq!(e.engine().err(), Some(DecideEngineError::NotConfigured));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_or_a_hosted_url_leaves_the_engine_unavailable() {
        let dir = temp_dir("bad");
        let path = dir.join("engine.json");
        std::fs::write(&path, "{not json").unwrap();
        let e = GatewayEngine::resolve(Some(&path), &env_of(&[("INTUTIC_DECIDE_MODEL", "m")]));
        assert_eq!(e.engine().err(), Some(DecideEngineError::NotConfigured));
        let e = GatewayEngine::resolve(
            None,
            &env_of(&[
                ("INTUTIC_DECIDE_ENGINE_URL", "https://api.openai.com"),
                ("INTUTIC_DECIDE_MODEL", "m"),
            ]),
        );
        assert!(matches!(
            e.engine().err(),
            Some(DecideEngineError::HostRefused(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn rule(rollout: &str) -> DecideRule {
        super::super::validate(&serde_json::json!({
            "id": "r", "on": "response",
            "questions": {"leak": {"type": "yes_no", "ask": "Does the response leak a secret?"}},
            "when": "leak", "rollout": rollout,
        }))
        .expect("valid")
    }

    #[test]
    fn the_stamp_follows_the_writers_order() {
        let pins = [Pin {
            model_digest: "id:m".into(),
            eval_run_id: "run".into(),
            band: None,
            combiner: None,
        }];
        let t = InterventionMode::Transparent;
        assert_eq!(
            stamp(&rule("shadow"), &pins, false, false, t),
            (Rollout::Shadow, "rule")
        );
        assert_eq!(
            stamp(&rule("enforce"), &pins, true, false, t),
            (Rollout::Shadow, "local-disable")
        );
        assert_eq!(
            stamp(
                &rule("enforce"),
                &pins,
                false,
                false,
                InterventionMode::SilentLog
            ),
            (Rollout::Shadow, "silent-log")
        );
        assert_eq!(
            stamp(&rule("enforce"), &[], false, false, t),
            (Rollout::Shadow, "no-pins")
        );
        assert_eq!(
            stamp(&rule("enforce"), &pins, false, true, t),
            (Rollout::Shadow, "server-shadow")
        );
        assert_eq!(
            stamp(&rule("enforce"), &pins, false, false, t),
            (Rollout::Enforce, "rule")
        );
    }

    #[test]
    fn a_pin_is_read_strictly() {
        let ok = serde_json::json!({"modelDigest": "id:m", "evalRunId": "run", "source": "local"});
        assert!(read_pin(&ok).is_some());
        for bad in [
            serde_json::json!({"modelDigest": "id:m", "evalRunId": "run"}),
            serde_json::json!({"modelDigest": "id:m", "evalRunId": "run", "source": "elsewhere"}),
            serde_json::json!({"modelDigest": "id:m", "evalRunId": "run", "source": "local", "extra": 1}),
            serde_json::json!({"modelDigest": "", "evalRunId": "run", "source": "local"}),
            serde_json::json!({"modelDigest": "id:m", "evalRunId": "run", "source": "local", "band": {"yes_at": 0.4, "no_below": 0.1}}),
        ] {
            assert!(read_pin(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn local_sop_ids_name_the_file() {
        let mut sop = crate::sops::Sop {
            title: "data".into(),
            ..Default::default()
        };
        assert_eq!(sop_id(&sop, true), "local:data.md");
        sop.title = "safety/rules".into();
        assert_eq!(sop_id(&sop, true), "local:safety:rules.md");
        assert_eq!(sop_id(&sop, false), "safety/rules");
    }

    /// The state `intutic decide test` and `decide eval` build for a response
    /// rule (`tools/cli/src/commands/decide.test.ts`, `STATE_HEAD`) is the one
    /// the gateway sends for the same SOP file: its whole body, then the
    /// response.
    #[test]
    fn a_response_rules_state_is_the_one_the_cli_measures() {
        let raw = "---\ndecide: {\"id\":\"no-leaks\",\"on\":\"response\",\"questions\":{\"leaks\":{\"type\":\"yes_no\",\"ask\":\"Does the response include customer data?\"}},\"when\":\"leaks\",\"rollout\":\"enforce\"}\n---\n# Production data handling\n\nCustomer data never leaves production.\n";
        let sop = crate::sops::parse_sop_content(
            "data".into(),
            raw,
            "test",
            crate::sops::SopScope::Workspace,
        )
        .expect("the SOP parses");
        let rules = GatewayRules::from_sops_in(
            &[sop],
            "",
            InterventionMode::Transparent,
            true,
            &temp_dir("cli-state"),
            None,
        );
        let leak = "Here is the customer record: Jane Roe, 12 Elm St.";
        let state = super::super::engine::build_response_state(
            &rules.entries()[0].rule_text,
            leak,
            DECIDE_MAX_RESPONSE_STATE_BYTES,
        )
        .expect("within the limit");
        assert_eq!(
            state,
            format!("ACTIVE SOP CONSTRAINTS:\n# Production data handling\n\nCustomer data never leaves production.\n\nASSISTANT RESPONSE:\n{leak}")
        );
    }

    #[test]
    fn served_rules_keep_pins_only_under_their_own_hash() {
        let line = r#"{"id":"r","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response leak a secret?"}},"when":"leak","rollout":"enforce"}"#;
        let DecideDecl::Rule(rule) = parse_line(line) else {
            panic!("reads")
        };
        let own = rule_hash(&rule);
        let pin = serde_json::json!({"modelDigest": "id:m", "evalRunId": "der_1", "source": "server", "temperature": {}});
        let served = |hash: &str, rollout: Option<&str>| {
            let mut r = serde_json::json!({"ir": line, "ruleHash": hash, "pins": [pin.clone(), {"modelDigest": "id:m"}]});
            if let Some(ro) = rollout {
                r["rollout"] = ro.into();
            }
            ServedDecide::from_resolve(&serde_json::json!({ "decideRules": [r] }))
        };
        let (pins, shadow) = served(&own, None).get(&own);
        assert_eq!(
            (pins.len(), shadow),
            (1, false),
            "the invalid pin is dropped"
        );
        assert_eq!(pins[0].eval_run_id, "der_1");
        let (pins, _) = served(&"0".repeat(64), None).get(&own);
        assert!(
            pins.is_empty(),
            "a served hash that is not the gateway's keeps no pins"
        );
        let (_, shadow) = served(&own, Some("shadow")).get(&own);
        assert!(shadow);
        // The resolve's object form of a line reads too, and a body without
        // decide rules serves none.
        let obj: Value = serde_json::from_str(line).unwrap();
        let s = ServedDecide::from_resolve(
            &serde_json::json!({"decideRules": [{"ir": obj, "pins": [pin]}]}),
        );
        assert_eq!(s.get(&own).0.len(), 1);
        assert_eq!(
            ServedDecide::from_resolve(&serde_json::json!({})),
            ServedDecide::default()
        );
    }

    /// The review queue matches an uploaded escalation to its served rule by
    /// `<sopId>#<rule id>` and the hash. The gateway wrote `<title>#<id>`, so
    /// no gateway escalation was ever queued (staging, 2026-10-18).
    #[test]
    fn a_served_rule_is_referred_to_by_its_sop_id() {
        let line = r#"{"id":"r","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response leak a secret?"}},"when":"leak","escalate":"review"}"#;
        let other = r#"{"id":"o","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response quote a secret?"}},"when":"leak"}"#;
        let DecideDecl::Rule(rule) = parse_line(line) else {
            panic!("reads")
        };
        let sop = crate::sops::Sop {
            title: "Data handling".into(),
            body: "# Data handling\n\nSecrets stay put.".into(),
            decide_rules: crate::decide::parse_lines([line, other]),
            ..Default::default()
        };
        let served = ServedDecide::from_resolve(&serde_json::json!({ "decideRules": [
            {"sopId": "sp_other", "sopTitle": "Elsewhere", "ir": line, "ruleHash": rule_hash(&rule)},
            {"sopId": "sp_data", "sopTitle": "Data handling", "ir": line, "ruleHash": rule_hash(&rule)},
        ]}));
        let dir = std::env::temp_dir().join(format!("intutic-ruleref-{}", std::process::id()));
        let refs = |served: Option<&ServedDecide>| -> Vec<String> {
            GatewayRules::from_sops_in(
                std::slice::from_ref(&sop),
                "",
                InterventionMode::Transparent,
                false,
                &dir,
                served,
            )
            .entries()
            .iter()
            .map(|e| e.rule_ref.clone())
            .collect()
        };
        assert_eq!(
            refs(Some(&served)),
            ["sp_data#r", "Data handling#o"],
            "the copy in this SOP names it; a rule nothing serves keeps the title"
        );
        assert_eq!(refs(None), ["Data handling#r", "Data handling#o"]);
    }
}

#[cfg(test)]
mod lld75_lane_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_tool_call_s_lane_is_its_strongest_token_s_class() {
        let ctx = LaneContext {
            role: "deployer".into(),
            revert_rates: Some(
                r#"{"|action:deploy": {"r": 0.3}, "deployer|action:destroy": {"j": 0.6}}"#.into(),
            ),
        };
        assert_eq!(
            lane_of_call("Bash", &json!({"command": "terraform destroy"}), Some(&ctx)),
            (Some("irreversible"), Some(0.6))
        );
        assert_eq!(
            lane_of_call("Bash", &json!({"command": "git push"}), Some(&ctx)),
            (Some("reversible_wide"), Some(0.3))
        );
        assert_eq!(
            lane_of_call("Bash", &json!({"command": "ls"}), Some(&ctx)),
            (None, None)
        );
        assert_eq!(
            lane_of_call("Bash", &json!({"command": "npm test"}), None),
            (Some("reversible_contained"), None)
        );
    }

    /// 3.0: a decide `allow` never releases a hold. Lane holds are
    /// `review_before:` entries the request path holds on before and whatever
    /// any decide rule says — `GatewayRules` has no input from, or output to,
    /// the hold set — so a rule pinned to allow everything leaves a closed
    /// lane's call held.
    #[test]
    fn a_decide_allow_never_releases_a_lane_hold() {
        use crate::plugins::anomaly::detectors::ReviewGateDetector;
        use crate::plugins::anomaly::AnomalyDetector;
        let raw = "---\nclosed_lanes: irreversible\ndecide: {\"id\":\"allow-all\",\"on\":\"tool_call\",\"tools\":[\"Bash\"],\"rollout\":\"enforce\",\"ask\":{\"q\":{\"type\":\"boolean\",\"prompt\":\"ok?\"}},\"when\":\"q == false\"}\n---\n";
        let sop = crate::sops::parse_sop_content(
            "lanes".into(),
            raw,
            "test",
            crate::sops::SopScope::Workspace,
        )
        .expect("sop");
        let gov = crate::sops::governance_fields_from(&[sop], "");
        assert!(gov.review_before.contains(&"action:destroy".to_string()));
        let mut ctx = crate::plugins::anomaly::detectors::test_support::base_ctx();
        ctx.review_before = gov.review_before;
        ctx.new_tool_calls =
            crate::manifest::expand_tool_actions(&[crate::manifest::ToolInvocation {
                name: "Bash".into(),
                input: json!({"command": "terraform destroy -auto-approve"}),
                source: crate::manifest::InvocationSource::Call,
                call_id: None,
                is_error: None,
            }]);
        let hold = ReviewGateDetector
            .detect(&ctx)
            .expect("held whatever decide says");
        assert_eq!(hold.disposition, crate::plugins::anomaly::Disposition::Ask);
    }
}
