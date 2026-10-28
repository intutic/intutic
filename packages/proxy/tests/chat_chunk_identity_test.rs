//! Regression (#392): on a streamed Chat Completions turn with output DLP on,
//! the chunks the proxy writes itself are well formed and in time.
//!
//! ## The bugs
//!
//! * The output DLP's held text (`intutic-dlp-holdback`) and a tool call's
//!   held arguments went out with no `created` or `model`, and an id of their
//!   own or none. The OpenAI chunk schema requires all three, and a strict
//!   client (Grok Build) failed the turn on them.
//! * A tool call's arguments, held per call and blanked in the chunks they
//!   came in, were flushed at `[DONE]`: after the chunk whose `finish_reason`
//!   ends the choice. A client that assembles its calls there (Goose) ran them
//!   with no arguments.
//!
//! ## What is pinned
//!
//! * every `chat.completion.chunk` the client reads carries the upstream
//!   stream's `id`, `created` and `model`;
//! * the call's arguments, whole, and the held text arrive before the chunk
//!   that finishes the choice, and nothing but `[DONE]` follows it.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: upstream
//! URLs, the control-plane URL and the SOP directory are process-global env.
#![cfg(feature = "control-plane")]

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\n---\nNo deletes.\n";
const STREAM_ID: &str = "chatcmpl-up";
const CREATED: u64 = 1_700_000_000;
const SERVED: &str = "served-model";

fn upstream_stream() -> String {
    let chunk = |delta: Value, finish: Value| {
        format!(
            "data: {}\n\n",
            json!({"id": STREAM_ID, "object": "chat.completion.chunk", "created": CREATED,
                   "model": SERVED,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        )
    };
    let mut s = String::new();
    s += &chunk(
        json!({"role": "assistant", "content": "Reading the readme"}),
        Value::Null,
    );
    s += &chunk(json!({"content": " now."}), Value::Null);
    s += &chunk(
        json!({"tool_calls": [{"index": 0, "id": "call_read", "type": "function",
                               "function": {"name": "read_file", "arguments": ""}}]}),
        Value::Null,
    );
    for part in ["{\"path\": \"REA", "DME.md\"}"] {
        s += &chunk(
            json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
            Value::Null,
        );
    }
    s += &chunk(json!({}), json!("tool_calls"));
    s += "data: [DONE]\n\n";
    s
}

#[tokio::test]
async fn the_proxys_own_chunks_carry_the_streams_identity_and_come_before_the_finish() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(upstream_stream(), "text/event-stream"),
        )
        .mount(&upstream)
        .await;
    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
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
        std::env::temp_dir().join(format!("intutic-chunk-identity-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the request
    // needs a provider key, so the operator fallback supplies a test one.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
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

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        // Runtime-assembled virtual key, per the repo's fixture rule.
        .header(
            "Authorization",
            concat!(
                "Bearer vk_",
                "0123456789abcdef0123456789abcdef",
                "_ws_chunkid"
            ),
        )
        .header("x-workspace-id", "ws_chunkid")
        .header("x-session-id", "ses_chunkid")
        .json(&json!({
            "model": "qwen-test-model", "stream": true,
            "messages": [{"role": "user", "content": "read the readme"}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let text = res.text().await.expect("stream drains");
    let _ = std::fs::remove_dir_all(&sops_dir);
    assert!(status.is_success(), "proxy returned {status}: {text}");

    let mut chunks = Vec::new();
    let mut after_done = 0;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            after_done += 1;
            continue;
        }
        let v: Value = serde_json::from_str(data).unwrap_or_else(|e| panic!("{e}: {data}\n{text}"));
        if v["object"] == "chat.completion.chunk" {
            chunks.push(v);
        }
    }
    assert_eq!(after_done, 1, "one [DONE]:\n{text}");

    for c in &chunks {
        assert_eq!(
            c["id"], STREAM_ID,
            "chunk without the stream's id: {c}\n{text}"
        );
        assert_eq!(
            c["created"], CREATED,
            "chunk without the stream's created: {c}\n{text}"
        );
        assert_eq!(
            c["model"], SERVED,
            "chunk without the stream's model: {c}\n{text}"
        );
    }

    let finish = chunks
        .iter()
        .position(|c| c["choices"][0]["finish_reason"].is_string())
        .unwrap_or_else(|| panic!("no finishing chunk:\n{text}"));
    let (before, after) = chunks.split_at(finish);
    // Only notes the proxy appends to the answer (governance, decide) may
    // follow the finish; none of the call's arguments or the held text may.
    let mut args = String::new();
    let mut content = String::new();
    for c in before {
        let delta = &c["choices"][0]["delta"];
        if let Some(a) = delta["tool_calls"][0]["function"]["arguments"].as_str() {
            args.push_str(a);
        }
        if let Some(t) = delta["content"].as_str() {
            content.push_str(t);
        }
    }
    for c in &after[1..] {
        assert!(
            c["choices"][0]["delta"]["tool_calls"].is_null(),
            "a tool call's arguments after the finishing chunk: {c}\n{text}"
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(&args).ok(),
        Some(json!({"path": "README.md"})),
        "the call's arguments, whole, before the finish ({args:?}):\n{text}"
    );
    assert!(
        content.starts_with("Reading the readme now."),
        "the held text before the finish ({content:?}):\n{text}"
    );
}
