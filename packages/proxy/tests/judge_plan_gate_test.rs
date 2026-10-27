//! A plan without LLM judging is never judged.
//!
//! `/auth/key-context` carries `llmJudgeEnabled`. On `false` the proxy does
//! not call `/api/v1/judge/chunk` or `/api/v1/judge/finalize`, streaming or
//! not, and the response reaches the client as an unjudged one does: the
//! model's text, no synthesis, no UNAVAILABLE note. The `/intutic judge`
//! prefix that asked for the judge is still stripped before the upstream sees
//! the prompt. An absent field (a control plane older than it) keeps judging;
//! `judge_stream_test.rs` and `judge_nonstream_finalize_only_test.rs` cover
//! that, since their key-context answers do not carry it.
//!
//! ONE `#[tokio::test]` in this file, matching this crate's convention for
//! process-global env vars (`OPENAI_UPSTREAM_URL`, `CONTROL_PLANE_URL`).
#![cfg(feature = "control-plane")]

use std::sync::Arc;

use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn upstream_sse_body() -> String {
    let mut body = String::new();
    for d in [
        "First streamed paragraph.",
        "\n\n",
        "Second streamed paragraph.",
    ] {
        let chunk = serde_json::json!({
            "id": "chatcmpl-plangate",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"content": d}, "finish_reason": null}]
        });
        body.push_str(&format!("data: {}\n\n", chunk));
    }
    let finish = serde_json::json!({
        "id": "chatcmpl-plangate",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20}
    });
    body.push_str(&format!("data: {}\n\n", finish));
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::test]
async fn a_plan_without_llm_judging_is_never_judged() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(serde_json::json!({ "stream": true })))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(upstream_sse_body(), "text/event-stream"),
        )
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(serde_json::json!({ "stream": false })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-plangate",
            "object": "chat.completion",
            "model": "qwen-test-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "First paragraph.\n\nSecond paragraph."},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}
        })))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_plan_gate_test",
            "ssoGroups": { "policy": null, "memberGroups": null },
            "llmJudgeEnabled": false
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })),
        )
        .mount(&cp)
        .await;
    // Mounted so a regression is a counted call, not wiremock's 404 turned
    // into an UNAVAILABLE note.
    for judge in ["/api/v1/judge/chunk", "/api/v1/judge/finalize"] {
        Mock::given(method("POST"))
            .and(path(judge))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "verdict": "PASS", "triggered": false, "personalTriggered": false,
                "explanation": "", "correctionSummary": "judged anyway", "independent": true
            })))
            .expect(0)
            .mount(&cp)
            .await;
    }

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the operator fallback
    // supplies a test provider key.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "0");

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

    let send = |stream: bool| {
        reqwest::Client::new()
            .post(format!("http://{}/v1/chat/completions", addr))
            // Fixture is runtime-assembled: the repo convention forbids
            // contiguous credential-shaped literals in source.
            .header(
                "Authorization",
                concat!(
                    "Bearer vk_",
                    "0123456789abcdef0123456789abcdef",
                    "_ws_plan_gate_test"
                ),
            )
            .header("x-workspace-id", "ws_plan_gate_test")
            .header("x-session-id", "ses_plan_gate_test")
            .json(&serde_json::json!({
                "model": "qwen-test-model",
                "stream": stream,
                "messages": [{"role": "user", "content": "/intutic judge Describe the deploy."}]
            }))
            .send()
    };

    for stream in [false, true] {
        let res = send(stream).await.expect("proxy reachable");
        let status = res.status();
        let body = res.text().await.expect("body reads");
        assert!(
            status.is_success(),
            "stream={stream}: proxy returned {status}: {body}"
        );
        assert!(
            body.contains("First"),
            "stream={stream}: the model's text: {body}"
        );
        assert!(
            body.contains("Second"),
            "stream={stream}: the model's text: {body}"
        );
        assert!(
            !body.contains("LLM-as-a-Judge"),
            "stream={stream}: an unjudged response carries no judge synthesis or note:\n{body}"
        );
    }

    let judge_calls = cp
        .received_requests()
        .await
        .expect("wiremock recording on")
        .into_iter()
        .filter(|r| r.url.path().starts_with("/api/v1/judge/"))
        .count();
    assert_eq!(
        judge_calls, 0,
        "a plan without LLM judging must never call the judge"
    );

    // The `/intutic judge` prefix is a proxy command, stripped as before.
    for req in upstream.received_requests().await.expect("recording on") {
        let sent = String::from_utf8_lossy(&req.body);
        assert!(
            !sent.contains("/intutic judge"),
            "prefix reached the upstream: {sent}"
        );
        assert!(sent.contains("Describe the deploy."), "{sent}");
    }
}
