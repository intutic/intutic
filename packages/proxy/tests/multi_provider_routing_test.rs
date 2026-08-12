//! End-to-end: requests naming a Mistral or OpenRouter model route to that
//! provider's own upstream, using a workspace-provisioned credential —
//! multi-provider wizard phase 3.
//!
//! ## What this pins
//!
//! Both providers are OpenAI-wire-shaped (`Provider::wire_shape()` collapses
//! them to `Provider::OpenAI`), which makes `is_same_provider` true and
//! sends the request down the same-provider branch — a branch that, before
//! this phase, always built its base URL from `provider` (the *inbound*
//! wire shape, always Anthropic/OpenAI/Gemini) rather than `target_provider`
//! (the actual destination). Getting that base-URL source wrong would send
//! a Mistral-model request to OpenAI's own upstream with a Mistral key
//! attached — this test observes the real destination and the real
//! forwarded headers, not just a 200 status, so that mistake would fail it.
//!
//! It also pins credential-blob parsing: `fetch_provider_credential` reads
//! Mistral/OpenRouter keys out of a `{provider}_config` JSON blob
//! (`{"apiKey": "..."}`), a different shape from the flat
//! `{provider}_api_key` string the original three providers use. No
//! `MISTRAL_API_KEY`/`OPENROUTER_API_KEY` env var is set in either test, so
//! a request reaching the mock with the right bearer token proves the blob
//! was actually read, not that a fallback silently covered for it.
//!
//! Two providers, two tests, one file: each reads a distinct upstream-URL
//! env var (`MISTRAL_UPSTREAM_URL` / `OPENROUTER_UPSTREAM_URL`), so they
//! don't collide the way two tests sharing one key would (see
//! `unservable_fallback_test.rs`'s module doc on why that sharing matters).

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn build_app(
    store: Arc<intutic_proxy::store::MemoryStore>,
) -> std::net::SocketAddr {
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: false
"#,
    )
    .expect("config parses");

    let state = intutic_proxy::proxy::AppState {
        config,
        wasm_registry: intutic_proxy::wasm::registry::PluginRegistry::new(None)
            .await
            .expect("empty registry"),
        http_client: Arc::new(reqwest::Client::new()),
        reward_engine: Arc::new(intutic_proxy::routing::reward::RewardEngine::new()),
        store: Arc::clone(&store) as Arc<dyn intutic_proxy::store::LocalStore>,
        control_plane: Arc::new(intutic_proxy::store::NullControlPlaneCache),
    };
    let app = intutic_proxy::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    addr
}

#[tokio::test]
async fn mistral_model_routes_to_mistral_upstream_with_provisioned_key() {
    let upstream = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer mistral-provisioned-key"))
        .and(body_string_contains("mistral-large-latest"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-mistral-test",
            "object": "chat.completion",
            "model": "mistral-large-latest",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "served by mistral"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
        })))
        .expect(1)
        .mount(&upstream)
        .await;

    std::env::set_var("MISTRAL_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("MISTRAL_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let workspace_id = "ws_mistral_routing_test";
    use intutic_proxy::store::LocalStore as _;
    store
        .set_workspace_credential(
            workspace_id,
            "mistral_config",
            r#"{"apiKey": "mistral-provisioned-key"}"#,
        )
        .await;

    let addr = build_app(Arc::clone(&store)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_mistral_routing_test",
        )
        .header("x-workspace-id", workspace_id)
        .json(&serde_json::json!({
            "model": "mistral-large-latest",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert!(status.is_success(), "status={status} body={body}");
    assert!(
        body.contains("served by mistral"),
        "response must come from the Mistral mock: {body}"
    );

    // The mock's `.expect(1)` on an exact bearer-token match already proves
    // the blob-parsed credential reached the upstream; verify() enforces it
    // on drop too.
    upstream.verify().await;
}

#[tokio::test]
async fn openrouter_model_routes_to_openrouter_upstream_with_provisioned_key() {
    let upstream = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer openrouter-provisioned-key"))
        .and(body_string_contains("mistralai/mistral-large"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-openrouter-test",
            "object": "chat.completion",
            "model": "mistralai/mistral-large",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "served by openrouter"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
        })))
        .expect(1)
        .mount(&upstream)
        .await;

    std::env::set_var("OPENROUTER_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("OPENROUTER_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    let workspace_id = "ws_openrouter_routing_test";
    use intutic_proxy::store::LocalStore as _;
    store
        .set_workspace_credential(
            workspace_id,
            "openrouter_config",
            r#"{"apiKey": "openrouter-provisioned-key"}"#,
        )
        .await;

    let addr = build_app(Arc::clone(&store)).await;

    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_openrouter_routing_test",
        )
        .header("x-workspace-id", workspace_id)
        // OpenRouter's own `vendor/model` naming convention -- the `/`
        // check in `get_model_provider` must resolve this to OpenRouter,
        // not fall through to the `mistral`-prefix check below it, since
        // this exact string starts with neither "mistral" nor a namespaced
        // prefix the Mistral-direct arm recognises.
        .json(&serde_json::json!({
            "model": "mistralai/mistral-large",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert!(status.is_success(), "status={status} body={body}");
    assert!(
        body.contains("served by openrouter"),
        "response must come from the OpenRouter mock: {body}"
    );

    upstream.verify().await;
}
