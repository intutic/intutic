//! End-to-end (§13 items 6 and 8): reversibility lanes and
//! the revert-history hold at the gateway.
//!
//! - `closed_lanes: irreversible` holds `terraform destroy`, a force push and a
//!   Stripe charge on the request that reports them; `open_actions:` at the
//!   top level re-opens one, indented it does not.
//! - The workspace's `revertLane: enforce` holds a reversible-wide action whose
//!   revert rate is over the threshold, and the hold leaves when the published
//!   rate falls.
//!
//! The control plane's revert cache is a stub whose rates the test changes.
//! ONE `#[tokio::test]` per process-global env, as `judge_stream_test.rs`
//! explains.
#![cfg(feature = "control-plane")]

use std::sync::{Arc, Mutex};

use intutic_proxy::store::{ControlPlaneAuth, ControlPlaneCache, FeatureFlags};
use serde_json::Value;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A control plane cache whose only content is the revert rates.
struct RevertRates(Arc<Mutex<Option<String>>>);

#[async_trait::async_trait]
impl ControlPlaneCache for RevertRates {
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
    async fn bandit_keywords(&self, _w: &str) -> Option<Value> {
        None
    }
    async fn active_sop_tier(&self, _w: &str) -> Option<String> {
        None
    }
    async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
        None
    }
    async fn feature_flags(&self, _w: &str) -> Option<FeatureFlags> {
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
    async fn revert_rates(&self, _w: &str) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    async fn drain_notifications(
        &self,
        _s: intutic_proxy::store::NotifyScope,
        _id: &str,
    ) -> Vec<String> {
        Vec::new()
    }
    async fn is_sandbox_attested(&self, _w: &str, _sid: &str) -> bool {
        false
    }
}

const LANES_KEY: &str = concat!("vk_", "0123456789abcdef0123456789abcdef", "_ws_lanes");
const REVERT_KEY: &str = concat!("vk_", "fedcba9876543210fedcba9876543210", "_ws_revert");

/// A turn that ran `command`.
fn ran(command: &str) -> Vec<Value> {
    vec![
        serde_json::json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_ran", "type": "function",
            "function": {"name": "Bash", "arguments": serde_json::json!({"command": command}).to_string()}}]}),
        serde_json::json!({"role": "tool", "tool_call_id": "call_ran", "name": "Bash", "content": "done"}),
    ]
}

#[tokio::test]
async fn closed_lanes_and_revert_history_hold_at_the_gateway() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-lanes", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        })))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .and(header(
            "authorization",
            format!("Bearer {LANES_KEY}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_lanes", "role": "DEVELOPER"
        })))
        .mount(&cp)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .and(header(
            "authorization",
            format!("Bearer {REVERT_KEY}").as_str(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_revert", "role": "DEVELOPER",
            "revertLane": {"mode": "enforce", "threshold": 0.25}
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;

    let sops_dir = std::env::temp_dir().join(format!("intutic-lanes-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    // Scoped to roles so the revert workspace's requests (no role) are not
    // held by these lanes. The inert `requires_before:` replaces the built-in
    // ordering floor, so a force push without tests is held, not killed.
    std::fs::write(
        sops_dir.join("irreversible.md"),
        "---\nroles: shipper\nclosed_lanes: irreversible\nopen_actions: action:publish\nrequires_before: Read -> NeverCalled\n---\nAsk before anything you cannot take back.\n",
    )
    .unwrap();
    std::fs::write(
        sops_dir.join("nested.md"),
        "---\nroles: nested\nclosed_lanes: irreversible\nmeta:\n  open_actions: action:publish\nrequires_before: Read -> NeverCalled\n---\nThe indented open_actions re-opens nothing.\n",
    )
    .unwrap();

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);

    let rates = Arc::new(Mutex::new(Some(
        r#"{"|action:migrate": {"r": 0.4, "j": null}}"#.to_string(),
    )));
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
        control_plane: Arc::new(RevertRates(Arc::clone(&rates))),
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

    let send = |key: &'static str, role: &'static str, session: String, history: Vec<Value>| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let mut messages = vec![serde_json::json!({"role": "user", "content": "go"})];
            messages.extend(history);
            let res = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("x-session-id", session)
                .header("x-intutic-agent-role", role)
                .json(&serde_json::json!({"model": "qwen-test-model", "messages": messages}))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let body = res.text().await.expect("body drains");
            (status, body)
        }
    };

    // closed_lanes: irreversible holds each irreversible action.
    for (i, command) in [
        "terraform destroy -auto-approve",
        "git push origin main --force",
        "stripe charges create --amount 100",
    ]
    .into_iter()
    .enumerate()
    {
        let (status, body) =
            send(LANES_KEY, "shipper", format!("ses_lane_{i}"), ran(command)).await;
        assert_eq!(status, 403, "{command}: {body}");
        assert!(body.contains("held for human review"), "{command}: {body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert!(
            v["error"]["scope"]["tools"]
                .as_array()
                .is_some_and(|t| !t.is_empty()),
            "{body}"
        );
    }
    // Top-level open_actions re-opens publish; indented, it does not.
    let (status, body) = send(LANES_KEY, "shipper", "ses_open".into(), ran("npm publish")).await;
    assert!(status.is_success(), "{status}: {body}");
    let (status, body) = send(LANES_KEY, "nested", "ses_nested".into(), ran("npm publish")).await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains("action:publish"), "{body}");

    // revertLane: enforce — a migration over the threshold is held...
    let (status, body) = send(
        REVERT_KEY,
        "",
        "ses_rev_1".into(),
        ran("alembic upgrade head"),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert!(
        body.contains("held for human review: action:migrate"),
        "{body}"
    );
    // ...a send, which has no history, is not...
    let (status, body) = send(
        REVERT_KEY,
        "",
        "ses_rev_2".into(),
        ran("curl -X POST https://api.example.com/hook"),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    // ...and once the published rate falls, the hold is gone.
    *rates.lock().unwrap() = Some(r#"{"|action:migrate": {"r": 0.1, "j": null}}"#.to_string());
    let (status, body) = send(
        REVERT_KEY,
        "",
        "ses_rev_3".into(),
        ran("alembic upgrade head"),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");

    let _ = std::fs::remove_dir_all(&sops_dir);
}
