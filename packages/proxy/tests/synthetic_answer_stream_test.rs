//! A command the proxy answers itself comes back in the shape the client asked
//! for: an SSE stream in the route's protocol when the request says
//! `"stream": true`, a JSON body otherwise.
//!
//! `/intutic` slash commands used to answer every request with a JSON body,
//! so a streaming client (Claude Code, Cursor) parsing `text/event-stream`
//! read nothing. The streamed `/intutic predict` answer named its model
//! `claude-3-5-sonnet` whatever the request asked for.
//!
//! ONE `#[tokio::test]`: `CONTROL_PLANE_URL` and `HOME` are process-global.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

const WORKSPACE: &str = "ws_synthetic";

// Runtime-assembled per the repo's fixture rule.
fn virtual_key() -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", WORKSPACE].concat()
}

struct Answer {
    content_type: String,
    body: String,
}

async fn post(addr: std::net::SocketAddr, route: &str, body: Value) -> Answer {
    let res = reqwest::Client::new()
        .post(format!("http://{addr}{route}"))
        .header("Authorization", format!("Bearer {}", virtual_key()))
        .header("x-workspace-id", WORKSPACE)
        .header("x-session-id", "ses_synthetic")
        .json(&body)
        .send()
        .await
        .expect("proxy reachable");
    assert!(
        res.status().is_success(),
        "{route} {body} -> {}",
        res.status()
    );
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = res.text().await.expect("body reads");
    Answer { content_type, body }
}

#[tokio::test]
async fn self_answered_commands_follow_the_requested_framing() {
    let home = std::env::temp_dir().join(format!(
        "intutic-synthetic-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    // Nothing here may reach a provider: every request is answered locally.
    let upstream = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(500))
        .mount(&upstream)
        .await;
    let cp = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "action": "allow",
            "workspaceId": WORKSPACE,
            "ssoGroups": {"policy": null, "memberGroups": null},
            "responseText": "status from the control plane",
        })))
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("ANTHROPIC_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::remove_var("INTUTIC_SOPS_DIR");

    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(&format!(
        "model_list: []\nintutic_settings:\n  policy:\n    control_plane_url: {}\n    fail_closed: false\n",
        cp.uri()
    ))
    .expect("config parses");
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
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .ok();
    });

    let user = |content: &str| json!([{"role": "user", "content": content}]);

    // ── Slash command, OpenAI chat completions ──────────────────────────
    let streamed = post(
        addr,
        "/v1/chat/completions",
        json!({"model": "gpt-4o-mini", "stream": true, "messages": user("/intutic status")}),
    )
    .await;
    assert!(
        streamed.content_type.starts_with("text/event-stream"),
        "a streaming chat client gets SSE, not {:?}: {}",
        streamed.content_type,
        streamed.body
    );
    assert!(
        streamed.body.contains("chat.completion.chunk"),
        "{}",
        streamed.body
    );
    assert!(streamed.body.contains("status from the control plane"));
    assert!(
        streamed.body.trim_end().ends_with("data: [DONE]"),
        "{}",
        streamed.body
    );

    let plain = post(
        addr,
        "/v1/chat/completions",
        json!({"model": "gpt-4o-mini", "messages": user("/intutic status")}),
    )
    .await;
    assert!(plain.content_type.starts_with("application/json"));
    let parsed: Value = serde_json::from_str(&plain.body).expect("a JSON body");
    assert_eq!(parsed["object"], "chat.completion");
    assert_eq!(
        parsed["choices"][0]["message"]["content"],
        "status from the control plane"
    );

    // ── Slash command, Anthropic Messages ───────────────────────────────
    let streamed = post(
        addr,
        "/v1/messages",
        json!({"model": "claude-sonnet-4-5", "max_tokens": 64, "stream": true,
               "messages": user("/intutic status")}),
    )
    .await;
    assert!(
        streamed.content_type.starts_with("text/event-stream"),
        "a streaming Anthropic client gets SSE, not {:?}: {}",
        streamed.content_type,
        streamed.body
    );
    assert!(
        streamed.body.starts_with("event: message_start"),
        "{}",
        streamed.body
    );
    assert!(streamed.body.contains("status from the control plane"));
    assert!(streamed.body.contains("event: message_stop"));

    let plain = post(
        addr,
        "/v1/messages",
        json!({"model": "claude-sonnet-4-5", "max_tokens": 64,
               "messages": user("/intutic status")}),
    )
    .await;
    let parsed: Value = serde_json::from_str(&plain.body).expect("a JSON body");
    assert_eq!(parsed["type"], "message");
    assert_eq!(
        parsed["content"][0]["text"],
        "status from the control plane"
    );

    // ── `/intutic predict`, streamed: the request's model, not a constant ─
    let streamed = post(
        addr,
        "/v1/messages",
        json!({"model": "claude-sonnet-4-5", "max_tokens": 64, "stream": true,
               "messages": user("/intutic predict how much will this cost")}),
    )
    .await;
    assert!(streamed.content_type.starts_with("text/event-stream"));
    assert!(
        streamed.body.contains("Pre-Flight Cost Prediction"),
        "{}",
        streamed.body
    );
    assert!(
        streamed.body.contains(r#""model":"claude-sonnet-4-5""#),
        "message_start names the request's model: {}",
        streamed.body
    );
    assert!(
        !streamed.body.contains("claude-3-5-sonnet"),
        "{}",
        streamed.body
    );
}
