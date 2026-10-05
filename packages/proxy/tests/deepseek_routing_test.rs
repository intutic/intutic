//! End-to-end: a request naming a DeepSeek model reaches DeepSeek's own
//! upstream, on whichever of DeepSeek's two native wire shapes it arrived in,
//! with governance applied exactly as for OpenAI and Anthropic (TD-370).
//!
//! ## Why two wire shapes
//!
//! DeepSeek serves an OpenAI-compatible API (`/v1/chat/completions` under
//! `https://api.deepseek.com`) AND an Anthropic-compatible one
//! (`/v1/messages` under `https://api.deepseek.com/anthropic`). dsh — the
//! harness whose `llm-deepseek` route the sync daemon redirects at this proxy
//! — speaks the second: observed live (`uat/evidence/live-verify/dsh-0.2.md`)
//! it sends `POST /v1/messages`, model `deepseek-flash`, `stream: true`, key in
//! `x-api-key`. Before the route existed, both shapes went to
//! `OPENAI_UPSTREAM_URL`, the Anthropic one untranslated.
//!
//! ## What is pinned
//!
//! * `deepseek-chat` (OpenAI wire) and `deepseek-flash` (Anthropic wire, the
//!   id dsh sends) reach the DeepSeek mock, at the path that wire maps to;
//! * the upstream auth header carries the workspace's provisioned DeepSeek key
//!   (`Authorization: Bearer` on the OpenAI wire, `x-api-key` on the Anthropic
//!   wire) — also when the virtual key arrives in `x-api-key`, as dsh sends
//!   it — and a raw key a dsh client sends itself is passed through;
//! * streaming works on both wires;
//! * a SOP-denied tool call in a streamed DeepSeek response is refused by the
//!   response gate on both wires, exactly as for OpenAI/Anthropic;
//! * `gpt-4o`, an Ollama-tagged `deepseek-r1:7b`, and untagged self-hosted /
//!   Groq / Together ids (`deepseek-r1`, `deepseek-coder-v2-instruct`,
//!   `deepseek-r1-distill-llama-70b`) still go to the OpenAI upstream with the
//!   OpenAI key — only DeepSeek's own API ids are routed to DeepSeek;
//! * a client-chosen path (`/anthropic/v1/messages`, `/v1/responses`) cannot
//!   select a DeepSeek endpoint: it is refused with 400 `unsupported_route`.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: upstream
//! URLs and the SOP directory are process-global env.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\n---\nNo deletes.\n";
const WS: &str = "ws_deepseek_routing";

// Upstream keys, runtime-assembled per the repo's fixture rule.
fn deepseek_key() -> String {
    ["ds", "-provisioned-", "test"].concat()
}
fn openai_key() -> String {
    ["oa", "-provisioned-", "test"].concat()
}
fn dsh_raw_key() -> String {
    ["dsh", "-client-", "test"].concat()
}

fn sse(event: Option<&str>, data: Value) -> String {
    match event {
        Some(e) => format!("event: {e}\ndata: {data}\n\n"),
        None => format!("data: {data}\n\n"),
    }
}

fn chat_json(text: &str, model: &str) -> Value {
    json!({
        "id": "chatcmpl-ds",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    })
}

fn chat_tool_stream(tool: &str, call_id: &str) -> String {
    let chunk = |delta: Value, finish: Value| {
        sse(
            None,
            json!({"id": "chatcmpl-ds", "object": "chat.completion.chunk",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}),
        )
    };
    let mut s = String::new();
    s += &chunk(
        json!({"role": "assistant", "content": "Cleaning up."}),
        Value::Null,
    );
    s += &chunk(
        json!({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                               "function": {"name": tool, "arguments": ""}}]}),
        Value::Null,
    );
    s += &chunk(
        json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"path\":\"/\"}"}}]}),
        Value::Null,
    );
    s += &chunk(json!({}), json!("tool_calls"));
    s += "data: [DONE]\n\n";
    s
}

fn anthropic_stream(text: &str, tool: Option<(&str, &str)>) -> String {
    let mut s = String::new();
    s += &sse(
        Some("message_start"),
        json!({"type": "message_start", "message": {"id": "msg_ds", "type": "message",
               "role": "assistant", "content": [], "model": "deepseek-flash",
               "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    );
    s += &sse(
        Some("content_block_start"),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    );
    s += &sse(
        Some("content_block_delta"),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
    );
    s += &sse(
        Some("content_block_stop"),
        json!({"type": "content_block_stop", "index": 0}),
    );
    let mut stop = "end_turn";
    if let Some((name, id)) = tool {
        stop = "tool_use";
        s += &sse(
            Some("content_block_start"),
            json!({"type": "content_block_start", "index": 1,
                   "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}}),
        );
        s += &sse(
            Some("content_block_delta"),
            json!({"type": "content_block_delta", "index": 1,
                   "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"/\"}"}}),
        );
        s += &sse(
            Some("content_block_stop"),
            json!({"type": "content_block_stop", "index": 1}),
        );
    }
    s += &sse(
        Some("message_delta"),
        json!({"type": "message_delta", "delta": {"stop_reason": stop},
               "usage": {"output_tokens": 20}}),
    );
    s += &sse(Some("message_stop"), json!({"type": "message_stop"}));
    s
}

fn sse_response(body: String) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(body, "text/event-stream")
}

/// Mount one mock that answers only on an exact path, auth header and marker.
async fn mount(
    server: &MockServer,
    up_path: &str,
    auth: (&'static str, String),
    marker: &str,
    resp: ResponseTemplate,
) {
    Mock::given(method("POST"))
        .and(path(up_path))
        .and(header(auth.0, auth.1.as_str()))
        .and(body_string_contains(marker))
        .respond_with(resp)
        .expect(1)
        .named(marker)
        .mount(server)
        .await;
}

#[tokio::test]
async fn deepseek_models_route_to_the_deepseek_upstream_on_both_wires_and_stay_governed() {
    let deepseek = MockServer::start().await;
    let openai = MockServer::start().await;

    let ds_bearer = ("authorization", format!("Bearer {}", deepseek_key()));
    let ds_xkey = ("x-api-key", deepseek_key());

    mount(
        &deepseek,
        "/v1/chat/completions",
        ds_bearer.clone(),
        "ds-chat-plain",
        ResponseTemplate::new(200)
            .set_body_json(chat_json("served by deepseek chat", "deepseek-chat")),
    )
    .await;
    mount(
        &deepseek,
        "/v1/chat/completions",
        ds_bearer.clone(),
        "ds-chat-deny",
        sse_response(chat_tool_stream("delete_everything", "call_dschatdeny")),
    )
    .await;
    mount(
        &deepseek,
        "/anthropic/v1/messages",
        ds_xkey.clone(),
        "ds-anth-plain",
        sse_response(anthropic_stream("served by deepseek anthropic", None)),
    )
    .await;
    mount(
        &deepseek,
        "/anthropic/v1/messages",
        ds_xkey.clone(),
        "ds-anth-deny",
        sse_response(anthropic_stream(
            "Cleaning up.",
            Some(("delete_everything", "toolu_dsanthdeny")),
        )),
    )
    .await;
    mount(
        &deepseek,
        "/anthropic/v1/messages",
        ("x-api-key", dsh_raw_key()),
        "ds-anth-passthrough",
        sse_response(anthropic_stream("served by deepseek passthrough", None)),
    )
    .await;

    mount(
        &deepseek,
        "/anthropic/v1/messages",
        ds_xkey.clone(),
        "ds-anth-vk-xkey",
        sse_response(anthropic_stream(
            "served by deepseek for a virtual key",
            None,
        )),
    )
    .await;

    let oa_bearer = ("authorization", format!("Bearer {}", openai_key()));
    mount(
        &openai,
        "/v1/chat/completions",
        oa_bearer.clone(),
        "oa-control",
        ResponseTemplate::new(200).set_body_json(chat_json("served by openai", "gpt-4o")),
    )
    .await;
    mount(
        &openai,
        "/v1/chat/completions",
        oa_bearer.clone(),
        "oa-ollama-tag",
        ResponseTemplate::new(200)
            .set_body_json(chat_json("served by openai-compatible", "deepseek-r1:7b")),
    )
    .await;

    // Untagged self-hosted / Groq / Together ids: not DeepSeek's own API ids,
    // so they keep the OpenAI-compatible upstream they reached before.
    for (marker, model) in [
        ("oa-untagged-r1", "deepseek-r1"),
        ("oa-untagged-coder", "deepseek-coder-v2-instruct"),
        ("oa-untagged-distill", "deepseek-r1-distill-llama-70b"),
    ] {
        mount(
            &openai,
            "/v1/chat/completions",
            oa_bearer.clone(),
            marker,
            ResponseTemplate::new(200)
                .set_body_json(chat_json("served by openai-compatible", model)),
        )
        .await;
    }

    let sops_dir =
        std::env::temp_dir().join(format!("intutic-deepseek-routing-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("DEEPSEEK_UPSTREAM_URL", deepseek.uri());
    std::env::set_var("OPENAI_UPSTREAM_URL", openai.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    std::env::remove_var("DEEPSEEK_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_WORKSPACE_ID");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    {
        use intutic_proxy::store::LocalStore as _;
        store
            .set_workspace_credential(
                WS,
                "deepseek_config",
                &json!({ "apiKey": deepseek_key() }).to_string(),
            )
            .await;
        store
            .set_workspace_credential(WS, "openai_api_key", &openai_key())
            .await;
    }

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n")
            .expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::clone(&store) as Arc<dyn intutic_proxy::store::LocalStore>,
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

    // Runtime-assembled virtual key, per the repo's fixture rule.
    let vk = concat!(
        "Bearer vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_deepseek_routing"
    );

    // (marker, route, model, stream, client auth, expected text, refused call id)
    type Case<'a> = (
        &'a str,
        &'a str,
        &'a str,
        bool,
        (&'a str, String),
        &'a str,
        Option<&'a str>,
    );
    let cases: Vec<Case> = vec![
        (
            "ds-chat-plain",
            "/v1/chat/completions",
            "deepseek-chat",
            false,
            ("authorization", vk.to_string()),
            "served by deepseek chat",
            None,
        ),
        (
            "ds-chat-deny",
            "/v1/chat/completions",
            "deepseek-chat",
            true,
            ("authorization", vk.to_string()),
            "Cleaning up.",
            Some("call_dschatdeny"),
        ),
        (
            "ds-anth-plain",
            "/v1/messages",
            "deepseek-flash",
            true,
            ("authorization", vk.to_string()),
            "served by deepseek anthropic",
            None,
        ),
        (
            "ds-anth-deny",
            "/v1/messages",
            "deepseek-flash",
            true,
            ("authorization", vk.to_string()),
            "Cleaning up.",
            Some("toolu_dsanthdeny"),
        ),
        // What dsh itself sends: its own DeepSeek key in `x-api-key`, no
        // virtual key, no workspace header — passed through untouched.
        (
            "ds-anth-passthrough",
            "/v1/messages",
            "deepseek-flash",
            true,
            ("x-api-key", dsh_raw_key()),
            "served by deepseek passthrough",
            None,
        ),
        // dsh with an Intutic virtual key as its `DEEPSEEK_API_KEY`: the key
        // arrives in `x-api-key` with no workspace header, and the workspace's
        // provisioned DeepSeek key replaces it upstream.
        (
            "ds-anth-vk-xkey",
            "/v1/messages",
            "deepseek-flash",
            true,
            ("x-api-key", vk.trim_start_matches("Bearer ").to_string()),
            "served by deepseek for a virtual key",
            None,
        ),
        (
            "oa-control",
            "/v1/chat/completions",
            "gpt-4o",
            false,
            ("authorization", vk.to_string()),
            "served by openai",
            None,
        ),
        // An Ollama-style tag: a local model behind an OpenAI-compatible
        // `OPENAI_UPSTREAM_URL`, not DeepSeek's hosted API.
        (
            "oa-ollama-tag",
            "/v1/chat/completions",
            "deepseek-r1:7b",
            false,
            ("authorization", vk.to_string()),
            "served by openai-compatible",
            None,
        ),
    ];
    let mut cases = cases;
    for (marker, model) in [
        ("oa-untagged-r1", "deepseek-r1"),
        ("oa-untagged-coder", "deepseek-coder-v2-instruct"),
        ("oa-untagged-distill", "deepseek-r1-distill-llama-70b"),
    ] {
        cases.push((
            marker,
            "/v1/chat/completions",
            model,
            false,
            ("authorization", vk.to_string()),
            "served by openai-compatible",
            None,
        ));
    }

    let mut failures = Vec::new();
    for (marker, route, model, stream, auth, expected, refused) in &cases {
        let prompt = format!("{marker}: tidy up");
        let body = if *route == "/v1/messages" {
            json!({"model": model, "max_tokens": 64, "stream": stream,
                   "messages": [{"role": "user", "content": prompt}]})
        } else {
            json!({"model": model, "stream": stream,
                   "messages": [{"role": "user", "content": prompt}]})
        };
        let mut req = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header(auth.0, auth.1.as_str())
            .header("x-session-id", format!("ses_{marker}"));
        if auth.1.starts_with("Bearer vk_") {
            req = req.header("x-workspace-id", WS);
        }
        let res = req.json(&body).send().await.expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.expect("body reads");
        if !status.is_success() {
            failures.push(format!("{marker}: proxy returned {status}: {text}"));
            continue;
        }
        if !text.contains(expected) {
            failures.push(format!("{marker}: expected {expected:?} in\n{text}"));
        }
        if let Some(call_id) = refused {
            if !text.contains("[Intutic] Blocked tool call") {
                failures.push(format!("{marker}: no refusal in the stream\n{text}"));
            }
            if text.contains(call_id) {
                failures.push(format!(
                    "{marker}: the refused call reached the client\n{text}"
                ));
            }
        }
    }

    // A client-chosen path must not pick DeepSeek's Anthropic endpoint while
    // the proxy reads the exchange as some other wire: the upstream path comes
    // from the protocol, and DeepSeek takes Messages or Chat Completions only.
    for (marker, route) in [
        ("ds-path-anthropic", "/anthropic/v1/messages"),
        ("ds-path-responses", "/v1/responses"),
    ] {
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header("authorization", vk)
            .header("x-workspace-id", WS)
            .json(&json!({"model": "deepseek-flash", "max_tokens": 16,
                          "messages": [{"role": "user", "content": format!("{marker}: hi")}],
                          "input": format!("{marker}: hi")}))
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if status.as_u16() != 400 || !text.contains("unsupported_route") {
            failures.push(format!(
                "{marker}: expected 400 unsupported_route, got {status}: {text}"
            ));
        }
    }
    for r in deepseek.received_requests().await.unwrap_or_default() {
        let b = String::from_utf8_lossy(&r.body);
        if b.contains("ds-path-") {
            failures.push(format!(
                "a client-chosen path reached DeepSeek at {}: {b}",
                r.url.path()
            ));
        }
    }

    // Nothing DeepSeek-bound leaked to the OpenAI upstream, and vice versa.
    for r in openai.received_requests().await.unwrap_or_default() {
        let b = String::from_utf8_lossy(&r.body);
        if b.contains("ds-") {
            failures.push(format!("OpenAI upstream received a DeepSeek request: {b}"));
        }
    }
    for r in deepseek.received_requests().await.unwrap_or_default() {
        let b = String::from_utf8_lossy(&r.body);
        if b.contains("oa-") {
            failures.push(format!("DeepSeek upstream received an OpenAI request: {b}"));
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
    deepseek.verify().await;
    openai.verify().await;
}
