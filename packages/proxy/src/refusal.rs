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

/// The workspace's intervention mode: the `interventionMode` of its active
/// PCAS policy with the lowest priority, carried on `/auth/key-context`
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
}

impl Code {
    pub const ALL: [Code; 6] = [
        Code::CostGateExceeded,
        Code::ToolDenied,
        Code::SsoGroup,
        Code::SqlGuard,
        Code::ResponseUnparseable,
        Code::OutputDlp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Code::CostGateExceeded => "COST_GATE_EXCEEDED",
            Code::ToolDenied => "TOOL_DENIED",
            Code::SsoGroup => "SSO_GROUP",
            Code::SqlGuard => "SQL_GUARD",
            Code::ResponseUnparseable => "RESPONSE_UNPARSEABLE",
            Code::OutputDlp => "OUTPUT_DLP",
        }
    }
}

/// One in-band refusal: what refused, and which rule decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: Code,
    pub rule: String,
}

impl Refusal {
    pub fn new(code: Code, rule: impl Into<String>) -> Self {
        Self {
            code,
            rule: rule.into(),
        }
    }

    /// The refusal as the agent may see it under `mode`. Under OPAQUE the rule
    /// id is emptied, which leaves the rule header off ([`Refusal::apply`])
    /// and the stream marker's `rule` an empty string; the code is kept, so
    /// an SDK still knows what kind of refusal it was.
    pub fn for_mode(mut self, mode: InterventionMode) -> Self {
        if mode == InterventionMode::Opaque {
            self.rule.clear();
        }
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
        let payload = serde_json::json!({
            "code": self.code.as_str(),
            "rule": self.rule,
            "message": message,
        });
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
    fn tool_rule_ids_keep_only_rule_id_characters() {
        assert_eq!(tool_rule_id("deny_tools", "Bash"), "deny_tools.Bash");
        assert_eq!(
            tool_rule_id("deny_tools", "run cmd/x\u{e9}"),
            "deny_tools.run_cmd_x_"
        );
    }
}
