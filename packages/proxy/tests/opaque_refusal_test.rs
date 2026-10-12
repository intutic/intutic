//! End-to-end: a workspace whose intervention mode is OPAQUE refuses its
//! agents without naming the rule.
//!
//! The mode reaches the proxy on `/auth/key-context` (`interventionMode`).
//! Two refusal paths are driven through the real router: a custom WASM rule's
//! request-side `403 policy_denied`, and the response gate's in-band SSO group
//! refusal on both the non-streaming and the streaming path. Under OPAQUE the
//! agent reads `refusal::OPAQUE_MESSAGE` with the same status, error type and
//! refusal code, and no rule id; a TRANSPARENT workspace's agent still reads
//! the rule.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and control-plane URL are process-global env.

use std::sync::Arc;

use intutic_proxy::refusal::OPAQUE_MESSAGE;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Refuses every request, giving its reason through the optional
/// `reason_ptr` / `reason_len` exports.
const KILL: &str = r#"(module
     (memory (export "memory") 1)
     (data (i32.const 60000) "no deploys during the freeze")
     (func (export "allocate") (param i32) (result i32) i32.const 8)
     (func (export "evaluate") (param i32 i32) (result i32) i32.const 1)
     (func (export "reason_ptr") (result i32) i32.const 60000)
     (func (export "reason_len") (result i32) i32.const 28))"#;
const RULE_REASON: &str = "no deploys during the freeze";

fn tool_call_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-opaque",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_opaque",
                    "type": "function",
                    "function": { "name": "shell", "arguments": "{\"command\":\"ls\"}" }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

/// An OpenAI-shaped stream ending in one `shell` call.
fn tool_call_stream() -> String {
    let chunk = |delta: serde_json::Value, finish: serde_json::Value| {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl-opaque",
                "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
            })
        )
    };
    let mut body = chunk(
        serde_json::json!({"role": "assistant", "content": "Listing files."}),
        serde_json::Value::Null,
    );
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "id": "call_opaque", "type": "function",
            "function": {"name": "shell", "arguments": "{\"command\":\"ls\"}"}}]}),
        serde_json::Value::Null,
    ));
    body.push_str(&chunk(
        serde_json::json!({}),
        serde_json::json!("tool_calls"),
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

// Runtime-assembled virtual keys, per the repo's fixture rule.
const OPAQUE: &str = concat!("vk_", "0123456789abcdef0123456789abcd01", "_ws_opaque");
const CLEAR: &str = concat!("vk_", "0123456789abcdef0123456789abcd02", "_ws_opaque");
const SSO_RULE: &str = "sso_group.high_risk.shell";

async fn serve(state: intutic_proxy::proxy::AppState) -> std::net::SocketAddr {
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    addr
}

async fn state(rules_dir: Option<&str>) -> intutic_proxy::proxy::AppState {
    intutic_proxy::proxy::AppState {
        config: serde_yaml::from_str("model_list: []\nintutic_settings: {}\n")
            .expect("minimal config parses"),
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(rules_dir)
            .await
            .expect("registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
        context_snapshot_rate: 0.0,
    }
}

struct Answer {
    status: reqwest::StatusCode,
    body: String,
    code: Option<String>,
    rule: Option<String>,
}

async fn send(addr: std::net::SocketAddr, key: &str, marker: &str, stream: bool) -> Answer {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .header("x-workspace-id", "ws_opaque")
        .header("x-session-id", format!("ses_{marker}"))
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": stream,
            "messages": [{"role": "user", "content": format!("{marker}: list the files")}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let named = |h: &str| {
        res.headers()
            .get(h)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let (code, rule) = (named("x-intutic-refusal"), named("x-intutic-refusal-rule"));
    Answer {
        status: res.status(),
        body: res.text().await.expect("body drains"),
        code,
        rule,
    }
}

#[tokio::test]
async fn an_opaque_workspace_refuses_without_naming_the_rule() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-stream"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(tool_call_stream(), "text/event-stream"),
        )
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body()))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })),
        )
        .mount(&cp)
        .await;
    let policy =
        serde_json::json!({ "highRiskTools": ["shell"], "requiredGroups": ["sre-oncall"] });
    for (key, mode) in [(OPAQUE, "OPAQUE"), (CLEAR, "TRANSPARENT")] {
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": "ws_opaque",
                "ssoGroups": { "policy": policy, "memberGroups": ["eng"] },
                "interventionMode": mode
            })))
            .mount(&cp)
            .await;
    }

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-opaque-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("10_freeze.wasm"), wat::parse_str(KILL).unwrap()).unwrap();
    let with_rule = serve(state(dir.to_str()).await).await;
    let without_rule = serve(state(None).await).await;

    // ── A custom WASM rule refuses the request ────────────────────────
    let clear = send(with_rule, CLEAR, "case-wasm", false).await;
    assert_eq!(
        clear.status,
        reqwest::StatusCode::FORBIDDEN,
        "{}",
        clear.body
    );
    let clear: serde_json::Value = serde_json::from_str(&clear.body).expect("JSON error");
    assert_eq!(clear["error"]["type"], "policy_denied");
    assert!(
        clear["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(RULE_REASON),
        "{clear}"
    );

    let opaque = send(with_rule, OPAQUE, "case-wasm", false).await;
    assert_eq!(
        opaque.status,
        reqwest::StatusCode::FORBIDDEN,
        "{}",
        opaque.body
    );
    let opaque: serde_json::Value = serde_json::from_str(&opaque.body).expect("JSON error");
    assert_eq!(opaque["error"]["type"], "policy_denied");
    assert_eq!(opaque["error"]["message"], OPAQUE_MESSAGE, "{opaque}");

    // ── The response gate refuses a tool call in band ─────────────────
    let clear = send(without_rule, CLEAR, "case-json", false).await;
    assert!(clear.status.is_success(), "{}", clear.body);
    assert!(clear.body.contains(SSO_RULE), "{}", clear.body);
    assert_eq!(
        (clear.code.as_deref(), clear.rule.as_deref()),
        (Some("SSO_GROUP"), Some(SSO_RULE))
    );

    let opaque = send(without_rule, OPAQUE, "case-json", false).await;
    assert!(opaque.status.is_success(), "{}", opaque.body);
    assert!(!opaque.body.contains("call_opaque"), "{}", opaque.body);
    assert!(!opaque.body.contains(SSO_RULE), "{}", opaque.body);
    assert!(opaque.body.contains(OPAQUE_MESSAGE), "{}", opaque.body);
    assert_eq!(
        (opaque.code.as_deref(), opaque.rule.as_deref()),
        (Some("SSO_GROUP"), None)
    );

    let opaque = send(without_rule, OPAQUE, "case-stream", true).await;
    assert!(opaque.status.is_success(), "{}", opaque.body);
    assert!(!opaque.body.contains("call_opaque"), "{}", opaque.body);
    assert!(!opaque.body.contains(SSO_RULE), "{}", opaque.body);
    assert!(opaque.body.contains(OPAQUE_MESSAGE), "{}", opaque.body);
    assert!(
        opaque
            .body
            .contains(r#": intutic-refusal {"code":"SSO_GROUP","#)
            && opaque.body.contains(r#""rule":"""#),
        "the stream does not name the refusal:\n{}",
        opaque.body
    );

    let _ = std::fs::remove_dir_all(&dir);
}
