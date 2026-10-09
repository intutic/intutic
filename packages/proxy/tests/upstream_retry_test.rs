//! End-to-end: upstream retries and fallbacks through the real router.
//!
//! Every test drives a real request through `build_router` at a mock
//! upstream — wiremock where an HTTP answer is enough, a raw TCP listener
//! where the failure is the connection itself (a reset before any response,
//! or a stream cut after the first event). What is asserted is what the
//! caller and the upstream can observe: the status, the
//! `x-intutic-upstream-attempts` / `x-intutic-upstream-fallback-from`
//! headers, how many calls the upstream received, and how long it took.
//! The trace fields themselves are pinned at the unit level
//! (`routing::retry`, `telemetry.rs`): `MemoryStore::publish_trace` keeps
//! nothing a test can read back.

// `serial()`'s guard is held across awaits on purpose: the upstream URLs are
// process-global env vars, so these tests must not overlap.
#![allow(clippy::await_holding_lock)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

// Runtime-assembled: the repo convention forbids contiguous credential-shaped
// literals in source.
fn virtual_key() -> String {
    [
        "Bearer vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_retry_test",
    ]
    .concat()
}

fn operator_key(provider: &str) -> String {
    ["test-", provider, "-operator-key"].concat()
}

async fn build_app(
    config_yaml: &str,
    store: Arc<intutic_proxy::store::MemoryStore>,
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
    addr
}

async fn app_with(config_yaml: &str) -> std::net::SocketAddr {
    build_app(
        config_yaml,
        Arc::new(intutic_proxy::store::MemoryStore::new()),
    )
    .await
}

fn set_env(anthropic: &str, openai: &str) {
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", anthropic);
    std::env::set_var("OPENAI_UPSTREAM_URL", openai);
    std::env::set_var("ANTHROPIC_API_KEY", operator_key("anthropic"));
    std::env::set_var("OPENAI_API_KEY", operator_key("openai"));
    std::env::remove_var("UPSTREAM_URL");
    std::env::remove_var("CONTROL_PLANE_URL");
}

const NO_ROUTING: &str = "model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n";

fn messages_ok() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "id": "msg_retry_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [{"type": "text", "text": "served after a retry"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    }))
}

fn chat_ok(model: &str, text: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "id": "chatcmpl-retry-test",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    }))
}

async fn post_messages(addr: std::net::SocketAddr, stream: bool) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}/v1/messages"))
        .header("Authorization", virtual_key())
        .header("x-workspace-id", "ws_retry_test")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-5",
            "max_tokens": 64,
            "stream": stream,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable")
}

async fn post_chat(addr: std::net::SocketAddr, model: &str, session: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .header("Authorization", virtual_key())
        .header("x-workspace-id", "ws_retry_test")
        .header("x-session-id", session)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable")
}

fn header_str(res: &reqwest::Response, name: &str) -> Option<String> {
    res.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

async fn hits(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .expect("recording on")
        .len()
}

/// A 529 with `retry-after-ms` is retried after exactly that wait, and the
/// caller sees only the success — plus the header saying it took two calls.
#[tokio::test]
async fn an_overloaded_529_is_retried_after_the_providers_own_delay() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(529)
                .insert_header("retry-after-ms", "150")
                .set_body_json(serde_json::json!({
                    "type": "error",
                    "error": {"type": "overloaded_error", "message": "Overloaded"}
                })),
        )
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(messages_ok())
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(NO_ROUTING).await;

    let started = Instant::now();
    let res = post_messages(addr, false).await;
    let elapsed = started.elapsed();
    let status = res.status();
    let attempts = header_str(&res, "x-intutic-upstream-attempts");
    let body = res.text().await.expect("body");

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("served after a retry"), "{body}");
    assert_eq!(attempts.as_deref(), Some("2"));
    assert_eq!(hits(&upstream).await, 2);
    assert!(
        elapsed >= Duration::from_millis(150),
        "the retry must wait the provider's retry-after-ms; took {elapsed:?}"
    );
}

/// Success after N failures: two 429s (`retry-after: 0`), then a 200, inside
/// the default three attempts.
#[tokio::test]
async fn a_rate_limit_is_retried_until_it_succeeds() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "0")
                .set_body_json(serde_json::json!({
                    "error": {"message": "Rate limit reached", "type": "requests", "code": "rate_limit_exceeded"}
                })),
        )
        .up_to_n_times(2)
        .with_priority(1)
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(chat_ok("gpt-4o", "third time lucky"))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(NO_ROUTING).await;

    let res = post_chat(addr, "gpt-4o", "ses_rate_limit").await;
    let status = res.status();
    let attempts = header_str(&res, "x-intutic-upstream-attempts");
    let body = res.text().await.expect("body");

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("third time lucky"), "{body}");
    assert_eq!(attempts.as_deref(), Some("3"));
    assert_eq!(hits(&upstream).await, 3);
}

/// A spend cap answers 429 too, but waiting does not clear it: no retry.
#[tokio::test]
async fn a_spend_cap_429_is_not_retried() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
            "type": "error",
            "error": {
                "type": "rate_limit_error",
                "message": "You have reached your specified API usage limits.",
                "details": {"error_code": "enforced_spend_limit_reached"}
            }
        })))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(NO_ROUTING).await;

    let res = post_messages(addr, false).await;
    let status = res.status();
    let body = res.text().await.expect("body");

    assert_eq!(status.as_u16(), 429);
    assert!(
        body.contains("enforced_spend_limit_reached"),
        "the provider's body passes through untouched: {body}"
    );
    assert_eq!(hits(&upstream).await, 1);
}

/// A request the provider rejects as malformed would fail the same way again.
#[tokio::test]
async fn a_client_error_is_not_retried() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "max_tokens: field required"}
        })))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(NO_ROUTING).await;

    let res = post_messages(addr, false).await;
    assert_eq!(res.status().as_u16(), 400);
    assert_eq!(hits(&upstream).await, 1);
}

/// `retry.enabled: false` makes exactly one call, whatever comes back.
#[tokio::test]
async fn retries_off_makes_one_call() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(529))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(
        "model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n    retry:\n      enabled: false\n",
    )
    .await;

    let res = post_messages(addr, false).await;
    assert_eq!(res.status().as_u16(), 529);
    assert!(res.headers().get("x-intutic-upstream-attempts").is_none());
    assert_eq!(hits(&upstream).await, 1);
}

/// A provider that asks for longer than the budget allows gets no retry: its
/// answer, `retry-after` included, goes straight back so the caller's own
/// client can wait.
#[tokio::test]
async fn a_retry_after_beyond_the_budget_is_passed_through_at_once() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(529).insert_header("retry-after", "30"))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(
        "model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n    retry:\n      budget_ms: 1000\n",
    )
    .await;

    let started = Instant::now();
    let res = post_messages(addr, false).await;
    let elapsed = started.elapsed();

    assert_eq!(res.status().as_u16(), 529);
    assert_eq!(header_str(&res, "retry-after").as_deref(), Some("30"));
    assert_eq!(hits(&upstream).await, 1);
    assert!(elapsed < Duration::from_secs(5), "took {elapsed:?}");
}

/// The budget bounds the whole request. Each 503 asks for 400 ms; a 1000 ms
/// budget fits two waits and not a third, so five allowed attempts become
/// three calls.
#[tokio::test]
async fn the_time_budget_stops_retries_before_max_attempts() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(503).insert_header("retry-after-ms", "400"))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(
        "model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n    retry:\n      max_attempts: 5\n      budget_ms: 1000\n",
    )
    .await;

    let started = Instant::now();
    let res = post_messages(addr, false).await;
    let elapsed = started.elapsed();

    assert_eq!(res.status().as_u16(), 503);
    assert_eq!(
        header_str(&res, "x-intutic-upstream-attempts").as_deref(),
        Some("3")
    );
    assert_eq!(hits(&upstream).await, 3);
    assert!(elapsed < Duration::from_millis(1500), "took {elapsed:?}");
}

/// Reads one HTTP request off `socket` — headers plus a Content-Length body —
/// so a reply (or a hang-up) comes after the proxy has sent everything.
async fn read_request(socket: &mut tokio::net::TcpStream) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = socket.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf);
        if let Some(end) = text.find("\r\n\r\n") {
            let len = text[..end]
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                return;
            }
        }
    }
}

/// A listener whose connections are handled by `respond(n, socket)`, where
/// `n` counts connections from 0.
async fn raw_upstream<F, Fut>(respond: F) -> (String, Arc<AtomicUsize>)
where
    F: Fn(usize, tokio::net::TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&count);
    let respond = Arc::new(respond);
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            let respond = Arc::clone(&respond);
            tokio::spawn(async move { respond(n, socket).await });
        }
    });
    (url, count)
}

/// A connection the upstream drops without answering is a transport failure
/// before any response, and is retried.
#[tokio::test]
async fn a_connection_reset_is_retried() {
    let _guard = serial();
    let (url, connections) = raw_upstream(|n, mut socket| async move {
        read_request(&mut socket).await;
        if n == 0 {
            // Hang up with no response at all.
            return;
        }
        let body = r#"{"id":"msg_reset","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"served after a reset"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}"#;
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(reply.as_bytes()).await;
        let _ = socket.shutdown().await;
    })
    .await;
    set_env(&url, &url);
    let addr = app_with(NO_ROUTING).await;

    let res = post_messages(addr, false).await;
    let status = res.status();
    let attempts = header_str(&res, "x-intutic-upstream-attempts");
    let body = res.text().await.expect("body");

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("served after a reset"), "{body}");
    assert_eq!(attempts.as_deref(), Some("2"));
    assert_eq!(connections.load(Ordering::SeqCst), 2);
}

/// Once a 2xx stream has started, a failure is never retried: the client may
/// already hold part of the answer.
#[tokio::test]
async fn a_stream_cut_after_it_started_is_not_retried() {
    let _guard = serial();
    let (url, connections) = raw_upstream(|_, mut socket| async move {
        read_request(&mut socket).await;
        let event = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_cut\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n";
        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
        let chunk = format!("{:x}\r\n{}\r\n", event.len(), event);
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(chunk.as_bytes()).await;
        let _ = socket.flush().await;
        // Cut the stream mid-body: no terminating chunk.
        tokio::time::sleep(Duration::from_millis(50)).await;
    })
    .await;
    set_env(&url, &url);
    let addr = app_with(NO_ROUTING).await;

    let res = post_messages(addr, true).await;
    assert!(
        res.status().is_success(),
        "the head was a 200: {}",
        res.status()
    );
    assert!(res.headers().get("x-intutic-upstream-attempts").is_none());
    // Drain whatever the proxy forwards; the cut may surface as an error.
    let _ = res.bytes().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        connections.load(Ordering::SeqCst),
        1,
        "a stream that had started must not be re-requested"
    );
}

/// Retries exhausted on the routed model: the fallback chain runs in order —
/// a target on another wire shape is skipped, a target on another provider
/// is called with that provider's own credential — and the session lock is
/// left on the routed model, whose prompt cache the next turn returns to.
#[tokio::test]
async fn exhausted_retries_fall_back_in_order_and_keep_the_session_lock() {
    let _guard = serial();
    let openai = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("gpt-primary"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&openai)
        .await;
    let mistral = MockServer::start().await;
    let mistral_bearer = ["Bearer ", &operator_key("mistral")].concat();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("mistral-small-latest"))
        .and(header("authorization", mistral_bearer.as_str()))
        .respond_with(chat_ok("mistral-small-latest", "served by the fallback"))
        .mount(&mistral)
        .await;
    set_env(&openai.uri(), &openai.uri());
    std::env::set_var("MISTRAL_UPSTREAM_URL", mistral.uri());
    std::env::set_var("MISTRAL_API_KEY", operator_key("mistral"));

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let addr = build_app(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: true
    mode: enforce
    candidate_models: ["gpt-primary", "gpt-other"]
    retry:
      initial_backoff_ms: 1
      max_backoff_ms: 1
    fallbacks:
      gpt-primary:
        - model: claude-sonnet-4-5
        - model: mistral-small-latest
          provider: mistral
"#,
        Arc::clone(&store),
    )
    .await;
    let session_id = "ses_fallback_test";
    let scope = format!("ws_retry_test:{session_id}");
    use intutic_proxy::store::LocalStore as _;
    store
        .set_session_locked_model(&scope, "gpt-primary")
        .await
        .expect("pre-lock");

    let res = post_chat(addr, "gpt-primary", session_id).await;
    let status = res.status();
    let attempts = header_str(&res, "x-intutic-upstream-attempts");
    let fallback_from = header_str(&res, "x-intutic-upstream-fallback-from");
    let routed_to = header_str(&res, "x-intutic-routed-to");
    let body = res.text().await.expect("body");

    assert!(status.is_success(), "status={status} body={body}");
    assert!(body.contains("served by the fallback"), "{body}");
    // Three calls to the routed model, then the Mistral target; the Claude
    // target was skipped, not called.
    assert_eq!(attempts.as_deref(), Some("4"));
    assert_eq!(fallback_from.as_deref(), Some("gpt-primary"));
    assert_eq!(routed_to.as_deref(), Some("mistral-small-latest"));
    assert_eq!(hits(&openai).await, 3);
    assert_eq!(hits(&mistral).await, 1);

    let session = store.session_routing(&scope).await.expect("session");
    assert_eq!(
        session.locked_model.as_deref(),
        Some("gpt-primary"),
        "a fallback must never move the session lock"
    );
    std::env::remove_var("MISTRAL_UPSTREAM_URL");
    std::env::remove_var("MISTRAL_API_KEY");
}

/// When every fallback fails too, the caller gets the routed model's own
/// error — the one about the request it made.
#[tokio::test]
async fn when_every_fallback_fails_the_primary_error_is_returned() {
    let _guard = serial();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("gpt-primary"))
        .respond_with(ResponseTemplate::new(503).set_body_string("primary overloaded"))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("gpt-backup"))
        .respond_with(ResponseTemplate::new(400).set_body_string("backup rejects this"))
        .mount(&upstream)
        .await;
    set_env(&upstream.uri(), &upstream.uri());
    let addr = app_with(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
    retry:
      max_attempts: 2
      initial_backoff_ms: 1
      max_backoff_ms: 1
    fallbacks:
      gpt-primary:
        - model: gpt-backup
"#,
    )
    .await;

    let res = post_chat(addr, "gpt-primary", "ses_all_fail").await;
    let status = res.status();
    let attempts = header_str(&res, "x-intutic-upstream-attempts");
    let fallback_from = header_str(&res, "x-intutic-upstream-fallback-from");
    let body = res.text().await.expect("body");

    assert_eq!(status.as_u16(), 503, "body={body}");
    assert_eq!(body, "primary overloaded");
    assert_eq!(attempts.as_deref(), Some("3"));
    assert!(fallback_from.is_none());
}
