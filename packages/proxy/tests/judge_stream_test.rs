//! End-to-end: a SAME-PROVIDER stream produces mid-stream judge chunks.
//!
//! ## Why this exists
//!
//! The mid-stream judge chunker lived entirely inside the cross-provider
//! translation branch. On a same-provider stream — an OpenAI-shaped client
//! talking to an OpenAI-shaped upstream, the most common topology — no
//! splitting ever ran: the whole response reached the judge as ONE trailing
//! chunk after the client already had every byte, and finalize's "segment log"
//! was a single entry. The fix expands one shared macro in both branches, but
//! until this file the claim "same-provider streams now chunk" was structural
//! only — asserted from the shape of the code, never observed. This test
//! observes it: a real request through the real router, a wiremock upstream
//! serving a canned SSE body, a wiremock control plane counting the
//! `/api/v1/judge/chunk` calls it receives.
//!
//! ## Shape notes
//!
//! - ONE `#[tokio::test]` in this file, deliberately. The upstream and
//!   control-plane addresses travel through process-global env vars
//!   (`OPENAI_UPSTREAM_URL`, `CONTROL_PLANE_URL`), and wiremock binds a fresh
//!   port per server — two tests in one binary would race each other's env.
//! - The judge is activated by `/intutic judge` in the last user message: the
//!   in-memory store carries no session flag, and that is also the activation
//!   path an open-core standalone user actually has.
//! - Policy check must be mocked and must allow: `policy.fail_closed` defaults
//!   to true, so an unmocked policy endpoint blocks the request before any of
//!   this runs. Every other control-plane endpoint the proxy touches on this
//!   path fails open on wiremock's default 404, which is itself part of what
//!   the test exercises.

use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A canned OpenAI-shaped SSE stream: three paragraphs separated by blank
/// lines, then a terminal. Two `\n\n` boundaries → two mid-stream chunks, and
/// the third paragraph is left for the trailing-chunk call.
fn upstream_sse_body() -> String {
    let deltas = [
        "First paragraph about the deploy.",
        "\n\n",
        "Second paragraph about the rollback plan.",
        "\n\n",
        "Third paragraph, still streaming when the stream ends.",
    ];
    let mut body = String::new();
    for d in deltas {
        let chunk = serde_json::json!({
            "id": "chatcmpl-judgetest",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"content": d}, "finish_reason": null}]
        });
        body.push_str(&format!("data: {}\n\n", chunk));
    }
    let finish = serde_json::json!({
        "id": "chatcmpl-judgetest",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 30}
    });
    body.push_str(&format!("data: {}\n\n", finish));
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::test]
async fn same_provider_stream_sends_mid_stream_chunks_to_the_judge() {
    // ── Fake upstream (same provider as the client protocol: OpenAI) ──
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(upstream_sse_body(), "text/event-stream"),
        )
        .expect(1)
        .mount(&upstream)
        .await;

    // ── Fake control plane ──
    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;
    // Two mid-stream paragraphs + one trailing chunk = exactly 3. `.expect` is
    // verified on drop; the explicit count assertion below gives the readable
    // failure message.
    Mock::given(method("POST"))
        .and(path("/api/v1/judge/chunk"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "verdict": "PASS", "triggered": false, "personalTriggered": false,
            "explanation": "clean", "independent": true
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/judge/finalize"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "verdict": "PASS", "triggered": false, "personalTriggered": false,
            "correctionSummary": "All three segments verified clean.",
            "independent": true
        })))
        .expect(1)
        .mount(&cp)
        .await;

    // Process-global on purpose — see the module doc for why this file holds
    // exactly one test.
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

    // ── Real router over a minimal standalone AppState ──
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

    // ── The request: same-provider (OpenAI protocol, OpenAI-family model),
    //    streaming, judge activated in-band ──
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        // Suffix-format virtual key: vk_<32 hex>_<workspaceId>. The proxy
        // authorizes the x-workspace-id header against the workspace the key
        // encodes, so the two must agree.
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_judge_stream_test",
        )
        .header("x-workspace-id", "ws_judge_stream_test")
        .header("x-session-id", "ses_judge_stream_test")
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": true,
            "messages": [{"role": "user", "content": "/intutic judge Describe the deploy."}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let body = res.text().await.expect("stream drains");
    assert!(status.is_success(), "proxy returned {status}: {body}");

    // The client got the model's text…
    assert!(body.contains("First paragraph about the deploy."), "{body}");
    assert!(
        body.contains("Third paragraph, still streaming when the stream ends."),
        "{body}"
    );
    // …and the finalize synthesis was injected into the SAME stream.
    assert!(
        body.contains("Intutic LLM-as-a-Judge final Security Synthesis"),
        "no synthesis block in stream:\n{body}"
    );
    assert!(body.contains("All three segments verified clean."), "{body}");

    // The load-bearing count: a same-provider stream used to produce ZERO
    // mid-stream chunk calls (one whole-body trailing chunk only). Three calls
    // = two mid-stream paragraph splits + the trailing remainder.
    let reqs = cp.received_requests().await.expect("wiremock recording on");
    let chunk_calls: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/judge/chunk")
        .collect();
    assert_eq!(
        chunk_calls.len(),
        3,
        "expected 2 mid-stream + 1 trailing chunk call, got {}",
        chunk_calls.len()
    );

    // The two mid-stream calls carry the split paragraphs, in order, and the
    // trailing call carries the remainder — i.e. splitting really happened at
    // the blank lines rather than one whole-body call arriving three times.
    let contents: Vec<String> = chunk_calls
        .iter()
        .map(|r| {
            serde_json::from_slice::<serde_json::Value>(&r.body)
                .expect("chunk body is JSON")
                .get("chunkContent")
                .and_then(|v| v.as_str())
                .expect("chunkContent present")
                .to_string()
        })
        .collect();
    assert_eq!(contents[0], "First paragraph about the deploy.");
    assert_eq!(contents[1], "Second paragraph about the rollback plan.");
    assert_eq!(
        contents[2],
        "Third paragraph, still streaming when the stream ends."
    );

    // Finalize got the full accumulated body, uncompressed.
    let finalize: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/judge/finalize")
        .collect();
    assert_eq!(finalize.len(), 1);
    let full = serde_json::from_slice::<serde_json::Value>(&finalize[0].body)
        .expect("finalize body is JSON");
    let full_content = full
        .get("fullContent")
        .and_then(|v| v.as_str())
        .expect("fullContent present");
    assert!(full_content.contains("First paragraph about the deploy."));
    assert!(full_content.contains("Third paragraph, still streaming when the stream ends."));
}
