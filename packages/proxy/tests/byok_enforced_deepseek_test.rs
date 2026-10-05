//! Under enforced BYO-key, a DeepSeek request from a workspace with no
//! provisioned DeepSeek key is refused with 402 `byok_required`, exactly as a
//! Mistral one is, and the operator's `DEEPSEEK_API_KEY` is not used.
//!
//! Its own file because the gateway config is a process-wide `OnceLock`.

use std::sync::Arc;

use intutic_proxy::gateway::{init_gateway_config, GatewayConfig};
use serde_json::json;
use wiremock::MockServer;

#[tokio::test]
async fn deepseek_without_a_provisioned_key_is_refused_like_mistral() {
    init_gateway_config(GatewayConfig {
        require_provisioned_key: true,
        ..Default::default()
    });
    let upstream = MockServer::start().await;
    std::env::set_var("DEEPSEEK_UPSTREAM_URL", upstream.uri());
    std::env::set_var("MISTRAL_UPSTREAM_URL", upstream.uri());
    // An operator key exists, and must not be ridden.
    std::env::set_var(
        "DEEPSEEK_API_KEY",
        ["operator", "-shared-", "test"].concat(),
    );
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n").expect("config parses");
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

    let vk = [
        "vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_byok_deepseek",
    ]
    .concat();
    for (route, model) in [
        ("/v1/messages", "deepseek-flash"),
        ("/v1/chat/completions", "deepseek-chat"),
        ("/v1/chat/completions", "mistral-large-latest"),
    ] {
        let body = if route == "/v1/messages" {
            json!({"model": model, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]})
        } else {
            json!({"model": model, "messages": [{"role": "user", "content": "hi"}]})
        };
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header("x-api-key", &vk)
            .json(&body)
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        assert_eq!(status.as_u16(), 402, "{model}: {text}");
        assert!(text.contains("byok_required"), "{model}: {text}");
    }
    assert!(
        upstream
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty(),
        "nothing may reach the upstream"
    );
}
