//! End-to-end: a self-hosted gateway with `INTUTIC_GATEWAY_LOCAL_JUDGE=true`
//! answers finalize-time judging from its OWN LiteLLM instance, and never
//! calls out to `CONTROL_PLANE_URL` for it (LLD #68 §2 phase 2).
//!
//! ## What this observes
//!
//! Two real requests through the real router against a wiremock upstream
//! (the "monitored" model) and a wiremock LOCAL LiteLLM (the judge target):
//!
//! 1. A local judge returning `VIOLATION` — the client's response carries a
//!    `(local)` synthesis block with the judge's own reasoning, and the
//!    control plane's `/api/v1/judge/finalize` is never hit (proven by
//!    asserting zero received requests there, not merely "no mock was set
//!    up for it").
//! 2. The local LiteLLM unreachable (a `LITELLM_LOCAL_URL` nobody is
//!    listening on) — the response degrades to the SAME `UNAVAILABLE`
//!    annotation convention (`judge_unavailable_note`) the SaaS-unavailable
//!    path already uses, proving this is a routing change, not a new
//!    failure mode.
//!
//! ONE `#[tokio::test]` in this file: `INTUTIC_GATEWAY_LOCAL_JUDGE` is
//! installed once via `init_gateway_config` (a `OnceLock`, cannot be
//! toggled mid-process), and `CONTROL_PLANE_URL`/`OPENAI_UPSTREAM_URL` are
//! process-global env vars — two tests in one binary would race. Both
//! scenarios run sequentially within the one test instead, since
//! `LITELLM_LOCAL_URL` IS read fresh per call and can change between them.

use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn upstream_chat_completion_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-localjudgetest",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "Here is the answer you asked for."},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}
    })
}

#[tokio::test]
async fn local_judge_answers_finalize_without_calling_the_control_plane() {
    // ── Fake upstream (the monitored model) ──
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(upstream_chat_completion_body()))
        .mount(&upstream)
        .await;

    // ── Fake control plane — policy check must be mocked (fail-closed
    //    default), but judge/finalize is deliberately NOT mocked so a call
    //    there falls through to wiremock's unmocked-404, and the explicit
    //    zero-received-requests assertion below proves local mode never
    //    reaches for it at all. ──
    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })))
        .mount(&cp)
        .await;

    // ── Fake LOCAL LiteLLM (the local judge's own target) ──
    let local_litellm = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{
                "message": {
                    "content": "{\"verdict\": \"VIOLATION\", \"reasoning\": \"Response ignored the workspace SOP.\"}"
                }
            }]
        })))
        .mount(&local_litellm)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("LITELLM_LOCAL_URL", local_litellm.uri());
    std::env::set_var("LITELLM_LOCAL_JUDGE_MODEL", "local-test-model");

    // Installed once, process-wide — local judge on, front-door flags at
    // their defaults (irrelevant to this test).
    intutic_proxy::gateway::init_gateway_config(intutic_proxy::gateway::GatewayConfig {
        local_judge: true,
        ..Default::default()
    });

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
    };
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // ── Scenario 1: local judge reachable, returns VIOLATION ──
    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_local_judge_test",
        )
        .header("x-workspace-id", "ws_local_judge_test")
        .header("x-session-id", "ses_local_judge_test_1")
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": false,
            "messages": [{"role": "user", "content": "/intutic judge Do the thing."}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert!(status.is_success(), "proxy returned {status}: {body}");

    assert!(
        body.contains("Intutic LLM-as-a-Judge (local) final Security Synthesis"),
        "expected the LOCAL synthesis heading, not the SaaS one, in:\n{body}"
    );
    assert!(
        body.contains("Response ignored the workspace SOP."),
        "expected the local judge's own reasoning text in:\n{body}"
    );

    // The load-bearing assertion: local mode must never reach the control
    // plane's judge routes at all, not merely "no mock happened to answer."
    let cp_reqs = cp.received_requests().await.expect("wiremock recording on");
    let judge_calls: Vec<_> = cp_reqs
        .iter()
        .filter(|r| r.url.path().starts_with("/api/v1/judge/"))
        .collect();
    assert!(
        judge_calls.is_empty(),
        "local judge mode must never call the control plane's judge routes, but saw: {:?}",
        judge_calls.iter().map(|r| r.url.path()).collect::<Vec<_>>()
    );

    // And the local LiteLLM really was the one asked.
    let local_reqs = local_litellm.received_requests().await.expect("wiremock recording on");
    assert_eq!(local_reqs.len(), 1, "expected exactly one call to the local judge's LiteLLM");

    // ── Scenario 2: local judge configured but unreachable — degrades to
    //    the SAME UNAVAILABLE convention the SaaS-unavailable path uses. ──
    std::env::set_var("LITELLM_LOCAL_URL", "http://127.0.0.1:1");

    let res2 = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_local_judge_test",
        )
        .header("x-workspace-id", "ws_local_judge_test")
        .header("x-session-id", "ses_local_judge_test_2")
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": false,
            "messages": [{"role": "user", "content": "/intutic judge Do the thing again."}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status2 = res2.status();
    let body2 = res2.text().await.expect("body reads");
    assert!(status2.is_success(), "proxy returned {status2}: {body2}");

    assert!(
        body2.contains("Intutic LLM-as-a-Judge: verdict UNAVAILABLE"),
        "expected the shared UNAVAILABLE annotation convention in:\n{body2}"
    );
    assert!(
        body2.contains("Treat it as unverified, not as clean."),
        "expected the exact shared UNAVAILABLE wording in:\n{body2}"
    );

    // Still never called the control plane's judge routes.
    let cp_reqs2 = cp.received_requests().await.expect("wiremock recording on");
    let judge_calls2: Vec<_> = cp_reqs2
        .iter()
        .filter(|r| r.url.path().starts_with("/api/v1/judge/"))
        .collect();
    assert!(
        judge_calls2.is_empty(),
        "local judge mode must never fall back to the control plane on its own failure, but saw: {:?}",
        judge_calls2.iter().map(|r| r.url.path()).collect::<Vec<_>>()
    );
}
