//! End-to-end: a workspace's `piiDetectors` setting, read from the per-key
//! `/auth/key-context` answer, decides what the request scan does with PII.
//!
//! The unit tests in `dlp` pin the precedence (the workspace is the baseline,
//! the machine's config may only tighten it) and `dlp::workspace` the parsing;
//! this pins the wiring on the request path.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and control-plane URL are process-global env.

use std::sync::Arc;

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// Runtime-assembled virtual keys, per the repo's fixture rule: one per workspace.
const REDACTS_EMAIL: &str = concat!("vk_", "0123456789abcdef0123456789abcdf1", "_ws_pii_a");
const BLOCKS_CARDS: &str = concat!("vk_", "0123456789abcdef0123456789abcdf2", "_ws_pii_b");
const NO_SETTING: &str = concat!("vk_", "0123456789abcdef0123456789abcdf3", "_ws_pii_c");

fn completion() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-pii",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": "Done." },
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    })
}

#[tokio::test]
async fn the_workspace_setting_decides_what_the_request_scan_does() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completion()))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;
    for (key, ws, detectors) in [
        (
            REDACTS_EMAIL,
            "ws_pii_a",
            serde_json::json!({"pii.email": "redact"}),
        ),
        (
            BLOCKS_CARDS,
            "ws_pii_b",
            serde_json::json!({"pii.card": "block"}),
        ),
        (NO_SETTING, "ws_pii_c", serde_json::json!({})),
    ] {
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": ws,
                "ssoGroups": { "policy": null, "memberGroups": null },
                "piiDetectors": detectors
            })))
            .mount(&cp)
            .await;
    }

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: the request needs a
    // provider key, so the operator fallback supplies a test one.
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

    let send = |key: &'static str, ws: &'static str, content: String| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let res = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("x-workspace-id", ws)
                .header("x-session-id", format!("ses_{ws}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "messages": [{"role": "user", "content": content}]
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            (status, res.text().await.expect("body drains"))
        }
    };
    let last_upstream_body = || async {
        let requests = upstream.received_requests().await.expect("recording");
        String::from_utf8_lossy(&requests.last().expect("a forwarded request").body).to_string()
    };

    let email = format!("{}@{}", "jane.doe", "corp.io");

    // The workspace turns email redaction on, which is off by default: the
    // provider receives the placeholder, not the address.
    let (status, body) = send(
        REDACTS_EMAIL,
        "ws_pii_a",
        format!("mail {email} the report"),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    let forwarded = last_upstream_body().await;
    assert!(!forwarded.contains(&email), "{forwarded}");
    assert!(forwarded.contains("[REDACTED_PII]"), "{forwarded}");

    // A workspace without the setting keeps this machine's actions: email is
    // off, so the address is forwarded as written.
    let (status, body) = send(NO_SETTING, "ws_pii_c", format!("mail {email} the report")).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(last_upstream_body().await.contains(&email));

    // The workspace blocks card numbers: the request is refused before it
    // reaches the provider.
    let before = upstream.received_requests().await.expect("recording").len();
    let card = ["4111", "1111", "1111", "1111"].join(" ");
    let (status, body) = send(BLOCKS_CARDS, "ws_pii_b", format!("charge {card}")).await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("dlp_policy_violation"), "{body}");
    assert_eq!(
        upstream.received_requests().await.expect("recording").len(),
        before,
        "a blocked request still reached the model"
    );
}
