//! End-to-end: the two previously-silent (or dishonest) upstream-failure
//! paths still serve the caller correctly once they publish a trace.
//!
//! ## What this pins
//!
//! Phase 8a added `ExecutionTrace` construction (and a `tokio::spawn` to
//! publish it) to two request paths that used to `return` immediately on
//! failure: the initial connection attempt, and the non-streaming
//! body-read step. It also changed the verdict a 5xx trace carries. None of
//! that should be observable in what the CALLER gets back — same status,
//! same body, no added latency from a publish that must be fire-and-forget.
//! These tests exercise the real router (the same `AppState` +
//! `MemoryStore` + wiremock harness `unservable_fallback_test.rs` and
//! `multi_provider_routing_test.rs` already use) and assert on the
//! HTTP-observable contract.
//!
//! ## What this does NOT cover
//!
//! `MemoryStore::publish_trace` only logs (see its own doc comment) and
//! keeps nothing a test can read back, so this cannot assert on
//! `verdict`/`upstream_error` field VALUES end-to-end. That guarantee is
//! covered at the unit level instead: `telemetry.rs`'s
//! `upstream_error_round_trips_and_is_omitted_when_absent`,
//! `upstream_error_status_is_omitted_for_a_pure_transport_failure` and
//! `every_trace_site_carries_upstream_error`, plus the source-text
//! assertions in this same file's sibling `shadow_reports_reach_the_trace.rs`
//! style. Same limitation this codebase's own `shadow_reports_reach_the_trace.rs`
//! module doc already documents for a sibling field, and for the same reason:
//! no test-observable sink exists for a published trace's contents yet.

use std::sync::Arc;

use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

/// `ANTHROPIC_UPSTREAM_URL` is process-global (read at call time — see
/// `Provider::upstream_base_url`), and this file's two `#[tokio::test]`s run
/// concurrently by default. Without this they race on the same env var,
/// exactly the failure mode `mirror_test.rs`'s own `serial()` documents.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

async fn build_app(store: Arc<intutic_proxy::store::MemoryStore>) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
"#,
    )
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    addr
}

/// A 5xx from the provider must still reach the caller as a 5xx with the
/// provider's own body — the honest-verdict trace this phase adds is
/// spawned alongside the response, not in front of it.
#[tokio::test]
async fn a_5xx_from_the_provider_still_reaches_the_caller_unchanged() {
    let _serial = serial();
    let upstream = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503).set_body_json(serde_json::json!({
            "error": {"type": "overloaded_error", "message": "Overloaded"}
        })))
        .expect(1)
        .mount(&upstream)
        .await;

    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("CONTROL_PLANE_URL");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let addr = build_app(Arc::clone(&store)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/messages", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_5xx_test",
        )
        .header("x-workspace-id", "ws_5xx_test")
        .header("x-api-key", "sk-ant-test")
        .json(&serde_json::json!({
            "model": "claude-3-5-haiku-20241022",
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert_eq!(status, 503, "the provider's own 5xx must reach the caller: body={body}");
    assert!(
        body.contains("overloaded_error"),
        "the provider's own error body must be forwarded, not replaced: {body}"
    );

    upstream.verify().await;
}

/// The provider being completely unreachable must still resolve promptly —
/// with a 502 — for the caller. Before this phase this path never
/// constructed a trace; now it does, and that publish (fire-and-forget) must
/// not block or change the response the caller gets.
#[tokio::test]
async fn a_connection_failure_still_resolves_to_a_prompt_502() {
    let _serial = serial();
    // Nothing is listening on this port.
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", "http://127.0.0.1:1");
    std::env::remove_var("CONTROL_PLANE_URL");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let addr = build_app(Arc::clone(&store)).await;

    let started = std::time::Instant::now();
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/messages", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_conn_fail_test",
        )
        .header("x-workspace-id", "ws_conn_fail_test")
        .header("x-api-key", "sk-ant-test")
        .json(&serde_json::json!({
            "model": "claude-3-5-haiku-20241022",
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let elapsed = started.elapsed();
    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert_eq!(status, 502, "an unreachable provider must surface as Bad Gateway: body={body}");
    assert!(
        body.contains("upstream_error"),
        "the error code must say what failed: {body}"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "the new trace publish is fire-and-forget and must not add latency; took {elapsed:?}"
    );
}
