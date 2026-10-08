//! End-to-end: the destructive-SQL guard (TD-480) withholds a model-emitted
//! shell call before the client sees it — on a stream and off one.
//!
//! The unit tests in `plugins::sql_guard` pin detection and the hold's state
//! machine; this pins the wiring: a SOP on disk declaring `sql_guard:`, a real
//! request through the real router, a wiremock upstream serving the tool call.
//! The streaming case is the one that matters — the hold re-enters released
//! lines into the proxy's line loop, and a mistake there either leaks the call
//! or drops an allowed one.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL, control-plane URL and SOP directory are process-global env.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\nsql_guard: refuse\nsql_allow_dsns: postgres://localhost/*\n---\nDestructive SQL only against local databases.\n";

/// An OpenAI-shaped stream carrying one `shell` call, its arguments split
/// across two deltas so no single line holds the whole command.
fn tool_call_stream(cmd: &str) -> String {
    let args = serde_json::json!({ "command": cmd }).to_string();
    let (a, b) = args.split_at(args.len() / 2);
    let chunk = |delta: serde_json::Value, finish: serde_json::Value| {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl-sqlguard",
                "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
            })
        )
    };
    let mut body = String::new();
    body.push_str(&chunk(
        serde_json::json!({"role": "assistant", "content": "Cleaning up."}),
        serde_json::Value::Null,
    ));
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "id": "call_sqlguard", "type": "function",
            "function": {"name": "shell", "arguments": ""}}]}),
        serde_json::Value::Null,
    ));
    for part in [a, b] {
        body.push_str(&chunk(
            serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
            serde_json::Value::Null,
        ));
    }
    body.push_str(&chunk(
        serde_json::json!({}),
        serde_json::json!("tool_calls"),
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

fn tool_call_body(cmd: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-sqlguard",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_sqlguard",
                    "type": "function",
                    "function": {
                        "name": "shell",
                        "arguments": serde_json::json!({ "command": cmd }).to_string()
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

#[tokio::test]
async fn destructive_sql_against_a_non_allowlisted_database_never_reaches_the_client() {
    const PROD: &str = "psql -h db.prod.internal -d app -c 'DROP TABLE users'";
    const LOCAL: &str = "psql -h localhost -d app_dev -c 'DROP TABLE users'";

    let upstream = MockServer::start().await;
    for (marker, cmd) in [("case-stream-prod", PROD), ("case-stream-local", LOCAL)] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(marker))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(tool_call_stream(cmd), "text/event-stream"),
            )
            .mount(&upstream)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-prod"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body(PROD)))
        .mount(&upstream)
        .await;

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
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;

    let sops_dir = std::env::temp_dir().join(format!("intutic-sqlguard-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("databases.md"), SOP).unwrap();

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream (TD-370): the request
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

    let send = |marker: &'static str, stream: bool| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let res = reqwest::Client::new()
                .post(url)
                // Runtime-assembled virtual key, per the repo's fixture rule.
                .header(
                    "Authorization",
                    concat!("Bearer vk_", "0123456789abcdef0123456789abcdef", "_ws_sqlguard"),
                )
                .header("x-workspace-id", "ws_sqlguard")
                .header("x-session-id", format!("ses_{marker}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "stream": stream,
                    "messages": [{"role": "user", "content": format!("{marker}: clean up the users table")}]
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let body = res.text().await.expect("body drains");
            assert!(
                status.is_success(),
                "{marker}: proxy returned {status}: {body}"
            );
            body
        }
    };

    // Streaming, production target: the call is withheld whole and the
    // refusal arrives in band, naming the target without credentials.
    let body = send("case-stream-prod", true).await;
    assert!(
        !body.contains("call_sqlguard"),
        "the refused tool call reached the client:\n{body}"
    );
    assert!(body.contains("[Intutic] Blocked tool call"), "{body}");
    assert!(body.contains("postgres://db.prod.internal/app"), "{body}");

    // Streaming, allowlisted target: released in order, nothing refused.
    let body = send("case-stream-local", true).await;
    assert!(
        body.contains("call_sqlguard"),
        "an allowed call was dropped:\n{body}"
    );
    assert!(!body.contains("Blocked tool call"), "{body}");
    let mut args = String::new();
    for line in body.lines() {
        let Some(d) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(d) else {
            continue;
        };
        if let Some(a) = v["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].as_str()
        {
            args.push_str(a);
        }
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&args).expect("released arguments reassemble");
    assert_eq!(parsed["command"], LOCAL);

    // Non-streaming, production target: the whole body is replaced.
    let body = send("case-json-prod", false).await;
    assert!(!body.contains("call_sqlguard"), "{body}");
    assert!(body.contains("[Intutic] Blocked tool call"), "{body}");

    let _ = std::fs::remove_dir_all(&sops_dir);
}
