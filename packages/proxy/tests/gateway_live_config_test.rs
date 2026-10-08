//! A registered gateway applies a remote config change to the running
//! proxy on its heartbeat, with no restart, against a mock control plane:
//! a version ahead of the applied one is pulled and enforced on the next
//! request; a failed or malformed pull leaves the running config alone; an
//! equal or older version is not pulled at all.
//!
//! One test in its own file: the live gateway config is process-wide.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intutic_proxy::gateway::{init_gateway_config, requires_vk_only, GatewayConfig};
use intutic_proxy::heartbeat::{spawn_heartbeat_loop, HeartbeatConfig};
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const GATEWAY: &str = "gw_live";

/// What the mock control plane answers, changed as the test goes.
struct ControlPlane {
    desired: AtomicU64,
    config: Mutex<(u16, Value)>,
}

impl ControlPlane {
    fn set_config(&self, status: u16, body: Value) {
        *self.config.lock().unwrap() = (status, body);
    }
}

fn requests_to(requests: &[Request], verb: &str, suffix: &str) -> Vec<Request> {
    requests
        .iter()
        .filter(|r| r.method.as_str() == verb && r.url.path().ends_with(suffix))
        .cloned()
        .collect()
}

async fn count(server: &MockServer, verb: &str, suffix: &str) -> usize {
    requests_to(
        &server.received_requests().await.unwrap_or_default(),
        verb,
        suffix,
    )
    .len()
}

/// The `appliedConfigVersion` of the most recent heartbeat, if it sent one.
async fn last_reported(server: &MockServer) -> Option<u64> {
    let beats = requests_to(
        &server.received_requests().await.unwrap_or_default(),
        "POST",
        "/heartbeat",
    );
    let body: Value = serde_json::from_slice(&beats.last()?.body).ok()?;
    body.get("appliedConfigVersion")?.as_u64()
}

async fn wait_for_beats(server: &MockServer, more: usize) {
    let target = count(server, "POST", "/heartbeat").await + more;
    for _ in 0..200 {
        if count(server, "POST", "/heartbeat").await >= target {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the heartbeat loop stopped beating");
}

async fn wait_until(what: &str, mut done: impl AsyncFnMut() -> bool) {
    for _ in 0..300 {
        if done().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// A request with a raw provider key: refused at the front door while
/// `requireVk` is on, let through to the rest of the pipeline while it is off.
async fn raw_key_refused(proxy: &str) -> bool {
    let res = reqwest::Client::new()
        .post(format!("{proxy}/v1/messages"))
        .bearer_auth(["sk-ant-", "raw-provider-", "key"].concat())
        .json(&json!({"model": "claude-sonnet-4-5", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .expect("proxy reachable");
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    status == 401 && text.contains("vk_required")
}

#[tokio::test]
async fn remote_config_applies_live_and_fails_safe() {
    // Boot posture: the front door is open (as INTUTIC_GATEWAY_REQUIRE_VK=false).
    init_gateway_config(GatewayConfig::default());
    assert!(!requires_vk_only());

    let cp = Arc::new(ControlPlane {
        desired: AtomicU64::new(1),
        config: Mutex::new((
            200,
            // localJudge is not remotely settable: ignored, never applied.
            json!({ "configVersion": 1, "config": { "requireVk": true, "localJudge": true } }),
        )),
    });
    let server = MockServer::start().await;
    let beat = cp.clone();
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/gateways/{GATEWAY}/heartbeat")))
        .respond_with(move |_: &Request| {
            ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "desiredConfigVersion": beat.desired.load(Ordering::SeqCst),
                "keyRotatedAt": null,
            }))
        })
        .mount(&server)
        .await;
    let pull = cp.clone();
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/gateways/{GATEWAY}/config")))
        .respond_with(move |_: &Request| {
            let (status, body) = pull.config.lock().unwrap().clone();
            ResponseTemplate::new(status).set_body_json(body)
        })
        .mount(&server)
        .await;

    // The proxy itself, serving requests the whole time: nothing below
    // rebuilds it, so every change it shows was applied while it ran.
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_SOPS_DIR");
    // A request let through goes on upstream: keep it off the internet.
    let upstream = MockServer::start().await;
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let proxy = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        axum::serve(listener, intutic_proxy::router::build_router(state))
            .await
            .ok();
    });
    assert!(
        !raw_key_refused(&proxy).await,
        "boot config lets it through"
    );

    spawn_heartbeat_loop(
        Arc::new(reqwest::Client::new()),
        HeartbeatConfig {
            gateway_id: GATEWAY.into(),
            gateway_token: ["gwk_", "live_config_test"].concat(),
            control_plane_url: server.uri(),
            interval: Duration::from_millis(40),
            rotation_interval: None,
            token_state_file: None,
            k8s_secret_writer: None,
        },
    );

    // 1. Version advance → applied to the running proxy, and reported back.
    wait_until("requireVk to go live", async || requires_vk_only()).await;
    assert!(raw_key_refused(&proxy).await, "the next request is refused");
    assert!(
        !intutic_proxy::gateway::uses_local_judge(),
        "an unknown field is never applied"
    );
    wait_until("the next heartbeat to report version 1", async || {
        last_reported(&server).await == Some(1)
    })
    .await;
    let pulls = count(&server, "GET", "/config").await;
    assert_eq!(pulls, 1, "exactly one pull for one version");

    // 2. Equal version → no pull.
    wait_for_beats(&server, 5).await;
    assert_eq!(count(&server, "GET", "/config").await, pulls);

    // 3. Fetch failure → the running config stays, and the pull is retried.
    cp.set_config(500, json!({ "error": "boom" }));
    cp.desired.store(2, Ordering::SeqCst);
    wait_until("two failed pulls", async || {
        count(&server, "GET", "/config").await >= pulls + 2
    })
    .await;
    assert!(requires_vk_only(), "a failed pull changes nothing");
    assert!(raw_key_refused(&proxy).await);
    assert_eq!(last_reported(&server).await, Some(1));

    // A config it only half understands is never applied either: the good
    // field must not land without the bad one.
    let before = count(&server, "GET", "/config").await;
    cp.set_config(
        200,
        json!({ "configVersion": 2, "config": { "requireVk": false, "requireProvisionedKey": "yes" } }),
    );
    wait_until("a pull of the malformed config", async || {
        count(&server, "GET", "/config").await >= before + 2
    })
    .await;
    assert!(requires_vk_only(), "a malformed config changes nothing");
    assert_eq!(last_reported(&server).await, Some(1));

    // Once the control plane answers properly, the change lands.
    cp.set_config(
        200,
        json!({ "configVersion": 2, "config": { "requireVk": false } }),
    );
    wait_until("requireVk to go off", async || !requires_vk_only()).await;
    assert!(!raw_key_refused(&proxy).await);
    wait_until("the next heartbeat to report version 2", async || {
        last_reported(&server).await == Some(2)
    })
    .await;

    // 4. A stale desired version (behind what is applied) → no pull.
    cp.desired.store(1, Ordering::SeqCst);
    let pulls = count(&server, "GET", "/config").await;
    wait_for_beats(&server, 5).await;
    assert_eq!(count(&server, "GET", "/config").await, pulls);
    assert!(!requires_vk_only());
    assert_eq!(last_reported(&server).await, Some(2));
}
