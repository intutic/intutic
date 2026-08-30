//! Non-streaming judged responses call `/api/v1/judge/finalize` only — no
//! per-paragraph `/api/v1/judge/chunk` calls.
//!
//! ## Why this exists
//!
//! The non-streaming path used to paragraph-split the already-fully-buffered
//! response body and run one `/api/v1/judge/chunk` call per segment, THEN
//! call finalize with the same full content anyway. Unlike the streaming
//! path — where mid-stream chunking overlaps with bytes the client has
//! already received, so it's not pure overhead — non-streaming has no
//! "mid-stream" at all: every chunk call and the finalize call all happen
//! after the model has already finished, before the client sees anything.
//! The chunk calls graded content finalize was about to grade again, in the
//! same request, for no benefit. Wave 5 (2026-08-30 architecture-audit
//! remediation) removed them; this test is the regression guard.
//!
//! ONE `#[tokio::test]` in this file, matching this crate's convention for
//! process-global env vars (`OPENAI_UPSTREAM_URL`, `CONTROL_PLANE_URL`).

use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Multiple paragraphs, deliberately — this is exactly the shape that used
/// to produce several `/api/v1/judge/chunk` calls before finalize.
fn upstream_chat_completion_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-nonstreamtest",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "First paragraph about the deploy.\n\nSecond paragraph about the rollback plan.\n\nThird paragraph, the closing summary."
            },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 24, "total_tokens": 36}
    })
}

#[tokio::test]
async fn non_streaming_response_calls_finalize_only_never_chunk() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(upstream_chat_completion_body()))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })))
        .mount(&cp)
        .await;
    // Deliberately NOT mocking /api/v1/judge/chunk: a call there falls
    // through to wiremock's unmocked-404, which would surface as a
    // "judge returned an error status" UNAVAILABLE note if one ever
    // happened — the explicit zero-count assertion below is the real
    // proof either way, this is just so a regression fails loudly.
    Mock::given(method("POST"))
        .and(path("/api/v1/judge/finalize"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "verdict": "PASS", "triggered": false, "personalTriggered": false,
            "correctionSummary": "All three paragraphs verified clean in one pass.",
            "independent": true
        })))
        .expect(1)
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    // Deadline disabled: this test is about call COUNTS, not timing — a
    // slow CI box tripping the default 5000ms deadline would turn this
    // into a flaky test about something it isn't testing.
    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "0");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n").expect("minimal config parses");
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // Fixture is runtime-assembled: the repo convention forbids contiguous
    // credential-shaped literals in source, in every package.
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            concat!("Bearer vk_", "0123456789abcdef0123456789abcdef", "_ws_nonstream_test"),
        )
        .header("x-workspace-id", "ws_nonstream_test")
        .header("x-session-id", "ses_nonstream_test")
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": false,
            "messages": [{"role": "user", "content": "/intutic judge Describe the deploy."}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert!(status.is_success(), "proxy returned {status}: {body}");

    assert!(
        body.contains("First paragraph about the deploy."),
        "{body}"
    );
    assert!(
        body.contains("All three paragraphs verified clean in one pass."),
        "expected the finalize synthesis spliced into the response body:\n{body}"
    );

    let reqs = cp.received_requests().await.expect("wiremock recording on");

    // The load-bearing assertion: zero chunk calls.
    let chunk_calls: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/judge/chunk")
        .collect();
    assert!(
        chunk_calls.is_empty(),
        "non-streaming must never call /api/v1/judge/chunk — finalize grades the whole content in one pass, but saw {} chunk call(s)",
        chunk_calls.len()
    );

    // Exactly one finalize call, and it carries the full body.
    let finalize_calls: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/judge/finalize")
        .collect();
    assert_eq!(finalize_calls.len(), 1);
    let full = serde_json::from_slice::<serde_json::Value>(&finalize_calls[0].body)
        .expect("finalize body is JSON");
    let full_content = full
        .get("fullContent")
        .and_then(|v| v.as_str())
        .expect("fullContent present");
    assert!(full_content.contains("First paragraph about the deploy."));
    assert!(full_content.contains("Third paragraph, the closing summary."));
}
