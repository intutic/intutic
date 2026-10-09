//! End-to-end: the response gate applies the workspace's SSO group policy to
//! the tool calls in a model response, for the member behind the virtual key.
//!
//! The unit tests in `sso_groups` and `plugins::response_gate` pin the
//! evaluator and the per-line decision; this pins the wiring: the per-key
//! `/auth/key-context` fetch, the streaming and non-streaming gates, and the
//! policy fail mode when that fetch fails.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and control-plane URL are process-global env.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// An OpenAI-shaped stream: some text, then one `shell` call.
fn tool_call_stream() -> String {
    let chunk = |delta: serde_json::Value, finish: serde_json::Value| {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl-ssogroup",
                "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
            })
        )
    };
    let mut body = String::new();
    body.push_str(&chunk(
        serde_json::json!({"role": "assistant", "content": "Listing files."}),
        serde_json::Value::Null,
    ));
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "id": "call_ssogroup", "type": "function",
            "function": {"name": "shell", "arguments": ""}}]}),
        serde_json::Value::Null,
    ));
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"command\":\"ls\"}"}}]}),
        serde_json::Value::Null,
    ));
    body.push_str(&chunk(
        serde_json::json!({}),
        serde_json::json!("tool_calls"),
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

fn tool_call_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-ssogroup",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_ssogroup",
                    "type": "function",
                    "function": { "name": "shell", "arguments": "{\"command\":\"ls\"}" }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

// Runtime-assembled virtual keys, per the repo's fixture rule: one per member.
const UNCLEARED: &str = concat!("vk_", "0123456789abcdef0123456789abcde1", "_ws_ssogroup");
const CLEARED: &str = concat!("vk_", "0123456789abcdef0123456789abcde2", "_ws_ssogroup");
const UNREACHABLE: &str = concat!("vk_", "0123456789abcdef0123456789abcde3", "_ws_ssogroup");

#[tokio::test]
async fn a_member_outside_the_required_groups_never_receives_the_tool_call() {
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
        .and(body_string_contains("case-json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body()))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;
    let policy =
        serde_json::json!({ "highRiskTools": ["shell"], "requiredGroups": ["sre-oncall"] });
    for (key, groups) in [(UNCLEARED, ["eng"]), (CLEARED, ["sre-oncall"])] {
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": "ws_ssogroup",
                "ssoGroups": { "policy": policy, "memberGroups": groups }
            })))
            .mount(&cp)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .and(header(
            "authorization",
            format!("Bearer {UNREACHABLE}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(503))
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the request needs a
    // provider key, so the operator fallback supplies a test one.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

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

    let send = |key: &'static str, marker: &'static str, stream: bool| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let res = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("x-workspace-id", "ws_ssogroup")
                .header("x-session-id", format!("ses_{marker}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "stream": stream,
                    "messages": [{"role": "user", "content": format!("{marker}: list the files")}]
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let named = |h: &str| {
                res.headers()
                    .get(h)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            let refusal = (named("x-intutic-refusal"), named("x-intutic-refusal-rule"));
            (status, res.text().await.expect("body drains"), refusal)
        }
    };

    // Streaming, member outside the required groups: the call is withheld
    // and the refusal names the rule, after the text that preceded it.
    // The stream names the refusal to an SDK in a comment line, since its
    // headers went out before the call was seen.
    let (status, body, _) = send(UNCLEARED, "case-stream", true).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        !body.contains("call_ssogroup"),
        "the refused tool call reached the client:\n{body}"
    );
    assert!(body.contains("Listing files."), "{body}");
    assert!(body.contains("[sso_group.high_risk.shell]"), "{body}");
    assert!(
        body.contains(r#": intutic-refusal {"code":"SSO_GROUP","#)
            && body.contains(r#""rule":"sso_group.high_risk.shell""#),
        "the stream does not name the refusal:\n{body}"
    );

    // Non-streaming, same member: the whole body is replaced, and the
    // headers name the refusal.
    let (status, body, refusal) = send(UNCLEARED, "case-json", false).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(!body.contains("call_ssogroup"), "{body}");
    assert!(body.contains("[sso_group.high_risk.shell]"), "{body}");
    assert_eq!(
        refusal,
        (
            Some("SSO_GROUP".to_string()),
            Some("sso_group.high_risk.shell".to_string())
        )
    );

    // A member in a required group gets the call, on both paths, unnamed.
    let (_, body, _) = send(CLEARED, "case-stream", true).await;
    assert!(
        body.contains("call_ssogroup"),
        "a cleared call was dropped:\n{body}"
    );
    assert!(!body.contains("Blocked tool call"), "{body}");
    assert!(!body.contains("intutic-refusal"), "{body}");
    let (_, body, refusal) = send(CLEARED, "case-json", false).await;
    assert!(body.contains("call_ssogroup"), "{body}");
    assert_eq!(refusal, (None, None));

    // The policy cannot be fetched: fail-closed, the default, refuses the
    // request before it reaches the model, as an unreachable policy check does.
    let before = upstream.received_requests().await.expect("recording").len();
    let (status, body, _) = send(UNREACHABLE, "case-json", false).await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{body}");
    assert!(body.contains("policy_denied"), "{body}");
    assert_eq!(
        upstream.received_requests().await.expect("recording").len(),
        before,
        "a refused request still reached the model"
    );

    // One key-context call per key for the whole run: the answer is cached.
    let fetches = cp
        .received_requests()
        .await
        .expect("recording")
        .into_iter()
        .filter(|r| r.url.path() == "/api/v1/auth/key-context")
        .count();
    assert_eq!(fetches, 3, "expected one fetch per key");
}
