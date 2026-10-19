//! End-to-end (§13 items 2 and 5): a qualified
//! prerequisite and an enforced path scope, through the real router to a
//! wiremock upstream.
//!
//! `requires_before: action:run_tests[ok] -> action:deploy` — a failing
//! `pytest` then `git push` is withheld `PREREQUISITE_UNMET` before the call
//! runs, on the non-streaming and the streaming path, and a passing run lets
//! it through. A pass made stale by a write, and a session that never ran the
//! tests, are refused with their own reasons. A deploy the harness ran anyway
//! is refused on the request that reports it, with `error.scope`.
//! `scope_paths_mode: enforce` withholds a write outside `scope_paths:` as
//! `OUT_OF_SCOPE`.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL, control-plane URL and SOP directory are process-global env.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PUSH: &str = "git push origin main";

fn chunk(delta: serde_json::Value, finish: serde_json::Value) -> String {
    format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-prereq",
            "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
        })
    )
}

/// An OpenAI stream ending in one call whose arguments arrive in two deltas.
fn tool_call_stream(tool: &str, input: serde_json::Value) -> String {
    let args = input.to_string();
    let (a, b) = args.split_at(args.len() / 2);
    let mut body = chunk(
        serde_json::json!({"role": "assistant", "content": "Shipping."}),
        serde_json::Value::Null,
    );
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "id": "call_gated", "type": "function",
            "function": {"name": tool, "arguments": ""}}]}),
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

fn tool_call_body(tool: &str, input: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-prereq",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_gated",
                    "type": "function",
                    "function": { "name": tool, "arguments": input.to_string() }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

/// A turn that ran `pytest` and reported `summary`.
fn test_run(summary: &str) -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_tests", "type": "function",
            "function": {"name": "Bash", "arguments": serde_json::json!({"command": "pytest -q"}).to_string()}}]}),
        serde_json::json!({"role": "tool", "tool_call_id": "call_tests", "name": "Bash", "content": summary}),
    ]
}

#[tokio::test]
async fn a_failing_run_withholds_the_deploy_and_a_passing_one_lets_it_through() {
    let upstream = MockServer::start().await;
    for marker in [
        "case-json-failed",
        "case-json-passed",
        "case-json-none",
        "case-json-stale",
    ] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(marker))
            .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body(
                "Bash",
                serde_json::json!({ "command": PUSH }),
            )))
            .mount(&upstream)
            .await;
    }
    for marker in ["case-stream-failed", "case-stream-passed"] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(marker))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(
                        tool_call_stream("Bash", serde_json::json!({ "command": PUSH })),
                        "text/event-stream",
                    ),
            )
            .mount(&upstream)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-scope"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body(
            "Write",
            serde_json::json!({ "file_path": "infra/main.tf", "content": "x" }),
        )))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-prereq", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        })))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_prereq",
            "role": "DEVELOPER",
            "interventionMode": "TRANSPARENT"
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

    let sops_dir = std::env::temp_dir().join(format!("intutic-prereq-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(
        sops_dir.join("ship.md"),
        "---\nrequires_before: action:run_tests[ok] -> action:deploy\nscope_paths: src\nscope_paths_mode: enforce\n---\nShip only tested code, and change only src/.\n",
    )
    .unwrap();

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
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

    let send = |marker: &'static str, stream: bool, history: Vec<serde_json::Value>| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let mut messages =
                vec![serde_json::json!({"role": "user", "content": format!("{marker}: ship it")})];
            messages.extend(history);
            let res = reqwest::Client::new()
                .post(url)
                // Runtime-assembled virtual key, per the repo's fixture rule.
                .header(
                    "Authorization",
                    concat!(
                        "Bearer vk_",
                        "0123456789abcdef0123456789abcdef",
                        "_ws_prereq"
                    ),
                )
                .header("x-workspace-id", "ws_prereq")
                .header("x-session-id", format!("ses_{marker}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "stream": stream,
                    "messages": messages
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let header = |name: &str| {
                res.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            let (code, rule) = (
                header(intutic_proxy::refusal::HEADER),
                header(intutic_proxy::refusal::RULE_HEADER),
            );
            let body = res.text().await.expect("body drains");
            (status, code, rule, body)
        }
    };
    const RULE: &str = "requires_before.action:run_tests[ok]->action:deploy";

    // Non-streaming, a failed run: the push never reaches the client.
    let (status, code, rule, body) = send(
        "case-json-failed",
        false,
        test_run("===== 1 failed, 2 passed in 0.50s ====="),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        !body.contains("call_gated"),
        "the gated call reached the client:\n{body}"
    );
    assert_eq!(code.as_deref(), Some("PREREQUISITE_UNMET"), "{body}");
    assert_eq!(rule.as_deref(), Some(RULE));
    assert!(
        body.contains("the last action:run_tests failed (summary_failed)"),
        "{body}"
    );

    // Non-streaming, a passing run: the push goes through untouched.
    let (status, code, _, body) = send(
        "case-json-passed",
        false,
        test_run("===== 3 passed in 0.50s ====="),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        body.contains("call_gated"),
        "a passing run did not let the push through:\n{body}"
    );
    assert_eq!(code, None, "{body}");

    // No run in the session, and a pass made stale by a later write.
    let (_, code, _, body) = send("case-json-none", false, Vec::new()).await;
    assert_eq!(code.as_deref(), Some("PREREQUISITE_UNMET"), "{body}");
    assert!(body.contains("none ran in this session"), "{body}");
    let mut stale = test_run("===== 3 passed in 0.50s =====");
    stale.extend([
        serde_json::json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_edit", "type": "function",
            "function": {"name": "Write", "arguments": serde_json::json!({"file_path": "src/a.rs", "content": "x"}).to_string()}}]}),
        serde_json::json!({"role": "tool", "tool_call_id": "call_edit", "name": "Write", "content": "ok"}),
    ]);
    let (_, code, _, body) = send("case-json-stale", false, stale).await;
    assert_eq!(code.as_deref(), Some("PREREQUISITE_UNMET"), "{body}");
    assert!(
        body.contains("files changed after the last passing"),
        "{body}"
    );

    // Streaming: the held block is withheld whole, the marker names the code.
    let (status, _, _, body) = send(
        "case-stream-failed",
        true,
        test_run("Tests:       2 failed, 9 passed, 11 total"),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(!body.contains("call_gated"), "{body}");
    let marker = body
        .lines()
        .find(|l| l.starts_with(": intutic-refusal "))
        .unwrap_or_else(|| panic!("no refusal marker:\n{body}"));
    assert!(
        marker.contains(r#""code":"PREREQUISITE_UNMET""#),
        "{marker}"
    );
    assert!(marker.contains(r#""scope":{"#), "{marker}");
    let (_, _, _, body) = send(
        "case-stream-passed",
        true,
        test_run("Tests:       11 passed, 11 total"),
    )
    .await;
    assert!(body.contains("call_gated"), "{body}");
    assert!(!body.contains("intutic-refusal"), "{body}");

    // scope_paths_mode: enforce — a write outside the scope is withheld.
    let (_, code, rule, body) = send("case-json-scope", false, Vec::new()).await;
    assert_eq!(code.as_deref(), Some("OUT_OF_SCOPE"), "{body}");
    assert_eq!(rule.as_deref(), Some("scope_paths.ship"));
    assert!(!body.contains("call_gated"), "{body}");

    // Request side: a deploy that ran after a failed run is refused on the
    // request that reports it, and the refusal says what to retry.
    let mut ran = test_run("===== 1 failed in 0.50s =====");
    ran.extend([
        serde_json::json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_push", "type": "function",
            "function": {"name": "Bash", "arguments": serde_json::json!({"command": PUSH}).to_string()}}]}),
        serde_json::json!({"role": "tool", "tool_call_id": "call_push", "name": "Bash", "content": "Everything up-to-date"}),
    ]);
    let (status, _, _, body) = send("case-json-history", false, ran).await;
    assert_eq!(status, 403, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json error");
    assert_eq!(v["error"]["type"], "policy_denied");
    assert_eq!(v["error"]["scope"]["tools"][0], "action:deploy", "{body}");
    assert_eq!(
        v["error"]["scope"]["step"], "action:run_tests[ok]",
        "{body}"
    );

    let _ = std::fs::remove_dir_all(&sops_dir);
}
