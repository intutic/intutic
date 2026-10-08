//! Regression: when the response gate refuses a tool call on a stream, the
//! text the model wrote before it still reaches the client — scrubbed — and
//! the refusal still closes the stream after it.
//!
//! ## The bug
//!
//! The refusal tail is a terminal event, so nothing may follow it, and the
//! post-loop holdback flush suppresses emission once the gate has tripped. Text
//! still held by the output-DLP holdback at the moment of refusal was therefore
//! drained into the trace and never sent: on OpenAI chat and Responses — where
//! no event closes the text before a tool call starts — the client saw the
//! refusal with the sentence before it cut short or missing. Both gates did
//! it: the deny-list name gate and the destructive-SQL guard.
//!
//! ## What is pinned, per wire shape and per gate
//!
//! * the pre-call text arrives, and arrives BEFORE the refusal;
//! * a credential split across two text deltas — visible only to the
//!   holdback — is redacted in what arrives (the flush goes through the
//!   scrubber, it does not bypass it);
//! * the refused call does not arrive, and the stream ends on its terminal.
//!
//! Anthropic is included as a control: its `content_block_stop` flushes the
//! text in-stream, so it passed before the fix and must keep passing.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: upstream
//! URLs, the control-plane URL and the SOP directory are process-global env.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\nsql_guard: refuse\nsql_allow_dsns: postgres://localhost/*\n---\nNo deletes; destructive SQL only against local databases.\n";
const PROD_DROP: &str = "psql -h db.prod.internal -d app -c 'DROP TABLE users'";

/// AWS-access-key-shaped, assembled at runtime per the fixture rule.
fn key() -> String {
    ["AK", "IA", "ABCDEFGH", "IJKLMNOP"].concat()
}

/// The pre-call text as two deltas, the credential split across them so the
/// per-line wire scrub cannot see it whole and only the holdback can.
fn text_deltas() -> [String; 2] {
    let k = key();
    [
        format!("Cleaning up. Retiring key {}", &k[..10]),
        format!("{} now.", &k[10..]),
    ]
}

fn sse(event: Option<&str>, data: Value) -> String {
    match event {
        Some(e) => format!("event: {e}\ndata: {data}\n\n"),
        None => format!("data: {data}\n\n"),
    }
}

fn args_json(tool: &str) -> String {
    if tool == "delete_everything" {
        json!({ "path": "/" }).to_string()
    } else {
        json!({ "command": PROD_DROP }).to_string()
    }
}

fn openai_chat_stream(tool: &str, call_id: &str) -> String {
    let chunk = |delta: Value, finish: Value| {
        sse(
            None,
            json!({"id": "chatcmpl-hb", "object": "chat.completion.chunk",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}),
        )
    };
    let [t1, t2] = text_deltas();
    let args = args_json(tool);
    let (a, b) = args.split_at(args.len() / 2);
    let mut s = String::new();
    s += &chunk(json!({"role": "assistant", "content": t1}), Value::Null);
    s += &chunk(json!({"content": t2}), Value::Null);
    s += &chunk(
        json!({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                               "function": {"name": tool, "arguments": ""}}]}),
        Value::Null,
    );
    for part in [a, b] {
        s += &chunk(
            json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
            Value::Null,
        );
    }
    s += &chunk(json!({}), json!("tool_calls"));
    s += "data: [DONE]\n\n";
    s
}

/// Chat completions with an ALLOWED call ahead of the refused one. The
/// allowed call's arguments sit in the argument holdback until the next
/// call's index arrives — which is the line the gate withholds — so they must
/// be flushed on the gate path too, or the client gets an allowed call with
/// empty arguments.
fn openai_chat_two_calls(tool: &str, call_id: &str) -> String {
    let full = openai_chat_stream(tool, call_id);
    let chunk = |delta: Value| {
        sse(
            None,
            json!({"id": "chatcmpl-hb", "object": "chat.completion.chunk",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": Value::Null}]}),
        )
    };
    let allowed_args = json!({ "path": "README.md" }).to_string();
    let (a, b) = allowed_args.split_at(8);
    let mut allowed = chunk(json!({"tool_calls": [{"index": 0, "id": "call_hballowed",
        "type": "function", "function": {"name": "read_file", "arguments": ""}}]}));
    for part in [a, b] {
        allowed += &chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}));
    }
    // The refused call moves to index 1, after the allowed one.
    let refused_at = full
        .find(call_id)
        .map(|i| full[..i].rfind("data:").unwrap())
        .unwrap();
    let rest = full[refused_at..]
        .replace("\"index\":0,\"id\"", "\"index\":1,\"id\"")
        .replace("{\"index\":0,\"function\"", "{\"index\":1,\"function\"");
    format!("{}{}{}", &full[..refused_at], allowed, rest)
}

fn responses_stream(tool: &str, call_id: &str) -> String {
    let [t1, t2] = text_deltas();
    let args = args_json(tool);
    let (a, b) = args.split_at(args.len() / 2);
    let mut s = String::new();
    s += &sse(
        Some("response.created"),
        json!({"type": "response.created", "response": {"id": "resp_hb", "status": "in_progress"}}),
    );
    s += &sse(
        Some("response.output_item.added"),
        json!({"type": "response.output_item.added", "output_index": 0,
               "item": {"id": "msg_hb", "type": "message", "role": "assistant", "content": []}}),
    );
    for t in [t1, t2] {
        s += &sse(
            Some("response.output_text.delta"),
            json!({"type": "response.output_text.delta", "item_id": "msg_hb",
                   "output_index": 0, "content_index": 0, "delta": t}),
        );
    }
    s += &sse(
        Some("response.output_item.done"),
        json!({"type": "response.output_item.done", "output_index": 0,
               "item": {"id": "msg_hb", "type": "message"}}),
    );
    s += &sse(
        Some("response.output_item.added"),
        json!({"type": "response.output_item.added", "output_index": 1,
               "item": {"id": call_id, "type": "function_call", "call_id": call_id,
                        "name": tool, "arguments": ""}}),
    );
    for part in [a, b] {
        s += &sse(
            Some("response.function_call_arguments.delta"),
            json!({"type": "response.function_call_arguments.delta", "item_id": call_id,
                   "output_index": 1, "delta": part}),
        );
    }
    s += &sse(
        Some("response.output_item.done"),
        json!({"type": "response.output_item.done", "output_index": 1,
               "item": {"id": call_id, "type": "function_call"}}),
    );
    s += &sse(
        Some("response.completed"),
        json!({"type": "response.completed", "response": {"id": "resp_hb", "status": "completed",
               "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}}}),
    );
    s
}

fn anthropic_stream(tool: &str, call_id: &str) -> String {
    let [t1, t2] = text_deltas();
    let args = args_json(tool);
    let (a, b) = args.split_at(args.len() / 2);
    let mut s = String::new();
    s += &sse(
        Some("message_start"),
        json!({"type": "message_start", "message": {"id": "msg_hb", "type": "message",
               "role": "assistant", "content": [], "model": "claude-3-5-haiku-20241022",
               "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    );
    s += &sse(
        Some("content_block_start"),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    );
    for t in [t1, t2] {
        s += &sse(
            Some("content_block_delta"),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": t}}),
        );
    }
    s += &sse(
        Some("content_block_stop"),
        json!({"type": "content_block_stop", "index": 0}),
    );
    s += &sse(
        Some("content_block_start"),
        json!({"type": "content_block_start", "index": 1,
               "content_block": {"type": "tool_use", "id": call_id, "name": tool, "input": {}}}),
    );
    for part in [a, b] {
        s += &sse(
            Some("content_block_delta"),
            json!({"type": "content_block_delta", "index": 1,
                   "delta": {"type": "input_json_delta", "partial_json": part}}),
        );
    }
    s += &sse(
        Some("content_block_stop"),
        json!({"type": "content_block_stop", "index": 1}),
    );
    s += &sse(
        Some("message_delta"),
        json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"},
               "usage": {"output_tokens": 20}}),
    );
    s += &sse(Some("message_stop"), json!({"type": "message_stop"}));
    s
}

/// Everything the client can read as text: the decoded deltas, in order.
fn client_text(body: &str) -> String {
    let mut out = String::new();
    for line in body.lines() {
        let Some(d) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(d) else {
            continue;
        };
        for t in [
            &v["choices"][0]["delta"]["content"],
            &v["delta"]["text"],
            &v["delta"],
        ] {
            if let Some(s) = t.as_str() {
                out.push_str(s);
            }
        }
    }
    out
}

/// `Err` names what went wrong, so one run reports every failing wire shape
/// and gate rather than stopping at the first.
fn check_flushed_then_refused(
    label: &str,
    body: &str,
    call_id: &str,
    terminal: &str,
) -> Result<(), String> {
    let text = client_text(body);
    let k = key();
    let fail = |why: &str| Err(format!("{label}: {why}\n{body}"));
    if !text.contains("Cleaning up. Retiring key") {
        return fail("the text before the refused call was lost");
    }
    if body.contains(&k) || text.contains(&k) {
        return fail("the split credential reached the client unredacted");
    }
    if !text.contains("[REDACTED_") {
        return fail("the held text was not flushed through the scrubber");
    }
    let at_text = text.find("Cleaning up").unwrap_or(usize::MAX);
    match text.find("[Intutic] Blocked tool call") {
        None => return fail("no refusal in the stream"),
        Some(at) if at < at_text => return fail("the refusal went out before the text it follows"),
        Some(_) => {}
    }
    if body.contains(call_id) {
        return fail("the refused call reached the client");
    }
    let last = body
        .lines()
        .rfind(|l| l.starts_with("data:"))
        .unwrap_or_default();
    if !last.contains(terminal) {
        return fail(&format!(
            "the stream did not end on its terminal ({terminal})"
        ));
    }
    Ok(())
}

#[tokio::test]
async fn a_refused_streamed_call_still_delivers_the_scrubbed_text_before_it() {
    // (marker, route, upstream path, wire builder, tool, call id, terminal)
    type Build = fn(&str, &str) -> String;
    let cases: Vec<(&str, &str, &str, Build, &str, &str, &str)> = vec![
        (
            "hb-chat-deny",
            "/v1/chat/completions",
            "/v1/chat/completions",
            openai_chat_stream,
            "delete_everything",
            "call_hbchatdeny",
            "[DONE]",
        ),
        (
            "hb-chat-sql",
            "/v1/chat/completions",
            "/v1/chat/completions",
            openai_chat_stream,
            "shell",
            "call_hbchatsql",
            "[DONE]",
        ),
        (
            "hb-chat-two-calls",
            "/v1/chat/completions",
            "/v1/chat/completions",
            openai_chat_two_calls,
            "delete_everything",
            "call_hbtwocalls",
            "[DONE]",
        ),
        (
            "hb-resp-deny",
            "/v1/responses",
            "/v1/responses",
            responses_stream,
            "delete_everything",
            "fc_hbrespdeny",
            "response.completed",
        ),
        (
            "hb-resp-sql",
            "/v1/responses",
            "/v1/responses",
            responses_stream,
            "shell",
            "fc_hbrespsql",
            "response.completed",
        ),
        (
            "hb-anth-deny",
            "/v1/messages",
            "/v1/messages",
            anthropic_stream,
            "delete_everything",
            "toolu_hbanthdeny",
            "message_stop",
        ),
        (
            "hb-anth-sql",
            "/v1/messages",
            "/v1/messages",
            anthropic_stream,
            "Bash",
            "toolu_hbanthsql",
            "message_stop",
        ),
    ];

    let upstream = MockServer::start().await;
    for (marker, _, up_path, build, tool, call_id, _) in &cases {
        Mock::given(method("POST"))
            .and(path(*up_path))
            .and(body_string_contains(*marker))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(build(tool, call_id), "text/event-stream"),
            )
            .mount(&upstream)
            .await;
    }
    let cp = MockServer::start().await;
    // Every virtual-key request asks for the key's SSO group policy; this
    // workspace has none.
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_test",
            "ssoGroups": { "policy": null, "memberGroups": null }
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "action": "allow" })))
        .mount(&cp)
        .await;

    let sops_dir =
        std::env::temp_dir().join(format!("intutic-holdback-flush-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream (TD-370): the request
    // needs a provider key, so the operator fallback supplies a test one.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream (TD-370): the request
    // needs a provider key, so the operator fallback supplies a test one.
    std::env::set_var("ANTHROPIC_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n")
            .expect("minimal config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
        context_snapshot_rate: 0.0,
    };
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let mut failures = Vec::new();
    for (marker, route, _, _, _, call_id, terminal) in &cases {
        let prompt = format!("{marker}: tidy up");
        let body = match *route {
            "/v1/messages" => json!({
                "model": "claude-3-5-haiku-20241022", "max_tokens": 64, "stream": true,
                "messages": [{"role": "user", "content": prompt}]
            }),
            "/v1/responses" => json!({
                "model": "qwen-test-model", "stream": true, "input": prompt
            }),
            _ => json!({
                "model": "qwen-test-model", "stream": true,
                "messages": [{"role": "user", "content": prompt}]
            }),
        };
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            // Runtime-assembled virtual key, per the repo's fixture rule.
            .header(
                "Authorization",
                concat!(
                    "Bearer vk_",
                    "0123456789abcdef0123456789abcdef",
                    "_ws_holdback"
                ),
            )
            .header("x-workspace-id", "ws_holdback")
            .header("x-session-id", format!("ses_{marker}"))
            .header("x-api-key", "test-upstream-key")
            .json(&body)
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.expect("stream drains");
        assert!(
            status.is_success(),
            "{marker}: proxy returned {status}: {text}"
        );
        if let Err(e) = check_flushed_then_refused(marker, &text, call_id, terminal) {
            failures.push(e);
        }
        if *marker == "hb-chat-two-calls" {
            let mut args = String::new();
            for line in text.lines() {
                let Some(d) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(d) else {
                    continue;
                };
                let tc = &v["choices"][0]["delta"]["tool_calls"][0];
                if tc["index"] == 0 {
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        args.push_str(a);
                    }
                }
            }
            match serde_json::from_str::<Value>(&args) {
                Ok(v) if v["path"] == "README.md" => {}
                _ => failures.push(format!(
                    "{marker}: the allowed call before the refusal lost its arguments ({args:?})\n{text}"
                )),
            }
        }
    }

    let _ = std::fs::remove_dir_all(&sops_dir);
    assert!(
        failures.is_empty(),
        "{} failure(s) across {} case(s):\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}
