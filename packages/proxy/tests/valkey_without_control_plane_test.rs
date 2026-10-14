//! A proxy with Valkey and no control plane handles a request exactly as a
//! standalone proxy does.
//!
//! `intutic start` runs a local Valkey whenever Docker is up, and a proxy that
//! finds one uses Valkey's auth cache. Nothing writes that cache without a
//! control plane, so every token missed it, and a miss with no control plane
//! to ask was a 401 "Virtual API key is invalid, expired, or revoked." — for a
//! provider key that was never a virtual key. There is now one rule for "no
//! control plane configured", whether or not Valkey is up: a provider key
//! passes through, and a virtual key is never forwarded, so the provider key
//! in the proxy's environment goes upstream, or the request fails as it does
//! standalone when there is none.
//!
//! Each case runs against both proxies, the Valkey-backed one and a standalone
//! one, and the answers must match. A runtime skip without `VALKEY_URL` (CI
//! sets it), as in `key_limits_valkey_test.rs`. ONE `#[tokio::test]`: upstream
//! URLs, provider keys and `HOME` are process-global.

use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

use intutic_proxy::store::{
    ControlPlaneCache, LocalStore, MemoryStore, NullControlPlaneCache, ValkeyControlPlaneCache,
    ValkeyStore,
};

// Runtime-assembled per the repo's fixture rule.
fn anthropic_key() -> String {
    ["sk-ant-", "api03-", "LOCALVALKEYTEST", "0123456789"].concat()
}
fn openai_key() -> String {
    ["sk-", "proj-", "LOCALVALKEYTEST", "0123456789"].concat()
}
fn operator_key() -> String {
    ["test", "-operator-", "key"].concat()
}
fn virtual_key() -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", "ws_local"].concat()
}

/// The key in either header a client authenticates with: `x-api-key` for an
/// Anthropic API key, `Authorization: Bearer` otherwise.
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

async fn serve(
    config: &str,
    store: Arc<dyn LocalStore>,
    control_plane: Arc<dyn ControlPlaneCache>,
) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str(config).expect("config parses");
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
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .ok();
    });
    addr
}

/// One request shape: route, auth header and body.
#[derive(Clone, Copy)]
enum Call {
    AnthropicXApiKey,
    AnthropicBearer,
    OpenAiBearer,
    VirtualKey,
}

async fn send(addr: std::net::SocketAddr, call: Call) -> (u16, String) {
    let client = reqwest::Client::new();
    let anthropic = json!({"model": "claude-sonnet-4-5", "max_tokens": 32,
                           "messages": [{"role": "user", "content": "Say hello."}]});
    let openai = json!({"model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": "Say hello."}]});
    let req = match call {
        Call::AnthropicXApiKey => client
            .post(format!("http://{addr}/v1/messages"))
            .header("x-api-key", anthropic_key())
            .json(&anthropic),
        Call::AnthropicBearer => client
            .post(format!("http://{addr}/v1/messages"))
            .header("Authorization", format!("Bearer {}", anthropic_key()))
            .json(&anthropic),
        Call::OpenAiBearer => client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {}", openai_key()))
            .json(&openai),
        Call::VirtualKey => client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {}", virtual_key()))
            .json(&openai),
    };
    let res = req.send().await.expect("proxy reachable");
    let status = res.status().as_u16();
    (status, res.text().await.expect("body reads"))
}

#[tokio::test]
async fn no_control_plane_means_standalone_whether_or_not_valkey_is_up() {
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

    // The upstream answers only a key it was meant to receive, so a pass
    // means that key, and no other, went upstream.
    let upstream = MockServer::start().await;
    for key in [anthropic_key(), operator_key()] {
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(CarriesKey(key))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "msg_local", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": "Hello from upstream."}],
                "stop_reason": "end_turn", "stop_sequence": null,
                "usage": {"input_tokens": 3, "output_tokens": 4}
            })))
            .mount(&upstream)
            .await;
    }
    for key in [openai_key(), operator_key()] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(CarriesKey(key))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "chatcmpl-local", "object": "chat.completion", "model": "gpt-4o-mini",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello from upstream."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
            })))
            .mount(&upstream)
            .await;
    }

    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_SOPS_DIR");

    // ── No control plane configured: Valkey-backed and standalone ───────
    let with_valkey = serve(
        "model_list: []\n",
        Arc::new(ValkeyStore::new(conn.clone())),
        Arc::new(ValkeyControlPlaneCache::new(conn.clone())),
    )
    .await;
    let standalone = serve(
        "model_list: []\n",
        Arc::new(MemoryStore::new()),
        Arc::new(NullControlPlaneCache),
    )
    .await;

    // A provider key passes through, sent as Claude Code sends it (either
    // header) or as an OpenAI client does.
    for call in [
        Call::AnthropicXApiKey,
        Call::AnthropicBearer,
        Call::OpenAiBearer,
    ] {
        let (status, body) = send(with_valkey, call).await;
        assert_eq!(
            status, 200,
            "a provider key passes through with Valkey: {body}"
        );
        assert!(body.contains("Hello from upstream."), "{body}");
        assert_eq!(send(standalone, call).await.0, 200);
    }

    // A virtual key with no provider key in the proxy's environment fails as
    // it does standalone, not as an invalid key.
    let (valkey_status, valkey_body) = send(with_valkey, Call::VirtualKey).await;
    let (standalone_status, standalone_body) = send(standalone, Call::VirtualKey).await;
    assert_ne!(valkey_status, 200, "{valkey_body}");
    assert_eq!(
        (valkey_status, &valkey_body),
        (standalone_status, &standalone_body),
        "the same answer with and without Valkey"
    );
    assert!(
        !valkey_body.contains("Virtual API key is invalid"),
        "{valkey_body}"
    );

    // With one there, the virtual key is accepted and that key goes upstream.
    std::env::set_var("OPENAI_API_KEY", operator_key());
    for addr in [with_valkey, standalone] {
        let (status, body) = send(addr, Call::VirtualKey).await;
        assert_eq!(
            status, 200,
            "the environment's provider key is used: {body}"
        );
        assert!(body.contains("Hello from upstream."), "{body}");
    }
    let virtual_key_upstream = upstream
        .received_requests()
        .await
        .expect("recording on")
        .iter()
        .any(|r| {
            r.headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains(&virtual_key()))
        });
    assert!(!virtual_key_upstream, "a virtual key is never forwarded");

    // ── Control plane configured: a provider key is still refused ───────
    let cp = MockServer::start().await;
    let connected = serve(
        &format!(
            "model_list: []\nintutic_settings:\n  policy:\n    control_plane_url: {}\n    fail_closed: false\n",
            cp.uri()
        ),
        Arc::new(ValkeyStore::new(conn.clone())),
        Arc::new(ValkeyControlPlaneCache::new(conn)),
    )
    .await;
    let (status, body) = send(connected, Call::AnthropicXApiKey).await;
    assert_eq!(status, 401, "connected mode is unchanged: {body}");
    assert!(body.contains("Virtual API key is invalid"), "{body}");
}
