//! A bandit reroute from a Claude model to a DeepSeek model that DeepSeek
//! cannot serve must not "fall back" by resending the Claude model id to
//! DeepSeek.
//!
//! DeepSeek serves the Anthropic wire natively, so a Messages request routed
//! from `claude-*` to `deepseek-*` takes the same-provider branch. The
//! unservable-model fallback re-sends the ORIGINAL request to the SAME upstream
//! URL with the SAME credentials — right when the routed model belongs to the
//! requested model's provider, wrong here: it sent `claude-…` to DeepSeek with
//! the DeepSeek key. The fallback is now built only when both models belong to
//! one provider; a cross-provider pick is penalised and unlocked, not retried.
//!
//! ONE `#[tokio::test]`: upstream URLs are process-global env.

use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const WS: &str = "ws_ds_reroute";
const REQUESTED: &str = "claude-3-5-haiku-20241022";

#[tokio::test]
async fn an_unservable_deepseek_reroute_is_not_retried_with_the_claude_model_at_deepseek() {
    let deepseek = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/anthropic/v1/messages"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": {
                "message": "The model `deepseek-flash` does not exist or you do not have access to it.",
                "type": "invalid_request_error",
                "param": "model",
                "code": "model_not_found"
            }
        })))
        .mount(&deepseek)
        .await;
    let anthropic = MockServer::start().await;

    std::env::set_var("DEEPSEEK_UPSTREAM_URL", deepseek.uri());
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", anthropic.uri());
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(&format!(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: true
    mode: enforce
    candidate_models: ["{REQUESTED}", "deepseek-flash"]
"#
    ))
    .expect("config parses");

    let deepseek_key = ["deepseek", "-provisioned-", "test"].concat();
    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    use intutic_proxy::store::LocalStore as _;
    store
        .set_workspace_credential(
            WS,
            "anthropic_api_key",
            &["anthropic", "-provisioned-", "test"].concat(),
        )
        .await;
    store
        .set_workspace_credential(
            WS,
            "deepseek_config",
            &json!({ "apiKey": deepseek_key }).to_string(),
        )
        .await;
    let session_id = "ses_ds_reroute";
    store
        .set_session_locked_model(&format!("{WS}:{session_id}"), "deepseek-flash")
        .await
        .expect("pre-lock");

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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/messages"))
        .header(
            "x-api-key",
            ["vk_", "0123456789abcdef0123456789abcdef", "_", WS].concat(),
        )
        .header("x-session-id", session_id)
        .json(&json!({
            "model": REQUESTED, "max_tokens": 16,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status();
    let _ = res.text().await;

    let bodies: Vec<String> = deepseek
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        bodies.iter().any(|b| b.contains("deepseek-flash")),
        "the routed DeepSeek model was never tried (status {status}): {bodies:?}"
    );
    assert!(
        !bodies.iter().any(|b| b.contains(REQUESTED)),
        "the Claude model id was sent to DeepSeek: {bodies:?}"
    );
    // The session must not stay pinned to the unservable pick.
    let session = store
        .session_routing(&format!("{WS}:{session_id}"))
        .await
        .expect("session readable");
    assert!(session.locked_model.is_none(), "lock not released");
}
