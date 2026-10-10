//! End-to-end: this machine's DLP switches cannot turn a workspace's
//! `piiDetectors` baseline off. Local config may only tighten what the
//! workspace sets, so with `dlp.enabled: false`, or with `scan_input` and
//! `scan_output` both false, the detectors the workspace names still run on
//! the request and on the response; this machine's own patterns stay off.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and control-plane URL are process-global env.

use std::sync::Arc;

use intutic_proxy::store::{BreakGlassGrant, ControlPlaneAuth, ControlPlaneCache};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// Runtime-assembled virtual keys, per the repo's fixture rule: one per workspace.
const REDACTS_EMAIL: &str = concat!("vk_", "0123456789abcdef0123456789abcdf5", "_ws_pii_e");
const BLOCKS_CARDS: &str = concat!("vk_", "0123456789abcdef0123456789abcdf6", "_ws_pii_f");

/// No control-plane cache, as a standalone proxy has.
struct NoCache;

#[async_trait::async_trait]
impl ControlPlaneCache for NoCache {
    async fn auth_context(&self, _t: &str) -> ControlPlaneAuth {
        ControlPlaneAuth::Unmanaged
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

fn completion(content: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-pii-off",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    })
}

async fn serve(dlp: &str) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(&format!(
        "model_list: []\nintutic_settings:\n  dlp: {dlp}\n"
    ))
    .expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(intutic_proxy::store::MemoryStore::new()),
        control_plane: Arc::new(NoCache),
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

#[tokio::test]
async fn the_workspace_baseline_runs_with_this_machines_dlp_switched_off() {
    let email = format!("{}@{}", "jane.doe", "corp.io");
    let card = ["4111", "1111", "1111", "1111"].join(" ");
    let aws_key = format!("AKIA{}", "IOSFODNN7EXAMPLE");

    let upstream = MockServer::start().await;
    // The model answers with an email address when asked to "echo".
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("echo"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(completion(&format!("Write to {email}."))),
        )
        .with_priority(1)
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion("Done.")))
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
    for (key, ws, detectors) in [
        (
            REDACTS_EMAIL,
            "ws_pii_e",
            serde_json::json!({"pii.email": "redact"}),
        ),
        (
            BLOCKS_CARDS,
            "ws_pii_f",
            serde_json::json!({"pii.card": "block"}),
        ),
    ] {
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": ws,
                "ssoGroups": { "policy": null, "memberGroups": null },
                "piiDetectors": detectors
            })))
            .mount(&cp)
            .await;
    }

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the request needs a
    // provider key, so the operator fallback supplies a test one.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

    let last_upstream_body = || async {
        let requests = upstream.received_requests().await.expect("recording");
        String::from_utf8_lossy(&requests.last().expect("a forwarded request").body).to_string()
    };

    for dlp in [
        "{ enabled: false }",
        "{ scan_input: false, scan_output: false }",
    ] {
        let addr = serve(dlp).await;
        let send = |key: &'static str, ws: &'static str, content: String| {
            let url = format!("http://{addr}/v1/chat/completions");
            async move {
                let res = reqwest::Client::new()
                    .post(url)
                    .header("Authorization", format!("Bearer {key}"))
                    .header("x-workspace-id", ws)
                    .header("x-session-id", format!("ses_{ws}"))
                    .json(&serde_json::json!({
                        "model": "qwen-test-model",
                        "messages": [{"role": "user", "content": content}]
                    }))
                    .send()
                    .await
                    .expect("proxy reachable");
                let status = res.status();
                (status, res.text().await.expect("body drains"))
            }
        };

        // Request: the address the workspace redacts never reaches the model,
        // and this machine's own patterns stay off, as its config says.
        let (status, body) = send(
            REDACTS_EMAIL,
            "ws_pii_e",
            format!("mail {email} the key {aws_key}"),
        )
        .await;
        assert!(status.is_success(), "dlp {dlp}: {status}: {body}");
        let forwarded = last_upstream_body().await;
        assert!(!forwarded.contains(&email), "dlp {dlp}: {forwarded}");
        assert!(
            forwarded.contains("[REDACTED_PII]"),
            "dlp {dlp}: {forwarded}"
        );
        assert!(forwarded.contains(&aws_key), "dlp {dlp}: {forwarded}");

        // Response: the address the model wrote is redacted on the way back.
        let (status, body) = send(REDACTS_EMAIL, "ws_pii_e", "echo it".to_string()).await;
        assert!(status.is_success(), "dlp {dlp}: {status}: {body}");
        assert!(!body.contains(&email), "dlp {dlp}: {body}");
        assert!(body.contains("[REDACTED_PII]"), "dlp {dlp}: {body}");

        // The workspace blocks card numbers: refused before the model.
        let before = upstream.received_requests().await.expect("recording").len();
        let (status, body) = send(BLOCKS_CARDS, "ws_pii_f", format!("charge {card}")).await;
        assert_eq!(
            status,
            reqwest::StatusCode::BAD_REQUEST,
            "dlp {dlp}: {body}"
        );
        assert!(body.contains("dlp_policy_violation"), "dlp {dlp}: {body}");
        assert_eq!(
            upstream.received_requests().await.expect("recording").len(),
            before,
            "dlp {dlp}: a blocked request still reached the model"
        );
    }
}
