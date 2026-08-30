//! The judge finalize deadline gate: a slow/wedged judge must not hold up
//! the client-visible stream forever, and — separately — must not be
//! cancelled just because the client stopped waiting on it.
//!
//! ## Why this exists
//!
//! Before this test existed, the post-stream judge tail (chunk-handle
//! joins, the trailing chunk, then finalize) ran fully sequential and
//! unbounded ahead of the terminal SSE event. Staging measured 26-27s
//! judged-stream close latency, entirely attributable to this: a slow judge
//! held up every judged response by exactly as long as it took the judge to
//! answer. `JUDGE_FINALIZE_DEADLINE_MS` caps that wait; on expiry the
//! stream releases with a `judge_unavailable_note` instead of the real
//! synthesis, and the client sees the response promptly. The subtle part —
//! and the one a naive implementation gets wrong — is what happens to the
//! in-flight finalize call itself: `tokio::time::timeout` racing a
//! `JoinHandle` only stops *waiting* on the spawned task, it does not abort
//! it. This test proves both halves: the client-visible release is fast,
//! and the finalize call the tail was making still lands at the control
//! plane afterward, on its own schedule — a real chunk verdict / finalize
//! outcome is not silently thrown away just because nobody was watching
//! for it in time.
//!
//! ## Shape notes
//!
//! - ONE `#[tokio::test]` in this file for the deadline-race scenario,
//!   matching `judge_stream_test.rs`'s convention — `OPENAI_UPSTREAM_URL`,
//!   `CONTROL_PLANE_URL`, and `JUDGE_FINALIZE_DEADLINE_MS` are all
//!   process-global env vars; a second test in this binary would race them.
//! - The plain `#[test]` for `judge_finalize_deadline_ms()`'s own parsing
//!   is free to share the file: it touches only
//!   `JUDGE_FINALIZE_DEADLINE_MS`, which no other test in this workspace
//!   sets, and it does not spawn a router.

use std::sync::Arc;
use std::time::Duration;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn judge_finalize_deadline_ms_parses_unset_disabled_and_explicit() {
    // Isolated to this one test in the crate — see the module doc.
    std::env::remove_var("JUDGE_FINALIZE_DEADLINE_MS");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(5000),
        "unset must default to 5000ms"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "0");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        None,
        "explicit 0 must disable the deadline"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "-100");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        None,
        "a negative value must disable the deadline, same as 0"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "2500");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(2500),
        "a positive value must be used verbatim"
    );

    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "not-a-number");
    assert_eq!(
        intutic_proxy::proxy::judge_finalize_deadline_ms(),
        Some(5000),
        "unparseable must fall back to the default, same as unset — never to unbounded"
    );

    std::env::remove_var("JUDGE_FINALIZE_DEADLINE_MS");
}

fn upstream_sse_body() -> String {
    let deltas = [
        "First paragraph about the deploy.",
        "\n\n",
        "Second paragraph, still streaming when the stream ends.",
    ];
    let mut body = String::new();
    for d in deltas {
        let chunk = serde_json::json!({
            "id": "chatcmpl-deadlinetest",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"content": d}, "finish_reason": null}]
        });
        body.push_str(&format!("data: {}\n\n", chunk));
    }
    let finish = serde_json::json!({
        "id": "chatcmpl-deadlinetest",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20}
    });
    body.push_str(&format!("data: {}\n\n", finish));
    body.push_str("data: [DONE]\n\n");
    body
}

#[tokio::test]
async fn a_slow_finalize_releases_the_stream_at_the_deadline_but_keeps_running() {
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

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;
    // Chunk calls answer instantly — the finalize delay below is what must
    // dominate the deadline race, not chunk latency.
    Mock::given(method("POST"))
        .and(path("/api/v1/judge/chunk"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "verdict": "PASS", "triggered": false, "personalTriggered": false,
            "explanation": "clean", "independent": true
        })))
        .mount(&cp)
        .await;
    // Deliberately slower than the 500ms deadline below, but the test still
    // waits it out afterward to prove the call actually completes.
    Mock::given(method("POST"))
        .and(path("/api/v1/judge/finalize"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(3))
                .set_body_json(serde_json::json!({
                    "verdict": "PASS", "triggered": false, "personalTriggered": false,
                    "correctionSummary": "Never seen by the client — the deadline fires first.",
                    "independent": true
                })),
        )
        .expect(1)
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("JUDGE_FINALIZE_DEADLINE_MS", "500");

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

    let started = std::time::Instant::now();
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            concat!(
                "Bearer vk_",
                "0123456789abcdef0123456789abcdef",
                "_ws_judge_deadline_test"
            ),
        )
        .header("x-workspace-id", "ws_judge_deadline_test")
        .header("x-session-id", "ses_judge_deadline_test")
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
    let elapsed = started.elapsed();
    assert!(status.is_success(), "proxy returned {status}: {body}");

    // The load-bearing timing assertion: released well before the 3s
    // finalize delay would otherwise force it to wait. Generous margin
    // above the 500ms deadline (network + task scheduling on a loaded CI
    // box), still far under the 3s the old unbounded behavior would need.
    assert!(
        elapsed < Duration::from_millis(2000),
        "stream took {elapsed:?} to close — the deadline should have released it well under 2s, not waited out the 3s finalize delay"
    );

    // The client got the model's text…
    assert!(body.contains("First paragraph about the deploy."), "{body}");
    // …an explicit UNAVAILABLE note instead of a real synthesis…
    assert!(
        body.contains("verdict UNAVAILABLE"),
        "expected an UNAVAILABLE note in the released stream:\n{body}"
    );
    assert!(
        body.contains("finalize exceeded its deadline"),
        "expected the deadline-specific reason text:\n{body}"
    );
    // …and NOT the real synthesis text, which only the (still in-flight)
    // slow finalize response carries.
    assert!(
        !body.contains("Never seen by the client"),
        "the real synthesis leaked into the released stream — the deadline did not actually cut it off:\n{body}"
    );

    // The detached-task proof: wait out the finalize mock's 3s delay (from
    // whenever the background task actually issued the request, which was
    // at or before the point the deadline fired above) and confirm the
    // call still landed. A naive `timeout(...).await` that dropped the
    // underlying future instead of only the JoinHandle would silently
    // never make this call at all.
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let reqs = cp.received_requests().await.expect("wiremock recording on");
    let finalize_calls: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/judge/finalize")
        .collect();
    assert_eq!(
        finalize_calls.len(),
        1,
        "the finalize call should still have completed in the background after the deadline released the client — it must not be cancelled, only stopped waiting on"
    );
}
