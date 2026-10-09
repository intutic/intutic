//! A custom rule that reaches no verdict refuses the request even when the
//! proxy fails open (`intutic_settings.policy.fail_closed: false`).
//!
//! The fail setting exists for control-plane outages, which an agent cannot
//! cause. A rule's deadline or budget an agent can exhaust by padding its
//! input, so a rule that could not decide must never become an allow. The
//! refusal is `403 GOVERNANCE_UNAVAILABLE`, naming the rule and the cause.
//!
//! ONE `#[tokio::test]` in this file, matching this crate's convention for
//! process-global env vars (`OPENAI_UPSTREAM_URL`, `CONTROL_PLANE_URL`).

use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Traps on every evaluation.
const TRAP: &str = r#"(module
     (memory (export "memory") 1)
     (func (export "allocate") (param i32) (result i32) i32.const 8)
     (func (export "evaluate") (param i32 i32) (result i32) unreachable))"#;

#[tokio::test]
async fn a_rule_without_a_verdict_refuses_even_when_the_proxy_fails_open() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-noverdict",
            "object": "chat.completion",
            "model": "qwen-test-model",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "Done." },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
        })))
        .mount(&upstream)
        .await;
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("CONTROL_PLANE_URL");

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-no-verdict-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("10_trap.wasm"), wat::parse_str(TRAP).unwrap()).unwrap();

    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        "model_list: []\nintutic_settings:\n  policy:\n    fail_closed: false\n",
    )
    .expect("config parses");
    assert!(!config.intutic_settings.policy.fail_closed);
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(dir.to_str())
            .await
            .expect("registry"),
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

    let provider_key = ["test", "-provider-", "token"].concat();
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header("Authorization", format!("Bearer {provider_key}"))
        .json(&serde_json::json!({
            "model": "qwen-test-model",
            "stream": false,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let body: serde_json::Value = res.json().await.expect("JSON error body");
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["type"], "GOVERNANCE_UNAVAILABLE", "{body}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("local:10_trap.wasm") && message.contains("(error)"),
        "{message}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
