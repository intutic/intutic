//! Response Integrity Score — a deterministic quality signal for routing.
//!
//! The router's whole view of quality is `upstream_ok`, latency and a token
//! *metering* discrepancy. A cheap model returning a confidently wrong answer,
//! quickly, scores a perfect `1.0` — and the session lock makes one such sample
//! persist for that session's life. Adding cost pressure to a reward function
//! that cannot notice a worse answer is how you build a router that saves money
//! by being wrong, so this exists before any of that.
//!
//! # What it detects, and what it cannot
//!
//! Four checks, strongest first: a **tool call the model could not have meant**
//! (a name it was not offered, arguments that are not JSON, a declared
//! `required` property missing), a **truncated** response, and **degenerate
//! output** — no content and no tool call when tools were on the table.
//!
//! What it cannot detect is the ceiling on every claim built on it:
//! **wrong-but-well-formed answers.** Code that compiles and is incorrect. A
//! plausible wrong root cause. A worse refactor. The right tool with wrong
//! values. Shallower reasoning. That is most of the real harm from downgrading a
//! model, and none of it is visible here.
//!
//! So the honest claim is that routing is guarded against **malformed,
//! truncated and unusable** responses — not against *worse* ones. Any copy
//! saying "no quality loss" is unsupportable.
//!
//! # Why refusal phrasing is not a check
//!
//! It is gameable by prompt content and misfires systematically on DLP- and
//! policy-adjacent traffic: a model declining to help with something the
//! workspace also forbids is behaving correctly, and scoring that as a fault
//! would punish an arm for being right. It ships as a trace annotation
//! elsewhere, never as a reward term.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A perfect response. Nothing detected.
pub const RIS_MAX: u8 = 100;

/// What each fault costs, and in what order it is reported.
///
/// A malformed tool call is the heaviest because it is the one the agent cannot
/// work around: it will re-issue, or act on arguments that were never valid.
const PENALTY_BAD_TOOL_CALL: u8 = 60;
const PENALTY_TRUNCATED: u8 = 40;
const PENALTY_DEGENERATE: u8 = 30;

/// The first failing check, named.
///
/// A bare score is not auditable — an operator seeing `40` cannot tell a
/// truncation from a bad tool call, and the two have opposite remedies (raise
/// `max_tokens` versus stop routing this task to this model).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityFault {
    /// A tool name the model was never offered.
    UnknownTool,
    /// `arguments` did not parse. OpenAI sends it as a JSON *string*, so this is
    /// a clean hard signal rather than an inference.
    ToolArgumentsNotJson,
    /// A property the tool's own schema declares `required` is absent.
    MissingRequiredArgument,
    /// The response was cut off — `max_tokens`, or a stream that never finished.
    Truncated,
    /// Neither content nor a tool call, with tools declared.
    Degenerate,
}

impl QualityFault {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UnknownTool => "unknown_tool",
            Self::ToolArgumentsNotJson => "tool_arguments_not_json",
            Self::MissingRequiredArgument => "missing_required_argument",
            Self::Truncated => "truncated",
            Self::Degenerate => "degenerate",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Integrity {
    pub score: u8,
    /// The first failing check. `None` on a clean response.
    pub fault: Option<QualityFault>,
    /// Whether anything was actually looked at.
    ///
    /// `score` is 100 both for "checked, and it was clean" and for "there was
    /// nothing to check". Those are not the same claim, and collapsing them is
    /// how the bandit came to credit arms for perfection nobody observed: the
    /// reward cron counts measured traces, and with an unmeasured response
    /// indistinguishable from a clean one it could never find an arm to skip.
    pub measured: bool,
}

impl Integrity {
    /// Checked, and nothing was wrong.
    pub fn clean() -> Self {
        Self { score: RIS_MAX, fault: None, measured: true }
    }

    /// Nothing was checked. Scores like a clean response — this is a quality
    /// signal, not a transport check — but says so.
    pub fn unmeasured() -> Self {
        Self { score: RIS_MAX, fault: None, measured: false }
    }
}

/// What the caller knows about the response, gathered where `token_anomaly` is.
pub struct ResponseFacts<'a> {
    /// The parsed response body, if it parsed at all.
    pub body: Option<&'a Value>,
    /// The request body, for the tool declarations. `ToolSchema` in the WASM
    /// context carries only name and description, so `input_schema` has to be
    /// read from here.
    pub request: Option<&'a Value>,
    /// Streaming only: whether the terminal event arrived.
    pub done_received: Option<bool>,
}

/// Tool names the request declared, with their required properties.
fn declared_tools(request: Option<&Value>) -> Vec<(String, Vec<String>)> {
    let Some(req) = request else { return Vec::new() };
    let mut out = Vec::new();

    // Anthropic: top-level `tools[]` with `input_schema`.
    // OpenAI: `tools[].function` with `parameters`.
    if let Some(tools) = req.get("tools").and_then(|t| t.as_array()) {
        for t in tools {
            let f = t.get("function").unwrap_or(t);
            let Some(name) = f.get("name").and_then(|n| n.as_str()) else { continue };
            let schema = f.get("input_schema").or_else(|| f.get("parameters"));
            let required = schema
                .and_then(|s| s.get("required"))
                .and_then(|r| r.as_array())
                .map(|r| {
                    r.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>()
                })
                .unwrap_or_default();
            out.push((name.to_string(), required));
        }
    }
    out
}

/// Every tool call in the response, as (name, arguments-or-raw-string).
///
/// Public because `plugins::response_gate` enforces the tool deny list against
/// the same extraction. A second implementation there would be a second opinion
/// on what counts as a tool call, and the two disagreeing is precisely how a
/// forbidden call gets forwarded while the scorer records nothing.
///
/// Three wire shapes, because there are three. The OpenAI Responses shape was
/// missing, and its absence was not cosmetic: a same-provider `/v1/responses`
/// body is forwarded untranslated (`proxy.rs`, the `is_same_provider` arm), so
/// it reaches here as `output[]` and matched neither of the other two. Codex
/// CLI's non-streaming tool calls were therefore invisible to both the deny
/// list and the integrity scorer.
pub fn response_tool_calls(body: &Value) -> Vec<(String, Option<Value>, Option<String>)> {
    let mut calls = Vec::new();

    // Anthropic: content[] blocks of type `tool_use`, `input` already an object.
    if let Some(content) = body.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                calls.push((name, block.get("input").cloned(), None));
            }
        }
    }

    // OpenAI: choices[].message.tool_calls[], where `arguments` is a JSON
    // STRING. A parse failure there is a clean hard signal — the model emitted
    // something that is not a document.
    if let Some(choices) = body.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            let Some(tcs) = choice
                .get("message")
                .and_then(|m| m.get("tool_calls"))
                .and_then(|t| t.as_array())
            else {
                continue;
            };
            for tc in tcs {
                let f = tc.get("function").unwrap_or(tc);
                let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                match f.get("arguments").and_then(|a| a.as_str()) {
                    Some(raw) => match serde_json::from_str::<Value>(raw) {
                        Ok(v) => calls.push((name, Some(v), None)),
                        Err(_) => calls.push((name, None, Some(raw.to_string()))),
                    },
                    None => calls.push((name, f.get("arguments").cloned(), None)),
                }
            }
        }
    }

    // OpenAI Responses: `output[]` items of type `function_call`, where
    // `arguments` is a JSON STRING as in chat completions. Note there is no
    // `function` wrapper here — `name` and `arguments` sit on the item itself.
    if let Some(output) = body.get("output").and_then(|o| o.as_array()) {
        for item in output {
            if item.get("type").and_then(|t| t.as_str()) != Some("function_call") {
                continue;
            }
            let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            match item.get("arguments").and_then(|a| a.as_str()) {
                Some(raw) => match serde_json::from_str::<Value>(raw) {
                    Ok(v) => calls.push((name, Some(v), None)),
                    Err(_) => calls.push((name, None, Some(raw.to_string()))),
                },
                None => calls.push((name, item.get("arguments").cloned(), None)),
            }
        }
    }

    calls
}

/// Whether the response says it was cut off.
/// Truncation that needs no body: the stream's terminal event never arrived.
///
/// Split out from `is_truncated` because the streaming call site has no body to
/// pass, and `score` must be able to answer this before it gives up for lack of
/// one. `None` means "not a stream", not "fine".
fn is_truncated_stream(done_received: Option<bool>) -> bool {
    done_received == Some(false)
}

fn is_truncated(body: &Value, done_received: Option<bool>) -> bool {
    // Streaming: the terminal event never arrived. Only meaningful when the
    // caller actually tracked it — `None` means "not a stream", not "fine".
    if done_received == Some(false) {
        return true;
    }

    // Anthropic non-streaming. This path had no equivalent check at all before:
    // `done_received` covers the stream and nothing covered a `max_tokens` stop.
    if body.get("stop_reason").and_then(|s| s.as_str()) == Some("max_tokens") {
        return true;
    }
    // OpenAI non-streaming.
    if let Some(choices) = body.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            if choice.get("finish_reason").and_then(|f| f.as_str()) == Some("length") {
                return true;
            }
        }
    }
    false
}

/// Whether the response carried any text at all.
fn has_content(body: &Value) -> bool {
    if let Some(content) = body.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if block.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.trim().is_empty()) {
                    return true;
                }
            }
        }
    }
    if let Some(choices) = body.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            if choice
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .is_some_and(|s| !s.trim().is_empty())
            {
                return true;
            }
        }
    }
    false
}

/// Scores one response.
///
/// **A body that did not parse scores clean.** That is deliberate: this is a
/// quality signal, not a transport check, and `upstream_ok` already covers
/// transport. Scoring an unparseable body as a fault would attribute the
/// proxy's own parse failure to the model, which is the wrong arm.
pub fn score(facts: &ResponseFacts<'_>) -> Integrity {
    // Truncation is decided FIRST, because it is the only check a stream can
    // answer and the streaming path has no body to give.
    //
    // This used to sit after the `body` early-return below. The streaming call
    // site passes `body: None, done_received: Some(..)` — the assembled body is
    // not reconstructable there — so the early return fired before
    // `done_received` was ever read, and **every streaming response scored a
    // hardcoded 100 with no fault**. Agent harnesses stream by default, so the
    // quality signal that the whole routing reward rests on was inert for the
    // dominant traffic shape, while the comment at the call site said
    // `done_received` was "the signal that matters here".
    //
    // The existing truncation test passed `body: Some(..)` and so never
    // exercised the production shape; `body_none_still_scores_truncation` below
    // pins it.
    if is_truncated_stream(facts.done_received) {
        return Integrity {
            score: RIS_MAX.saturating_sub(PENALTY_TRUNCATED),
            fault: Some(QualityFault::Truncated),
            measured: true,
        };
    }

    let Some(body) = facts.body else {
        // No body. Termination is then the only check available — and a stream
        // that delivered its terminal event is a real observation on it, not an
        // absence of one.
        //
        // This used to return `unmeasured()` unconditionally, which made the
        // streaming path asymmetric in the worst possible direction: a
        // truncated stream took the early return above and was stored as 60,
        // while a clean stream fell through to here and was stored as NULL. So
        // `banditRewardCron`'s `AVG(response_integrity)` — which ignores NULLs —
        // averaged an arm's *failures alone*. A model serving 10,000 streams
        // with 5 truncations scored exactly 60, and one serving 10,000 clean
        // streams scored nothing at all and was skipped for having measured
        // zero. Repairing the inert 100 and replacing it with a mean over
        // failures would have been worse than leaving it.
        //
        // `Some(false)` cannot reach here — the truncation check above owns it.
        return match facts.done_received {
            Some(true) => Integrity::clean(),
            // Nothing to go on at all: no body, no terminal-event signal.
            None => Integrity::unmeasured(),
            Some(false) => unreachable!("truncation is decided above"),
        };
    };

    let mut score = RIS_MAX;
    let mut fault: Option<QualityFault> = None;

    // ── 1. Tool calls the model could not have meant ──
    let declared = declared_tools(facts.request);
    let calls = response_tool_calls(body);

    for (name, args, unparsed) in &calls {
        if unparsed.is_some() {
            score = score.saturating_sub(PENALTY_BAD_TOOL_CALL);
            fault = fault.or(Some(QualityFault::ToolArgumentsNotJson));
            continue;
        }
        // Only checkable when the request declared anything. A request with no
        // tools tells us nothing about whether this name was offered.
        if !declared.is_empty() && !declared.iter().any(|(d, _)| d == name) {
            score = score.saturating_sub(PENALTY_BAD_TOOL_CALL);
            fault = fault.or(Some(QualityFault::UnknownTool));
            continue;
        }
        if let Some((_, required)) = declared.iter().find(|(d, _)| d == name) {
            let obj = args.as_ref().and_then(|a| a.as_object());
            for key in required {
                let present = obj.is_some_and(|o| o.contains_key(key));
                if !present {
                    score = score.saturating_sub(PENALTY_BAD_TOOL_CALL);
                    fault = fault.or(Some(QualityFault::MissingRequiredArgument));
                    break;
                }
            }
        }
    }

    // ── 2. Truncation ──
    if is_truncated(body, facts.done_received) {
        score = score.saturating_sub(PENALTY_TRUNCATED);
        fault = fault.or(Some(QualityFault::Truncated));
    }

    // ── 3. Degenerate output ──
    //
    // Only when tools were declared. A plain chat turn that returns nothing is
    // odd but not a governance signal, and scoring it would penalise every arm
    // for the same empty completions.
    if !declared.is_empty() && calls.is_empty() && !has_content(body) {
        score = score.saturating_sub(PENALTY_DEGENERATE);
        fault = fault.or(Some(QualityFault::Degenerate));
    }

    Integrity { score, fault, measured: true }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts<'a>(body: &'a Value, request: &'a Value) -> ResponseFacts<'a> {
        ResponseFacts { body: Some(body), request: Some(request), done_received: None }
    }

    const REQ: fn() -> Value = || {
        json!({"tools": [
            {"name": "Read", "input_schema": {"required": ["file_path"]}},
            {"name": "Bash", "input_schema": {"required": ["command"]}}
        ]})
    };

    /// The OpenAI Responses body shape, which this extractor could not read.
    ///
    /// A same-provider `/v1/responses` request is forwarded untranslated, so
    /// its body arrives here as `output[]` — not `content[]`, not `choices[]`.
    /// Both existing arms missed it, so Codex CLI's non-streaming tool calls
    /// were invisible to the deny list (`plugins::response_gate::gate_response`
    /// reuses this function) and to the integrity scorer.
    #[test]
    fn responses_output_items_are_tool_calls() {
        let body = json!({
            "id": "resp_1",
            "object": "response",
            "output": [
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "running it"}]},
                {"type": "function_call", "call_id": "call_1", "name": "Bash",
                 "arguments": "{\"command\":\"ls -la\"}"}
            ]
        });
        let calls = response_tool_calls(&body);
        assert_eq!(calls.len(), 1, "expected exactly the function_call item: {calls:?}");
        assert_eq!(calls[0].0, "Bash");
        // `arguments` is a JSON string on the wire and must come back parsed,
        // the same as chat completions — argument-level policy depends on it.
        assert_eq!(calls[0].1, Some(json!({"command": "ls -la"})));
        assert_eq!(calls[0].2, None);
    }

    /// Unparseable arguments are a hard signal, not a reason to drop the call.
    /// Dropping it would let a denied tool through by emitting bad JSON.
    #[test]
    fn responses_unparseable_arguments_still_yield_the_call() {
        let body = json!({
            "output": [{"type": "function_call", "name": "Bash", "arguments": "{not json"}]
        });
        let calls = response_tool_calls(&body);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "Bash");
        assert_eq!(calls[0].1, None);
        assert_eq!(calls[0].2, Some("{not json".to_string()));
    }

    /// A Responses body with no tool call must stay empty. `output[]` also
    /// carries messages and reasoning items, and counting those as calls would
    /// deny every Codex CLI response.
    #[test]
    fn responses_output_without_a_function_call_is_empty() {
        let body = json!({
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "no tools needed"}]}
            ]
        });
        assert!(response_tool_calls(&body).is_empty());
    }

    #[test]
    fn a_clean_response_scores_full() {
        let body = json!({"content": [{"type": "text", "text": "here you go"}]});
        let r = score(&facts(&body, &REQ()));
        assert_eq!(r.score, RIS_MAX);
        assert!(r.fault.is_none());
    }

    #[test]
    fn a_well_formed_tool_call_scores_full() {
        let body = json!({"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "a.rs"}}
        ]});
        assert_eq!(score(&facts(&body, &REQ())).score, RIS_MAX);
    }

    #[test]
    fn a_tool_the_model_was_not_offered_is_a_fault() {
        let body = json!({"content": [
            {"type": "tool_use", "name": "Deploy", "input": {}}
        ]});
        let r = score(&facts(&body, &REQ()));
        assert_eq!(r.fault, Some(QualityFault::UnknownTool));
        assert!(r.score < RIS_MAX);
    }

    /// OpenAI sends `arguments` as a JSON string, so a parse failure is a clean
    /// hard signal rather than an inference about intent.
    #[test]
    fn openai_arguments_that_do_not_parse_are_a_fault() {
        let body = json!({"choices": [{"message": {"tool_calls": [
            {"function": {"name": "Read", "arguments": "{\"file_path\": "}}
        ]}}]});
        let r = score(&facts(&body, &REQ()));
        assert_eq!(r.fault, Some(QualityFault::ToolArgumentsNotJson));
    }

    #[test]
    fn openai_arguments_that_do_parse_are_fine() {
        let body = json!({"choices": [{"message": {"tool_calls": [
            {"function": {"name": "Read", "arguments": "{\"file_path\": \"a.rs\"}"}}
        ]}}]});
        assert_eq!(score(&facts(&body, &REQ())).score, RIS_MAX);
    }

    #[test]
    fn a_missing_required_argument_is_a_fault() {
        let body = json!({"content": [
            {"type": "tool_use", "name": "Bash", "input": {"timeout": 30}}
        ]});
        assert_eq!(score(&facts(&body, &REQ())).fault, Some(QualityFault::MissingRequiredArgument));
    }

    /// The non-streaming path had no truncation check at all — `done_received`
    /// covers the stream and nothing covered a `max_tokens` stop.
    #[test]
    fn a_max_tokens_stop_is_truncation() {
        let body = json!({"stop_reason": "max_tokens", "content": [{"type": "text", "text": "half"}]});
        assert_eq!(score(&facts(&body, &REQ())).fault, Some(QualityFault::Truncated));
    }

    #[test]
    fn an_openai_length_finish_is_truncation() {
        let body = json!({"choices": [{"finish_reason": "length", "message": {"content": "half"}}]});
        assert_eq!(score(&facts(&body, &REQ())).fault, Some(QualityFault::Truncated));
    }

    #[test]
    fn a_stream_that_never_finished_is_truncation() {
        let body = json!({"content": [{"type": "text", "text": "half"}]});
        let f = ResponseFacts {
            body: Some(&body),
            request: Some(&REQ()),
            done_received: Some(false),
        };
        assert_eq!(score(&f).fault, Some(QualityFault::Truncated));
    }

    /// The shape the streaming path actually passes.
    ///
    /// The test above supplies a body. The production streaming call site cannot
    /// — the assembled body is not reconstructable there — so it passes
    /// `body: None, done_received: Some(..)`, and for as long as the `body`
    /// early-return came first, `done_received` was discarded and **every
    /// streaming response scored a hardcoded 100 with no fault**. Agent
    /// harnesses stream by default, so the signal the entire routing reward
    /// rests on was inert for the dominant traffic shape, with a comment at the
    /// call site asserting the opposite.
    ///
    /// A test that supplies a body cannot catch that, which is why it did not.
    #[test]
    fn body_none_still_scores_truncation() {
        let f = ResponseFacts { body: None, request: None, done_received: Some(false) };
        let r = score(&f);
        assert_eq!(
            r.fault,
            Some(QualityFault::Truncated),
            "a stream that never terminated must fault even with no body to inspect",
        );
        assert!(r.score < RIS_MAX, "and it must cost the arm something: {}", r.score);
        assert!(r.measured, "it WAS measured — the terminal event is the observation");
    }

    /// Nothing at all is unmeasured. A completed stream is not nothing.
    ///
    /// **This test previously asserted the opposite** — that `body: None,
    /// done_received: Some(true)` must come back `measured: false`, on the
    /// reasoning that a completed stream "has nothing left to check" and that a
    /// 100 earned from a body check and a 100 earned from no check should not
    /// collapse. The distinction is real; the conclusion drawn from it was
    /// wrong, and it was wrong in a way that made the reward worse than the
    /// hardcoded 100 it had just replaced.
    ///
    /// SQL `AVG` ignores NULLs. Marking a clean stream unmeasured stored NULL
    /// for it while a truncated stream stored 60, so `banditRewardCron`'s
    /// `AVG(response_integrity)` averaged **an arm's failures alone**: 9,995
    /// clean streams and 5 truncations scored exactly 60.0, and an arm with no
    /// truncations at all measured zero rows and was skipped entirely, so it
    /// never learned. Repairing an inert 100 by replacing it with a mean over
    /// failures is not a repair.
    ///
    /// A stream that delivered its terminal event **was** observed — on the one
    /// check a body-less path can run. That the check is narrower than a body
    /// inspection is a matter of confidence, not of whether it happened, and
    /// `measured` answers whether it happened. What must stay unmeasured is the
    /// case with genuinely no signal: no body *and* no terminal event.
    #[test]
    fn nothing_at_all_is_unmeasured_but_a_finished_stream_is_not() {
        // No body, no terminal event: nothing was looked at.
        let nothing = ResponseFacts { body: None, request: None, done_received: None };
        let r = score(&nothing);
        assert_eq!(r.score, RIS_MAX);
        assert_eq!(r.fault, None);
        assert!(
            !r.measured,
            "with no body and no terminal event nothing was observed, and crediting an arm \
             here is exactly the defect `measured` exists to prevent"
        );

        // A finished stream: narrow, but a real observation.
        let finished = score(&ResponseFacts {
            body: None,
            request: None,
            done_received: Some(true),
        });
        assert!(
            finished.measured,
            "a delivered terminal event is an observation; storing NULL for it leaves \
             AVG(response_integrity) computed over the arm's truncations alone"
        );

        // And a real body check reports measured too, at the same score.
        let body = json!({"content": [{"type": "text", "text": "fine"}]});
        let checked = score(&ResponseFacts {
            body: Some(&body),
            request: Some(&REQ()),
            done_received: None,
        });
        assert!(checked.measured);
        assert_eq!(checked.score, finished.score);
    }

    /// `None` means "not a stream", not "the stream is fine". Treating it as a
    /// failure would fault every non-streaming response.
    #[test]
    fn a_non_stream_is_not_treated_as_unfinished() {
        let body = json!({"content": [{"type": "text", "text": "done"}]});
        let f = ResponseFacts { body: Some(&body), request: Some(&REQ()), done_received: None };
        assert_eq!(score(&f).score, RIS_MAX);
    }

    #[test]
    fn nothing_at_all_with_tools_declared_is_degenerate() {
        let body = json!({"content": []});
        assert_eq!(score(&facts(&body, &REQ())).fault, Some(QualityFault::Degenerate));
    }

    /// Without declared tools an empty turn is odd, not a governance signal —
    /// and faulting it would penalise every arm equally for the same traffic.
    #[test]
    fn nothing_at_all_without_tools_is_not_a_fault() {
        let body = json!({"content": []});
        let req = json!({});
        assert_eq!(score(&facts(&body, &req)).score, RIS_MAX);
    }

    /// The proxy failing to parse a body is the proxy's problem, and charging it
    /// to the model would blame the wrong arm. `upstream_ok` covers transport.
    #[test]
    fn an_unparseable_body_scores_clean_rather_than_blaming_the_model() {
        let f = ResponseFacts { body: None, request: None, done_received: None };
        let r = score(&f);
        assert_eq!(r.score, RIS_MAX);
        assert!(r.fault.is_none());
    }

    #[test]
    fn the_heaviest_fault_is_reported_first() {
        // Both a bad tool call and a truncation. The tool call is the one the
        // agent cannot work around, so it is what an operator should see.
        let body = json!({
            "stop_reason": "max_tokens",
            "content": [{"type": "tool_use", "name": "Deploy", "input": {}}]
        });
        assert_eq!(score(&facts(&body, &REQ())).fault, Some(QualityFault::UnknownTool));
    }

    #[test]
    fn faults_accumulate_rather_than_replacing_each_other() {
        let body = json!({
            "stop_reason": "max_tokens",
            "content": [{"type": "tool_use", "name": "Deploy", "input": {}}]
        });
        let r = score(&facts(&body, &REQ()));
        assert!(
            r.score < RIS_MAX - PENALTY_BAD_TOOL_CALL,
            "two faults scored the same as one: {}",
            r.score
        );
    }

    #[test]
    fn the_score_never_underflows() {
        let body = json!({
            "stop_reason": "max_tokens",
            "choices": [{"finish_reason": "length", "message": {"tool_calls": [
                {"function": {"name": "A", "arguments": "{"}},
                {"function": {"name": "B", "arguments": "{"}}
            ]}}]
        });
        // Saturating arithmetic, not wrapping: a pile of faults must floor at 0
        // rather than wrap to 255 and read as a perfect response.
        assert_eq!(score(&facts(&body, &REQ())).score, 0);
    }

    #[test]
    fn every_fault_has_a_stable_name() {
        // The name is what an operator acts on, and the two most common faults
        // have opposite remedies — raise max_tokens, or stop routing this task
        // to this model.
        for (f, s) in [
            (QualityFault::UnknownTool, "unknown_tool"),
            (QualityFault::ToolArgumentsNotJson, "tool_arguments_not_json"),
            (QualityFault::MissingRequiredArgument, "missing_required_argument"),
            (QualityFault::Truncated, "truncated"),
            (QualityFault::Degenerate, "degenerate"),
        ] {
            assert_eq!(f.as_str(), s);
        }
    }
}

#[cfg(test)]
mod streaming_symmetry_tests {
    use super::*;

    /// Both stream outcomes must be measured, or the mean is over failures only.
    ///
    /// The reward cron computes `AVG(response_integrity)`, and SQL `AVG` ignores
    /// NULLs. So if a truncated stream stores 60 and a clean one stores NULL,
    /// an arm's mean integrity is the mean of the requests that went wrong — an
    /// arm with 9,995 clean streams and 5 truncations scores exactly 60. That is
    /// worse than the hardcoded 100 this scorer was repaired to replace.
    #[test]
    fn a_clean_stream_is_measured_not_merely_unrecorded() {
        let clean = score(&ResponseFacts { body: None, request: None, done_received: Some(true) });
        assert!(
            clean.measured,
            "a stream that delivered its terminal event was observed; storing NULL for it \
             leaves AVG(response_integrity) averaging the arm's truncations alone"
        );
        assert_eq!(clean.score, RIS_MAX);
        assert!(clean.fault.is_none());

        let truncated =
            score(&ResponseFacts { body: None, request: None, done_received: Some(false) });
        assert!(truncated.measured);
        assert!(truncated.score < clean.score, "truncation must cost something");

        // The asymmetry is the defect: both are observations of the same check.
        assert_eq!(
            clean.measured, truncated.measured,
            "a stream check that only records one of its two outcomes biases every mean built on it"
        );
    }

    /// No body and no terminal signal is still nothing.
    #[test]
    fn absent_signal_stays_unmeasured() {
        let none = score(&ResponseFacts { body: None, request: None, done_received: None });
        assert!(
            !none.measured,
            "with no body and no terminal event there is nothing to have measured, and \
             crediting an arm here is the defect the `measured` flag exists to prevent"
        );
    }
}
