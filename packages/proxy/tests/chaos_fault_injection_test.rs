//! End-to-end: the chaos fault stage on the real router.
//!
//! One plan is installed for this whole test binary (a process carries one
//! plan for its lifetime, exactly as a chaos repetition's dedicated proxy
//! does). Each test owns its faults through a model or host no other test
//! uses, so their counters never interfere, and reads back only the event
//! lines whose `target` it owns.
//!
//! What every test pins: the status and body the agent sees, the canary in
//! the error text, and the `fault_injected` / `llm_usage` lines the runner's
//! probes read. The last test pins the rule the stage exists under: a request
//! governance blocked gets no fault and is not even counted.

// `serial()`'s guard is held across awaits on purpose: the upstream URL is a
// process-global env var, so these tests must not overlap.
#![allow(clippy::await_holding_lock)]

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, Uri};
use base64::Engine as _;
use serde_json::{json, Value};
use wiremock::matchers::{body_partial_json, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

use intutic_proxy::chaos::{self, ChaosPlan, EventSink};
use intutic_proxy::tls_mitm::handle_connect;

const CANARY: &str = "E-INTUTIC-C0FFEE";

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

static EVENTS: OnceLock<PathBuf> = OnceLock::new();

/// Install this binary's plan once, through the same base64url path the
/// runner's environment variable takes.
fn events_path() -> &'static PathBuf {
    EVENTS.get_or_init(|| {
        let plan = json!({
            "v": 1,
            "runId": "run_proxy_it",
            "repetition": 1,
            "canary": CANARY,
            "faults": [
                {"id": "llm.rate_limit", "match": {"model": "claude-chaos-ratelimit"}, "after_calls": 1, "times": 1, "retry_after_s": 7},
                {"id": "llm.rate_limit", "match": {"model": "gpt-chaos-ratelimit"}},
                {"id": "llm.upstream_5xx", "match": {"model": "claude-chaos-5xx"}, "status": 529},
                {"id": "llm.upstream_5xx", "match": {"model": "claude-chaos-cut"}, "stream_cut_after_chunks": 2},
                {"id": "llm.context_trim", "match": {"model": "claude-chaos-trim"}, "drop_oldest": 1, "drop_system": true},
                {"id": "llm.model_degrade", "match": {"model": "claude-chaos-big"}, "to_model": "claude-chaos-small"},
                {"id": "egress.dns_fail", "match": {"host": "*.npmjs.org"}},
                {"id": "egress.credential_401", "match": {"host": "api.github.com"}},
                {"id": "egress.credential_401", "match": {"host": "git.example.test"}},
                {"id": "egress.credential_401", "match": {"host": "api.openai.com"}},
                {"id": "llm.rate_limit", "match": {"model": "claude-chaos-governed"}}
            ]
        });
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(plan.to_string());
        let path =
            std::env::temp_dir().join(format!("intutic-chaos-{}.jsonl", uuid::Uuid::new_v4()));
        let sink = EventSink::open(&path).expect("events file opens");
        chaos::install(chaos::Chaos::new(
            ChaosPlan::decode(&raw).expect("plan decodes"),
            sink,
        ));
        path
    })
}

fn events() -> Vec<Value> {
    std::fs::read_to_string(events_path())
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).expect("every event line is one JSON object"))
        .collect()
}

fn injected(target: &str) -> Vec<Value> {
    events()
        .into_iter()
        .filter(|e| e["type"] == "fault_injected" && e["target"] == target)
        .collect()
}

async fn build_app() -> std::net::SocketAddr {
    events_path();
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
"#,
    )
    .expect("config parses");
    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: store as Arc<dyn intutic_proxy::store::LocalStore>,
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
    addr
}

/// Point both providers at `upstream` with runtime-assembled operator keys:
/// a virtual key is never forwarded, so the request needs a provider key.
fn use_upstream(upstream: &str) {
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream);
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream);
    std::env::set_var("ANTHROPIC_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::remove_var("CONTROL_PLANE_URL");
}

fn vk() -> String {
    // Runtime-assembled: no contiguous credential-shaped literal in source.
    [
        "Bearer vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_chaos_test",
    ]
    .concat()
}

async fn post(
    client: &reqwest::Client,
    url: &str,
    body: Value,
) -> (StatusCode, reqwest::header::HeaderMap, String) {
    let res = client
        .post(url)
        .header("Authorization", vk())
        .header("x-workspace-id", "ws_chaos_test")
        .json(&body)
        .send()
        .await
        .expect("proxy reachable");
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap();
    let headers = res.headers().clone();
    (status, headers, res.text().await.expect("body reads"))
}

fn messages(model: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "hello"}]
    })
}

fn anthropic_ok(model: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "id": "msg_chaos",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [{"type": "text", "text": "hi"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 12, "output_tokens": 3}
    }))
}

fn assert_canary(body: &str) {
    assert!(
        body.contains(&format!("[{CANARY}]")),
        "the injected error must carry the canary: {body}"
    );
}

#[tokio::test]
async fn plan_loaded_is_reported_once() {
    let _serial = serial();
    events_path();
    let loaded: Vec<Value> = events()
        .into_iter()
        .filter(|e| e["type"] == "plan_loaded")
        .collect();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0]["faults"], 11);
    assert_eq!(loaded[0]["runId"], "run_proxy_it");
    assert_eq!(loaded[0]["component"], "proxy");
}

#[tokio::test]
async fn rate_limit_hits_only_the_calls_after_calls_and_times_select() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(anthropic_ok("claude-chaos-ratelimit"))
        .expect(2)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/v1/messages");

    let (first, _, _) = post(&client, &url, messages("claude-chaos-ratelimit")).await;
    assert_eq!(first, StatusCode::OK, "after_calls 1 skips the first call");

    let (second, headers, body) = post(&client, &url, messages("claude-chaos-ratelimit")).await;
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers["retry-after"], "7");
    let v: Value = serde_json::from_str(&body).expect("JSON error body");
    assert_eq!(v["type"], "error", "Anthropic-shaped for a Messages call");
    assert_eq!(v["error"]["type"], "rate_limit_error");
    assert_canary(&body);

    let (third, _, _) = post(&client, &url, messages("claude-chaos-ratelimit")).await;
    assert_eq!(third, StatusCode::OK, "times 1 stops after one injection");

    let hits = injected("claude-chaos-ratelimit");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "llm.rate_limit");
    assert_eq!(hits[0]["call"], 2);
    upstream.verify().await;
}

#[tokio::test]
async fn rate_limit_on_chat_completions_is_openai_shaped() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    let (status, headers, body) = post(
        &reqwest::Client::new(),
        &format!("http://{addr}/v1/chat/completions"),
        json!({"model": "gpt-chaos-ratelimit", "messages": [{"role": "user", "content": "hi"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers["retry-after"], "5", "the contract's default");
    let v: Value = serde_json::from_str(&body).expect("JSON error body");
    assert_eq!(v["error"]["code"], "rate_limit_exceeded");
    assert_canary(v["error"]["message"].as_str().unwrap());
    assert_eq!(injected("gpt-chaos-ratelimit").len(), 1);
    upstream.verify().await;
}

#[tokio::test]
async fn upstream_5xx_fails_the_call_without_forwarding() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    let (status, _, body) = post(
        &reqwest::Client::new(),
        &format!("http://{addr}/v1/messages"),
        messages("claude-chaos-5xx"),
    )
    .await;
    assert_eq!(status.as_u16(), 529);
    let v: Value = serde_json::from_str(&body).expect("JSON error body");
    assert_eq!(v["error"]["type"], "overloaded_error");
    assert_canary(&body);
    let hits = injected("claude-chaos-5xx");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "llm.upstream_5xx");
    upstream.verify().await;
}

fn anthropic_sse() -> String {
    let events = [
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "msg_cut", "type": "message", "role": "assistant", "model": "claude-chaos-cut", "content": [], "usage": {"input_tokens": 9, "output_tokens": 0}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "never seen"}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ];
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}

#[tokio::test]
async fn upstream_5xx_with_a_stream_cut_forwards_then_cuts_the_stream() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(anthropic_sse(), "text/event-stream"),
        )
        .expect(1)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    let mut req = messages("claude-chaos-cut");
    req["stream"] = json!(true);
    let (status, _, body) = post(
        &reqwest::Client::new(),
        &format!("http://{addr}/v1/messages"),
        req,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a cut stream has already started: 200"
    );
    assert!(
        body.starts_with("event: message_start\ndata: "),
        "the first two chunks are forwarded: {body}"
    );
    assert!(
        !body.contains("never seen") && !body.contains("message_stop"),
        "nothing after the cut reaches the client: {body}"
    );
    assert!(body.contains("event: error"), "{body}");
    assert_canary(&body);
    let hits = injected("claude-chaos-cut");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "llm.upstream_5xx");

    // A streamed response's usage is reported when the stream task finishes,
    // which can be just after the client's body ends. The counts are whatever
    // the proxy's own accounting made of a stream the client stopped reading,
    // so only their presence is pinned here.
    let mut usage = Vec::new();
    for _ in 0..50 {
        usage = events()
            .into_iter()
            .filter(|e| e["type"] == "llm_usage" && e["model"] == "claude-chaos-cut")
            .collect();
        if !usage.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(usage.len(), 1, "streamed usage is reported too");
    assert!(usage[0]["inputTokens"].is_u64() && usage[0]["outputTokens"].is_u64());
    assert!(usage[0]["costUsd"].as_f64().is_some_and(|c| c >= 0.0));
    upstream.verify().await;
}

#[tokio::test]
async fn context_trim_drops_the_oldest_message_and_the_system_prompt() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(anthropic_ok("claude-chaos-trim"))
        .expect(1)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    let (status, _, _) = post(
        &reqwest::Client::new(),
        &format!("http://{addr}/v1/messages"),
        json!({
            "model": "claude-chaos-trim",
            "max_tokens": 16,
            "system": "remember the plan",
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "second"},
                {"role": "user", "content": "third"}
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let received = upstream.received_requests().await.expect("recording on");
    let sent: Value = serde_json::from_slice(&received[0].body).expect("JSON request");
    assert!(
        sent.get("system").is_none(),
        "system prompt dropped: {sent}"
    );
    let contents: Vec<&str> = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    assert_eq!(contents, vec!["second", "third"]);
    assert_eq!(injected("claude-chaos-trim").len(), 1);
    upstream.verify().await;
}

#[tokio::test]
async fn model_degrade_forwards_the_smaller_model_and_hides_the_swap() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(body_partial_json(json!({"model": "claude-chaos-small"})))
        .respond_with(anthropic_ok("claude-chaos-small"))
        .expect(1)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    let (status, headers, body) = post(
        &reqwest::Client::new(),
        &format!("http://{addr}/v1/messages"),
        messages("claude-chaos-big"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v: Value = serde_json::from_str(&body).expect("JSON response");
    assert_eq!(
        v["model"], "claude-chaos-big",
        "the requested id is restored"
    );
    assert!(
        headers.get("x-intutic-routed-to").is_none(),
        "no routing header gives the swap away"
    );

    let hits = injected("claude-chaos-big");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "llm.model_degrade");
    assert_eq!(hits[0]["call"], 1);

    let usage: Vec<Value> = events()
        .into_iter()
        .filter(|e| e["type"] == "llm_usage" && e["model"] == "claude-chaos-small")
        .collect();
    assert_eq!(
        usage.len(),
        1,
        "usage is reported for the model that served"
    );
    assert_eq!(usage[0]["inputTokens"], 12);
    assert_eq!(usage[0]["outputTokens"], 3);
    assert!(usage[0]["costUsd"].as_f64().unwrap() >= 0.0);
    upstream.verify().await;
}

fn connect_req(authority: &str) -> Request<Body> {
    let uri: Uri = authority.parse().expect("authority-form uri parses");
    Request::builder()
        .method(Method::CONNECT)
        .uri(uri)
        .body(Body::empty())
        .expect("request builds")
}

async fn body_text(resp: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body reads");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn egress_faults_refuse_the_connect_for_a_matching_host() {
    let _serial = serial();
    events_path();

    let dns = handle_connect(connect_req("registry.npmjs.org:443")).await;
    assert_eq!(dns.status(), StatusCode::BAD_GATEWAY);
    let text = body_text(dns).await;
    assert!(text.contains("could not resolve host registry.npmjs.org"));
    assert_canary(&text);
    let hits = injected("registry.npmjs.org");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "egress.dns_fail");

    // An opaque tunnel: the 401 cannot be written inside it, so the CONNECT
    // itself is refused with one.
    let cred = handle_connect(connect_req("api.github.com:443")).await;
    assert_eq!(cred.status(), StatusCode::UNAUTHORIZED);
    assert_canary(&body_text(cred).await);
    assert_eq!(injected("api.github.com").len(), 1);

    // An intercepted provider host keeps its tunnel; its requests are
    // answered with the 401 inside it (next test).
    // The other test's HTTP 401 for this host may already be in the file,
    // so the CONNECT is checked to add nothing rather than for an empty list.
    let before = injected("api.openai.com").len();
    let intercepted = handle_connect(connect_req("api.openai.com:443")).await;
    assert_eq!(intercepted.status(), StatusCode::OK);
    assert_eq!(injected("api.openai.com").len(), before);

    // A host no fault names is untouched.
    let other = handle_connect(connect_req("crates.io:443")).await;
    assert_eq!(other.status(), StatusCode::OK);
}

#[tokio::test]
async fn credential_401_answers_in_http_where_the_proxy_sees_the_request() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;

    // A plain forward: the absolute-form request names the host.
    let forwarding = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{addr}")).expect("proxy url"))
        .build()
        .expect("client builds");
    let (status, _, body) = post(
        &forwarding,
        "http://git.example.test/v1/messages",
        messages("claude-3-5-haiku-20241022"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_canary(&body);
    let hits = injected("git.example.test");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["faultId"], "egress.credential_401");

    // A TLS-intercepted provider request reaches the router with the
    // provider's host in `Host`.
    let res = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header("host", "api.openai.com")
        .header("Authorization", vk())
        .header("x-workspace-id", "ws_chaos_test")
        .json(&json!({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .expect("proxy reachable");
    assert_eq!(res.status().as_u16(), 401);
    let v: Value = serde_json::from_str(&res.text().await.unwrap()).expect("JSON");
    assert_eq!(v["error"]["code"], "invalid_api_key", "OpenAI-shaped");
    assert_canary(v["error"]["message"].as_str().unwrap());
    let hits = injected("api.openai.com");
    assert_eq!(
        hits.len(),
        1,
        "the intercepted CONNECT itself is never counted"
    );
    assert_eq!(hits[0]["call"], 1);
    upstream.verify().await;
}

#[tokio::test]
async fn a_request_governance_blocked_gets_no_fault_and_is_not_counted() {
    let _serial = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&upstream)
        .await;
    use_upstream(&upstream.uri());
    let addr = build_app().await;
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/v1/messages");

    // Input DLP blocks a private key. The fault matches this model on every
    // call, so only governance can explain the absence of a fault.
    let pem = format!("-----BEGIN {} KEY-----", "PRIVATE");
    let mut blocked = messages("claude-chaos-governed");
    blocked["messages"][0]["content"] = json!(format!("store this {pem}"));
    let (status, _, body) = post(&client, &url, blocked).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("dlp_policy_violation"), "{body}");
    assert!(
        !body.contains(CANARY),
        "a governance refusal is not a fault"
    );
    assert!(
        injected("claude-chaos-governed").is_empty(),
        "no fault_injected for a blocked request"
    );

    // The next, allowed call is the fault's FIRST matching call: the blocked
    // one never reached the stage, so it was not counted either.
    let (status, _, _) = post(&client, &url, messages("claude-chaos-governed")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let hits = injected("claude-chaos-governed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["call"], 1);
    upstream.verify().await;
}

/// A chaos run's traces must not reach the shared local trace log: the sync
/// daemon uploads that log to the connected workspace, where injected failures
/// would read as real ones.
#[tokio::test]
async fn a_chaos_run_writes_nothing_to_the_shared_trace_log() {
    let _guard = serial();
    events_path();
    let home = std::env::temp_dir().join(format!("intutic-chaos-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("temp home");
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    intutic_proxy::local_spend::log_offline_trace(&json!({"trace_id": "chaos-trace"}));
    match previous {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
    let logs = home.join(".intutic").join("logs");
    let written = std::fs::read_dir(&logs).map(|d| d.count()).unwrap_or(0);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(written, 0, "no trace file may appear under {}", logs.display());
}
