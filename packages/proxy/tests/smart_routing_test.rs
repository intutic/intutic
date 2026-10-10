//! End-to-end: what smart routing may pick for a request, and what happens to
//! the session lock when a pick fails.
//!
//! Each test drives a real request through `build_router` at wiremock
//! upstreams for Anthropic, OpenAI and the Gemini API. The router is steered
//! with the session lock rather than seeded arm statistics: a lock is honoured
//! only while its arm is in the request's pool, so pre-locking the scope says
//! "this is what the bandit picked" deterministically, and a lock outside the
//! pool must be ignored. What is asserted is what the caller and the upstreams
//! observe, and the lock left behind.

// `serial()`'s guard is held across awaits on purpose: the upstream URLs and
// operator keys are process-global env vars, so these tests must not overlap.
#![allow(clippy::await_holding_lock)]

use std::sync::Arc;

use intutic_proxy::store::{ControlPlaneAuth, ControlPlaneCache, LocalStore, MemoryStore};
use serde_json::json;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

const WS: &str = "ws_smart_routing";

// Runtime-assembled: the repo convention forbids contiguous credential-shaped
// literals in source.
fn virtual_key() -> String {
    ["Bearer vk_", "0123456789abcdef0123456789abcdef", "_", WS].concat()
}

fn operator_key(provider: &str) -> String {
    ["test-", provider, "-operator-key"].concat()
}

/// What a control plane has written for the workspace: its own candidate
/// list, its allowlist and the models its stored keys were seen to list.
#[derive(Default)]
struct Workspace {
    routing_candidates: Option<Vec<String>>,
    allowed_models: Option<Vec<String>>,
    provider_models: Vec<(&'static str, Vec<String>)>,
}

fn strings(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

#[async_trait::async_trait]
impl ControlPlaneCache for Workspace {
    async fn routing_candidates(&self, _w: &str) -> Option<Vec<String>> {
        self.routing_candidates.clone()
    }
    async fn provider_models(&self, _w: &str, provider: &str) -> Option<Vec<String>> {
        self.provider_models
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, m)| m.clone())
    }
    async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
        self.allowed_models.clone()
    }
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

/// Standalone routing, enforced, over the default-shaped pool, with retries
/// that do not make a test wait.
const ROUTING: &str = r#"
model_list: []
intutic_settings:
  routing:
    enabled: true
    mode: enforce
    candidate_models: ["claude-sonnet-5-5", "gpt-4.1", "gemini-3.8-flash"]
    retry:
      initial_backoff_ms: 1
      max_backoff_ms: 1
"#;

struct Upstreams {
    anthropic: MockServer,
    openai: MockServer,
    gemini: MockServer,
}

/// Three upstreams, every operator key cleared: a test grants the keys it
/// means the workspace to have.
async fn upstreams() -> Upstreams {
    let u = Upstreams {
        anthropic: MockServer::start().await,
        openai: MockServer::start().await,
        gemini: MockServer::start().await,
    };
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", u.anthropic.uri());
    std::env::set_var("OPENAI_UPSTREAM_URL", u.openai.uri());
    std::env::set_var("GEMINI_UPSTREAM_URL", u.gemini.uri());
    for var in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "UPSTREAM_URL",
        "CONTROL_PLANE_URL",
    ] {
        std::env::remove_var(var);
    }
    u
}

fn grant_operator_keys(providers: &[&str]) {
    for p in providers {
        std::env::set_var(
            format!("{}_API_KEY", p.to_ascii_uppercase()),
            operator_key(p),
        );
    }
}

async fn serve(workspace: Workspace, store: Arc<MemoryStore>) -> std::net::SocketAddr {
    serve_with(ROUTING, workspace, store).await
}

async fn serve_with(
    config_yaml: &str,
    workspace: Workspace,
    store: Arc<MemoryStore>,
) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str(config_yaml).expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: store as Arc<dyn LocalStore>,
        control_plane: Arc::new(workspace),
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

/// The routing scope a request with `x-session-id: session` resolves to.
fn scope(session: &str) -> String {
    format!("{WS}:{session}")
}

async fn lock(store: &MemoryStore, session: &str, arm: &str) {
    store
        .set_session_locked_model(&scope(session), arm)
        .await
        .expect("pre-lock");
}

async fn locked(store: &MemoryStore, session: &str) -> Option<String> {
    store
        .session_routing(&scope(session))
        .await
        .expect("session readable")
        .locked_model
}

async fn post(
    addr: std::net::SocketAddr,
    route: &str,
    session: &str,
    body: serde_json::Value,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}{route}"))
        .header("Authorization", virtual_key())
        .header("x-workspace-id", WS)
        .header("x-session-id", session)
        .json(&body)
        .send()
        .await
        .expect("proxy reachable")
}

async fn post_chat(addr: std::net::SocketAddr, model: &str, session: &str) -> reqwest::Response {
    post(
        addr,
        "/v1/chat/completions",
        session,
        json!({"model": model, "messages": [{"role": "user", "content": "write a function"}]}),
    )
    .await
}

async fn post_messages(
    addr: std::net::SocketAddr,
    model: &str,
    session: &str,
) -> reqwest::Response {
    post(
        addr,
        "/v1/messages",
        session,
        json!({
            "model": model,
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "write a function"}]
        }),
    )
    .await
}

fn messages_ok(text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "id": "msg_smart_routing",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    }))
}

fn chat_ok(text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "id": "chatcmpl-smart-routing",
        "object": "chat.completion",
        "model": "gpt-4.1",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    }))
}

async fn mount(server: &MockServer, route: &str, model: &str, response: ResponseTemplate) {
    Mock::given(method("POST"))
        .and(path(route))
        .and(body_string_contains(model))
        .respond_with(response)
        .mount(server)
        .await;
}

async fn hits(server: &MockServer) -> usize {
    server.received_requests().await.unwrap_or_default().len()
}

/// Claude Code speaks the Messages format, and nothing translates Messages to
/// the OpenAI format. An OpenAI candidate is never in its pool, so a lock an
/// OpenAI-format request left in the same scope is ignored, not served.
#[tokio::test]
async fn an_anthropic_format_request_is_never_sent_to_an_openai_model() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1",
        chat_ok("from gpt"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_wire", "gpt-4.1").await;

    let res = post_messages(addr, "claude-sonnet-5-5", "ses_wire").await;
    let status = res.status();
    let body = res.text().await.unwrap();

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("from claude"), "{body}");
    assert_eq!(hits(&u.openai).await, 0, "an Anthropic body reached OpenAI");
    assert_eq!(
        locked(&store, "ses_wire").await.as_deref(),
        Some("claude-sonnet-5-5"),
        "the unreachable lock is replaced"
    );
}

/// The other direction has a translation both ways: an OpenAI-format request
/// routed to Claude is sent as Messages and answered in its own format.
#[tokio::test]
async fn an_openai_format_request_routed_to_claude_is_translated_both_ways() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_translate", "claude-sonnet-5-5").await;

    let res = post_chat(addr, "gpt-4.1", "ses_translate").await;
    let status = res.status();
    let routed_to = res
        .headers()
        .get("x-intutic-routed-to")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body: serde_json::Value = res.json().await.unwrap();

    assert!(status.is_success(), "status={status} body={body}");
    assert_eq!(routed_to.as_deref(), Some("claude-sonnet-5-5"));
    assert_eq!(body["object"], "chat.completion", "{body}");
    assert_eq!(body["choices"][0]["message"]["content"], "from claude");
    assert_eq!(hits(&u.openai).await, 0);
}

/// A candidate on a provider the workspace has no key for is left out, so the
/// request is served as asked instead of failing with 402.
#[tokio::test]
async fn a_candidate_without_a_credential_is_left_out() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["openai"]);
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1",
        chat_ok("from gpt"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_nokey", "claude-sonnet-5-5").await;

    let res = post_chat(addr, "gpt-4.1", "ses_nokey").await;
    let status = res.status();
    let body = res.text().await.unwrap();

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("from gpt"), "{body}");
    assert_eq!(hits(&u.anthropic).await, 0);
}

/// A workspace key counts like an operator key: with an Anthropic key stored
/// for the workspace, Claude is back in the pool.
#[tokio::test]
async fn a_workspace_credential_puts_its_provider_in_the_pool() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["openai"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    store
        .set_workspace_credential(
            WS,
            "anthropic_api_key",
            &operator_key("workspace-anthropic"),
        )
        .await;
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_wskey", "claude-sonnet-5-5").await;

    let res = post_chat(addr, "gpt-4.1", "ses_wskey").await;
    let body = res.text().await.unwrap();
    assert!(body.contains("from claude"), "{body}");
}

/// The allowlist binds a routed pick as it binds the request.
#[tokio::test]
async fn a_candidate_off_the_allowlist_is_left_out() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai"]);
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1",
        chat_ok("from gpt"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let workspace = Workspace {
        allowed_models: Some(strings(&["gpt-4.1"])),
        ..Default::default()
    };
    let addr = serve(workspace, Arc::clone(&store)).await;
    lock(&store, "ses_allow", "claude-sonnet-5-5").await;

    let res = post_chat(addr, "gpt-4.1", "ses_allow").await;
    let body = res.text().await.unwrap();
    assert!(body.contains("from gpt"), "{body}");
    assert_eq!(hits(&u.anthropic).await, 0);
}

/// The models a workspace key was seen to list narrow the pool: a candidate
/// the key does not list is left out, and a dated snapshot in the list counts
/// for the alias the candidate names.
#[tokio::test]
async fn discovered_models_narrow_the_pool() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["openai"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1",
        chat_ok("from gpt"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    store
        .set_workspace_credential(
            WS,
            "anthropic_api_key",
            &operator_key("workspace-anthropic"),
        )
        .await;

    let not_listed = Workspace {
        provider_models: vec![("anthropic", strings(&["claude-opus-5-5"]))],
        ..Default::default()
    };
    let addr = serve(not_listed, Arc::clone(&store)).await;
    lock(&store, "ses_listed", "claude-sonnet-5-5").await;
    let body = post_chat(addr, "gpt-4.1", "ses_listed")
        .await
        .text()
        .await
        .unwrap();
    assert!(
        body.contains("from gpt"),
        "a model the key does not list was routed to: {body}"
    );
    assert_eq!(hits(&u.anthropic).await, 0);

    let snapshot_listed = Workspace {
        provider_models: vec![(
            "anthropic",
            strings(&["claude-opus-5-5", "claude-sonnet-5-5-20260101"]),
        )],
        ..Default::default()
    };
    let addr = serve(snapshot_listed, Arc::clone(&store)).await;
    lock(&store, "ses_listed", "claude-sonnet-5-5").await;
    let body = post_chat(addr, "gpt-4.1", "ses_listed")
        .await
        .text()
        .await
        .unwrap();
    assert!(body.contains("from claude"), "{body}");
}

/// A workspace's own candidate list replaces the proxy's, and a Gemini pick is
/// sent to the Gemini API under the model that was chosen.
#[tokio::test]
async fn workspace_candidates_replace_the_pool_and_gemini_is_sent_the_chosen_model() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai", "gemini"]);
    Mock::given(method("POST"))
        .and(path("/v1beta/models/gemini-3.8-flash:generateContent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"role": "model", "parts": [{"text": "from gemini"}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 9, "candidatesTokenCount": 4}
        })))
        .mount(&u.gemini)
        .await;
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1",
        chat_ok("from gpt"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let workspace = Workspace {
        routing_candidates: Some(strings(&["gpt-4.1", "gemini-3.8-flash"])),
        ..Default::default()
    };
    let addr = serve(workspace, Arc::clone(&store)).await;

    // Claude is in the proxy's pool, not the workspace's: its lock is ignored.
    lock(&store, "ses_ws_pool", "claude-sonnet-5-5").await;
    let body = post_chat(addr, "gpt-4.1", "ses_ws_pool")
        .await
        .text()
        .await
        .unwrap();
    assert!(body.contains("from gpt"), "{body}");
    assert_eq!(hits(&u.anthropic).await, 0);

    lock(&store, "ses_ws_pool", "gemini-3.8-flash").await;
    let res = post_chat(addr, "gpt-4.1", "ses_ws_pool").await;
    let status = res.status();
    let body = res.text().await.unwrap();
    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("from gemini"), "{body}");
}

/// A dated snapshot of a candidate enters routing through that candidate;
/// served as asked, it keeps its exact name.
#[tokio::test]
async fn a_dated_snapshot_enters_routing_through_its_candidate() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    mount(
        &u.openai,
        "/v1/chat/completions",
        "gpt-4.1-2025-04-14",
        chat_ok("from the snapshot"),
    )
    .await;
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;

    lock(&store, "ses_snapshot", "claude-sonnet-5-5").await;
    let body = post_chat(addr, "gpt-4.1-2025-04-14", "ses_snapshot")
        .await
        .text()
        .await
        .unwrap();
    assert!(
        body.contains("from claude"),
        "the snapshot was not routed: {body}"
    );

    // Locked to its own candidate, the request goes out exactly as written.
    lock(&store, "ses_snapshot", "gpt-4.1").await;
    let body = post_chat(addr, "gpt-4.1-2025-04-14", "ses_snapshot")
        .await
        .text()
        .await
        .unwrap();
    assert!(body.contains("from the snapshot"), "{body}");
}

/// A routed pick that fails releases the lock, so the next request re-selects
/// instead of returning to it for the rest of the lock's day. A request the
/// caller got wrong (400) is not the model's failure and keeps the lock.
#[tokio::test]
async fn a_failing_pick_releases_the_session_lock() {
    let _guard = serial();
    for (status, released) in [
        (401, true),
        (403, true),
        (429, true),
        (503, true),
        (400, false),
    ] {
        let u = upstreams().await;
        grant_operator_keys(&["anthropic", "openai"]);
        mount(
            &u.anthropic,
            "/v1/messages",
            "claude-sonnet-5-5",
            ResponseTemplate::new(status)
                .set_body_json(json!({"type": "error", "error": {"type": "x", "message": "no"}})),
        )
        .await;
        let store = Arc::new(MemoryStore::new());
        let addr = serve(Workspace::default(), Arc::clone(&store)).await;
        lock(&store, "ses_fail", "claude-sonnet-5-5").await;

        let res = post_chat(addr, "gpt-4.1", "ses_fail").await;
        assert_eq!(res.status().as_u16(), status);
        let after = locked(&store, "ses_fail").await;
        if released {
            assert_eq!(after, None, "HTTP {status} left the failing pick locked");
        } else {
            assert_eq!(after.as_deref(), Some("claude-sonnet-5-5"), "HTTP {status}");
        }
    }

    // No answer at all.
    let _u = upstreams().await;
    grant_operator_keys(&["anthropic", "openai"]);
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", "http://127.0.0.1:1");
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_fail", "claude-sonnet-5-5").await;
    let res = post_chat(addr, "gpt-4.1", "ses_fail").await;
    assert_eq!(res.status(), reqwest::StatusCode::BAD_GATEWAY);
    assert_eq!(locked(&store, "ses_fail").await, None);
}

/// No credential for the locked model at all: the 402 releases the lock too.
#[tokio::test]
async fn a_402_for_a_missing_credential_releases_the_lock() {
    let _guard = serial();
    let _u = upstreams().await;
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;
    lock(&store, "ses_402", "claude-sonnet-5-5").await;

    let res = post_messages(addr, "claude-sonnet-5-5", "ses_402").await;
    assert_eq!(res.status(), reqwest::StatusCode::PAYMENT_REQUIRED);
    assert_eq!(locked(&store, "ses_402").await, None);
}

/// The Gemini route carries its model in the URL, which this proxy does not
/// read. It used to be forwarded to OpenAI's chat endpoint as a Gemini body;
/// it is refused, and nothing is sent.
#[tokio::test]
async fn the_gemini_route_is_refused_rather_than_sent_to_openai() {
    let _guard = serial();
    let u = upstreams().await;
    grant_operator_keys(&["openai", "gemini"]);
    let store = Arc::new(MemoryStore::new());
    let addr = serve(Workspace::default(), Arc::clone(&store)).await;

    let res = post(
        addr,
        "/v1beta/models/gemini-3.8-flash:generateContent",
        "ses_gemini_route",
        json!({"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}),
    )
    .await;
    let status = res.status();
    let body = res.text().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("unsupported_route"), "{body}");
    assert_eq!(hits(&u.openai).await, 0);
    assert_eq!(hits(&u.gemini).await, 0);
}

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

/// The keys the control plane writes (`syncSettingsToValkey`,
/// `providerVerify.ts`) are the keys the proxy reads, in the same shape. An
/// empty candidate list reads as unset, never as a pool of nothing.
#[tokio::test]
async fn the_valkey_cache_reads_what_the_control_plane_writes() {
    use redis::AsyncCommands;
    let Some(conn) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let ws = format!("test-smart-routing-{nanos}");
    let candidates_key = format!("workspace:routing_candidates:{ws}");
    let models_key = format!("workspace:provider_models:{ws}");
    let mut c = (*conn).clone();
    let _: () = c
        .set(&candidates_key, r#"["gpt-4.1"," ","claude-sonnet-5-5"]"#)
        .await
        .unwrap();
    let _: () = c
        .hset(
            &models_key,
            "anthropic",
            r#"{"models":["claude-sonnet-5-5-20260101"],"checkedAt":"2026-10-10T00:00:00.000Z"}"#,
        )
        .await
        .unwrap();
    let cache = intutic_proxy::store::ValkeyControlPlaneCache::new(Arc::clone(&conn));

    assert_eq!(
        cache.routing_candidates(&ws).await,
        Some(strings(&["gpt-4.1", "claude-sonnet-5-5"]))
    );
    assert_eq!(
        cache.provider_models(&ws, "anthropic").await,
        Some(strings(&["claude-sonnet-5-5-20260101"]))
    );
    assert_eq!(cache.provider_models(&ws, "openai").await, None);

    let _: () = c.set(&candidates_key, "[]").await.unwrap();
    assert_eq!(cache.routing_candidates(&ws).await, None);

    let _: () = c.del(&[&candidates_key, &models_key]).await.unwrap();
}

/// A mirror copy goes to the candidate's own provider with that provider's
/// key. It used to reuse the served request's URL and key, so a DeepSeek
/// candidate for a Claude request was posted to Anthropic and failed unseen.
/// Sampling is random and capped at 5%, so this sends enough requests that a
/// run without a single mirrored call is a one-in-millions event.
#[tokio::test]
async fn a_mirror_copy_goes_to_the_candidates_own_provider() {
    let _guard = serial();
    let u = upstreams().await;
    let deepseek = MockServer::start().await;
    std::env::set_var("DEEPSEEK_UPSTREAM_URL", deepseek.uri());
    grant_operator_keys(&["anthropic", "deepseek"]);
    mount(
        &u.anthropic,
        "/v1/messages",
        "claude-sonnet-5-5",
        messages_ok("from claude"),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/anthropic/v1/messages"))
        .and(body_string_contains("deepseek-chat"))
        .and(wiremock::matchers::header(
            "x-api-key",
            operator_key("deepseek").as_str(),
        ))
        .respond_with(messages_ok("from deepseek"))
        .mount(&deepseek)
        .await;
    let store = Arc::new(MemoryStore::new());
    let config = r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
    mirror_sample_rate: 0.05
    mirror_candidate_model: deepseek-chat
"#;
    let addr = serve_with(config, Workspace::default(), Arc::clone(&store)).await;

    let mut mirrored = 0;
    for _ in 0..300 {
        let body = post_messages(addr, "claude-sonnet-5-5", "ses_mirror")
            .await
            .text()
            .await
            .unwrap();
        assert!(body.contains("from claude"), "{body}");
        mirrored = hits(&deepseek).await;
        if mirrored > 0 {
            break;
        }
    }
    // The copy is spawned after the answer; give it a moment to land.
    for _ in 0..50 {
        if hits(&deepseek).await > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    mirrored = mirrored.max(hits(&deepseek).await);
    assert!(mirrored > 0, "no mirror copy reached DeepSeek's own API");
    let anthropic_bodies = u.anthropic.received_requests().await.unwrap_or_default();
    assert!(
        anthropic_bodies
            .iter()
            .all(|r| !String::from_utf8_lossy(&r.body).contains("deepseek-chat")),
        "a mirror copy was sent to the served request's upstream"
    );
    std::env::remove_var("DEEPSEEK_UPSTREAM_URL");
    std::env::remove_var("DEEPSEEK_API_KEY");
}
