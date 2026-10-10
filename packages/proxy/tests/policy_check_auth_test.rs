//! The control-plane policy pre-check carries the caller's virtual key.
//!
//! ## Why this exists
//!
//! `POST /api/v1/policy/check` answers whether a workspace is over its budget
//! cap or its daily plan limits. The proxy used to send only the key's first 12
//! characters in the body, which are not a secret, so the route could not tell
//! the proxy apart from anyone else asking about a workspace ID. The proxy now
//! sends the whole `vk_` key as the bearer, the same credential it already
//! authenticates with to `/api/v1/judge`.
//!
//! The other half is pinned too: a token that is not a virtual key is the
//! caller's own provider credential, and it must never be sent to the control
//! plane, not even its first 12 characters. The route refuses anything but a
//! virtual key, so the proxy answers that request's check itself, as the
//! route's refusal would have been answered: fail-closed here, so refused.
//!
//! ONE `#[tokio::test]` in this file, matching this crate's convention for
//! process-global env vars (`OPENAI_UPSTREAM_URL`, `CONTROL_PLANE_URL`).

use std::sync::Arc;

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn upstream_chat_completion_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-policycheckauth",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "Done." },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
    })
}

#[tokio::test]
async fn policy_check_sends_the_virtual_key_and_never_a_provider_key() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(upstream_chat_completion_body()))
        .mount(&upstream)
        .await;

    // Fixtures are runtime-assembled: the repo convention forbids contiguous
    // credential-shaped literals in source, in every package.
    let virtual_key = concat!("vk_", "0123456789abcdef0123456789abcdef", "_ws_policy_auth");
    let provider_key = ["test", "-provider-", "token"].concat();

    let cp = MockServer::start().await;
    // Every virtual-key request asks for the key's SSO group policy; this
    // workspace has none.
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_test",
            "ssoGroups": { "policy": null, "memberGroups": null }
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .and(header(
            "authorization",
            format!("Bearer {virtual_key}").as_str(),
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })),
        )
        .expect(1)
        .mount(&cp)
        .await;
    // Anything else reaching the route would be allowed, so a provider-key
    // request refused below was refused by the proxy, not by this mock.
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "action": "allow" })),
        )
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the request
    // needs a provider key, so the operator fallback supplies a test one.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());

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

    let send = |token: String| {
        reqwest::Client::new()
            .post(format!("http://{}/v1/chat/completions", addr))
            .header("Authorization", format!("Bearer {token}"))
            .header("x-workspace-id", "ws_policy_auth")
            .json(&serde_json::json!({
                "model": "qwen-test-model",
                "stream": false,
                "messages": [{"role": "user", "content": "hello"}]
            }))
            .send()
    };

    let res = send(virtual_key.to_string())
        .await
        .expect("proxy reachable");
    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert!(status.is_success(), "proxy returned {status}: {body}");

    let res = send(provider_key.clone()).await.expect("proxy reachable");
    let status = res.status();
    let body = res.text().await.expect("body reads");
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{body}");
    assert!(body.contains("policy_denied"), "{body}");

    let received = cp
        .received_requests()
        .await
        .expect("request recording is on");
    let checks: Vec<_> = received
        .iter()
        .filter(|r| r.url.path() == "/api/v1/policy/check")
        .collect();
    assert_eq!(
        checks.len(),
        1,
        "only the virtual-key request was checked remotely"
    );
    for r in &received {
        let body = String::from_utf8_lossy(&r.body);
        assert!(
            !body.contains(&provider_key[..12]),
            "part of a provider key was sent to the control plane: {body}"
        );
    }
    // `.expect(1)` on the first mock is verified when `cp` drops.
}
