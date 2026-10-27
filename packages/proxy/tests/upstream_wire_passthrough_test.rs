//! End-to-end: behind a shared gateway (`UPSTREAM_URL`, no provider-specific
//! upstream), `INTUTIC_UPSTREAM_WIRE=passthrough` forwards every request in
//! the wire it arrived in, model name untouched, and governance still applies.
//!
//! ## What is pinned
//!
//! With passthrough, at the gateway, in the caller's wire:
//!
//! * `/v1/messages` naming `qwen3-coder` (was 400 `unsupported_route`);
//! * `/v1/chat/completions` naming `claude-sonnet-4-5` (was translated to
//!   Messages and back);
//! * `/v1/responses` naming `claude-sonnet-4-5`, its `instructions` and
//!   `input` intact (was translated to Messages);
//! * `/v1/chat/completions` naming `gemini-2.5-flash` (was sent to the Gemini
//!   API and refused 402 `no_upstream_credential`);
//! * `/v1/chat/completions` naming `vertex/claude-opus-4-1`, a gateway route
//!   name (was sent to Vertex AI directly);
//! * `/v1/responses` naming `deepseek-chat` (DeepSeek has no Responses
//!   endpoint, so this was refused 400).
//!
//! A raw caller credential is passed through on each wire's own header; a
//! virtual key is replaced with the key for the wire's provider and never
//! forwarded; the SOPs are injected; DLP redacts the request; and a denied
//! tool call in the answer is refused.
//!
//! Without the setting, the same gateway keeps the model-name routing: the
//! first and fourth rows are refused as before.
//!
//! ONE `#[tokio::test]`: the upstream URLs, the mode and the SOP directory
//! are process-global env.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\n---\nNo deletes.\n";
const WS: &str = "ws_upstream_wire";

// Runtime-assembled, per the repo's fixture rule.
fn gateway_key() -> String {
    ["sk-", "gateway-caller-", "test"].concat()
}
fn workspace_anthropic_key() -> String {
    ["an", "-provisioned-", "test"].concat()
}
fn aws_key() -> String {
    ["AKIA", "IOSFODNN7EXAMPLE"].concat()
}
fn vk() -> String {
    [
        "vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_upstream_wire",
    ]
    .concat()
}

fn messages_answer(model: &str, text: &str) -> Value {
    json!({
        "id": "msg_gw", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 5, "output_tokens": 3}
    })
}
fn chat_answer(model: &str, text: &str) -> Value {
    json!({
        "id": "chatcmpl-gw", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    })
}
fn chat_tool_answer(model: &str, tool: &str) -> Value {
    json!({
        "id": "chatcmpl-gw", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": null,
            "tool_calls": [{"id": "call_denied", "type": "function",
                            "function": {"name": tool, "arguments": "{\"path\":\"/\"}"}}]}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    })
}
fn responses_answer(model: &str, text: &str) -> Value {
    json!({
        "id": "resp_gw", "object": "response", "status": "completed", "model": model,
        "output": [{"type": "message", "id": "msg_gw", "status": "completed", "role": "assistant",
                    "content": [{"type": "output_text", "text": text, "annotations": []}]}],
        "usage": {"input_tokens": 5, "output_tokens": 3, "total_tokens": 8}
    })
}

/// A request body for `route` naming `model`, carrying `marker`.
fn body(route: &str, model: &str, marker: &str) -> Value {
    match route {
        "/v1/messages" => json!({"model": model, "max_tokens": 64,
            "messages": [{"role": "user", "content": format!("{marker}: hi")}]}),
        "/v1/responses" => json!({"model": model,
            "instructions": "You are Codex.",
            "input": [{"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": format!("{marker}: hi")}]}]}),
        _ => json!({"model": model,
            "messages": [{"role": "user", "content": format!("{marker}: hi")}]}),
    }
}

/// (marker, route, model, the caller's own credential header, the gateway's
/// answer, the text the client reads)
type Row<'a> = (
    &'a str,
    &'a str,
    &'a str,
    (&'a str, String),
    ResponseTemplate,
    &'a str,
);

#[tokio::test]
async fn passthrough_forwards_every_wire_natively_to_the_shared_gateway() {
    let gateway = MockServer::start().await;

    let sops_dir =
        std::env::temp_dir().join(format!("intutic-upstream-wire-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("UPSTREAM_URL", gateway.uri());
    for name in [
        "ANTHROPIC_UPSTREAM_URL",
        "OPENAI_UPSTREAM_URL",
        "GEMINI_UPSTREAM_URL",
        "MISTRAL_UPSTREAM_URL",
        "OPENROUTER_UPSTREAM_URL",
        "DEEPSEEK_UPSTREAM_URL",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CONTROL_PLANE_URL",
        "INTUTIC_WORKSPACE_ID",
    ] {
        std::env::remove_var(name);
    }
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    std::env::set_var("INTUTIC_UPSTREAM_WIRE", "passthrough");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    {
        use intutic_proxy::store::LocalStore as _;
        store
            .set_workspace_credential(WS, "anthropic_api_key", &workspace_anthropic_key())
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

    let bearer = ("authorization", format!("Bearer {}", gateway_key()));
    let x_api_key = ("x-api-key", gateway_key());
    let rows: Vec<Row> = vec![
        (
            "qwen-messages",
            "/v1/messages",
            "qwen3-coder",
            x_api_key.clone(),
            ResponseTemplate::new(200).set_body_json(messages_answer("qwen3-coder", "qwen here")),
            "qwen here",
        ),
        (
            "claude-chat",
            "/v1/chat/completions",
            "claude-sonnet-4-5",
            bearer.clone(),
            ResponseTemplate::new(200)
                .set_body_json(chat_answer("claude-sonnet-4-5", "claude on chat")),
            "claude on chat",
        ),
        (
            "claude-responses",
            "/v1/responses",
            "claude-sonnet-4-5",
            bearer.clone(),
            ResponseTemplate::new(200)
                .set_body_json(responses_answer("claude-sonnet-4-5", "claude on responses")),
            "claude on responses",
        ),
        (
            "gemini-chat",
            "/v1/chat/completions",
            "gemini-2.5-flash",
            bearer.clone(),
            ResponseTemplate::new(200)
                .set_body_json(chat_answer("gemini-2.5-flash", "gemini on chat")),
            "gemini on chat",
        ),
        (
            "vertex-chat",
            "/v1/chat/completions",
            "vertex/claude-opus-4-1",
            bearer.clone(),
            ResponseTemplate::new(200).set_body_json(chat_answer(
                "vertex/claude-opus-4-1",
                "vertex route on chat",
            )),
            "vertex route on chat",
        ),
        (
            "deepseek-responses",
            "/v1/responses",
            "deepseek-chat",
            bearer.clone(),
            ResponseTemplate::new(200)
                .set_body_json(responses_answer("deepseek-chat", "deepseek on responses")),
            "deepseek on responses",
        ),
    ];

    let mut failures = Vec::new();
    for (marker, route, model, auth, answer, expected) in rows {
        Mock::given(method("POST"))
            .and(path(route))
            .and(header(auth.0, auth.1.as_str()))
            .and(body_string_contains(marker))
            .respond_with(answer)
            .expect(1)
            .named(marker)
            .mount(&gateway)
            .await;
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header(auth.0, auth.1.as_str())
            .json(&body(route, model, marker))
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() || !text.contains(expected) {
            failures.push(format!("{marker}: {status}: {text}"));
        }
    }

    // Each reached the gateway in its own wire, with its model, and nothing
    // translated: a Responses body keeps `instructions` and `input`, and the
    // SOPs are injected in the wire's own way.
    let received = gateway.received_requests().await.unwrap_or_default();
    let sent = |marker: &str| -> Value {
        received
            .iter()
            .find(|r| String::from_utf8_lossy(&r.body).contains(marker))
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .unwrap_or(Value::Null)
    };
    for (marker, model) in [
        ("qwen-messages", "qwen3-coder"),
        ("claude-chat", "claude-sonnet-4-5"),
        ("claude-responses", "claude-sonnet-4-5"),
        ("gemini-chat", "gemini-2.5-flash"),
        ("vertex-chat", "vertex/claude-opus-4-1"),
        ("deepseek-responses", "deepseek-chat"),
    ] {
        let b = sent(marker);
        if b["model"] != model {
            failures.push(format!("{marker}: sent as {b}"));
        }
        if !b.to_string().contains("No deletes.") {
            failures.push(format!("{marker}: no SOPs in {b}"));
        }
    }
    let responses = sent("claude-responses");
    if responses.get("input").is_none()
        || !responses["instructions"]
            .as_str()
            .is_some_and(|s| s.contains("You are Codex."))
        || responses.get("messages").is_some()
    {
        failures.push(format!("claude-responses: translated: {responses}"));
    }
    if sent("claude-chat").get("max_tokens").is_some() {
        failures.push("claude-chat: translated to Messages".into());
    }

    // A virtual key is replaced by the key for the wire's provider (here the
    // workspace's Anthropic key on /v1/messages) and never forwarded.
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", workspace_anthropic_key().as_str()))
        .and(body_string_contains("vk-messages"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(messages_answer("qwen3-coder", "vk served")),
        )
        .expect(1)
        .named("vk-messages")
        .mount(&gateway)
        .await;
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/messages"))
        .header("authorization", format!("Bearer {}", vk()))
        .header("x-workspace-id", WS)
        .json(&body("/v1/messages", "qwen3-coder", "vk-messages"))
        .send()
        .await
        .expect("proxy reachable");
    let text = res.text().await.unwrap_or_default();
    if !text.contains("vk served") {
        failures.push(format!("vk-messages: {text}"));
    }

    // DLP still redacts what is forwarded, and the response gate still
    // refuses a denied tool call.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("dlp-and-gate"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(chat_tool_answer("claude-sonnet-4-5", "delete_everything")),
        )
        .expect(1)
        .named("dlp-and-gate")
        .mount(&gateway)
        .await;
    let mut leaky = body("/v1/chat/completions", "claude-sonnet-4-5", "dlp-and-gate");
    leaky["messages"][0]["content"] = json!(format!("dlp-and-gate: my key is {}", aws_key()));
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header(bearer.0, bearer.1.as_str())
        .json(&leaky)
        .send()
        .await
        .expect("proxy reachable");
    let text = res.text().await.unwrap_or_default();
    if !text.contains("[Intutic] Blocked tool call") || text.contains("call_denied") {
        failures.push(format!("dlp-and-gate: denied call not refused: {text}"));
    }

    // Without the setting the same gateway keeps the model-name routing.
    std::env::remove_var("INTUTIC_UPSTREAM_WIRE");
    for (marker, route, model, status, code) in [
        (
            "default-qwen",
            "/v1/messages",
            "qwen3-coder",
            400,
            "unsupported_route",
        ),
        (
            "default-gemini",
            "/v1/chat/completions",
            "gemini-2.5-flash",
            402,
            "no_upstream_credential",
        ),
    ] {
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header(bearer.0, bearer.1.as_str())
            .header("x-api-key", gateway_key())
            .json(&body(route, model, marker))
            .send()
            .await
            .expect("proxy reachable");
        let got = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if got != status || !text.contains(code) {
            failures.push(format!(
                "{marker}: expected {status} {code}, got {got}: {text}"
            ));
        }
    }

    let received = gateway.received_requests().await.unwrap_or_default();
    for r in &received {
        let b = String::from_utf8_lossy(&r.body);
        if b.contains(&aws_key()) {
            failures.push(format!("the AWS key reached the gateway: {b}"));
        }
        if b.contains("default-") {
            failures.push(format!("a default-mode refusal reached the gateway: {b}"));
        }
        for (name, value) in r.headers.iter() {
            if value.to_str().unwrap_or("").contains("vk_") {
                failures.push(format!("the virtual key was forwarded in {name}"));
            }
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
