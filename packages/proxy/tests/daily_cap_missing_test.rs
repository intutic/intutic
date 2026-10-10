//! End-to-end: a managed key's daily cap is never invented. When the copy the
//! control plane writes to Valkey is missing, the proxy reads the cap from
//! `/auth/key-context` (`budget.dailyUsd`) and enforces it; when that answer
//! carries none or cannot be had, the request is refused as
//! `BUDGET_UNVERIFIABLE`. It used to fall back to $100 a day whatever the
//! workspace had saved; $100 is now the control plane's default for a
//! workspace that never saved a cap, stated on key-context like any other.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and control-plane URL are process-global env.

use std::sync::Arc;

use intutic_proxy::metering::VirtualKeyRecord;
use intutic_proxy::store::{BreakGlassGrant, ControlPlaneAuth, ControlPlaneCache};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// Runtime-assembled virtual keys, per the repo's fixture rule; the suffix
// after the hex is the workspace.
const TINY_CAP: &str = concat!("vk_", "0123456789abcdef0123456789abcd01", "_ws_tiny");
const DEFAULT_CAP: &str = concat!("vk_", "0123456789abcdef0123456789abcd02", "_ws_default");
/// The same default cap, with the day's spend already at it.
const DEFAULT_CAP_SPENT: &str = concat!("vk_", "0123456789abcdef0123456789abcd05", "_ws_spent");
const NO_CAP: &str = concat!("vk_", "0123456789abcdef0123456789abcd03", "_ws_none");
const DOWN: &str = concat!("vk_", "0123456789abcdef0123456789abcd04", "_ws_down");

/// A control-plane cache that knows every key, as the control plane's API-key
/// middleware wrote it, but holds no daily cap for its workspace: the key
/// `v2:budget:{ws}:daily_limit` is missing.
struct KnowsKeysNotCaps;

#[async_trait::async_trait]
impl ControlPlaneCache for KnowsKeysNotCaps {
    async fn auth_context(&self, token: &str) -> ControlPlaneAuth {
        // `vk_<32 hex>_<workspace>`, as the proxy reads a key's workspace.
        let workspace = token.get(36..).unwrap_or_default();
        ControlPlaneAuth::Known(Box::new(VirtualKeyRecord {
            token: token.to_string(),
            key_name: None,
            team_id: Some(workspace.to_string()),
            user_id: Some("mbr_1".to_string()),
            max_budget: None,
            spend: if workspace == "ws_spent" {
                99.999_999
            } else {
                0.0
            },
            models: Vec::new(),
            expires: None,
            org_id: None,
            byok_required: None,
        }))
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
    async fn break_glass_grant(&self, _t: &str, _w: &str) -> Option<BreakGlassGrant> {
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

fn completion() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-cap",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "Done." },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    })
}

#[tokio::test]
async fn a_missing_daily_cap_is_read_from_the_control_plane_never_invented() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion()))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })),
        )
        .mount(&cp)
        .await;
    for (key, budget) in [
        (
            TINY_CAP,
            serde_json::json!({ "dailyUsd": 0.000001, "monthlyUsd": 0.00003 }),
        ),
        (
            DEFAULT_CAP,
            // A workspace that never saved a cap: the control plane states its
            // $100 default (DEFAULT_DAILY_BUDGET_USD in shared-types).
            serde_json::json!({ "dailyUsd": 100.0, "monthlyUsd": 500.0 }),
        ),
        (
            DEFAULT_CAP_SPENT,
            serde_json::json!({ "dailyUsd": 100.0, "monthlyUsd": 500.0 }),
        ),
        (NO_CAP, serde_json::Value::Null),
    ] {
        let workspace = &key[36..];
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": workspace,
                "ssoGroups": { "policy": null, "memberGroups": null },
                "piiDetectors": {},
                "budget": budget
            })))
            .mount(&cp)
            .await;
    }
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .and(header("authorization", format!("Bearer {DOWN}").as_str()))
        .respond_with(ResponseTemplate::new(503))
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

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
        control_plane: Arc::new(KnowsKeysNotCaps),
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

    let send = |key: &'static str| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let workspace = &key[36..];
            let res = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("x-session-id", format!("ses_{workspace}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "messages": [{"role": "user", "content": "hello"}]
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            (status, res.text().await.expect("body drains"))
        }
    };

    // The control plane's cap is enforced: far below this request's estimate.
    let (status, body) = send(TINY_CAP).await;
    assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body.contains("BUDGET_EXCEEDED"), "{body}");

    // The $100 default covers a small request, and refuses one once the
    // day's spend has reached it.
    let (status, body) = send(DEFAULT_CAP).await;
    assert!(status.is_success(), "{status}: {body}");
    let (status, body) = send(DEFAULT_CAP_SPENT).await;
    assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body.contains("BUDGET_EXCEEDED"), "{body}");

    // No cap stated, or no answer: refused, never admitted under a made-up cap.
    for key in [NO_CAP, DOWN] {
        let (status, body) = send(key).await;
        assert_eq!(
            status,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            "{key}: {body}"
        );
        assert!(body.contains("BUDGET_UNVERIFIABLE"), "{key}: {body}");
    }
}
