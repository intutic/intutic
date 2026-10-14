//! A proxy with Valkey and no control plane passes the caller's own provider
//! key through, as a standalone proxy does.
//!
//! `intutic start` runs a local Valkey whenever Docker is up, and a proxy that
//! finds one uses Valkey's auth cache. Nothing writes that cache without a
//! control plane, so every token missed it, and a miss with no control plane
//! to ask was a 401 "Virtual API key is invalid, expired, or revoked." —
//! for a provider key that was never a virtual key. Whether a token is
//! authenticated is decided by whether a control plane is configured, not by
//! whether Valkey answered.
//!
//! A runtime skip without `VALKEY_URL` (CI sets it), as in
//! `key_limits_valkey_test.rs`. ONE `#[tokio::test]`: upstream URLs and `HOME`
//! are process-global.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{header, method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

use intutic_proxy::store::{ValkeyControlPlaneCache, ValkeyStore};

// Runtime-assembled per the repo's fixture rule.
fn anthropic_key() -> String {
    ["sk-ant-", "api03-", "LOCALVALKEYTEST", "0123456789"].concat()
}
fn openai_key() -> String {
    ["sk-", "proj-", "LOCALVALKEYTEST", "0123456789"].concat()
}
fn virtual_key() -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", "ws_local"].concat()
}

/// The caller's key in either header an Anthropic client authenticates with:
/// `x-api-key` for an API key, `Authorization: Bearer` for an OAuth token.
struct CarriesKey(String);

impl Match for CarriesKey {
    fn matches(&self, r: &Request) -> bool {
        let bearer = format!("Bearer {}", self.0);
        r.headers
            .get("x-api-key")
            .is_some_and(|v| v.as_bytes() == self.0.as_bytes())
            || r.headers
                .get("authorization")
                .is_some_and(|v| v.as_bytes() == bearer.as_bytes())
    }
}

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

/// Serves `config` over the Valkey-backed stores `main.rs` builds when Valkey
/// answers.
async fn serve(config: &str, conn: Arc<redis::aio::ConnectionManager>) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str(config).expect("config parses");
    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::new(ValkeyStore::new(conn.clone())),
        control_plane: Arc::new(ValkeyControlPlaneCache::new(conn)),
        context_snapshot_rate: 0.0,
    };
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .ok();
    });
    addr
}

async fn send(req: reqwest::RequestBuilder) -> (u16, String) {
    let res = req.send().await.expect("proxy reachable");
    let status = res.status().as_u16();
    (status, res.text().await.expect("body reads"))
}

#[tokio::test]
async fn provider_keys_pass_through_when_no_control_plane_is_configured() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("note: VALKEY_URL not set or unreachable — test skipped");
        return;
    };

    let home = std::env::temp_dir().join(format!(
        "intutic-valkey-no-cp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    // The upstream answers only when it receives the caller's own key, so a
    // pass means the key went through untouched.
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(CarriesKey(anthropic_key()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_local", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "Hello from upstream."}],
            "stop_reason": "end_turn", "stop_sequence": null,
            "usage": {"input_tokens": 3, "output_tokens": 4}
        })))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", format!("Bearer {}", openai_key()).as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-local", "object": "chat.completion", "model": "gpt-4o-mini",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from upstream."}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
        })))
        .mount(&upstream)
        .await;

    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // No operator key to fall back on: what reaches the upstream is the caller's.
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let client = reqwest::Client::new();
    let anthropic_body = json!({"model": "claude-sonnet-4-5", "max_tokens": 32,
                                "messages": [{"role": "user", "content": "Say hello."}]});
    let openai_body = json!({"model": "gpt-4o-mini",
                             "messages": [{"role": "user", "content": "Say hello."}]});

    // ── No control plane configured ─────────────────────────────────────
    let addr = serve("model_list: []\n", conn.clone()).await;

    // Claude Code sends an API key as `x-api-key`...
    let (status, body) = send(
        client
            .post(format!("http://{addr}/v1/messages"))
            .header("x-api-key", anthropic_key())
            .json(&anthropic_body),
    )
    .await;
    assert_eq!(status, 200, "x-api-key passes through: {body}");
    assert!(body.contains("Hello from upstream."), "{body}");

    // ...or as a bearer token.
    let (status, body) = send(
        client
            .post(format!("http://{addr}/v1/messages"))
            .header("Authorization", format!("Bearer {}", anthropic_key()))
            .json(&anthropic_body),
    )
    .await;
    assert_eq!(status, 200, "an Anthropic bearer passes through: {body}");

    let (status, body) = send(
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {}", openai_key()))
            .json(&openai_body),
    )
    .await;
    assert_eq!(status, 200, "an OpenAI bearer passes through: {body}");
    assert!(body.contains("Hello from upstream."), "{body}");

    // A virtual key cannot be checked without a control plane, and says so
    // rather than calling itself invalid.
    let (status, body) = send(
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {}", virtual_key()))
            .json(&openai_body),
    )
    .await;
    assert_eq!(status, 401, "{body}");
    let parsed: Value = serde_json::from_str(&body).expect("a JSON error");
    let message = parsed.to_string();
    assert!(
        message.contains("control plane") && !message.contains("invalid, expired, or revoked"),
        "the refusal explains that virtual keys need a control plane: {message}"
    );

    // ── Control plane configured: a provider key is still refused ───────
    let cp = MockServer::start().await;
    let addr = serve(
        &format!(
            "model_list: []\nintutic_settings:\n  policy:\n    control_plane_url: {}\n    fail_closed: false\n",
            cp.uri()
        ),
        conn,
    )
    .await;
    let (status, body) = send(
        client
            .post(format!("http://{addr}/v1/messages"))
            .header("x-api-key", anthropic_key())
            .json(&anthropic_body),
    )
    .await;
    assert_eq!(status, 401, "connected mode is unchanged: {body}");
    assert!(body.contains("invalid, expired, or revoked"), "{body}");
}
