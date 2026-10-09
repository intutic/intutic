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

    /// Names the refusal on a non-streaming response. A rule id that is not a
    /// valid header value is left off rather than failing the response; the
    /// code alone still tells the SDK it was refused.
    pub fn apply(&self, headers: &mut HeaderMap) {
        headers.insert(HEADER, HeaderValue::from_static(self.code.as_str()));
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

    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/fixtures/refusal-codes.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
        serde_json::from_str::<serde_json::Value>(&text).expect("refusal-codes.json parses")
            ["proxy"]
            .clone()
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
