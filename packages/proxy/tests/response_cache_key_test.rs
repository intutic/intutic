//! The response cache answers a request only with a response to that same
//! request, and only in a shape the client can read.
//!
//! ## The bug
//!
//! The exact cache was keyed on the workspace plus the plain text of the
//! user/system messages. Everything else that decides the answer was left out:
//! the model, the tool list, assistant turns, tool results, sampling
//! parameters. In an agent loop turn 2 (prompt, assistant tool call, tool
//! result) therefore hashed exactly like turn 1, and the proxy answered it with
//! turn 1's cached reply. The semantic cache embedded the same text, so it
//! matched the same way. A hit was also always served as one JSON body, also
//! to a `"stream": true` client parsing `text/event-stream`, and the
//! Responses API reply came back in the chat-completions shape.
//!
//! ## What is pinned
//!
//! Every case drives real requests through the proxy against a mock upstream
//! that answers each call with a unique `UPSTREAM#n` text, so a reply the
//! client receives is either fresh (a new `n`) or a replay (an `n` it has seen).
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: upstream
//! URLs and the embedding/TurboVec endpoints are process-global env.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intutic_proxy::store::{ControlPlaneAuth, ControlPlaneCache, FeatureFlags};
use serde_json::{json, Value};
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// Workspaces whose id starts with this get the semantic cache only; every
/// other workspace gets the exact cache only. Isolating the two is what lets
/// a semantic case show a semantic hit rather than an exact one.
const SEMANTIC_WS: &str = "ws_rck_sem_";

/// A managed control plane that turns the response cache on.
struct CacheOn;

#[async_trait::async_trait]
impl ControlPlaneCache for CacheOn {
    async fn auth_context(&self, _t: &str) -> ControlPlaneAuth {
        ControlPlaneAuth::Unmanaged
    }
    async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    async fn wasm_binary(&self, _sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    async fn policy_version(&self, _w: &str) -> Option<u64> {
        None
    }
    async fn predict_gate_threshold(&self, _w: &str) -> Option<f64> {
        None
    }
    async fn token_baseline(
        &self,
        _w: &str,
        _m: &str,
        _b: &str,
    ) -> Option<intutic_proxy::store::TokenBaseline> {
        None
    }
    async fn bandit_keywords(&self, _w: &str) -> Option<Value> {
        None
    }
    async fn active_sop_tier(&self, _w: &str) -> Option<String> {
        None
    }
    async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
        None
    }
    async fn feature_flags(&self, w: &str) -> Option<FeatureFlags> {
        let semantic = w.starts_with(SEMANTIC_WS);
        Some(FeatureFlags {
            bandit_routing: false,
            shadow_routing: false,
            response_cache_exact: !semantic,
            response_cache_semantic: semantic,
            shadow_enforcement: false,
        })
    }
    async fn daily_budget(&self, _w: &str) -> Option<(f64, Option<f64>)> {
        None
    }
    async fn hard_block(&self, _w: &str) -> intutic_proxy::store::HardCapStatus {
        intutic_proxy::store::HardCapStatus::Clear
    }
    async fn loop_status(&self, _l: &str) -> Option<String> {
        None
    }
    async fn active_loop_run(&self, _w: &str, _m: Option<&str>) -> Option<String> {
        None
    }
    async fn auto_judge_active(&self, _s: intutic_proxy::store::JudgeScope, _id: &str) -> bool {
        false
    }
    async fn break_glass_grant(
        &self,
        _t: &str,
        _w: &str,
    ) -> Option<intutic_proxy::store::BreakGlassGrant> {
        None
    }
    async fn transition_baseline(&self, _w: &str) -> Option<String> {
        None
    }
    async fn drain_notifications(
        &self,
        _s: intutic_proxy::store::NotifyScope,
        _id: &str,
    ) -> Vec<String> {
        Vec::new()
    }
    async fn is_sandbox_attested(&self, _sid: &str) -> bool {
        false
    }
}

// ── Mock upstream ────────────────────────────────────────────────────────

static UPSTREAM_CALLS: AtomicUsize = AtomicUsize::new(0);

/// Put this in a prompt to make the upstream answer with text AND a tool call.
const WANT_TOOL: &str = "[[tool]]";
/// Put this in a prompt to make the upstream answer with a credential in it.
const WANT_SECRET: &str = "[[secret]]";

/// AWS-access-key-shaped, assembled at runtime per the fixture rule.
fn secret() -> String {
    ["AK", "IA", "ZYXWVUTS", "RQPONMLK"].concat()
}

fn sse(event: Option<&str>, data: Value) -> String {
    match event {
        Some(e) => format!("event: {e}\ndata: {data}\n\n"),
        None => format!("data: {data}\n\n"),
    }
}

/// Whether this request already carries a tool result, in any wire shape. The
/// upstream only calls a tool on a turn that has not had one answered yet.
fn has_tool_result(body: &str) -> bool {
    ["tool_result", "\"role\":\"tool\"", "function_call_output"]
        .iter()
        .any(|m| body.contains(m))
}

fn upstream_reply(req: &Request) -> ResponseTemplate {
    let n = UPSTREAM_CALLS.fetch_add(1, Ordering::SeqCst) + 1;
    let raw = String::from_utf8_lossy(&req.body).to_string();
    let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
    let stream = body["stream"].as_bool().unwrap_or(false);
    let tool = raw.contains(WANT_TOOL) && !has_tool_result(&raw);
    let text = if raw.contains(WANT_SECRET) {
        format!("UPSTREAM#{n} key {}", secret())
    } else {
        format!("UPSTREAM#{n}")
    };
    let route = req.url.path();
    if !stream {
        let v = match route {
            "/v1/messages" => {
                let mut content = vec![json!({"type": "text", "text": text})];
                if tool {
                    content.push(json!({"type": "tool_use", "id": format!("toolu_{n}"),
                        "name": "read_file", "input": {"path": "README.md"}}));
                }
                json!({"id": format!("msg_{n}"), "type": "message", "role": "assistant",
                    "model": body["model"], "content": content,
                    "stop_reason": if tool { "tool_use" } else { "end_turn" },
                    "usage": {"input_tokens": 10, "output_tokens": 5}})
            }
            "/v1/responses" => {
                let mut output = vec![json!({"id": format!("msg_{n}"), "type": "message",
                    "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": text, "annotations": []}]})];
                if tool {
                    output.push(json!({"id": format!("fc_{n}"), "type": "function_call",
                        "call_id": format!("call_{n}"), "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}", "status": "completed"}));
                }
                json!({"id": format!("resp_{n}"), "object": "response", "status": "completed",
                    "model": body["model"], "output": output,
                    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}})
            }
            _ => {
                let mut message = json!({"role": "assistant", "content": text});
                if tool {
                    message["tool_calls"] = json!([{"id": format!("call_{n}"), "type": "function",
                        "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"}}]);
                }
                json!({"id": format!("chatcmpl-{n}"), "object": "chat.completion",
                    "model": body["model"],
                    "choices": [{"index": 0, "message": message,
                        "finish_reason": if tool { "tool_calls" } else { "stop" }}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
            }
        };
        return ResponseTemplate::new(200).set_body_json(v);
    }

    let mut s = String::new();
    match route {
        "/v1/messages" => {
            s += &sse(
                Some("message_start"),
                json!({"type": "message_start", "message": {
                "id": format!("msg_{n}"), "type": "message", "role": "assistant", "content": [],
                "model": body["model"], "usage": {"input_tokens": 10, "output_tokens": 0}}}),
            );
            s += &sse(
                Some("content_block_start"),
                json!({"type": "content_block_start",
                "index": 0, "content_block": {"type": "text", "text": ""}}),
            );
            s += &sse(
                Some("content_block_delta"),
                json!({"type": "content_block_delta",
                "index": 0, "delta": {"type": "text_delta", "text": text}}),
            );
            s += &sse(
                Some("content_block_stop"),
                json!({"type": "content_block_stop", "index": 0}),
            );
            if tool {
                s += &sse(
                    Some("content_block_start"),
                    json!({"type": "content_block_start",
                    "index": 1, "content_block": {"type": "tool_use", "id": format!("toolu_{n}"),
                    "name": "read_file", "input": {}}}),
                );
                s += &sse(
                    Some("content_block_delta"),
                    json!({"type": "content_block_delta",
                    "index": 1, "delta": {"type": "input_json_delta",
                    "partial_json": "{\"path\":\"README.md\"}"}}),
                );
                s += &sse(
                    Some("content_block_stop"),
                    json!({"type": "content_block_stop", "index": 1}),
                );
            }
            s += &sse(
                Some("message_delta"),
                json!({"type": "message_delta",
                "delta": {"stop_reason": if tool { "tool_use" } else { "end_turn" }},
                "usage": {"output_tokens": 5}}),
            );
            s += &sse(Some("message_stop"), json!({"type": "message_stop"}));
        }
        "/v1/responses" => {
            s += &sse(
                Some("response.created"),
                json!({"type": "response.created",
                "response": {"id": format!("resp_{n}"), "status": "in_progress"}}),
            );
            s += &sse(
                Some("response.output_item.added"),
                json!({"type": "response.output_item.added",
                "output_index": 0, "item": {"id": format!("msg_{n}"), "type": "message",
                "role": "assistant", "content": []}}),
            );
            s += &sse(
                Some("response.output_text.delta"),
                json!({"type": "response.output_text.delta",
                "item_id": format!("msg_{n}"), "output_index": 0, "content_index": 0, "delta": text}),
            );
            s += &sse(
                Some("response.output_item.done"),
                json!({"type": "response.output_item.done",
                "output_index": 0, "item": {"id": format!("msg_{n}"), "type": "message",
                "role": "assistant", "content": [{"type": "output_text", "text": text}]}}),
            );
            if tool {
                s += &sse(
                    Some("response.output_item.added"),
                    json!({"type": "response.output_item.added",
                    "output_index": 1, "item": {"id": format!("fc_{n}"), "type": "function_call",
                    "call_id": format!("call_{n}"), "name": "read_file", "arguments": ""}}),
                );
                s += &sse(
                    Some("response.function_call_arguments.delta"),
                    json!({
                    "type": "response.function_call_arguments.delta", "item_id": format!("fc_{n}"),
                    "output_index": 1, "delta": "{\"path\":\"README.md\"}"}),
                );
                s += &sse(
                    Some("response.output_item.done"),
                    json!({"type": "response.output_item.done",
                    "output_index": 1, "item": {"id": format!("fc_{n}"), "type": "function_call",
                    "call_id": format!("call_{n}"), "name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"}}),
                );
            }
            s += &sse(
                Some("response.completed"),
                json!({"type": "response.completed",
                "response": {"id": format!("resp_{n}"), "status": "completed",
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}),
            );
        }
        _ => {
            let chunk = |delta: Value, finish: Value| {
                sse(
                    None,
                    json!({"id": format!("chatcmpl-{n}"), "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}),
                )
            };
            s += &chunk(json!({"role": "assistant", "content": text}), Value::Null);
            if tool {
                s += &chunk(
                    json!({"tool_calls": [{"index": 0, "id": format!("call_{n}"),
                    "type": "function", "function": {"name": "read_file",
                    "arguments": "{\"path\":\"README.md\"}"}}]}),
                    Value::Null,
                );
            }
            s += &chunk(json!({}), json!(if tool { "tool_calls" } else { "stop" }));
            s += "data: [DONE]\n\n";
        }
    }
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(s, "text/event-stream")
}

// ── Fake embedding service and TurboVec ──────────────────────────────────

/// Every text embeds to the same vector, so every query is a perfect (1.0)
/// match for the latest entry in its workspace: the most permissive
/// similarity there can be. Whatever the semantic cache refuses here it
/// refuses on something other than the score.
fn embedding_reply(_req: &Request) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"data": [{"embedding": vec![0.125_f32; 8]}]}))
}

#[derive(Clone, Default)]
struct FakeTurboVec(Arc<Mutex<HashMap<String, String>>>);

impl wiremock::Respond for FakeTurboVec {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or_default();
        let mut latest = self.0.lock().unwrap();
        if req.url.path().ends_with("/insert") {
            let ws = body["metadata"]["workspaceId"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let hash = body["metadata"]["hash"].as_str().unwrap_or("").to_string();
            latest.insert(ws.clone(), hash.clone());
            return ResponseTemplate::new(200)
                .set_body_json(json!({"id": 1, "workspaceId": ws, "hash": hash, "created": true}));
        }
        let ws = body["workspaceId"].as_str().unwrap_or("");
        let hits: Vec<Value> = latest
            .get(ws)
            .map(|h| {
                vec![json!({"id": 1, "score": 1.0, "metadata": {"hash": h, "workspaceId": ws}})]
            })
            .unwrap_or_default();
        ResponseTemplate::new(200).set_body_json(Value::Array(hits))
    }
}

// ── Client side ──────────────────────────────────────────────────────────

#[derive(Debug)]
struct Reply {
    status: reqwest::StatusCode,
    content_type: String,
    /// The assistant text the client reconstructs from the reply.
    text: String,
    /// The reply carries a tool call the client would execute.
    tool_call: bool,
    /// A streamed reply ended with the protocol's terminal event.
    terminal: bool,
    raw: String,
}

fn parse_json_reply(route: &str, v: &Value) -> (String, bool) {
    match route {
        "/v1/messages" => {
            let blocks = v["content"].as_array().cloned().unwrap_or_default();
            let text = blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect();
            (text, blocks.iter().any(|b| b["type"] == "tool_use"))
        }
        "/v1/responses" => {
            let items = v["output"].as_array().cloned().unwrap_or_default();
            let mut text = String::new();
            for item in items.iter().filter(|i| i["type"] == "message") {
                for part in item["content"].as_array().into_iter().flatten() {
                    if part["type"] == "output_text" {
                        text.push_str(part["text"].as_str().unwrap_or(""));
                    }
                }
            }
            (text, items.iter().any(|i| i["type"] == "function_call"))
        }
        _ => {
            let msg = &v["choices"][0]["message"];
            (
                msg["content"].as_str().unwrap_or("").to_string(),
                msg["tool_calls"].as_array().is_some_and(|a| !a.is_empty()),
            )
        }
    }
}

fn parse_sse_reply(route: &str, raw: &str) -> (String, bool, bool) {
    let (mut text, mut tool, mut terminal) = (String::new(), false, false);
    for line in raw.lines() {
        let Some(d) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if d == "[DONE]" {
            terminal |= route == "/v1/chat/completions";
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(d) else {
            continue;
        };
        match route {
            "/v1/messages" => {
                if v["type"] == "content_block_delta" {
                    text.push_str(v["delta"]["text"].as_str().unwrap_or(""));
                }
                tool |=
                    v["type"] == "content_block_start" && v["content_block"]["type"] == "tool_use";
                terminal |= v["type"] == "message_stop";
            }
            "/v1/responses" => {
                if v["type"] == "response.output_text.delta" {
                    text.push_str(v["delta"].as_str().unwrap_or(""));
                }
                tool |= v["type"] == "response.output_item.added"
                    && v["item"]["type"] == "function_call";
                terminal |= v["type"] == "response.completed";
            }
            _ => {
                let delta = &v["choices"][0]["delta"];
                text.push_str(delta["content"].as_str().unwrap_or(""));
                tool |= delta["tool_calls"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty());
            }
        }
    }
    (text, tool, terminal)
}

async fn send(addr: std::net::SocketAddr, route: &str, ws: &str, body: &Value) -> Reply {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}{route}"))
        // Runtime-assembled virtual key, per the repo's fixture rule. Its
        // suffix names the workspace, which must match `x-workspace-id`.
        .header(
            "Authorization",
            ["Bearer vk_", "0123456789abcdef0123456789abcdef", "_", ws].concat(),
        )
        .header("x-workspace-id", ws)
        .json(body)
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = res.text().await.expect("body drains");
    let (text, tool_call, terminal) = if body["stream"] == true {
        parse_sse_reply(route, &raw)
    } else {
        let v: Value = serde_json::from_str(&raw).unwrap_or_default();
        let (t, tc) = parse_json_reply(route, &v);
        (t, tc, false)
    };
    let reply = Reply {
        status,
        content_type,
        text,
        tool_call,
        terminal,
        raw,
    };
    // A streamed reply is cached by the stream task after the last byte, so
    // give it a moment to land before the next request looks for it.
    if body["stream"] == true {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    reply
}

fn fresh(r: &Reply) -> bool {
    r.status.is_success() && r.text.starts_with("UPSTREAM#")
}

/// `second` was answered by the upstream, not replayed from `first`.
fn check_miss(case: &str, first: &Reply, second: &Reply, failures: &mut Vec<String>) {
    if !fresh(first) || !fresh(second) {
        failures.push(format!(
            "{case}: a reply was not an upstream answer\n{first:?}\n{second:?}"
        ));
    } else if first.text == second.text {
        failures.push(format!(
            "{case}: served the cached reply to a different request ({:?})",
            second.text
        ));
    }
}

/// `second` was replayed from the cache entry `first` filled.
fn check_hit(case: &str, first: &Reply, second: &Reply, failures: &mut Vec<String>) {
    if !fresh(first) || first.text != second.text {
        failures.push(format!(
            "{case}: an identical request was not served from the cache\n{first:?}\n{second:?}"
        ));
    }
}

fn anthropic_user(text: &str) -> Value {
    json!({"role": "user", "content": text})
}

const READ_FILE_TOOL_ANTHROPIC: &str = r#"{"name":"read_file","description":"Read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}"#;
const READ_FILE_TOOL_OPENAI: &str = r#"{"type":"function","function":{"name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}"#;

#[tokio::test]
async fn the_response_cache_answers_only_the_request_that_filled_it() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(upstream_reply)
        .mount(&upstream)
        .await;
    let embed = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(embedding_reply)
        .mount(&embed)
        .await;
    // One responder for both routes, so a query sees what an insert wrote.
    let turbovec = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(FakeTurboVec::default())
        .mount(&turbovec)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the operator fallback
    // supplies a test provider key.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("ANTHROPIC_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var(
        "EMBEDDING_GENERATOR_URL",
        format!("{}/v1/embeddings", embed.uri()),
    );
    std::env::set_var("TURBOVEC_URL", turbovec.uri());
    std::env::remove_var("CONTROL_PLANE_URL");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n").expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(CacheOn),
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

    let mut failures: Vec<String> = Vec::new();
    let haiku = "claude-3-5-haiku-20241022";
    let tools_a: Value = serde_json::from_str(&format!("[{READ_FILE_TOOL_ANTHROPIC}]")).unwrap();
    let tools_o: Value = serde_json::from_str(&format!("[{READ_FILE_TOOL_OPENAI}]")).unwrap();

    // ── Control: an identical request is a hit ────────────────────────────
    {
        let ws = "ws_rck_control";
        let body = json!({"model": haiku, "max_tokens": 64,
            "messages": [anthropic_user("control: what is 2+2?")]});
        let a = send(addr, "/v1/messages", ws, &body).await;
        let b = send(addr, "/v1/messages", ws, &body).await;
        check_hit("control/anthropic", &a, &b, &mut failures);
    }

    // ── (a) Anthropic tool loop: turn 2 carries a tool result ─────────────
    {
        let ws = "ws_rck_anth_loop";
        let prompt = "loop: what does README.md say?";
        let turn1 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
            "messages": [anthropic_user(prompt)]});
        let a = send(addr, "/v1/messages", ws, &turn1).await;
        let turn2 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
        "messages": [
            anthropic_user(prompt),
            {"role": "assistant", "content": [
                {"type": "text", "text": a.text},
                {"type": "tool_use", "id": "toolu_1", "name": "read_file",
                 "input": {"path": "README.md"}}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "hello"}]}
        ]});
        let b = send(addr, "/v1/messages", ws, &turn2).await;
        check_miss(
            "anthropic tool loop: turn 2 vs turn 1",
            &a,
            &b,
            &mut failures,
        );
    }

    // The same loop when turn 1 really was a tool call: its text half must
    // not be replayed as a finished answer either.
    {
        let ws = "ws_rck_anth_loop_tool";
        let prompt = format!("loop-tool: {WANT_TOOL} what does README.md say?");
        let turn1 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
            "messages": [anthropic_user(&prompt)]});
        let a = send(addr, "/v1/messages", ws, &turn1).await;
        let turn2 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
        "messages": [
            anthropic_user(&prompt),
            {"role": "assistant", "content": [
                {"type": "text", "text": a.text},
                {"type": "tool_use", "id": "toolu_1", "name": "read_file",
                 "input": {"path": "README.md"}}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "hello"}]}
        ]});
        let b = send(addr, "/v1/messages", ws, &turn2).await;
        check_miss(
            "anthropic tool loop (tool_use turn 1): turn 2 vs turn 1",
            &a,
            &b,
            &mut failures,
        );
        if !a.tool_call {
            failures.push(format!(
                "anthropic tool loop: turn 1 lost its tool call\n{a:?}"
            ));
        }
    }

    // ── (b) Same prompt, different model / tools / system / sampling ──────
    {
        let ws = "ws_rck_anth_params";
        let base = json!({"model": haiku, "max_tokens": 64,
            "messages": [anthropic_user("params: name a colour")]});
        let a = send(addr, "/v1/messages", ws, &base).await;
        let variants: Vec<(&str, Value)> = vec![
            ("model", {
                let mut v = base.clone();
                v["model"] = json!("claude-sonnet-4-5");
                v
            }),
            ("tools", {
                let mut v = base.clone();
                v["tools"] = tools_a.clone();
                v
            }),
            ("tool_choice", {
                let mut v = base.clone();
                v["tool_choice"] = json!({"type": "any"});
                v
            }),
            ("system", {
                let mut v = base.clone();
                v["system"] = json!([{"type": "text", "text": "Answer in French."}]);
                v
            }),
            ("temperature", {
                let mut v = base.clone();
                v["temperature"] = json!(0.0);
                v
            }),
            ("max_tokens", {
                let mut v = base.clone();
                v["max_tokens"] = json!(8);
                v
            }),
            ("stop_sequences", {
                let mut v = base.clone();
                v["stop_sequences"] = json!(["\n"]);
                v
            }),
        ];
        for (field, body) in variants {
            let b = send(addr, "/v1/messages", ws, &body).await;
            check_miss(
                &format!("same prompt, different {field}"),
                &a,
                &b,
                &mut failures,
            );
        }
        // `metadata.user_id` cannot change the answer: still a hit.
        let mut same = base.clone();
        same["metadata"] = json!({"user_id": "someone-else"});
        let c = send(addr, "/v1/messages", ws, &same).await;
        check_hit("same request, different metadata", &a, &c, &mut failures);
    }

    // ── (c) OpenAI chat tool loop ─────────────────────────────────────────
    {
        let ws = "ws_rck_chat_loop";
        let user = json!({"role": "user", "content": "chat-loop: what does README.md say?"});
        let turn1 = json!({"model": "qwen-test-model", "tools": tools_o, "messages": [user]});
        let a = send(addr, "/v1/chat/completions", ws, &turn1).await;
        let turn2 = json!({"model": "qwen-test-model", "tools": tools_o, "messages": [
            user,
            {"role": "assistant", "content": null, "tool_calls": [{"id": "call_1",
                "type": "function", "function": {"name": "read_file",
                "arguments": "{\"path\":\"README.md\"}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "hello"}
        ]});
        let b = send(addr, "/v1/chat/completions", ws, &turn2).await;
        check_miss(
            "openai chat tool loop: turn 2 vs turn 1",
            &a,
            &b,
            &mut failures,
        );
    }

    // ── (c) Responses API tool loop ───────────────────────────────────────
    {
        let ws = "ws_rck_resp_loop";
        let user = json!({"role": "user", "content": "resp-loop: what does README.md say?"});
        let turn1 = json!({"model": "qwen-test-model", "store": false, "tools": [
            {"type": "function", "name": "read_file", "parameters": {"type": "object"}}],
            "input": [user]});
        let a = send(addr, "/v1/responses", ws, &turn1).await;
        let mut turn2 = turn1.clone();
        turn2["input"] = json!([
            user,
            {"type": "function_call", "call_id": "call_1", "name": "read_file",
             "arguments": "{\"path\":\"README.md\"}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "hello"}
        ]);
        let b = send(addr, "/v1/responses", ws, &turn2).await;
        check_miss(
            "responses tool loop: turn 2 vs turn 1",
            &a,
            &b,
            &mut failures,
        );

        // A hit on /v1/responses comes back in the Responses shape.
        let c = send(addr, "/v1/responses", ws, &turn1).await;
        check_hit(
            "responses: identical stateless request",
            &a,
            &c,
            &mut failures,
        );
        let v: Value = serde_json::from_str(&c.raw).unwrap_or_default();
        if v["object"] != "response" || v.get("choices").is_some() {
            failures.push(format!(
                "responses: a cache hit is not a Responses body: {}",
                c.raw
            ));
        }

        // A stored response can be chained with `previous_response_id`; a
        // replayed one carries an id the provider never issued.
        let mut stored = turn1.clone();
        stored.as_object_mut().unwrap().remove("store");
        stored["input"] = json!([{"role": "user", "content": "resp-stored: hello"}]);
        let d = send(addr, "/v1/responses", ws, &stored).await;
        let e = send(addr, "/v1/responses", ws, &stored).await;
        check_miss(
            "responses: a stored (chainable) response",
            &d,
            &e,
            &mut failures,
        );
    }

    // ── (d) Streaming: a hit is a valid stream in the request's protocol ──
    for (route, model, body_extra) in [
        ("/v1/messages", haiku, json!({"max_tokens": 64})),
        ("/v1/chat/completions", "qwen-test-model", json!({})),
        ("/v1/responses", "qwen-test-model", json!({"store": false})),
    ] {
        let ws = format!("ws_rck_stream_{}", route.replace('/', "_"));
        let mut body = body_extra.clone();
        body["model"] = json!(model);
        body["stream"] = json!(true);
        let prompt = format!("stream {route}: name a planet");
        if route == "/v1/responses" {
            body["input"] = json!([{"role": "user", "content": prompt}]);
        } else {
            body["messages"] = json!([{"role": "user", "content": prompt}]);
        }
        let a = send(addr, route, &ws, &body).await;
        let b = send(addr, route, &ws, &body).await;
        check_hit(&format!("stream {route}"), &a, &b, &mut failures);
        if !b.content_type.starts_with("text/event-stream") || !b.terminal {
            failures.push(format!(
                "stream {route}: the cache hit is not a complete event stream \
                 (content-type {:?}, terminal {})\n{}",
                b.content_type, b.terminal, b.raw
            ));
        }
        // `stream` is not part of the key: the same request unstreamed hits.
        let mut unstreamed = body.clone();
        unstreamed["stream"] = json!(false);
        let c = send(addr, route, &ws, &unstreamed).await;
        check_hit(
            &format!("stream {route} → non-streamed"),
            &a,
            &c,
            &mut failures,
        );
    }

    // ── A reply that called a tool is never replayed as text ──────────────
    for (route, model, stream) in [
        ("/v1/messages", haiku, false),
        ("/v1/messages", haiku, true),
        ("/v1/chat/completions", "qwen-test-model", false),
        ("/v1/chat/completions", "qwen-test-model", true),
        ("/v1/responses", "qwen-test-model", false),
        ("/v1/responses", "qwen-test-model", true),
    ] {
        let ws = format!("ws_rck_toolreply_{}_{stream}", route.replace('/', "_"));
        let prompt = format!("{WANT_TOOL} tool-reply {route} {stream}: read README.md");
        let mut body = json!({"model": model, "stream": stream});
        match route {
            "/v1/messages" => {
                body["max_tokens"] = json!(64);
                body["tools"] = tools_a.clone();
                body["messages"] = json!([anthropic_user(&prompt)]);
            }
            "/v1/responses" => {
                body["store"] = json!(false);
                body["tools"] = json!([{"type": "function", "name": "read_file",
                    "parameters": {"type": "object"}}]);
                body["input"] = json!([{"role": "user", "content": prompt}]);
            }
            _ => {
                body["tools"] = tools_o.clone();
                body["messages"] = json!([{"role": "user", "content": prompt}]);
            }
        }
        let a = send(addr, route, &ws, &body).await;
        let b = send(addr, route, &ws, &body).await;
        let case = format!("tool-call reply {route} stream={stream}");
        if !a.tool_call {
            failures.push(format!(
                "{case}: the upstream's tool call did not reach the client\n{a:?}"
            ));
        } else if !b.tool_call {
            failures.push(format!(
                "{case}: the repeat lost the tool call (replayed as text {:?})",
                b.text
            ));
        }
    }

    // ── Output DLP: what was redacted for the client is not cached raw ────
    for stream in [false, true] {
        let ws = format!("ws_rck_dlp_{stream}");
        let body = json!({"model": haiku, "max_tokens": 64, "stream": stream,
            "messages": [anthropic_user(&format!("dlp {stream}: {WANT_SECRET} show the key"))]});
        let a = send(addr, "/v1/messages", &ws, &body).await;
        let b = send(addr, "/v1/messages", &ws, &body).await;
        for (which, r) in [("first", &a), ("repeat", &b)] {
            if r.raw.contains(&secret()) {
                failures.push(format!(
                    "dlp stream={stream}: the {which} reply carries the credential output DLP redacts"
                ));
            }
        }
    }

    // ── Semantic cache: similarity never crosses a different context ──────
    {
        let ws = format!("{SEMANTIC_WS}loop");
        let prompt = "sem-loop: what does README.md say?";
        let turn1 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
            "messages": [anthropic_user(prompt)]});
        let a = send(addr, "/v1/messages", &ws, &turn1).await;
        let turn2 = json!({"model": haiku, "max_tokens": 64, "tools": tools_a,
        "messages": [
            anthropic_user(prompt),
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "read_file",
                 "input": {"path": "README.md"}}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "hello"}]}
        ]});
        let b = send(addr, "/v1/messages", &ws, &turn2).await;
        check_miss(
            "semantic: tool loop turn 2 vs turn 1",
            &a,
            &b,
            &mut failures,
        );
    }
    {
        let ws = format!("{SEMANTIC_WS}params");
        let base = json!({"model": haiku, "max_tokens": 64,
            "messages": [anthropic_user("sem-params: name a colour")]});
        let a = send(addr, "/v1/messages", &ws, &base).await;
        let mut other_model = base.clone();
        other_model["model"] = json!("claude-sonnet-4-5");
        let b = send(addr, "/v1/messages", &ws, &other_model).await;
        check_miss(
            "semantic: same question, different model",
            &a,
            &b,
            &mut failures,
        );
        let mut other_system = base.clone();
        other_system["system"] = json!("Answer in French.");
        let c = send(addr, "/v1/messages", &ws, &other_system).await;
        check_miss(
            "semantic: same question, different system prompt",
            &a,
            &c,
            &mut failures,
        );
    }
    {
        // Control: a reworded question in the same context is a semantic hit.
        let ws = format!("{SEMANTIC_WS}control");
        let a = send(
            addr,
            "/v1/messages",
            &ws,
            &json!({"model": haiku, "max_tokens": 64,
            "messages": [anthropic_user("sem-control: name a colour")]}),
        )
        .await;
        let b = send(
            addr,
            "/v1/messages",
            &ws,
            &json!({"model": haiku, "max_tokens": 64,
            "messages": [anthropic_user("sem-control: tell me one colour")]}),
        )
        .await;
        check_hit(
            "semantic: reworded question, same context",
            &a,
            &b,
            &mut failures,
        );
    }

    assert!(
        failures.is_empty(),
        "{} response-cache failure(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
