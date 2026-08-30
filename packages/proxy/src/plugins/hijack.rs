//! Tool calls the proxy substituted before the harness could run them.
//!
//! # What a "hijack" is here, precisely
//!
//! `decision_mining_queue.hijacked_tool_call` has always meant: the model asked
//! for one thing, the product substituted another, and *the substitute is what
//! ran*. That is a strong claim, and most of the proxy's controls do not make
//! it. They are worth naming, because each was checked and rejected as a
//! producer for this column rather than assumed unsuitable:
//!
//! - A **review hold** (`services/control-plane` `POST /api/v1/decisions`)
//!   stops an action. Nothing was rewritten, so there is no pair — and
//!   `holdRedaction.ts` computing a redacted *snapshot* for a reviewer does not
//!   change that, because the snapshot never executes.
//! - The **response gate** refuses. The denied call is withheld and replaced by
//!   a text refusal, not by a corrected call.
//! - **Request-path DLP** does rewrite tool-call arguments, but only in
//!   conversation *history* — those calls already ran. That is a corrected
//!   transcript, not a corrected call.
//! - The **snip compactor** touches `tool_result` text and message content, and
//!   no branch of it reads `tool_calls`, `arguments`, `input` or `tool_use`.
//! - **mcp-proxy** has a `redact` decision variant and a `tool_redacted` event
//!   kind in its types, and nothing constructs either; its policy rule type has
//!   no rewrite action, and its forwarder writes the original raw JSON-RPC line
//!   regardless.
//!
//! **Response-path DLP on the non-streaming path is the exception**, and it is
//! a real one. `dlp::scan` is whole-string and `dlp::redact` is offset-based
//! over that same string, so redacting a response body reaches inside a tool
//! call's `arguments` — and the redacted body is the body that ships. The
//! harness executes the corrected call. That is exactly the claim the column
//! makes, and `packages/db/src/seed.ts` describes this precise case
//! (`aws_client{access_key: AKIA…}` → redacted), so it is what the column was
//! designed for rather than a novel reading of it.
//!
//! # Why this is non-streaming only
//!
//! Streaming redaction of tool arguments is real — `dlp::scrub_stream_text`
//! runs on every wire line — but it is **unattributable**. OpenAI dribbles
//! `arguments` across chunks and Anthropic sends `input_json_delta`, so no
//! point in the forward loop holds a complete original *and* a complete
//! corrected call. Reporting a streaming redaction as a pair would be inventing
//! one side of it. It is reported as a count instead, in the warning
//! `proxy::handle_proxy` emits when the stream ends.
//!
//! # Honest frequency
//!
//! A row exists only when a secret is genuinely present inside a tool call's
//! arguments. That is rare. This does **not** make the column non-null in the
//! general case and nothing here should be read as claiming it does — the
//! overwhelming majority of decisions still have no substitution, because no
//! substitution happened.

use serde_json::Value;

/// One tool call the proxy rewrote, with both sides of the substitution.
#[derive(Debug, Clone, PartialEq)]
pub struct HijackedCall {
    /// The tool's name. Unchanged by redaction — only arguments are rewritten.
    pub tool: String,
    /// The call as the model emitted it.
    pub original: Value,
    /// The call as it shipped, and therefore as the harness ran it.
    pub hijacked: Value,
}

/// Tool calls whose arguments differ between `before` and `after`.
///
/// Both sides are extracted with `routing::integrity::response_tool_calls`,
/// which is public for exactly this reason: a second extractor here would be a
/// second opinion on what counts as a tool call, and the two disagreeing is how
/// a substitution gets recorded against the wrong call — or missed.
///
/// Matched **by position**, not by name or id. Redaction cannot add, remove or
/// reorder calls; it rewrites bytes inside argument strings, so position is
/// stable across it by construction. A length mismatch therefore means the
/// assumption failed, and the honest response is to report nothing rather than
/// to zip mismatched calls into pairs that never existed.
pub fn substituted_calls(before: &Value, after: &Value) -> Vec<HijackedCall> {
    let originals = crate::routing::integrity::response_tool_calls(before);
    let corrected = crate::routing::integrity::response_tool_calls(after);

    if originals.len() != corrected.len() {
        tracing::warn!(
            before = originals.len(),
            after = corrected.len(),
            "Tool-call count changed across output redaction — not recording a substitution"
        );
        return Vec::new();
    }

    let mut out = Vec::new();
    for ((o_name, o_args, o_raw), (h_name, h_args, h_raw)) in
        originals.into_iter().zip(corrected)
    {
        // A name that changed means the two lists are not the same calls, so
        // the positional assumption above did not hold for this entry.
        if o_name != h_name {
            continue;
        }
        // `arguments` that would not parse are carried as the raw string, and
        // both sides have to be compared in whichever form they arrived in —
        // a redaction inside an unparseable argument string is still a
        // substitution the harness will act on.
        let original = args_value(&o_args, &o_raw);
        let hijacked = args_value(&h_args, &h_raw);
        if original == hijacked {
            continue;
        }
        out.push(HijackedCall {
            tool: o_name,
            original: serde_json::json!({ "name": h_name, "arguments": original }),
            hijacked: serde_json::json!({ "name": h_name, "arguments": hijacked }),
        });
    }
    out
}

/// The arguments in whichever form they survived extraction in.
fn args_value(parsed: &Option<Value>, raw: &Option<String>) -> Value {
    match (parsed, raw) {
        (Some(v), _) => v.clone(),
        (None, Some(r)) => Value::String(r.clone()),
        (None, None) => Value::Null,
    }
}

/// The batch body `POST /api/v1/decisions/substitutions` accepts.
///
/// `workspaceId` is deliberately **not** sent. The control plane takes the
/// workspace from the authenticated key, and a tenant id supplied by a caller
/// is a claim rather than an authorisation — the same rule `HoldSchema` states
/// for the daemon's holds, and this endpoint is reachable by every proxy.
pub fn report_body(
    session_id: &str,
    trace_id: &str,
    calls: &[HijackedCall],
) -> Value {
    serde_json::json!({
        "substitutions": calls
            .iter()
            .map(|c| serde_json::json!({
                "v": 1,
                "sessionId": session_id,
                "traceId": trace_id,
                "tool": c.tool,
                "originalToolCall": c.original,
                "hijackedToolCall": c.hijacked,
                "reason": "output_dlp_redaction",
            }))
            .collect::<Vec<_>>()
    })
}

/// Send the substitutions to the control plane.
///
/// Failure is logged and dropped. There is nothing to retry into — the response
/// has already been returned to the client — and a proxy that blocked on the
/// control plane to record a *past* event would convert an observability
/// outage into a latency outage.
pub async fn report(
    client: &reqwest::Client,
    control_plane_url: &str,
    token: &str,
    workspace_id: &str,
    session_id: &str,
    trace_id: &str,
    calls: &[HijackedCall],
) {
    let url = format!(
        "{}/api/v1/decisions/substitutions",
        control_plane_url.trim_end_matches('/')
    );
    let tools: Vec<&str> = calls.iter().map(|c| c.tool.as_str()).collect();
    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&report_body(session_id, trace_id, calls))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::warn!(
                workspace_id = %workspace_id,
                session_id = %session_id,
                trace_id = %trace_id,
                tools = ?tools,
                "Output DLP substituted a tool call before the harness ran it"
            );
        }
        Ok(resp) => {
            tracing::warn!(
                workspace_id = %workspace_id,
                status = %resp.status(),
                tools = ?tools,
                "Control plane refused a tool-call substitution report"
            );
        }
        Err(e) => {
            tracing::warn!(
                workspace_id = %workspace_id,
                error = %e,
                tools = ?tools,
                "Could not report a tool-call substitution"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The case `seed.ts` describes, through the code that actually ships it.
    ///
    /// Not a hand-written pair: the "after" side is produced by running the
    /// real `dlp::scan` + `dlp::redact` over the real body, which is the only
    /// way this test can show that redaction reaches inside `arguments` rather
    /// than that the author believes it does.
    #[test]
    fn a_redacted_credential_inside_tool_arguments_is_a_substitution() {
        // Fixture is runtime-assembled: the repo convention forbids contiguous
        // credential-shaped literals in source, in every package.
        let before_str = concat!(
            r#"{"choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"aws configure set aws_access_key_id AKIA"#,
            r#"IOSFODNN7EXAMPLE\"}"}}]}}]}"#
        );
        let findings = crate::dlp::scan(before_str);
        assert!(!findings.is_empty(), "the fixture must actually trip DLP");
        let after_str = crate::dlp::redact(before_str, &findings);

        let before: Value = serde_json::from_str(before_str).unwrap();
        let after: Value =
            serde_json::from_str(&after_str).expect("redaction must leave valid JSON");

        let hijacks = substituted_calls(&before, &after);
        assert_eq!(hijacks.len(), 1, "expected one substituted call: {hijacks:?}");
        assert_eq!(hijacks[0].tool, "bash");
        assert!(
            hijacks[0].original["arguments"]["command"]
                .as_str()
                .unwrap()
                .contains(concat!("AKIA", "IOSFODNN7EXAMPLE")),
            "the original side lost the secret it exists to record"
        );
        assert!(
            !hijacks[0].hijacked["arguments"]["command"]
                .as_str()
                .unwrap()
                .contains(concat!("AKIA", "IOSFODNN7EXAMPLE")),
            "the shipped call still carries the credential"
        );
        assert!(hijacks[0].hijacked["arguments"]["command"]
            .as_str()
            .unwrap()
            .contains("[REDACTED"));
    }

    /// Anthropic's `tool_use` blocks carry `input` as an object, and the same
    /// whole-body redaction reaches into it.
    #[test]
    fn anthropic_tool_use_input_is_covered_too() {
        let before_str = concat!(
            r#"{"content":[{"type":"tool_use","id":"toolu_1","name":"deploy","input":{"token":"AKIA"#,
            r#"IOSFODNN7EXAMPLE"}}]}"#
        );
        let findings = crate::dlp::scan(before_str);
        let after_str = crate::dlp::redact(before_str, &findings);
        let before: Value = serde_json::from_str(before_str).unwrap();
        let after: Value = serde_json::from_str(&after_str).unwrap();

        let hijacks = substituted_calls(&before, &after);
        assert_eq!(hijacks.len(), 1);
        assert_eq!(hijacks[0].tool, "deploy");
        assert_eq!(hijacks[0].original["arguments"]["token"], concat!("AKIA", "IOSFODNN7EXAMPLE"));
        assert!(hijacks[0].hijacked["arguments"]["token"]
            .as_str()
            .unwrap()
            .starts_with("[REDACTED"));
    }

    /// The OpenAI Responses shape, now that `response_tool_calls` reads it.
    #[test]
    fn responses_output_items_are_covered_too() {
        let before_str = concat!(
            r#"{"output":[{"type":"function_call","call_id":"c1","name":"bash","arguments":"{\"k\":\"AKIA"#,
            r#"IOSFODNN7EXAMPLE\"}"}]}"#
        );
        let findings = crate::dlp::scan(before_str);
        let after_str = crate::dlp::redact(before_str, &findings);
        let before: Value = serde_json::from_str(before_str).unwrap();
        let after: Value = serde_json::from_str(&after_str).unwrap();

        let hijacks = substituted_calls(&before, &after);
        assert_eq!(hijacks.len(), 1);
        assert_eq!(hijacks[0].tool, "bash");
    }

    /// A redaction that only touched assistant *text* is not a hijack. Nothing
    /// the harness executes changed, and recording one would assert a
    /// substitution that did not happen — the same lie the review-hold path
    /// refuses to tell by writing `null`.
    #[test]
    fn a_redaction_in_message_text_is_not_a_substitution() {
        let before_str = concat!(
            r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"your key is AKIA"#,
            r#"IOSFODNN7EXAMPLE","tool_calls":[{"id":"c1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]}}]}"#
        );
        let findings = crate::dlp::scan(before_str);
        assert!(!findings.is_empty());
        let after_str = crate::dlp::redact(before_str, &findings);
        let before: Value = serde_json::from_str(before_str).unwrap();
        let after: Value = serde_json::from_str(&after_str).unwrap();

        assert!(
            substituted_calls(&before, &after).is_empty(),
            "a text-only redaction was reported as a hijacked tool call"
        );
    }

    /// No redaction at all — the overwhelmingly common case — produces nothing.
    #[test]
    fn an_unchanged_body_produces_no_substitution() {
        let body: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]}}]}"#,
        )
        .unwrap();
        assert!(substituted_calls(&body, &body).is_empty());
    }

    /// A body with no tool calls at all cannot produce a pair, whatever else
    /// was redacted in it.
    #[test]
    fn a_body_without_tool_calls_produces_no_substitution() {
        let before: Value = serde_json::from_str(concat!(
            r#"{"choices":[{"message":{"content":"AKIA"#,
            r#"IOSFODNN7EXAMPLE"}}]}"#
        ))
        .unwrap();
        let after: Value =
            serde_json::from_str(r#"{"choices":[{"message":{"content":"[REDACTED_SECRET]"}}]}"#)
                .unwrap();
        assert!(substituted_calls(&before, &after).is_empty());
    }

    /// If the two sides disagree about how many calls exist, positional pairing
    /// is unsound and nothing is reported. Zipping anyway would attribute a
    /// substitution to a call that never carried it.
    #[test]
    fn a_call_count_mismatch_reports_nothing() {
        let before: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"a","arguments":"{}"}},{"function":{"name":"b","arguments":"{}"}}]}}]}"#,
        )
        .unwrap();
        let after: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"a","arguments":"{}"}}]}}]}"#,
        )
        .unwrap();
        assert!(substituted_calls(&before, &after).is_empty());
    }

    /// The wire body, including what it must NOT carry.
    ///
    /// The workspace comes from the authenticated key on the control plane. A
    /// tenant id in the payload would be a claim the endpoint could be tempted
    /// to trust, and every proxy can reach that endpoint.
    #[test]
    fn the_report_body_carries_both_sides_and_no_tenant_claim() {
        let calls = vec![HijackedCall {
            tool: "bash".into(),
            original: json!({"name": "bash", "arguments": {"command": "AKIA..."}}),
            hijacked: json!({"name": "bash", "arguments": {"command": "[REDACTED_SECRET]"}}),
        }];
        let body = report_body("ses_1", "tr_1", &calls);
        let s = serde_json::to_string(&body).unwrap();
        assert!(!s.contains("workspaceId"), "the report claimed a tenant: {s}");

        let entry = &body["substitutions"][0];
        assert_eq!(entry["v"], 1);
        assert_eq!(entry["sessionId"], "ses_1");
        // The proxy knows the trace; it must not be left for reconstruction.
        assert_eq!(entry["traceId"], "tr_1");
        assert_eq!(entry["tool"], "bash");
        assert_eq!(entry["reason"], "output_dlp_redaction");
        assert_eq!(entry["originalToolCall"]["arguments"]["command"], "AKIA...");
        assert_eq!(
            entry["hijackedToolCall"]["arguments"]["command"],
            "[REDACTED_SECRET]"
        );
    }

    /// Arguments that never parsed as JSON are still compared, in raw form. A
    /// secret redacted inside a malformed argument string is still a call the
    /// harness will act on differently.
    #[test]
    fn unparseable_arguments_are_compared_in_raw_form() {
        let before: Value = serde_json::from_str(concat!(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"bash","arguments":"{not json AKIA"#,
            r#"IOSFODNN7EXAMPLE"}}]}}]}"#,
        ))
        .unwrap();
        let after: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"tool_calls":[{"function":{"name":"bash","arguments":"{not json [REDACTED_SECRET]"}}]}}]}"#,
        )
        .unwrap();
        let hijacks = substituted_calls(&before, &after);
        assert_eq!(hijacks.len(), 1);
        assert_eq!(hijacks[0].original["arguments"], concat!("{not json AKIA", "IOSFODNN7EXAMPLE"));
        assert_eq!(hijacks[0].hijacked["arguments"], "{not json [REDACTED_SECRET]");
    }
}
