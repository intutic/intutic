//! Refusals the proxy answers in band: a 200 whose body is an assistant turn
//! explaining why, instead of the answer the model gave.
//!
//! An in-band refusal is right for the agent — it reads the reason as its own
//! previous turn, where a non-2xx would read as a transport fault and be
//! retried (see `plugins::response_gate::refusal_body`). It is wrong for an
//! SDK, which would take the explanation for the model's answer and report
//! `allow`. So every in-band refusal also names itself, with a stable code and
//! the id of the rule that decided:
//!
//! - **Non-streaming:** the `x-intutic-refusal` and `x-intutic-refusal-rule`
//!   response headers.
//! - **Streaming:** the headers went out with the first byte, long before the
//!   refusal, so the stream carries one SSE comment line instead, immediately
//!   before the refusal text: `: intutic-refusal {"code":…,"rule":…,"message":…}`.
//!   A comment and not an event, because every SSE parser skips comments by
//!   specification, while an event type a client does not know is an error in
//!   some of them (OpenAI's Python SDK raises on one).
//!
//! The codes, header names and marker are listed once, in
//! `packages/shared-types/fixtures/refusal-codes.json`; the test below holds
//! this module to it, and the clawde SDKs' tests hold their tables to it.

use axum::http::{HeaderMap, HeaderValue};

/// Response header naming the refusal's code.
pub const HEADER: &str = "x-intutic-refusal";
/// Response header naming the rule that decided.
pub const RULE_HEADER: &str = "x-intutic-refusal-rule";
/// The prefix of the SSE comment line that names a refusal on a stream.
pub const STREAM_MARKER: &str = ": intutic-refusal ";

/// What the agent is told in place of a rule's reason when its workspace is
/// OPAQUE. Listed as `opaqueMessage` in the shared fixture; every surface
/// that refuses an agent sends this same sentence.
#[rustfmt::skip]
pub const OPAQUE_MESSAGE: &str = "Blocked by workspace policy. Ask a workspace admin if you need this action.";

/// The workspace's intervention mode: its `interventionMode` workspace
/// setting, carried on `/auth/key-context`
/// (`crate::key_context::intervention_mode`).
///
/// Only [`InterventionMode::Opaque`] changes anything here: an agent refused
/// by a rule is not told which rule, so it cannot learn the policy and route
/// around it. The refusal's status, error type and code are unchanged, and
/// logs, traces, findings and metrics keep the full reason; only what the
/// agent sees changes. TRANSPARENT and SILENT_LOG refuse exactly as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterventionMode {
    /// The schema default, and the answer for a control plane that predates
    /// the field, a standalone proxy, or a value this proxy does not know.
    #[default]
    Transparent,
    Opaque,
    SilentLog,
}

impl InterventionMode {
    /// The mode a key-context value names; anything but `OPAQUE` or
    /// `SILENT_LOG` (absent, null, unknown) is TRANSPARENT.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("OPAQUE") => Self::Opaque,
            Some("SILENT_LOG") => Self::SilentLog,
            _ => Self::Transparent,
        }
    }

    /// What the agent is shown for a rule-identifying refusal whose full
    /// reason is `full`: [`OPAQUE_MESSAGE`] under OPAQUE, `full` otherwise.
    /// The one place that decides it, so every refusal site redacts alike.
    pub fn agent_text(self, full: &str) -> &str {
        match self {
            Self::Opaque => OPAQUE_MESSAGE,
            Self::Transparent | Self::SilentLog => full,
        }
    }
}

/// Every refusal the proxy can answer in band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// The cost-prediction gate, on a non-streaming request.
    CostGateExceeded,
    /// A tool call an SOP's `deny_tools` forbids this role.
    ToolDenied,
    /// A tool call the workspace's SSO group policy does not clear.
    SsoGroup,
    /// Destructive SQL against a database `sql_allow_dsns` does not admit.
    SqlGuard,
    /// The response did not parse while a tool policy was in force.
    ResponseUnparseable,
    /// Output DLP found content it could not redact without breaking the body.
    OutputDlp,
    /// A qualified `requires_before:` prerequisite is not met: no passing
    /// run, a failed or unreadable one, or one made stale by a later write.
    PrerequisiteUnmet,
    /// A file-changing call outside `scope_paths` under
    /// `scope_paths_mode: enforce`.
    OutOfScope,
}

impl Code {
    pub const ALL: [Code; 8] = [
        Code::CostGateExceeded,
        Code::ToolDenied,
        Code::SsoGroup,
        Code::SqlGuard,
        Code::ResponseUnparseable,
        Code::OutputDlp,
        Code::PrerequisiteUnmet,
        Code::OutOfScope,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Code::CostGateExceeded => "COST_GATE_EXCEEDED",
            Code::ToolDenied => "TOOL_DENIED",
            Code::SsoGroup => "SSO_GROUP",
            Code::SqlGuard => "SQL_GUARD",
            Code::ResponseUnparseable => "RESPONSE_UNPARSEABLE",
            Code::OutputDlp => "OUTPUT_DLP",
            Code::PrerequisiteUnmet => "PREREQUISITE_UNMET",
            Code::OutOfScope => "OUT_OF_SCOPE",
        }
    }
}

/// Most entries a [`RefusalScope`] list, or a refusal's evidence, carries.
pub const DETAIL_MAX_ITEMS: usize = 8;
/// Longest string a [`RefusalScope`] or [`RefusalEvidence`] field carries, in
/// characters (code points, as the TypeScript and Python ports count them).
pub const DETAIL_MAX_CHARS: usize = 256;

/// `s` with C0 control characters (U+0000–U+001F) removed and cut to [`DETAIL_MAX_CHARS`]
/// bytes. A refusal's detail is shown to an agent and written to logs; a
/// newline or escape in it must not reshape either.
pub fn bound_detail(s: &str) -> String {
    s.chars()
        .filter(|c| (*c as u32) >= 0x20)
        .take(DETAIL_MAX_CHARS)
        .collect()
}

fn bound_list(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|s| bound_detail(s))
        .filter(|s| !s.is_empty())
        .take(DETAIL_MAX_ITEMS)
        .collect()
}

/// What a refusal was about, so an agent can retry inside it: the paths
/// outside a scope, the tools off a plan, the prerequisite step it skipped.
/// `shared-types` refusalDetail.ts `RefusalScope`, held equal by
/// `fixtures/refusal-detail-vectors.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RefusalScope {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
}

impl RefusalScope {
    pub fn tools<I: IntoIterator<Item = S>, S: Into<String>>(tools: I) -> Self {
        Self {
            tools: tools.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    pub fn paths<I: IntoIterator<Item = S>, S: Into<String>>(paths: I) -> Self {
        Self {
            paths: paths.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    pub fn with_step(mut self, step: impl Into<String>) -> Self {
        self.step = Some(step.into());
        self
    }

    pub fn with_rule(mut self, rule: impl Into<String>) -> Self {
        self.rule = Some(rule.into());
        self
    }

    pub fn with_detector(mut self, detector: impl Into<String>) -> Self {
        self.detector = Some(detector.into());
        self
    }

    /// Every list at most [`DETAIL_MAX_ITEMS`] long, every string at most
    /// [`DETAIL_MAX_CHARS`] and free of control characters.
    pub fn bounded(&self) -> Self {
        let one = |s: &Option<String>| s.as_deref().map(bound_detail).filter(|s| !s.is_empty());
        Self {
            paths: bound_list(&self.paths),
            tools: bound_list(&self.tools),
            step: one(&self.step),
            detector: one(&self.detector),
            rule: one(&self.rule),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
            && self.tools.is_empty()
            && self.step.is_none()
            && self.detector.is_none()
            && self.rule.is_none()
    }

    /// The `[Intutic] Retry scope:` line's value: the paths, else the tools.
    pub fn retry_hint(&self) -> Option<String> {
        if !self.paths.is_empty() {
            return Some(self.paths.join(", "));
        }
        (!self.tools.is_empty()).then(|| self.tools.join(", "))
    }
}

/// One piece of evidence behind a refusal: `{kind, detail}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RefusalEvidence {
    pub kind: String,
    pub detail: String,
}

impl RefusalEvidence {
    pub fn new(kind: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            detail: detail.into(),
        }
    }
}

/// The extra stderr line an exit-code harness prints for a refusal
/// (`retryScopeLine`): `[Intutic] Retry scope: ` and the bounded scope's
/// paths, else its tools. `None` under OPAQUE, or with neither.
pub fn retry_scope_line(scope: Option<&RefusalScope>, mode: InterventionMode) -> Option<String> {
    if mode == InterventionMode::Opaque {
        return None;
    }
    let s = scope?.bounded();
    s.retry_hint()
        .map(|h| format!("[Intutic] Retry scope: {h}"))
}

/// At most [`DETAIL_MAX_ITEMS`] items, each field bounded like a scope's; an
/// item with a field empty after cleaning is dropped and does not count.
pub fn bound_evidence(items: &[RefusalEvidence]) -> Vec<RefusalEvidence> {
    items
        .iter()
        .map(|e| RefusalEvidence {
            kind: bound_detail(&e.kind),
            detail: bound_detail(&e.detail),
        })
        .filter(|e| !e.kind.is_empty() && !e.detail.is_empty())
        .take(DETAIL_MAX_ITEMS)
        .collect()
}

/// The refusal detail an agent under `mode` may see: both bounded, both
/// dropped under OPAQUE (only the code survives, as with
/// [`Refusal::for_mode`]). SILENT_LOG shows them, as TRANSPARENT does.
pub fn detail_for_mode(
    scope: Option<&RefusalScope>,
    evidence: &[RefusalEvidence],
    mode: InterventionMode,
) -> (Option<RefusalScope>, Vec<RefusalEvidence>) {
    if mode == InterventionMode::Opaque {
        return (None, Vec::new());
    }
    (
        scope.map(RefusalScope::bounded).filter(|s| !s.is_empty()),
        bound_evidence(evidence),
    )
}

/// One in-band refusal: what refused, and which rule decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: Code,
    pub rule: String,
    /// What the refusal was about, for the agent to retry inside it.
    pub scope: Option<RefusalScope>,
    pub evidence: Vec<RefusalEvidence>,
}

impl Refusal {
    pub fn new(code: Code, rule: impl Into<String>) -> Self {
        Self {
            code,
            rule: rule.into(),
            scope: None,
            evidence: Vec::new(),
        }
    }

    /// The same refusal, carrying `scope`.
    pub fn with_scope(mut self, scope: Option<RefusalScope>) -> Self {
        self.scope = scope;
        self
    }

    /// The refusal as the agent may see it under `mode`. Under OPAQUE the rule
    /// id is emptied, which leaves the rule header off ([`Refusal::apply`])
    /// and the stream marker's `rule` an empty string; the code is kept, so
    /// an SDK still knows what kind of refusal it was. The scope and evidence
    /// go too.
    pub fn for_mode(mut self, mode: InterventionMode) -> Self {
        if mode == InterventionMode::Opaque {
            self.rule.clear();
        }
        let (scope, evidence) = detail_for_mode(self.scope.as_ref(), &self.evidence, mode);
        self.scope = scope;
        self.evidence = evidence;
        self
    }

    /// Names the refusal on a non-streaming response. A rule id that is empty
    /// (an OPAQUE workspace's, [`Refusal::for_mode`]) or not a valid header
    /// value is left off rather than failing the response; the code alone
    /// still tells the SDK it was refused.
    pub fn apply(&self, headers: &mut HeaderMap) {
        headers.insert(HEADER, HeaderValue::from_static(self.code.as_str()));
        if self.rule.is_empty() {
            return;
        }
        if let Ok(v) = HeaderValue::from_str(&self.rule) {
            headers.insert(RULE_HEADER, v);
        }
    }

    /// The SSE comment line that names the refusal on a stream, blank line
    /// included. `message` is the text the agent is shown, so an SDK reading
    /// the stream raises with the same reason.
    pub fn stream_marker(&self, message: &str) -> String {
        let mut payload = serde_json::json!({
            "code": self.code.as_str(),
            "rule": self.rule,
            "message": message,
        });
        // Only when there is something to say, so a refusal with none keeps
        // the three-key marker every older SDK parses.
        if let Some(scope) = self.scope.as_ref().filter(|s| !s.is_empty()) {
            payload["scope"] = serde_json::to_value(scope.bounded()).unwrap_or_default();
        }
        if !self.evidence.is_empty() {
            payload["evidence"] =
                serde_json::to_value(bound_evidence(&self.evidence)).unwrap_or_default();
        }
        format!("{STREAM_MARKER}{payload}\n\n")
    }
}

/// A rule id built from a kind and a tool name, keeping only the characters
/// a rule id may carry (`[A-Za-z0-9_.:-]`), so it is always a valid header
/// value and survives the control plane's `ruleIdFromReason`.
pub fn tool_rule_id(kind: &str, tool: &str) -> String {
    let safe: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{kind}.{safe}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole_fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/fixtures/refusal-codes.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
        serde_json::from_str::<serde_json::Value>(&text).expect("refusal-codes.json parses")
    }

    fn fixture() -> serde_json::Value {
        whole_fixture()["proxy"].clone()
    }

    #[test]
    fn the_opaque_message_matches_the_shared_list() {
        assert_eq!(whole_fixture()["opaqueMessage"], OPAQUE_MESSAGE);
    }

    #[test]
    fn only_opaque_replaces_the_reason() {
        let full = "Request blocked by custom WASM governance rule: no deploys on Friday";
        assert_eq!(InterventionMode::Opaque.agent_text(full), OPAQUE_MESSAGE);
        assert_eq!(InterventionMode::Transparent.agent_text(full), full);
        assert_eq!(InterventionMode::SilentLog.agent_text(full), full);
    }

    #[test]
    fn an_absent_or_unknown_mode_is_transparent() {
        assert_eq!(InterventionMode::parse(None), InterventionMode::Transparent);
        assert_eq!(
            InterventionMode::parse(Some("TRANSPARENT")),
            InterventionMode::Transparent
        );
        assert_eq!(
            InterventionMode::parse(Some("opaque")),
            InterventionMode::Transparent
        );
        assert_eq!(
            InterventionMode::parse(Some("OPAQUE")),
            InterventionMode::Opaque
        );
        assert_eq!(
            InterventionMode::parse(Some("SILENT_LOG")),
            InterventionMode::SilentLog
        );
    }

    #[test]
    fn opaque_keeps_the_code_and_drops_the_rule() {
        let r = Refusal::new(Code::ToolDenied, "deny_tools.Bash");
        let mut h = HeaderMap::new();
        r.clone().for_mode(InterventionMode::Opaque).apply(&mut h);
        assert_eq!(h[HEADER], "TOOL_DENIED");
        assert!(h.get(RULE_HEADER).is_none());
        let m = r
            .clone()
            .for_mode(InterventionMode::Opaque)
            .stream_marker(OPAQUE_MESSAGE);
        let payload: serde_json::Value =
            serde_json::from_str(m.trim_end().strip_prefix(STREAM_MARKER).unwrap()).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({"code": "TOOL_DENIED", "rule": "", "message": OPAQUE_MESSAGE})
        );
        // TRANSPARENT and SILENT_LOG leave it as it was.
        for mode in [InterventionMode::Transparent, InterventionMode::SilentLog] {
            assert_eq!(r.clone().for_mode(mode), r);
        }
    }

    #[test]
    fn header_names_and_marker_match_the_shared_list() {
        let f = fixture();
        assert_eq!(f["header"], HEADER);
        assert_eq!(f["ruleHeader"], RULE_HEADER);
        assert_eq!(f["streamMarker"], STREAM_MARKER);
    }

    #[test]
    fn every_in_band_code_is_listed_and_every_listed_one_exists() {
        let f = fixture();
        let listed: std::collections::BTreeSet<String> = f["refusals"]
            .as_array()
            .expect("refusals is a list")
            .iter()
            .filter(|r| r["inBand"] == true)
            .map(|r| r["code"].as_str().expect("code").to_string())
            .collect();
        let ours: std::collections::BTreeSet<String> =
            Code::ALL.iter().map(|c| c.as_str().to_string()).collect();
        assert_eq!(listed, ours);
    }

    #[test]
    fn headers_carry_the_code_and_the_rule() {
        let mut h = HeaderMap::new();
        Refusal::new(Code::SsoGroup, "sso_group.high_risk.Bash").apply(&mut h);
        assert_eq!(h[HEADER], "SSO_GROUP");
        assert_eq!(h[RULE_HEADER], "sso_group.high_risk.Bash");
    }

    #[test]
    fn a_rule_that_is_not_a_header_value_is_left_off() {
        let mut h = HeaderMap::new();
        Refusal::new(Code::OutputDlp, "dlp.bad\nvalue").apply(&mut h);
        assert_eq!(h[HEADER], "OUTPUT_DLP");
        assert!(h.get(RULE_HEADER).is_none());
    }

    #[test]
    fn the_stream_marker_is_one_comment_line_with_a_json_payload() {
        let m =
            Refusal::new(Code::ToolDenied, "deny_tools.Bash").stream_marker("no \"Bash\"\nhere");
        assert!(m.starts_with(STREAM_MARKER));
        assert!(m.ends_with("\n\n"));
        let line = m.trim_end();
        assert!(
            !line.contains('\n'),
            "the payload must stay on the comment line"
        );
        let payload: serde_json::Value =
            serde_json::from_str(&line[STREAM_MARKER.len()..]).expect("JSON payload");
        assert_eq!(
            payload,
            serde_json::json!({"code": "TOOL_DENIED", "rule": "deny_tools.Bash", "message": "no \"Bash\"\nhere"})
        );
    }

    #[test]
    fn refusal_detail_is_bounded_and_stripped_of_control_characters() {
        let long = "x".repeat(400);
        let scope = RefusalScope {
            paths: (0..12).map(|i| format!("p{i}\n")).collect(),
            tools: vec![long.clone(), "\u{1b}[31mBash".into(), "\u{7}".into()],
            step: Some("prerequisite\r".into()),
            ..RefusalScope::default()
        }
        .bounded();
        assert_eq!(scope.paths.len(), DETAIL_MAX_ITEMS);
        assert_eq!(scope.paths[0], "p0");
        assert_eq!(scope.tools[0].chars().count(), DETAIL_MAX_CHARS);
        assert_eq!(scope.tools[1], "[31mBash");
        assert_eq!(scope.tools.len(), 2, "an all-control entry is dropped");
        assert_eq!(scope.step.as_deref(), Some("prerequisite"));
        // Characters, not bytes.
        assert_eq!(bound_detail(&"é".repeat(300)).chars().count(), 256);
        let ev: Vec<RefusalEvidence> = (0..10)
            .map(|i| RefusalEvidence::new("k", format!("d{i}")))
            .collect();
        assert_eq!(bound_evidence(&ev).len(), DETAIL_MAX_ITEMS);
    }

    #[test]
    fn opaque_drops_scope_and_evidence_and_silent_log_keeps_them() {
        let mut r = Refusal::new(Code::OutOfScope, "scope_paths.Deploy")
            .with_scope(Some(RefusalScope::paths(["infra/x.tf"])));
        r.evidence.push(RefusalEvidence::new("scope", "packages/"));
        let opaque = r.clone().for_mode(InterventionMode::Opaque);
        assert!(opaque.scope.is_none() && opaque.evidence.is_empty());
        let marker = opaque.stream_marker(OPAQUE_MESSAGE);
        assert!(!marker.contains("scope") && !marker.contains("evidence"));
        for mode in [InterventionMode::Transparent, InterventionMode::SilentLog] {
            let shown = r.clone().for_mode(mode);
            assert_eq!(shown.scope, r.scope);
            let line = shown.stream_marker("m");
            let payload: serde_json::Value =
                serde_json::from_str(line.trim_end().strip_prefix(STREAM_MARKER).unwrap()).unwrap();
            assert_eq!(payload["scope"]["paths"][0], "infra/x.tf");
            assert_eq!(payload["evidence"][0]["kind"], "scope");
        }
    }

    #[test]
    fn the_new_codes_name_themselves() {
        assert_eq!(Code::PrerequisiteUnmet.as_str(), "PREREQUISITE_UNMET");
        assert_eq!(Code::OutOfScope.as_str(), "OUT_OF_SCOPE");
        assert_eq!(Code::ALL.len(), 8);
    }

    #[test]
    fn tool_rule_ids_keep_only_rule_id_characters() {
        assert_eq!(tool_rule_id("deny_tools", "Bash"), "deny_tools.Bash");
        assert_eq!(
            tool_rule_id("deny_tools", "run cmd/x\u{e9}"),
            "deny_tools.run_cmd_x_"
        );
    }
}

#[cfg(test)]
mod lld75_vectors {
    //! `fixtures/refusal-detail-vectors.json`: bounding, the
    //! intervention mode, and the retry line, as the TypeScript and Python
    //! ports read them.
    use super::*;
    use serde_json::Value;

    /// A scope from loosely typed JSON: non-strings dropped, as the ports do.
    fn scope_of(v: &Value) -> Option<RefusalScope> {
        let o = v.as_object()?;
        let list = |k: &str| -> Vec<String> {
            o.get(k)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        let one = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        Some(RefusalScope {
            paths: list("paths"),
            tools: list("tools"),
            step: one("step"),
            detector: one("detector"),
            rule: one("rule"),
        })
    }

    fn evidence_of(v: &Value) -> Vec<RefusalEvidence> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_object())
                    .map(|o| {
                        RefusalEvidence::new(
                            o.get("kind").and_then(Value::as_str).unwrap_or(""),
                            o.get("detail").and_then(Value::as_str).unwrap_or(""),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn bounded_json(s: Option<&RefusalScope>) -> Value {
        s.map(RefusalScope::bounded)
            .filter(|b| !b.is_empty())
            .map(|b| serde_json::to_value(b).unwrap())
            .unwrap_or(Value::Null)
    }

    #[test]
    fn every_refusal_detail_vector_holds() {
        let Some(v) =
            crate::plugins::anomaly::outcome::lld75_fixture("refusal-detail-vectors.json")
        else {
            return;
        };
        for c in v["scope"].as_array().unwrap() {
            assert_eq!(
                bounded_json(scope_of(&c["input"]).as_ref()),
                c["output"],
                "{}",
                c["name"]
            );
        }
        for c in v["evidence"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(bound_evidence(&evidence_of(&c["input"]))).unwrap(),
                c["output"],
                "{}",
                c["name"]
            );
        }
        for c in v["forMode"].as_array().unwrap() {
            let mode = InterventionMode::parse(c["mode"].as_str());
            let (s, e) = detail_for_mode(
                scope_of(&c["scope"]).as_ref(),
                &evidence_of(&c["evidence"]),
                mode,
            );
            let mut out = serde_json::Map::new();
            if let Some(s) = s {
                out.insert("scope".into(), serde_json::to_value(s).unwrap());
            }
            if !e.is_empty() {
                out.insert("evidence".into(), serde_json::to_value(e).unwrap());
            }
            assert_eq!(Value::Object(out), c["output"], "{}", c["name"]);
        }
        for c in v["retryLine"].as_array().unwrap() {
            let mode = InterventionMode::parse(c["mode"].as_str());
            assert_eq!(
                retry_scope_line(scope_of(&c["scope"]).as_ref(), mode).as_deref(),
                c["line"].as_str(),
                "{}",
                c["name"]
            );
        }
    }
}
