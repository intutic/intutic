//! A captured session credential is stored only for an admitted request.
//!
//! A passthrough proxy stores the caller's Anthropic token as its workspace's
//! credential, so a developer's OAuth session can be reused. The capture used
//! to run before authentication. On a managed proxy, which refuses every
//! non-`vk_` bearer, an unauthenticated caller could therefore write any
//! `sk-ant-` string into the shared credential store of whichever workspace it
//! named in `x-workspace-id`, replacing that workspace's provisioned key, and
//! receive a 401 for it. Standalone, where the store is the proxy's own
//! memory, still captures.
//!
//! ONE `#[tokio::test]`: the upstream URL is process-global.

use std::sync::Arc;
use std::time::Duration;

use intutic_proxy::store::{ControlPlaneAuth, ControlPlaneCache, LocalStore, MemoryStore};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const VICTIM: &str = "ws_capture_victim";

/// A managed control plane that has issued no key matching the request's
/// bearer: what Valkey answers for any provider key.
struct NoSuchKey;

#[async_trait::async_trait]
impl ControlPlaneCache for NoSuchKey {
    async fn auth_context(&self, _t: &str) -> ControlPlaneAuth {
        ControlPlaneAuth::Rejected
    }
    async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    async fn wasm_binary(&self, _sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    async fn policy_version(&self, _w: &str) -> Option<u64> {
        None
    }
    async fn predict_gate_threshold(&self, _w: &str) -> Option<f64> {
        None
    }
    async fn token_baseline(
        &self,
        _w: &str,
        _m: &str,
        _b: &str,
    ) -> Option<intutic_proxy::store::TokenBaseline> {
        None
    }
    async fn bandit_keywords(&self, _w: &str) -> Option<serde_json::Value> {
        None
    }
    async fn active_sop_tier(&self, _w: &str) -> Option<String> {
        None
    }
    async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
        None
    }
    async fn feature_flags(&self, _w: &str) -> Option<intutic_proxy::store::FeatureFlags> {
        None
    }
    async fn daily_budget(&self, _w: &str) -> Option<(f64, Option<f64>)> {
        None
    }
    async fn hard_block(&self, _w: &str) -> intutic_proxy::store::HardCapStatus {
        intutic_proxy::store::HardCapStatus::Clear
    }
    async fn loop_status(&self, _l: &str) -> Option<String> {
        None
    }
    async fn active_loop_run(&self, _w: &str, _m: Option<&str>) -> Option<String> {
        None
    }
    async fn auto_judge_active(&self, _s: intutic_proxy::store::JudgeScope, _id: &str) -> bool {
        false
    }
    async fn break_glass_grant(
        &self,
        _t: &str,
        _w: &str,
    ) -> Option<intutic_proxy::store::BreakGlassGrant> {
        None
    }
    async fn transition_baseline(&self, _w: &str) -> Option<String> {
        None
    }
    async fn drain_notifications(
        &self,
        _s: intutic_proxy::store::NotifyScope,
        _id: &str,
    ) -> Vec<String> {
        Vec::new()
    }
    async fn is_sandbox_attested(&self, _sid: &str) -> bool {
        false
    }
}

async fn serve(
    store: Arc<MemoryStore>,
    control_plane: Arc<dyn ControlPlaneCache>,
) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings: {}\n").expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store,
        control_plane,
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
    addr
}

async fn send(addr: std::net::SocketAddr, token: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("http://{addr}/v1/messages"))
        .header("x-api-key", token)
        .header("x-workspace-id", VICTIM)
        .json(&json!({
            "model": "claude-sonnet-4",
            "max_tokens": 16,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable")
        .status()
}

async fn captured(store: &MemoryStore) -> Option<String> {
    // The write is spawned off the request path.
    tokio::time::sleep(Duration::from_millis(200)).await;
    store
        .workspace_credential(VICTIM, &["anthropic_api_key"])
        .await
}

#[tokio::test]
async fn only_an_admitted_request_has_its_token_captured() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_capture", "type": "message", "role": "assistant", "model": "m",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1}
        })))
        .mount(&upstream)
        .await;
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("CONTROL_PLANE_URL");

    // Runtime-assembled per the repo's fixture rule.
    let token = ["sk-ant-", "api03-", "capture-fixture"].concat();

    let managed_store = Arc::new(MemoryStore::new());
    let managed = serve(Arc::clone(&managed_store), Arc::new(NoSuchKey)).await;
    assert_eq!(
        send(managed, &token).await,
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        captured(&managed_store).await,
        None,
        "a refused request wrote its token into the workspace's credentials"
    );

    let standalone_store = Arc::new(MemoryStore::new());
    let standalone = serve(
        Arc::clone(&standalone_store),
        Arc::new(intutic_proxy::store::NullControlPlaneCache),
    )
    .await;
    assert!(send(standalone, &token).await.is_success());
    assert_eq!(captured(&standalone_store).await, Some(token));
}
