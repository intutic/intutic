//! End-to-end: an unreadable `decide:` line refuses every response at the
//! gateway, as a `VIOLATION` whose note is the parse error, on a stream and
//! off one, and asks no engine anything.
//!
//! Its own binary: the SOP directory is process-global and cached, and an
//! unreadable line refuses every response, so it cannot share a process with
//! the cases in `decide_gateway_test.rs`. ONE `#[tokio::test]`, for the same
//! reason.
#![cfg(feature = "control-plane")]

use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = r#"---
decide: {"id":"broken-rule","on":"response","when":"leak"}
---
# Broken rules

Responses stay on topic.
"#;

#[tokio::test]
async fn an_unreadable_decide_line_refuses_every_response() {
    // An engine that would allow everything, to show it is never asked.
    let engine = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&engine)
        .await;

    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json:"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-decide", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "Here is the plan."}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        })))
        .mount(&upstream)
        .await;
    let stream = [
        json!({"role": "assistant", "content": "Here is "}),
        json!({"content": "the plan."}),
    ]
    .iter()
    .map(|d| {
        format!(
            "data: {}\n\n",
            json!({"id": "c", "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": d, "finish_reason": null}]})
        )
    })
    .collect::<String>()
        + &format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"id": "c", "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-stream:"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(stream, "text/event-stream"),
        )
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workspaceId": "ws_test",
            "ssoGroups": { "policy": null, "memberGroups": null }
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "action": "allow" })))
        .mount(&cp)
        .await;

    let root =
        std::env::temp_dir().join(format!("intutic-decide-unreadable-{}", std::process::id()));
    let home = root.join("home");
    let sops_dir = root.join("sops");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("broken.md"), SOP).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    std::env::set_var("INTUTIC_DECIDE_ENGINE_URL", engine.uri());
    std::env::set_var("INTUTIC_DECIDE_MODEL", "stub-model");
    intutic_proxy::decide::gateway::install_from_env();

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

    for (marker, stream) in [("case-json", false), ("case-stream", true)] {
        let res = reqwest::Client::new()
            .post(format!("http://{addr}/v1/chat/completions"))
            // Runtime-assembled virtual key, per the repo's fixture rule.
            .header(
                "Authorization",
                concat!(
                    "Bearer vk_",
                    "0123456789abcdef0123456789abcdef",
                    "_ws_decide"
                ),
            )
            .header("x-workspace-id", "ws_decide")
            .header("x-session-id", format!("ses_{marker}"))
            .json(&json!({
                "model": "qwen-test-model",
                "stream": stream,
                "messages": [{"role": "user", "content": format!("{marker}: go")}]
            }))
            .send()
            .await
            .expect("proxy reachable");
        assert!(res.status().is_success());
        let body = res.text().await.expect("body drains");
        assert!(body.contains("Here is "), "{marker}: {body}");
        assert!(
            body.contains("Intutic Decide (gateway): VIOLATION"),
            "{marker}: {body}"
        );
        assert!(body.contains("broken-rule"), "{marker}: {body}");
        assert!(body.contains("does not read"), "{marker}: {body}");
        // The parse error is the note.
        assert!(body.contains("questions"), "{marker}: {body}");
        if stream {
            let note = body.find("VIOLATION").unwrap();
            assert!(note < body.rfind("data: [DONE]").unwrap(), "{body}");
        }
    }
    assert!(
        engine.received_requests().await.unwrap().is_empty(),
        "an unreadable line asks the engine nothing"
    );

    let _ = std::fs::remove_dir_all(&root);
}
