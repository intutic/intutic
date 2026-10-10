//! Response-side tool-call gate — refuse a tool call before the client sees it.
//!
//! # Why this exists
//!
//! Tool authorisation used to happen exactly one turn late. `UnauthorizedToolDetector`
//! reads `RequestContext::tool_calls`, which `manifest::extract_request_tool_invocations`
//! fills from the *conversation history the client sends back* — so the first
//! request that carries a forbidden call is the request issued *after* the
//! harness already ran it. The proxy blocked the follow-up and reported a
//! violation for something that had already happened.
//!
//! The proxy is, however, the thing that hands the response to the client: it
//! reads the whole body on the non-streaming path and forwards the stream
//! line by line on the streaming one. Every byte passes through here first,
//! which is all response-side enforcement needs. No harness cooperation, no
//! per-harness hook — a call refused here never reaches the tool runner.
//!
//! # What it can and cannot match
//!
//! Non-streaming, the whole body is in hand, so both the tool **name** and its
//! **arguments** are available. Streaming, they are not: OpenAI sends
//! `function.name` on the first `tool_calls` delta and dribbles `arguments` out
//! as JSON fragments across later chunks, and the decision to withhold has to be
//! made on the chunk in front of us — buffering until the arguments are complete
//! would mean holding back the whole response, which defeats streaming.
//!
//! So the streaming gate matches on the tool **name only**. That is exactly
//! sufficient for a denied-tools policy, which is itself keyed on names
//! (`sops::denied_tools_for_role`), and it is honest about the limit:
//! **argument-level matching is non-streaming-only.** Anything built on top of
//! this that wants to gate on argument *values* must not assume the streaming
//! path can see them.
//!
//! The one argument-level rule, the destructive-SQL guard (`sql_guard:` in a
//! SOP), gets its arguments on a stream the other way: while it is in
//! force, the lines of a *shell-tool* block are held back until the block ends
//! and evaluated whole — see [`crate::plugins::sql_guard::StreamHold`]. Every
//! other block, and every stream with no SQL guard declared, flows unheld.
//!
//! # Wire shapes it does not see
//!
//! Anthropic (`content[].type == "tool_use"`, `content_block_start`), OpenAI
//! chat completions (`choices[].message.tool_calls[]`,
//! `choices[].delta.tool_calls[]`) and — since the Responses gap was closed —
//! the OpenAI Responses API (`response.output_item.added` with
//! `item.type == "function_call"`).
//!
//! The Responses shape was the serious omission, and it was missing on **both**
//! paths, not just the streaming one:
//!
//! - Streaming: `try_parse_openai` needs `choices[]`, which a Responses stream
//!   never emits, so a denied tool call reached Codex CLI's tool runner.
//! - Non-streaming: a same-provider `/v1/responses` body is forwarded
//!   *untranslated*, so it arrives here as `output[]` — which matched neither
//!   arm of `routing::integrity::response_tool_calls` either. The initial
//!   reading of this gap said non-streaming was covered because the body is
//!   translated to `choices[]`; that is only true cross-provider.
//!
//! Both are closed now. That was a policy control silently off, not a missing
//! feature — the deny list was reported as enforced on a route where nothing
//! enforced it.
//!
//! **Gemini's native `functionCall` parts are not matched**, on either path,
//! because neither of the two extractors this reuses —
//! `routing::integrity::response_tool_calls` and
//! `protocol::tool_use_parser::parse_sse_chunk` — reads
//! `candidates[].content.parts[].functionCall`. A Gemini request the proxy
//! forwards to Gemini is therefore ungated. Teaching those two extractors the
//! Gemini shape is what closes it, and both are shared with the routing
//! integrity scorer, so it is a behaviour change there too rather than an
//! addition here.
//!
//! # SSO-group clearance
//!
//! The same name-keyed check carries the workspace's SSO group policy
//! ([`crate::sso_groups`]): a tool the member's groups do not clear, or one
//! that is on-behalf-of only, is withheld exactly as a `deny_tools` hit is,
//! and the refusal names the deciding rule (`[sso_group.high_risk.Bash]`).
//! Harnesses with no hook system of their own — Roo Code, or aider pointed at
//! the proxy — have no other gate to apply it. Neither
//! shadow enforcement nor any intervention mode softens it, matching the hook
//! gate, the MCP proxy and the harness gates.
//!
//! # Fail direction
//!
//! Two-level, deliberately.
//!
//! 1. **Scope.** The gate is inert unless the role has a non-empty deny list
//!    (or the workspace has an SSO group policy that names a tool).
//!    A workspace that has declared no `deny_tools` cannot be broken by any of
//!    this, whatever the response looks like. That is what keeps a fail-closed
//!    default from being reckless: the blast radius is the set of operators who
//!    explicitly asked for enforcement.
//! 2. **Within that scope, closed.** A response body that will not parse as
//!    JSON cannot be shown to be free of a denied call, so with a deny list in
//!    force it is refused rather than forwarded (`ResponseGateConfig::fail_closed`,
//!    default `true`). An operator who would rather ship an unverifiable body
//!    than a refusal sets `fail_closed: false`.
//!
//! The streaming path deliberately does **not** honour `fail_closed`. Most SSE
//! lines are not JSON at all — `event:` headers, blank separators, `:` comments
//! — so "refuse anything that does not parse" would kill every stream rather
//! than a suspicious one. On a stream the gate acts on what it can read and
//! nothing else; see `gate_stream_line`.

use serde_json::Value;

use crate::commands::WireProvider;
use crate::config::ResponseGateConfig;
use crate::plugins::anomaly::AnomalyKind;
use crate::plugins::sql_guard::{self, SqlGuardPolicy, SqlViolation};
use crate::refusal::{tool_rule_id, Code, Refusal};
use crate::sso_groups::{Clearance, SsoGroupDecision, SsoGroupGate};

/// Why the gate refused a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenialReason {
    /// Tool names the role's SOPs forbid, sorted and deduped.
    Tools(Vec<String>),
    /// A tool the workspace's SSO group policy refuses this member — `DENIED`
    /// or `REQUIRES_OBO`, which every gate refuses alike.
    SsoGroup {
        tool: String,
        decision: SsoGroupDecision,
    },
    /// A shell call that would run destructive SQL against a database the
    /// role's `sql_allow_dsns:` does not admit (`plugins::sql_guard`).
    DestructiveSql(SqlViolation),
    /// The body did not parse, so the gate could not show it carried no denied
    /// call. Only ever produced when `fail_closed` is set.
    Unparseable,
}

/// A refusal the caller must act on before any of the response reaches the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denial {
    pub reason: DenialReason,
    /// Where the refusal text has to be written on a stream: the content-block
    /// index (Anthropic) or choice index (OpenAI) the withheld event carried.
    ///
    /// Meaningless on the non-streaming path — there the whole body is replaced
    /// — and left at `0` there.
    pub block_index: u64,
}

impl Denial {
    /// Re-address the refusal to a different index.
    ///
    /// Needed on the cross-provider streaming path, where the withheld event is
    /// Anthropic-shaped — so `block_index` is a *content-block* index — while
    /// the refusal is written as an OpenAI chunk, where the index names a
    /// *choice*. Carrying block 1 across would address choice 1 of a completion
    /// that has exactly one choice.
    pub fn at_block(mut self, index: u64) -> Self {
        self.block_index = index;
        self
    }

    /// The code and rule id that name this refusal to an SDK: in the
    /// response headers on the non-streaming path, in the stream marker on
    /// the streaming one (`crate::refusal`).
    pub fn refusal(&self) -> Refusal {
        match &self.reason {
            DenialReason::Tools(t) => Refusal::new(
                Code::ToolDenied,
                tool_rule_id(
                    "deny_tools",
                    t.first().map(String::as_str).unwrap_or_default(),
                ),
            ),
            DenialReason::SsoGroup { tool, decision } => Refusal::new(
                Code::SsoGroup,
                decision
                    .rule_id
                    .clone()
                    .unwrap_or_else(|| tool_rule_id("sso_group", tool)),
            ),
            DenialReason::DestructiveSql(_) => {
                Refusal::new(Code::SqlGuard, "sql_guard.sql_allow_dsns")
            }
            DenialReason::Unparseable => {
                Refusal::new(Code::ResponseUnparseable, "response_gate.fail_closed")
            }
        }
    }

    /// Operator-facing one-liner. Deliberately the same vocabulary as the
    /// request-side block at `proxy.rs` so both read as one policy rather than
    /// two features: `[UNAUTHORIZED_TOOL]` plus the offending names.
    pub fn log_message(&self) -> String {
        match &self.reason {
            DenialReason::Tools(t) => format!(
                "Response blocked by anomaly policy [{}]: forbidden tool call: {} — denied by an SOP in force for this node",
                AnomalyKind::UnauthorizedTool.as_str(),
                t.join(", ")
            ),
            DenialReason::SsoGroup { decision, .. } => format!(
                "Response blocked by SSO group policy [{}]: {}",
                decision.clearance.as_str(),
                decision.refusal_reason()
            ),
            DenialReason::DestructiveSql(v) => format!(
                "Response blocked by anomaly policy [{}]: {}",
                AnomalyKind::ToolAbuse.as_str(),
                v.log_message()
            ),
            DenialReason::Unparseable => format!(
                "Response blocked by anomaly policy [{}]: response body did not parse, and a tool deny list, SSO group policy or SQL guard is in force — cannot show it carries no forbidden call",
                AnomalyKind::UnauthorizedTool.as_str()
            ),
        }
    }

    /// What the *agent* is told, in the response body itself.
    ///
    /// Written for a model that will read it as its own previous turn, so it
    /// says what happened, that the call did not run, and what to do instead.
    /// A bare "blocked" invites an immediate retry of the same call.
    pub fn agent_message(&self) -> String {
        match &self.reason {
            DenialReason::Tools(t) => format!(
                "[Intutic] Blocked tool call: {}. This tool is denied by an SOP in force for this agent role. \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that tool, or ask an operator to change the policy.",
                t.join(", ")
            ),
            DenialReason::SsoGroup { tool, decision } => format!(
                "[Intutic] Blocked tool call: {tool}. {} \
                 The call was withheld by the proxy and never reached the client, so it did not run. \
                 Do not retry it — continue without that tool, or ask an operator for the access.",
                decision.refusal_reason()
            ),
            DenialReason::DestructiveSql(v) => v.agent_message(),
            DenialReason::Unparseable => {
                "[Intutic] The model's response could not be parsed, and a tool deny list, SSO group policy or SQL guard is in force \
                 for this agent role, so the proxy could not show the response carried no forbidden \
                 tool call. The response was withheld. Retry the request."
                    .to_string()
            }
        }
    }
}

/// Case-insensitive membership, matching `UnauthorizedToolDetector`.
fn is_denied(name: &str, denied_tools: &[String]) -> bool {
    denied_tools.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Whether this gate has anything to do at all.
///
/// Both halves matter: `enabled` is the operator's off switch, and an empty
/// deny list means there is no policy to enforce, so running would only be a
/// chance to be wrong.
fn active(cfg: &ResponseGateConfig, denied_tools: &[String]) -> bool {
    cfg.enabled && !denied_tools.is_empty()
}

/// Evaluate a complete, parsed response body.
///
/// `body` is `None` when the bytes did not parse as JSON — see the fail
/// direction note in the module docs.
pub fn gate_response(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    denied_tools: &[String],
) -> Option<Denial> {
    if !active(cfg, denied_tools) {
        return None;
    }

    let Some(body) = body else {
        return cfg.fail_closed.then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };

    // Shared with the routing-integrity scorer rather than reimplemented: it
    // already handles both wire shapes, including OpenAI's `arguments` arriving
    // as a JSON *string*. Two extractors would be two chances to disagree about
    // what counts as a tool call, and the disagreement would be silent.
    let mut hits: Vec<String> = crate::routing::integrity::response_tool_calls(body)
        .into_iter()
        .map(|(name, _args, _raw)| name)
        .filter(|name| is_denied(name, denied_tools))
        .collect();
    if hits.is_empty() {
        return None;
    }
    hits.sort();
    hits.dedup();

    Some(Denial {
        reason: DenialReason::Tools(hits),
        block_index: 0,
    })
}

/// The SSO group gate, when there is one that could refuse something and the
/// response gate is on.
fn active_sso_gate<'a>(
    cfg: &ResponseGateConfig,
    gate: Option<&'a SsoGroupGate>,
) -> Option<&'a SsoGroupGate> {
    gate.filter(|g| cfg.enabled && g.can_refuse())
}

fn sso_group_denial(gate: &SsoGroupGate, tool: &str, block_index: u64) -> Option<Denial> {
    let decision = gate.decide(tool);
    (decision.clearance != Clearance::Granted).then(|| Denial {
        reason: DenialReason::SsoGroup {
            tool: tool.to_string(),
            decision,
        },
        block_index,
    })
}

/// Evaluate a complete, parsed response body against the workspace's SSO
/// group policy, for the member the request's key belongs to.
///
/// Inert without a policy or with the gate off — the same two-level fail
/// direction as the deny list, `fail_closed` included. The first refused call
/// decides; the body is replaced whole, so a second one never ships either.
pub fn gate_response_sso_groups(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    gate: Option<&SsoGroupGate>,
) -> Option<Denial> {
    let gate = active_sso_gate(cfg, gate)?;
    let Some(body) = body else {
        return cfg.fail_closed.then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
    };
    crate::routing::integrity::response_tool_calls(body)
        .into_iter()
        .find_map(|(name, _args, _raw)| sso_group_denial(gate, &name, 0))
}

/// The SSO group check on one SSE line — name only, like [`gate_stream_line`],
/// and like it `None` for any line that is not a readable tool-call start.
pub fn gate_stream_line_sso_groups(
    cfg: &ResponseGateConfig,
    line: &str,
    gate: Option<&SsoGroupGate>,
) -> Option<Denial> {
    let gate = active_sso_gate(cfg, gate)?;
    let event = crate::protocol::tool_use_parser::parse_sse_chunk(line)?;
    sso_group_denial(gate, &event.tool_name, event.block_index)
}

/// Evaluate a complete, parsed response body against the SQL guard in force.
///
/// Returns the refusal, if an enforcing `refuse` policy is violated, and every
/// other violation (`warn`, shadow) for the caller to log. Argument-level, so
/// on a stream this is [`sql_guard::StreamHold`]'s job instead.
///
/// Inert when the gate is disabled or no SOP declares `sql_guard:` — the same
/// two-level fail direction the deny list follows, including `fail_closed` for
/// a body that will not parse while a `refuse` policy is in force.
pub fn gate_response_sql(
    cfg: &ResponseGateConfig,
    body: Option<&Value>,
    policies: &[SqlGuardPolicy],
) -> (Option<Denial>, Vec<SqlViolation>) {
    if !cfg.enabled || policies.is_empty() {
        return (None, Vec::new());
    }
    let Some(body) = body else {
        let refusing = policies.iter().any(SqlGuardPolicy::refuses);
        let denial = (cfg.fail_closed && refusing).then_some(Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        });
        return (denial, Vec::new());
    };
    let mut denial = None;
    let mut notes = Vec::new();
    for (name, args, raw) in crate::routing::integrity::response_tool_calls(body) {
        // Arguments that did not parse as JSON are still a command string.
        let args = args
            .or_else(|| raw.map(Value::String))
            .unwrap_or(Value::Null);
        for v in sql_guard::evaluate(policies, &name, &args) {
            if denial.is_none() && v.refuses() {
                denial = Some(Denial {
                    reason: DenialReason::DestructiveSql(v),
                    block_index: 0,
                });
            } else {
                notes.push(v);
            }
        }
    }
    (denial, notes)
}

/// Evaluate one SSE line, before it is forwarded.
///
/// Returns `Some` only when the line *is readable* and *does* carry a denied
/// tool name. A line that is not a `data:` line, or whose payload is not JSON,
/// yields `None`: on a stream that is the overwhelmingly common case (event
/// headers, blank separators, keep-alive comments) and refusing it would end
/// every stream rather than a suspicious one. `fail_closed` is therefore
/// non-streaming-only, by design and not by omission.
pub fn gate_stream_line(
    cfg: &ResponseGateConfig,
    line: &str,
    denied_tools: &[String],
) -> Option<Denial> {
    if !active(cfg, denied_tools) {
        return None;
    }

    let event = crate::protocol::tool_use_parser::parse_sse_chunk(line)?;
    if !is_denied(&event.tool_name, denied_tools) {
        return None;
    }

    Some(Denial {
        reason: DenialReason::Tools(vec![event.tool_name]),
        block_index: event.block_index,
    })
}

/// The body to send instead, on the non-streaming path.
///
/// # Why a 200 with a refusal message and not a 403
///
/// The request-side block returns `403 policy_denied`, and copying that here
/// was the obvious move. It is the wrong one:
///
/// * The streaming path **cannot** return a status — bytes are already on the
///   wire — so it has to refuse in band. Two paths refusing the same policy in
///   two incompatible ways is a bug waiting to be found by a customer whose
///   agent only breaks when `stream: true`.
/// * A request-side 403 happens before the model ran. Here the model *did* run;
///   the thing being refused is one block of its output. The faithful
///   representation of that is an assistant turn saying so.
/// * Harnesses treat a non-2xx from the completions endpoint as a transport
///   fault and retry. The retry replays the same prompt, gets the same tool
///   call, and 403s again — a paid-for loop that never tells the model why. An
///   in-band refusal puts the reason where the model will read it next turn.
///
/// The safety property is unchanged either way: the returned body contains no
/// `tool_use` block and no `tool_calls` array, so there is nothing executable
/// left for the client to run.
pub fn refusal_body(provider: WireProvider, model: &str, denial: &Denial) -> Value {
    crate::commands::non_streaming_body(provider, model, &denial.agent_message())
}

/// The bytes to append instead of the withheld event, on the streaming path.
///
/// They open with the SSE comment that names the refusal to an SDK
/// ([`crate::refusal`]), which every client skips.
///
/// This closes the stream *coherently*: a client parsing `text/event-stream`
/// still sees a terminal event, and the refusal arrives as ordinary assistant
/// text at the index the tool call would have occupied.
///
/// `proxy::get_terminal_stream_event` is deliberately not reused for Anthropic.
/// It hardcodes `content_block_stop` at index 0, which double-closes the text
/// block the model had already finished before it reached for the tool — the
/// client would see a stop for a block that is already stopped and no stop for
/// the block this refusal opens. `commands::streaming_body` is not reusable
/// either: it emits a whole stream starting at `message_start`, and a second
/// `message_start` mid-message is not a stream any client can parse.
pub fn refusal_tail(provider: WireProvider, denial: &Denial) -> String {
    let text = denial.agent_message();
    let idx = denial.block_index;
    // First, so a client that stops reading at the terminal event has
    // already passed it.
    let marker = denial.refusal().stream_marker(&text);

    let events = match provider {
        WireProvider::Anthropic => {
            let start = serde_json::json!({
                "type": "content_block_start",
                "index": idx,
                "content_block": { "type": "text", "text": "" }
            });
            let delta = serde_json::json!({
                "type": "content_block_delta",
                "index": idx,
                "delta": { "type": "text_delta", "text": text }
            });
            let stop = serde_json::json!({ "type": "content_block_stop", "index": idx });
            let msg_delta = serde_json::json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": 0 }
            });
            format!(
                "event: content_block_start\ndata: {start}\n\n\
                 event: content_block_delta\ndata: {delta}\n\n\
                 event: content_block_stop\ndata: {stop}\n\n\
                 event: message_delta\ndata: {msg_delta}\n\n\
                 event: message_stop\ndata: {{\"type\": \"message_stop\"}}\n\n"
            )
        }
        // The Responses API has neither `choices[]` nor `[DONE]`. Emitting the
        // OpenAI arm here would cut the stream — which does stop the tool call,
        // the security property — and then hand Codex CLI bytes it cannot
        // parse, so the agent would see a transport failure rather than the
        // refusal it is supposed to read next turn. The refusal is written as
        // its own output item at the index the withheld `function_call` item
        // claimed, then the stream is closed with `response.completed`.
        WireProvider::OpenAIResponses => format!(
            "{}{}",
            crate::commands::responses_message_events(&text, idx, "msg_intutic_response_gate"),
            crate::commands::responses_terminal_event("intutic-response-gate"),
        ),
        // Gemini follows the OpenAI arm for the same reason
        // `get_terminal_stream_event` and `commands::streaming_body` do: the
        // proxy's Gemini streaming reaches the client as OpenAI chunks.
        _ => {
            let content = serde_json::json!({
                "id": "chatcmpl-intutic-response-gate",
                "object": "chat.completion.chunk",
                "choices": [{
                    "index": idx,
                    "delta": { "content": text },
                    "finish_reason": serde_json::Value::Null
                }]
            });
            let finish = serde_json::json!({
                "id": "chatcmpl-intutic-response-gate",
                "object": "chat.completion.chunk",
                "choices": [{
                    "index": idx,
                    "delta": {},
                    "finish_reason": "stop"
                }]
            });
            format!("data: {content}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
        }
    };
    format!("{marker}{events}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ResponseGateConfig {
        ResponseGateConfig::default()
    }

    fn denied() -> Vec<String> {
        vec!["Bash".to_string(), "terraform_apply".to_string()]
    }

    fn openai_response(tool: &str, args: &str) -> Value {
        serde_json::json!({
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": serde_json::Value::Null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": tool, "arguments": args }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        })
    }

    fn anthropic_response(tool: &str) -> Value {
        serde_json::json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "on it" },
                { "type": "tool_use", "id": "toolu_1", "name": tool, "input": { "cmd": "rm -rf /" } }
            ],
            "stop_reason": "tool_use"
        })
    }

    // ── Non-streaming: the two wire shapes ──────────────────────────────

    #[test]
    fn denies_openai_non_streaming_tool_call() {
        let body = openai_response("Bash", r#"{"command":"rm -rf /"}"#);
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("denied tool must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    #[test]
    fn denies_anthropic_non_streaming_tool_call() {
        let body = anthropic_response("bash");
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("denied tool must be caught");
        // Matched case-insensitively, like `UnauthorizedToolDetector` — a deny
        // list written `Bash` must not be evaded by emitting `bash`.
        assert_eq!(d.reason, DenialReason::Tools(vec!["bash".to_string()]));
    }

    /// The refusal that replaces the body must not smuggle the call through.
    #[test]
    fn refusal_body_carries_no_executable_tool_call() {
        let body = anthropic_response("bash");
        let d = gate_response(&cfg(), Some(&body), &denied()).unwrap();
        let out = refusal_body(WireProvider::Anthropic, "claude-x", &d);

        assert!(
            crate::routing::integrity::response_tool_calls(&out).is_empty(),
            "the refusal body still contains a tool call: {out}"
        );
        let rendered = out.to_string();
        assert!(
            rendered.contains("bash"),
            "the refusal must name the tool it blocked"
        );
        assert!(
            !rendered.contains("rm -rf /"),
            "the refusal leaked the blocked arguments"
        );

        let openai_out = refusal_body(WireProvider::OpenAI, "gpt-x", &d);
        assert!(
            crate::routing::integrity::response_tool_calls(&openai_out).is_empty(),
            "the OpenAI refusal body still contains a tool call: {openai_out}"
        );
    }

    // ── Non-streaming: everything that must NOT be blocked ──────────────

    #[test]
    fn allowed_tool_call_passes_through_byte_identical() {
        let body = openai_response("read_file", r#"{"path":"/etc/hosts"}"#);
        let before = serde_json::to_vec(&body).unwrap();

        assert!(gate_response(&cfg(), Some(&body), &denied()).is_none());

        assert_eq!(
            serde_json::to_vec(&body).unwrap(),
            before,
            "the gate mutated a body it allowed"
        );
    }

    #[test]
    fn absent_tool_calls_do_not_block() {
        let plain = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "hello" } }]
        });
        assert!(gate_response(&cfg(), Some(&plain), &denied()).is_none());
    }

    /// A `tool_calls` array of the wrong shape must not be read as permission
    /// *or* as a violation — there is no name in it, so there is nothing denied.
    #[test]
    fn malformed_tool_calls_do_not_block() {
        let junk = serde_json::json!({
            "choices": [{ "message": { "tool_calls": "not-an-array" } }]
        });
        assert!(gate_response(&cfg(), Some(&junk), &denied()).is_none());

        let nameless = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{ "function": { "arguments": "{}" } }] } }]
        });
        assert!(gate_response(&cfg(), Some(&nameless), &denied()).is_none());
    }

    /// A denied tool whose `arguments` are not JSON must still be caught: the
    /// name is what the policy is keyed on, and a broken argument string is not
    /// a way out of it.
    #[test]
    fn denied_tool_with_unparseable_arguments_still_blocks() {
        let body = openai_response("Bash", "{not json");
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("name match must survive");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    #[test]
    fn no_deny_list_means_the_gate_never_fires() {
        let body = anthropic_response("bash");
        assert!(gate_response(&cfg(), Some(&body), &[]).is_none());
        assert!(gate_response(&cfg(), None, &[]).is_none());
        assert!(gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &[]).is_none());
    }

    #[test]
    fn disabled_gate_never_fires() {
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        let body = anthropic_response("bash");
        assert!(gate_response(&off, Some(&body), &denied()).is_none());
        assert!(gate_response(&off, None, &denied()).is_none());
        assert!(gate_stream_line(&off, ANTHROPIC_TOOL_LINE, &denied()).is_none());
    }

    // ── Fail direction ──────────────────────────────────────────────────

    #[test]
    fn unparseable_body_fails_closed_by_default_and_open_when_configured() {
        let d = gate_response(&cfg(), None, &denied()).expect("default must fail closed");
        assert_eq!(d.reason, DenialReason::Unparseable);

        let open = ResponseGateConfig {
            enabled: true,
            fail_closed: false,
        };
        assert!(gate_response(&open, None, &denied()).is_none());
    }

    // ── Destructive-SQL guard ───────────────────────────────────────────

    fn sql_policy(
        severity: crate::plugins::sql_guard::SqlGuardSeverity,
        shadow: bool,
    ) -> Vec<SqlGuardPolicy> {
        vec![SqlGuardPolicy {
            severity,
            allow: vec!["postgres://localhost/*".into()],
            org_allow: Vec::new(),
            shadow,
        }]
    }

    #[test]
    fn sql_guard_refuses_a_production_drop_and_passes_an_allowlisted_one() {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'DROP TABLE users'"}"#,
        );
        let (d, notes) = gate_response_sql(&cfg(), Some(&prod), &sql_policy(Refuse, false));
        let d = d.expect("must refuse");
        assert!(matches!(d.reason, DenialReason::DestructiveSql(_)));
        assert!(notes.is_empty());
        let out = refusal_body(WireProvider::OpenAI, "gpt-x", &d);
        assert!(crate::routing::integrity::response_tool_calls(&out).is_empty());
        assert!(out.to_string().contains("postgres://db.prod/app"));

        let local = openai_response(
            "Bash",
            r#"{"command":"psql -h localhost -d app -c 'DROP TABLE users'"}"#,
        );
        assert_eq!(
            gate_response_sql(&cfg(), Some(&local), &sql_policy(Refuse, false)),
            (None, Vec::new())
        );
    }

    #[test]
    fn sql_guard_warn_and_shadow_report_without_refusing() {
        use crate::plugins::sql_guard::SqlGuardSeverity::{Refuse, Warn};
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'TRUNCATE events'"}"#,
        );
        for policies in [sql_policy(Warn, false), sql_policy(Refuse, true)] {
            let (d, notes) = gate_response_sql(&cfg(), Some(&prod), &policies);
            assert!(d.is_none());
            assert_eq!(notes.len(), 1);
        }
    }

    #[test]
    fn sql_guard_is_inert_without_a_policy_or_with_the_gate_off() {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -c 'DROP TABLE users'"}"#,
        );
        assert_eq!(
            gate_response_sql(&cfg(), Some(&prod), &[]),
            (None, Vec::new())
        );
        assert_eq!(gate_response_sql(&cfg(), None, &[]), (None, Vec::new()));
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        assert_eq!(
            gate_response_sql(&off, Some(&prod), &sql_policy(Refuse, false)),
            (None, Vec::new())
        );
    }

    #[test]
    fn sql_guard_unparseable_body_fails_closed_only_under_refuse() {
        use crate::plugins::sql_guard::SqlGuardSeverity::{Refuse, Warn};
        let (d, _) = gate_response_sql(&cfg(), None, &sql_policy(Refuse, false));
        assert_eq!(d.unwrap().reason, DenialReason::Unparseable);
        assert!(gate_response_sql(&cfg(), None, &sql_policy(Warn, false))
            .0
            .is_none());
        assert!(gate_response_sql(&cfg(), None, &sql_policy(Refuse, true))
            .0
            .is_none());
    }

    // ── Streaming ───────────────────────────────────────────────────────

    const ANTHROPIC_TOOL_LINE: &str = r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}"#;
    const OPENAI_TOOL_LINE: &str = r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":""}}]}}]}"#;

    #[test]
    fn stream_withholds_denied_anthropic_tool_start() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["bash".to_string()]));
        // The refusal has to be written at the index the tool block claimed,
        // not at 0 — index 0 is the text block the model already closed.
        assert_eq!(d.block_index, 1);
    }

    #[test]
    fn stream_withholds_denied_openai_tool_start() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
        assert_eq!(d.block_index, 0);
    }

    #[test]
    fn stream_lets_ordinary_lines_through() {
        for line in [
            "event: content_block_delta",
            "",
            ": keep-alive",
            "data: [DONE]",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t","name":"read_file","input":{}}}"#,
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            "data: {not json",
        ] {
            assert!(
                gate_stream_line(&cfg(), line, &denied()).is_none(),
                "the gate withheld an ordinary line: {line}"
            );
        }
    }

    /// An OpenAI `arguments` fragment arrives on its own chunk with no name.
    /// The gate must not treat that as a second, unnamed call — and must not
    /// pretend it can match arguments there. This is the documented limit.
    #[test]
    fn stream_argument_fragments_are_not_matched() {
        let frag = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"rm -rf /\"}"}}]}}]}"#;
        assert!(gate_stream_line(&cfg(), frag, &denied()).is_none());

        // Even with the tool's *arguments* naming a denied tool, only the name
        // field is policy input on a stream.
        let named_in_args = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{\"cmd\":\"Bash\"}"}}]}}]}"#;
        assert!(gate_stream_line(&cfg(), named_in_args, &denied()).is_none());
    }

    /// The refusal tail must leave a stream a client can still finish parsing:
    /// every `data:` payload valid JSON, and a terminal event present.
    #[test]
    fn anthropic_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(WireProvider::Anthropic, &d);

        assert!(
            tail.contains("event: message_stop"),
            "stream never terminates: {tail}"
        );
        assert!(
            !tail.contains("\"type\":\"tool_use\""),
            "the tail re-emitted the tool call"
        );

        let mut payloads = 0;
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            payloads += 1;
            let v: Value = serde_json::from_str(data)
                .unwrap_or_else(|e| panic!("tail emitted invalid JSON ({e}): {data}"));
            // Every block event must carry the withheld block's index, never 0
            // — index 0 belongs to the text the model already finished.
            if let Some(i) = v.get("index") {
                assert_eq!(
                    i.as_u64(),
                    Some(1),
                    "tail wrote at the wrong block index: {data}"
                );
            }
        }
        assert_eq!(payloads, 5, "unexpected Anthropic tail shape: {tail}");

        // Each SSE event must be blank-line separated.
        assert!(
            tail.ends_with("\n\n"),
            "tail does not close its last event: {tail:?}"
        );
    }

    #[test]
    fn openai_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(WireProvider::OpenAI, &d);

        assert!(
            tail.ends_with("data: [DONE]\n\n"),
            "stream never terminates: {tail}"
        );
        assert!(
            !tail.contains("tool_calls"),
            "the tail re-emitted the tool call"
        );

        let mut finish_reasons = Vec::new();
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let v: Value = serde_json::from_str(data)
                .unwrap_or_else(|e| panic!("tail emitted invalid JSON ({e}): {data}"));
            finish_reasons.push(
                v["choices"][0]["finish_reason"]
                    .as_str()
                    .unwrap_or("null")
                    .to_string(),
            );
        }
        assert_eq!(
            finish_reasons,
            vec!["null", "stop"],
            "unexpected OpenAI tail shape: {tail}"
        );
    }

    /// Non-streaming Responses was blind too, and for a different reason than
    /// the stream: a same-provider `/v1/responses` body is never translated, so
    /// it reaches `gate_response` as `output[]`.
    #[test]
    fn denies_responses_non_streaming_tool_call() {
        let body = serde_json::json!({
            "id": "resp_1", "object": "response",
            "output": [{"type": "function_call", "call_id": "c1", "name": "Bash",
                        "arguments": "{\"command\":\"rm -rf /\"}"}]
        });
        let d = gate_response(&cfg(), Some(&body), &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
    }

    /// And the refusal body it is replaced with must be a Responses body.
    #[test]
    fn responses_refusal_body_is_a_response_object_with_no_tool_call() {
        let d = Denial {
            reason: DenialReason::Tools(vec!["Bash".into()]),
            block_index: 0,
        };
        let out = refusal_body(WireProvider::OpenAIResponses, "gpt-5", &d);
        assert_eq!(out["object"], "response");
        assert_eq!(out["output"][0]["content"][0]["type"], "output_text");
        assert!(out["output"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Blocked tool call"));
        let s = serde_json::to_string(&out).unwrap();
        assert!(
            !s.contains("function_call"),
            "the refusal carried an executable call: {s}"
        );
        assert!(
            !s.contains("choices"),
            "emitted a chat-completions body: {s}"
        );
    }

    // ── OpenAI Responses (Codex CLI) ──────────────────────────────────────

    /// The `response.output_item.added` line Codex CLI's upstream emits when
    /// the model reaches for a tool. Spec-derived, not captured — see
    /// `protocol::tool_use_parser::try_parse_openai_responses`.
    const RESPONSES_TOOL_LINE: &str = r#"data: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"Bash","arguments":""}}"#;

    /// The hole this closes: a denied tool call streamed to Codex CLI reached
    /// the tool runner while the gate reported the deny list as enforced.
    #[test]
    fn stream_withholds_denied_responses_tool_start() {
        let d = gate_stream_line(&cfg(), RESPONSES_TOOL_LINE, &denied()).expect("must be caught");
        assert_eq!(d.reason, DenialReason::Tools(vec!["Bash".to_string()]));
        // `output_index`, so the refusal item lands where the withheld one was.
        assert_eq!(d.block_index, 2);
    }

    /// Ordinary Responses traffic must not be mistaken for a tool call. A false
    /// positive here refuses a legitimate response, and `fail_closed` cannot
    /// help — the gate would be confidently wrong rather than unsure.
    #[test]
    fn stream_lets_ordinary_responses_lines_through() {
        for line in [
            "event: response.output_text.delta",
            r#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}"#,
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}"#,
            r#"data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hi"}"#,
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"cmd\":"}"#,
            r#"data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}"#,
        ] {
            assert!(
                gate_stream_line(&cfg(), line, &denied()).is_none(),
                "gated an ordinary Responses line: {line}"
            );
        }
    }

    /// An allowed tool call is not withheld — the gate enforces a deny list,
    /// not a blanket ban on tools.
    #[test]
    fn stream_allows_permitted_responses_tool_start() {
        let line = r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_2","type":"function_call","name":"read_file","arguments":""}}"#;
        assert!(gate_stream_line(&cfg(), line, &denied()).is_none());
    }

    /// The refusal must be a Responses stream, not a chat-completions one.
    ///
    /// Cutting the stream is the security property and it holds either way.
    /// This is about the other half: the agent is meant to *read* the refusal
    /// next turn and not retry. A `chat.completion.chunk` here is bytes Codex
    /// CLI cannot parse, so the agent would see a transport failure, retry the
    /// same prompt, and get refused again — a paid-for loop.
    #[test]
    fn responses_refusal_tail_is_well_formed_and_terminates() {
        let d = gate_stream_line(&cfg(), RESPONSES_TOOL_LINE, &denied()).unwrap();
        let tail = refusal_tail(WireProvider::OpenAIResponses, &d);

        assert!(
            tail.contains("event: response.completed"),
            "stream never terminates in the Responses shape: {tail}"
        );
        assert!(
            !tail.contains("[DONE]"),
            "emitted the chat-completions sentinel: {tail}"
        );
        assert!(
            !tail.contains("chat.completion"),
            "emitted a chat-completions chunk: {tail}"
        );
        assert!(
            !tail.contains("function_call"),
            "the tail re-emitted the tool call"
        );
        assert!(
            !tail.contains("tool_calls"),
            "the tail re-emitted the tool call"
        );
        assert!(
            tail.ends_with("\n\n"),
            "tail does not close its last event: {tail:?}"
        );
        assert_payloads_parse(&tail);

        // The refusal claims the index the withheld item had, and carries the
        // message the agent is supposed to read.
        let mut types = Vec::new();
        for line in tail.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let v: Value = serde_json::from_str(data).unwrap();
            if let Some(t) = v["type"].as_str() {
                types.push(t.to_string());
            }
            if let Some(i) = v.get("output_index").and_then(|i| i.as_u64()) {
                assert_eq!(i, 2, "refusal addressed to the wrong output item: {data}");
            }
        }
        assert_eq!(
            types,
            vec![
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed",
            ],
            "unexpected Responses tail sequence"
        );
        assert!(
            tail.contains("Blocked tool call"),
            "the agent is not told why"
        );
    }

    /// Composition, on the shape where the gate used to see nothing at all: the
    /// denied call must not appear anywhere in what the client received, and
    /// what it did receive must still be a parseable, terminated stream.
    #[test]
    fn responses_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let lines = [
            r#"data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}"#,
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}"#,
            r#"data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Let me run that."}"#,
            RESPONSES_TOOL_LINE,
            r#"data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":2,"delta":"{\"command\":\"rm -rf /\"}"}"#,
            r#"data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}"#,
        ];
        let (sse, tripped) = replay(&lines, WireProvider::OpenAIResponses);
        assert!(tripped, "the denied call was never caught");
        assert!(
            !sse.contains("function_call"),
            "the denied call reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf"),
            "the arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("Let me run that."),
            "text before the call was dropped"
        );
        assert!(
            sse.contains("event: response.completed"),
            "the cut stream never terminates: {sse}"
        );
        assert_payloads_parse(&sse);
    }

    /// Gemini has no distinct streaming shape in this proxy — it reaches the
    /// client as OpenAI chunks, exactly as `get_terminal_stream_event` assumes.
    #[test]
    fn gemini_tail_follows_the_openai_shape() {
        let d = gate_stream_line(&cfg(), OPENAI_TOOL_LINE, &denied()).unwrap();
        assert_eq!(
            refusal_tail(WireProvider::Gemini, &d),
            refusal_tail(WireProvider::OpenAI, &d)
        );
    }

    /// Walk a realistic transcript the way `proxy::handle_proxy` walks it —
    /// forward each line unless the gate withholds it, and on a withholding
    /// append the tail and stop — then check what the client actually received.
    ///
    /// The unit tests above check the pieces; this checks the composition,
    /// which is where "withheld the event but left the stream unparseable"
    /// would hide.
    fn replay(lines: &[&str], provider: WireProvider) -> (String, bool) {
        let mut out = String::new();
        for line in lines {
            if let Some(d) = gate_stream_line(&cfg(), line, &denied()) {
                out.push_str(&refusal_tail(provider, &d));
                return (out, true);
            }
            out.push_str(line);
            out.push('\n');
        }
        (out, false)
    }

    /// Every `data:` payload in an SSE body must be valid JSON or `[DONE]`.
    fn assert_payloads_parse(sse: &str) {
        for line in sse.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            serde_json::from_str::<Value>(data)
                .unwrap_or_else(|e| panic!("client would fail to parse ({e}): {data}"));
        }
    }

    #[test]
    fn anthropic_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let (sse, tripped) = replay(
            &[
                r#"event: message_start"#,
                r#"data: {"type":"message_start","message":{"id":"msg_1","content":[]}}"#,
                "",
                r#"event: content_block_start"#,
                r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
                "",
                r#"event: content_block_delta"#,
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will run it."}}"#,
                "",
                r#"event: content_block_stop"#,
                r#"data: {"type":"content_block_stop","index":0}"#,
                "",
                // Everything from here must never reach the client.
                r#"event: content_block_start"#,
                ANTHROPIC_TOOL_LINE,
                "",
                r#"event: content_block_delta"#,
                r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"rm -rf /\"}"}}"#,
                "",
                r#"event: message_stop"#,
                r#"data: {"type":"message_stop"}"#,
                "",
            ],
            WireProvider::Anthropic,
        );

        assert!(tripped, "the gate never fired");
        assert!(
            !sse.contains("tool_use"),
            "the tool-use event reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf /"),
            "the tool arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("I will run it."),
            "text emitted before the call was dropped"
        );
        assert!(
            sse.contains("event: message_stop"),
            "stream never terminates: {sse}"
        );
        assert!(
            sse.contains("[Intutic] Blocked tool call"),
            "no in-band reason: {sse}"
        );
        assert_payloads_parse(&sse);

        // The refusal opens block 1 — the index the tool wanted — and closes
        // it. Block 0 is stopped exactly once, by the upstream. Counted over
        // parsed events rather than raw substrings: serde_json orders object
        // keys itself, so a substring count would be asserting its field order.
        let stops: Vec<u64> = sse
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("content_block_stop"))
            .filter_map(|v| v.get("index").and_then(|i| i.as_u64()))
            .collect();
        assert_eq!(
            stops,
            vec![0, 1],
            "blocks were not opened and closed once each: {sse}"
        );
    }

    #[test]
    fn openai_stream_is_cut_before_the_tool_call_and_still_terminates() {
        let (sse, tripped) = replay(
            &[
                r#"data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"I will run it."},"finish_reason":null}]}"#,
                "",
                OPENAI_TOOL_LINE,
                "",
                r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"rm -rf /\"}"}}]}}]}"#,
                "",
                "data: [DONE]",
                "",
            ],
            WireProvider::OpenAI,
        );

        assert!(tripped, "the gate never fired");
        assert!(
            !sse.contains("tool_calls"),
            "the tool-call delta reached the client: {sse}"
        );
        assert!(
            !sse.contains("rm -rf /"),
            "the tool arguments reached the client: {sse}"
        );
        assert!(
            sse.contains("I will run it."),
            "text emitted before the call was dropped"
        );
        assert!(
            sse.trim_end().ends_with("data: [DONE]"),
            "stream never terminates: {sse}"
        );
        assert!(
            sse.contains("[Intutic] Blocked tool call"),
            "no in-band reason: {sse}"
        );
        assert_payloads_parse(&sse);
    }

    /// A stream that never reaches for a denied tool must come out untouched —
    /// the gate is not allowed to rewrite ordinary traffic.
    #[test]
    fn allowed_stream_is_forwarded_unchanged() {
        let lines = [
            r#"data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}"#,
            "",
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":""}}]}}]}"#,
            "",
            "data: [DONE]",
            "",
        ];
        let (sse, tripped) = replay(&lines, WireProvider::OpenAI);

        assert!(!tripped, "the gate fired on an allowed tool");
        assert_eq!(sse, lines.join("\n") + "\n");
    }

    #[test]
    fn messages_name_the_policy_and_the_tool() {
        let d = gate_stream_line(&cfg(), ANTHROPIC_TOOL_LINE, &denied()).unwrap();
        assert!(d.log_message().contains("UNAUTHORIZED_TOOL"));
        assert!(d.log_message().contains("bash"));
        assert!(d.agent_message().contains("bash"));

        let u = Denial {
            reason: DenialReason::Unparseable,
            block_index: 0,
        };
        assert!(u.log_message().contains("UNAUTHORIZED_TOOL"));
        assert!(!u.agent_message().is_empty());
    }

    // ── SSO-group clearance ─────────────────────────────────────────────

    fn sso_gate(member_groups: Option<&[&str]>) -> SsoGroupGate {
        SsoGroupGate {
            policy: crate::sso_groups::parse_policy(&serde_json::json!({
                "highRiskTools": ["Bash"],
                "requiredGroups": ["sre-oncall"],
                "requireOboFor": ["deploy_prod"]
            }))
            .unwrap(),
            member_groups: member_groups.map(|g| g.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn sso_group_denies_a_high_risk_tool_the_member_is_not_cleared_for() {
        let body = openai_response("Bash", r#"{"command":"ls"}"#);
        let gate = sso_gate(Some(&["eng"]));
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        let DenialReason::SsoGroup { tool, decision } = &d.reason else {
            panic!("wrong reason: {d:?}")
        };
        assert_eq!(tool, "Bash");
        assert_eq!(decision.clearance, Clearance::Denied);
        assert_eq!(
            decision.rule_id.as_deref(),
            Some("sso_group.high_risk.Bash")
        );
        // The rule id closes both messages, where `ruleIdFromReason` reads it.
        assert!(
            d.log_message().ends_with("[sso_group.high_risk.Bash]"),
            "{}",
            d.log_message()
        );
        assert!(d.agent_message().contains("[sso_group.high_risk.Bash]"));

        let out = refusal_body(WireProvider::OpenAI, "gpt-x", &d);
        assert!(crate::routing::integrity::response_tool_calls(&out).is_empty());
        assert!(!out.to_string().contains("\"command\""));
    }

    #[test]
    fn sso_group_grants_a_cleared_member_and_unlisted_tools() {
        let gate = sso_gate(Some(&["sre-oncall"]));
        let bash = openai_response("Bash", "{}");
        assert!(gate_response_sso_groups(&cfg(), Some(&bash), Some(&gate)).is_none());
        let uncleared = sso_gate(Some(&["eng"]));
        let read = anthropic_response("read_file");
        assert!(gate_response_sso_groups(&cfg(), Some(&read), Some(&uncleared)).is_none());
    }

    /// Names match exactly, as every other gate matches them — unlike the
    /// case-insensitive deny list, which would refuse a call the hook gate
    /// allows.
    #[test]
    fn sso_group_matches_tool_names_exactly() {
        let gate = sso_gate(Some(&["eng"]));
        let lower = anthropic_response("bash");
        assert!(gate_response_sso_groups(&cfg(), Some(&lower), Some(&gate)).is_none());
    }

    #[test]
    fn sso_group_refuses_on_behalf_of_only_tools_even_for_a_cleared_member() {
        let gate = sso_gate(Some(&["sre-oncall"]));
        let body = anthropic_response("deploy_prod");
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        assert!(d.log_message().contains("REQUIRES_OBO"));
        assert!(d
            .log_message()
            .ends_with("[sso_group.require_obo.deploy_prod]"));
    }

    #[test]
    fn sso_group_unknown_groups_are_refused_a_high_risk_tool() {
        let gate = sso_gate(None);
        let body = openai_response("Bash", "{}");
        let d = gate_response_sso_groups(&cfg(), Some(&body), Some(&gate)).expect("must refuse");
        assert!(d
            .agent_message()
            .contains("does not know the member's groups"));
    }

    #[test]
    fn sso_group_is_inert_without_a_policy_or_with_the_gate_off() {
        let body = openai_response("Bash", "{}");
        assert!(gate_response_sso_groups(&cfg(), Some(&body), None).is_none());
        assert!(gate_response_sso_groups(&cfg(), None, None).is_none());
        assert!(gate_stream_line_sso_groups(&cfg(), OPENAI_TOOL_LINE, None).is_none());
        let off = ResponseGateConfig {
            enabled: false,
            fail_closed: true,
        };
        let gate = sso_gate(Some(&["eng"]));
        assert!(gate_response_sso_groups(&off, Some(&body), Some(&gate)).is_none());
        assert!(gate_stream_line_sso_groups(&off, OPENAI_TOOL_LINE, Some(&gate)).is_none());
        // A policy that names no tool cannot refuse one, so it cannot turn an
        // unparseable body into a refusal either.
        let empty = SsoGroupGate {
            policy: crate::sso_groups::SsoGroupPolicy::default(),
            member_groups: None,
        };
        assert!(gate_response_sso_groups(&cfg(), None, Some(&empty)).is_none());
    }

    #[test]
    fn sso_group_unparseable_body_follows_fail_closed() {
        let gate = sso_gate(Some(&["eng"]));
        let d = gate_response_sso_groups(&cfg(), None, Some(&gate)).expect("closed by default");
        assert_eq!(d.reason, DenialReason::Unparseable);
        let open = ResponseGateConfig {
            enabled: true,
            fail_closed: false,
        };
        assert!(gate_response_sso_groups(&open, None, Some(&gate)).is_none());
    }

    #[test]
    fn sso_group_withholds_the_tool_start_on_every_streamed_wire_shape() {
        let gate = sso_gate(Some(&["eng"]));
        for (line, idx) in [(OPENAI_TOOL_LINE, 0), (RESPONSES_TOOL_LINE, 2)] {
            let d = gate_stream_line_sso_groups(&cfg(), line, Some(&gate)).expect("must refuse");
            assert_eq!(d.block_index, idx, "{line}");
            assert!(matches!(d.reason, DenialReason::SsoGroup { .. }));
        }
        let anthropic = r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}"#;
        let d = gate_stream_line_sso_groups(&cfg(), anthropic, Some(&gate)).expect("must refuse");
        assert_eq!(d.block_index, 1);
        let tail = refusal_tail(WireProvider::Anthropic, &d);
        assert!(tail.contains("[sso_group.high_risk.Bash]"));
        assert!(!tail.contains("\"tool_use\""));
        assert_payloads_parse(&tail);

        let cleared = sso_gate(Some(&["sre-oncall"]));
        assert!(gate_stream_line_sso_groups(&cfg(), anthropic, Some(&cleared)).is_none());
        for line in [
            "event: content_block_delta",
            "",
            "data: [DONE]",
            "data: {not json",
        ] {
            assert!(gate_stream_line_sso_groups(&cfg(), line, Some(&gate)).is_none());
        }
    }

    // ── Naming the refusal to an SDK ────────────────────────────────────

    /// One denial of every reason, as the gate builds them.
    fn one_of_each() -> Vec<Denial> {
        use crate::plugins::sql_guard::SqlGuardSeverity::Refuse;
        let tools = gate_response(
            &cfg(),
            Some(&openai_response("terraform_apply", "{}")),
            &denied(),
        )
        .unwrap();
        let sso = gate_response_sso_groups(
            &cfg(),
            Some(&openai_response("Bash", "{}")),
            Some(&sso_gate(Some(&["eng"]))),
        )
        .unwrap();
        let prod = openai_response(
            "Bash",
            r#"{"command":"psql -h db.prod -d app -c 'DROP TABLE users'"}"#,
        );
        let sql = gate_response_sql(&cfg(), Some(&prod), &sql_policy(Refuse, false))
            .0
            .unwrap();
        let unparseable = gate_response(&cfg(), None, &denied()).unwrap();
        vec![tools, sso, sql, unparseable]
    }

    #[test]
    fn every_denial_names_its_code_and_deciding_rule() {
        let named: Vec<(&str, String)> = one_of_each()
            .iter()
            .map(|d| {
                let r = d.refusal();
                (r.code.as_str(), r.rule)
            })
            .collect();
        assert_eq!(
            named,
            vec![
                ("TOOL_DENIED", "deny_tools.terraform_apply".to_string()),
                ("SSO_GROUP", "sso_group.high_risk.Bash".to_string()),
                ("SQL_GUARD", "sql_guard.sql_allow_dsns".to_string()),
                (
                    "RESPONSE_UNPARSEABLE",
                    "response_gate.fail_closed".to_string()
                ),
            ]
        );
    }

    /// The marker is the first thing in every tail, on every wire shape, and
    /// carries the text the agent is shown — so an SDK reading the stream
    /// raises with the same reason, and a client that stops at the terminal
    /// event has already passed it.
    #[test]
    fn every_tail_opens_with_the_refusal_marker() {
        for d in one_of_each() {
            for provider in [
                WireProvider::Anthropic,
                WireProvider::OpenAI,
                WireProvider::OpenAIResponses,
                WireProvider::Gemini,
            ] {
                let tail = refusal_tail(provider, &d);
                let first = tail.lines().next().unwrap();
                let json = first
                    .strip_prefix(crate::refusal::STREAM_MARKER)
                    .unwrap_or_else(|| panic!("tail does not open with the marker: {tail}"));
                let v: Value = serde_json::from_str(json).unwrap();
                let r = d.refusal();
                assert_eq!(v["code"], r.code.as_str());
                assert_eq!(v["rule"], r.rule);
                assert_eq!(v["message"], d.agent_message());
                assert_payloads_parse(&tail);
            }
        }
    }
}
