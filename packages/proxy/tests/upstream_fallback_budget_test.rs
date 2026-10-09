//! End-to-end: a fallback target is held to the spend budget the request
//! passed, priced for the target's own model.
//!
//! Standalone, so the budget is the machine's daily cap from
//! `~/.intutic/config.json` — the same pre-request check the request went
//! through (`BudgetGatePlugin::verdict`). The routed model is cheap and fits;
//! the first fallback is priced far past the cap and must be skipped without
//! a call; the second is cheap and answers. The key and workspace budgets go
//! through `key_budget_refusal`, the same entry point, which the unit tests in
//! `proxy.rs` (`fallback_budget`) cover.
//!
//! ONE `#[tokio::test]` in this file: `HOME` and the upstream URL are
//! process-global, and the local config is cached per process.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn a_fallback_that_would_overshoot_the_budget_is_skipped() {
    let home = std::env::temp_dir().join(format!("intutic-fallback-budget-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".intutic")).expect("temp home");
    std::fs::write(
        home.join(".intutic").join("config.json"),
        r#"{"maxDailyBudgetUsd": 0.10}"#,
    )
    .expect("config.json");
    std::env::set_var("HOME", &home);
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_LOCAL_BUDGET_ENFORCE");
    std::env::remove_var("UPSTREAM_URL");

    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("\"gpt-4o-mini\""))
        .respond_with(ResponseTemplate::new(503))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("\"gpt-4\""))
        .respond_with(ResponseTemplate::new(200).set_body_string("must never be called"))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("\"gpt-4.1-nano\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-budget",
            "object": "chat.completion",
            "model": "gpt-4.1-nano",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "served within budget"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        })))
        .mount(&upstream)
        .await;
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());

    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
    retry:
      max_attempts: 1
    fallbacks:
      gpt-4o-mini:
        - model: gpt-4
        - model: gpt-4.1-nano
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
        store: Arc::new(intutic_proxy::store::MemoryStore::new())
            as Arc<dyn intutic_proxy::store::LocalStore>,
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

    // ~10k input tokens: about $0.002 on gpt-4o-mini and gpt-4.1-nano with
    // the gate's margin, about $0.36 on gpt-4 — far past the $0.10 cap.
    let prompt = "word ".repeat(8_000);
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header(
            "Authorization",
            [
                "Bearer vk_",
                "0123456789abcdef0123456789abcdef",
                "_ws_budget_test",
            ]
            .concat(),
        )
        .header("x-workspace-id", "ws_budget_test")
        .json(&serde_json::json!({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let status = res.status();
    let attempts = res
        .headers()
        .get("x-intutic-upstream-attempts")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = res.text().await.expect("body");
    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("served within budget"), "{body}");
    // The routed model, then the nano target; the gpt-4 target was skipped.
    assert_eq!(attempts.as_deref(), Some("2"));
    let models: Vec<String> = upstream
        .received_requests()
        .await
        .expect("recording on")
        .iter()
        .filter_map(|r| serde_json::from_slice::<serde_json::Value>(&r.body).ok())
        .filter_map(|b| b["model"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        models,
        vec!["gpt-4o-mini", "gpt-4.1-nano"],
        "gpt-4 must never be called"
    );
}
