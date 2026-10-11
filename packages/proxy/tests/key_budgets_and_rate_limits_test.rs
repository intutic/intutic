//! End-to-end: a virtual key's hard spend budgets and per-minute rate limits
//! refuse a request before it reaches the provider.
//!
//! The budgets and limits arrive on the key's record (`hardBudgets`,
//! `rateLimit`, `keyId`) and the spend each budget is checked against comes
//! from `ControlPlaneCache::spend_counters`; both are stubbed here so each case
//! can set them. The arithmetic and the Valkey scripts have their own tests
//! (`key_limits.rs`, `key_limits_valkey_test.rs`); this pins the wiring on the
//! request path: status, code, `Retry-After`, the structured body, and that a
//! refused request is never forwarded.
//!
//! ONE `#[tokio::test]`: upstream URLs and provider keys are process-global env.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use intutic_proxy::key_limits::{BudgetPeriod, BudgetScope, HardBudget, RateLimit};
use intutic_proxy::metering::VirtualKeyRecord;
use intutic_proxy::store::{BreakGlassGrant, ControlPlaneAuth, ControlPlaneCache};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// Runtime-assembled virtual keys, per the repo's fixture rule.
fn vk(n: u8, ws: &str) -> String {
    ["vk_", &format!("{n:032x}"), "_", ws].concat()
}

fn record(token: &str, ws: &str) -> VirtualKeyRecord {
    VirtualKeyRecord {
        token: token.to_string(),
        key_name: None,
        team_id: Some(ws.to_string()),
        user_id: Some("mem_budget".to_string()),
        max_budget: None,
        spend: 0.0,
        models: vec![],
        expires: None,
        org_id: None,
        byok_required: None,
        key_id: Some(format!("key_{ws}")),
        hard_budgets: Some(vec![]),
        rate_limit: None,
    }
}

/// Known keys by token, and the spend the counters report (`None`: unreadable).
struct Keys {
    records: HashMap<String, VirtualKeyRecord>,
    spent: Mutex<Option<Vec<f64>>>,
    asked: Mutex<Vec<Vec<String>>>,
}

#[async_trait::async_trait]
impl ControlPlaneCache for Keys {
    async fn auth_context(&self, t: &str) -> ControlPlaneAuth {
        match self.records.get(t) {
            Some(r) => ControlPlaneAuth::Known(Box::new(r.clone())),
            None => ControlPlaneAuth::Rejected,
        }
    }
    async fn spend_counters(&self, keys: &[String]) -> Option<Vec<f64>> {
        self.asked.lock().unwrap().push(keys.to_vec());
        self.spent
            .lock()
            .unwrap()
            .clone()
            .map(|v| v.into_iter().take(keys.len()).collect())
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
        "id": "chatcmpl-budget",
        "object": "chat.completion",
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "Done." },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 40, "completion_tokens": 10, "total_tokens": 50}
    })
}

#[tokio::test]
async fn hard_budgets_and_rate_limits_refuse_before_the_request_leaves() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion()))
        .mount(&upstream)
        .await;
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::remove_var("CONTROL_PLANE_URL");

    let budgeted = vk(1, "ws_kb_budget");
    let limited_rpm = vk(2, "ws_kb_rpm");
    let limited_tpm = vk(3, "ws_kb_tpm");
    let legacy = vk(4, "ws_kb_legacy");

    let mut records = HashMap::new();
    let mut r = record(&budgeted, "ws_kb_budget");
    r.hard_budgets = Some(vec![
        HardBudget {
            scope: BudgetScope::Workspace,
            period: BudgetPeriod::Month,
            limit_usd: 1000.0,
        },
        HardBudget {
            scope: BudgetScope::Key,
            period: BudgetPeriod::Day,
            limit_usd: 5.0,
        },
    ]);
    records.insert(budgeted.clone(), r);
    let mut r = record(&limited_rpm, "ws_kb_rpm");
    r.rate_limit = Some(RateLimit {
        rpm: Some(2),
        tpm: None,
    });
    records.insert(limited_rpm.clone(), r);
    let mut r = record(&limited_tpm, "ws_kb_tpm");
    r.rate_limit = Some(RateLimit {
        rpm: None,
        tpm: Some(30),
    });
    records.insert(limited_tpm.clone(), r);
    // A record from a control plane that predates `hardBudgets`: the legacy
    // workspace daily cap, through `max_budget` and `spend`.
    let mut r = record(&legacy, "ws_kb_legacy");
    r.hard_budgets = None;
    r.max_budget = Some(10.0);
    r.spend = 9.9999;
    records.insert(legacy.clone(), r);

    let keys = Arc::new(Keys {
        records,
        spent: Mutex::new(Some(vec![0.0, 0.0])),
        asked: Mutex::new(Vec::new()),
    });

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
        control_plane: Arc::clone(&keys) as Arc<dyn ControlPlaneCache>,
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

    let send = |key: String| async move {
        let res = reqwest::Client::new()
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {key}"))
            .header("x-session-id", "ses_key_budgets")
            .json(&serde_json::json!({
                "model": "gpt-4o",
                "max_tokens": 100,
                "messages": [{"role": "user", "content": "summarise the diff"}]
            }))
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status();
        let retry_after = res
            .headers()
            .get("retry-after")
            .map(|v| v.to_str().unwrap().to_string());
        let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
        (status, retry_after, body)
    };
    let forwarded = || async { upstream.received_requests().await.expect("recording").len() };

    // Within every budget: forwarded, and both counters were asked for in one read.
    let (status, _, body) = send(budgeted.clone()).await;
    assert!(status.is_success(), "{status}: {body}");
    let asked = keys
        .asked
        .lock()
        .unwrap()
        .last()
        .cloned()
        .expect("counters read");
    assert_eq!(asked.len(), 2);
    assert!(
        asked[0].starts_with("v2:budget:ws_kb_budget:monthly"),
        "{asked:?}"
    );
    assert!(
        asked[1].starts_with("v2:budget:ws_kb_budget:key:key_ws_kb_budget:day:"),
        "{asked:?}"
    );

    // The key's day budget is all but spent: refused, not forwarded, and told when it resets.
    *keys.spent.lock().unwrap() = Some(vec![0.0, 4.9999]);
    let before = forwarded().await;
    let (status, retry_after, body) = send(budgeted.clone()).await;
    assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["type"], "BUDGET_EXCEEDED");
    assert_eq!(body["error"]["budget"]["scope"], "key");
    assert_eq!(body["error"]["budget"]["period"], "day");
    assert_eq!(body["error"]["budget"]["limitUsd"], 5.0);
    let retry: u64 = retry_after.expect("Retry-After").parse().unwrap();
    assert!((1..=86_400).contains(&retry), "{retry}");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("This API key's daily spend budget of $5.00"));
    assert_eq!(
        forwarded().await,
        before,
        "a refused request reached the model"
    );

    // Spend that cannot be read is not admitted against a hard budget.
    *keys.spent.lock().unwrap() = None;
    let (status, _, body) = send(budgeted.clone()).await;
    assert_eq!(status, reqwest::StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["type"], "BUDGET_UNVERIFIABLE");
    assert_eq!(forwarded().await, before);

    // Two requests a minute: the third in the same minute is refused. The
    // minute could turn between them; a fresh minute admits again, so retry
    // the whole sequence once if that happened.
    let mut refused = None;
    for _ in 0..2 {
        let mut statuses = Vec::new();
        for _ in 0..3 {
            statuses.push(send(limited_rpm.clone()).await);
        }
        if statuses[2].0 == reqwest::StatusCode::TOO_MANY_REQUESTS {
            refused = Some(statuses);
            break;
        }
    }
    let statuses = refused.expect("the third request in a minute is refused");
    assert!(statuses[0].0.is_success() && statuses[1].0.is_success());
    let (_, retry_after, body) = &statuses[2];
    assert_eq!(body["error"]["type"], "RATE_LIMITED");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("limited to 2 requests per minute"));
    let retry: u64 = retry_after.as_ref().expect("Retry-After").parse().unwrap();
    assert!((1..=60).contains(&retry));

    // Thirty tokens a minute: the first call uses fifty (40 in, 10 out), so the
    // next one in the minute is refused for tokens.
    let mut refused = false;
    for _ in 0..2 {
        let (first, _, body) = send(limited_tpm.clone()).await;
        assert!(first.is_success(), "{body}");
        let (second, _, body) = send(limited_tpm.clone()).await;
        if second == reqwest::StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(body["error"]["type"], "RATE_LIMITED");
            assert!(body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("limited to 30 tokens per minute"));
            refused = true;
            break;
        }
    }
    assert!(refused, "a key over its tokens per minute is refused");

    // A record without `hardBudgets` keeps the workspace daily cap it had before.
    let (status, _, body) = send(legacy.clone()).await;
    assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["type"], "BUDGET_EXCEEDED");
}
