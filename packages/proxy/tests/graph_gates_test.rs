//! End-to-end (§13 item 9): worker context isolation and node
//! kinds, through the real router to a wiremock upstream.
//!
//! - A node declaring itself `code` is refused on its first request with
//!   403 `NODE_KIND_DENIED`.
//! - A `worker` node's `Task` call is withheld in band as `TOOL_DENIED`, rule
//!   `node_kind.worker`, and a child claiming that worker as its parent is
//!   refused.
//! - Two sibling workers handed the same 20 KiB brief: under
//!   `context_isolation: enforce` the second is re-asked (409), naming the
//!   sibling.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL and SOP directory are process-global env.
#![cfg(feature = "control-plane")]

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn text_body() -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-graph", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
    })
}

#[tokio::test]
async fn node_kinds_and_sibling_isolation_are_enforced_at_the_gateway() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-worker-task"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-graph", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": null, "tool_calls": [{
                "id": "call_spawn", "type": "function",
                "function": {"name": "Task", "arguments": "{\"prompt\":\"split it again\"}"}}]},
                "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
        })))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(text_body()))
        .mount(&upstream)
        .await;

    let sops_dir = std::env::temp_dir().join(format!("intutic-graph-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(
        sops_dir.join("isolation.md"),
        "---\ncontext_isolation: enforce\n---\nHand each worker only its slice.\n",
    )
    .unwrap();

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    let cp = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/key-context"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "workspaceId": "ws_graph",
            "role": "DEVELOPER"
        })))
        .mount(&cp)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);

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

    // graph, node, parent, depth, declared kind, user text.
    let send = |graph: &'static str,
                node: &'static str,
                parent: &'static str,
                kind: Option<&'static str>,
                text: String| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let mut req = reqwest::Client::new()
                .post(url)
                // Runtime-assembled virtual key, per the repo's fixture rule.
                .header(
                    "Authorization",
                    concat!(
                        "Bearer vk_",
                        "0123456789abcdef0123456789abcdef",
                        "_ws_graph"
                    ),
                )
                .header("x-workspace-id", "ws_graph")
                .header("x-session-id", format!("ses_{node}"))
                .header("x-intutic-graph-id", graph)
                .header("x-intutic-node-id", node)
                .header("x-intutic-parent-session", parent)
                .header("x-intutic-depth", "1")
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "messages": [{"role": "user", "content": text}]
                }));
            if let Some(k) = kind {
                req = req.header("x-intutic-node-kind", k);
            }
            let res = req.send().await.expect("proxy reachable");
            let status = res.status();
            let rule = res
                .headers()
                .get(intutic_proxy::refusal::RULE_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            (status, rule, res.text().await.expect("body drains"))
        }
    };

    // A `code` node calls no model.
    let (status, _, body) = send("g_kind", "n_code", "root", Some("code"), "compute".into()).await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains("NODE_KIND_DENIED"), "{body}");
    assert!(body.contains("may not call a model"), "{body}");

    // A worker may call the model, but its spawn call is withheld.
    let (status, rule, body) = send(
        "g_kind",
        "n_worker",
        "root",
        Some("worker"),
        "case-worker-task: do your slice".into(),
    )
    .await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        !body.contains("call_spawn"),
        "the spawn call reached the client:\n{body}"
    );
    assert_eq!(rule.as_deref(), Some("node_kind.worker"), "{body}");

    // A child claiming the worker as its parent is refused.
    let (status, _, body) = send("g_kind", "n_child", "n_worker", None, "hello".into()).await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains("may not spawn"), "{body}");

    // Two siblings handed the same 20 KiB brief: the second is re-asked.
    let brief: String = (0..4000)
        .map(|i| format!("step{} ", i % 997))
        .collect::<String>()
        + "implement the whole service";
    assert!(brief.len() > 20 * 1024);
    let (status, _, body) = send("g_sib", "w1", "splitter", None, brief.clone()).await;
    assert!(status.is_success(), "{status}: {body}");
    let (status, _, body) = send("g_sib", "w2", "splitter", None, brief.clone()).await;
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("policy_reask"), "{body}");
    assert!(body.contains("sibling node `w1`"), "{body}");
    // A sibling with its own brief is not.
    let other: String = (0..4000).map(|i| format!("other{} ", i * 7)).collect();
    let (status, _, body) = send("g_sib", "w3", "splitter", None, other).await;
    assert!(status.is_success(), "{status}: {body}");

    let _ = std::fs::remove_dir_all(&sops_dir);
}
