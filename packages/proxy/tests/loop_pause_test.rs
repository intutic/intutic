//! End-to-end (§13 item 7): a loop run whose SOP says
//! `on_reask_exhausted: pause` is held for review on its third failed
//! correction, and gets three fresh attempts afterwards; refusals carry
//! `scope`, and an OPAQUE workspace's agent learns neither the rule nor the
//! scope.
//!
//! The re-ask comes from `plan_steps_mode: enforce`: each request reports one
//! more off-plan `Bash` call. Standalone, the review hold is not recorded
//! (`MemoryStore::request_loop_review` has no control plane to release it),
//! so this pins the request path's answers — the 403
//! `LOOP_RUN_PENDING_REVIEW` in place of `policy_denied`, and the counter
//! reset — while `proxy::lld75_proxy_tests` pins the review reason's bytes.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL, control-plane URL and SOP directory are process-global env.

use std::sync::Arc;

use intutic_proxy::refusal::OPAQUE_MESSAGE;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const OPAQUE_KEY: &str = concat!("vk_", "0123456789abcdef0123456789abcdef", "_ws_opaque");
const OPEN_KEY: &str = concat!("vk_", "fedcba9876543210fedcba9876543210", "_ws_open");

/// `n` off-plan `Bash` calls and their results.
fn history(n: usize) -> Vec<serde_json::Value> {
    (0..n)
        .flat_map(|i| {
            [
                serde_json::json!({"role": "assistant", "content": null, "tool_calls": [{"id": format!("call_{i}"), "type": "function",
                    "function": {"name": "Bash", "arguments": serde_json::json!({"command": format!("ls dir{i}")}).to_string()}}]}),
                serde_json::json!({"role": "tool", "tool_call_id": format!("call_{i}"), "name": "Bash", "content": "a.rs"}),
            ]
        })
        .collect()
}

#[tokio::test]
async fn an_exhausted_correction_pauses_the_run_and_opaque_hides_the_rule() {
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-pause", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        })))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
    for (key, mode, ws) in [
        (OPAQUE_KEY, "OPAQUE", "ws_opaque"),
        (OPEN_KEY, "TRANSPARENT", "ws_open"),
    ] {
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(header("authorization", format!("Bearer {key}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": ws,
                "role": "DEVELOPER",
                "interventionMode": mode
            })))
            .mount(&cp)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/api/v1/policy/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;

    let sops_dir = std::env::temp_dir().join(format!("intutic-pause-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(
        sops_dir.join("plan.md"),
        "---\nplan_steps: Read, Edit\nplan_steps_mode: enforce\non_reask_exhausted: pause\n---\nRead, then edit.\n",
    )
    .unwrap();

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
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

    let send = |key: &'static str, ws: &'static str, run: Option<&'static str>, n: usize| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let mut messages = vec![serde_json::json!({"role": "user", "content": "fix it"})];
            messages.extend(history(n));
            let mut req = reqwest::Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {key}"))
                .header("x-workspace-id", ws)
                .header(
                    "x-session-id",
                    format!("ses_{ws}_{}", run.unwrap_or("none")),
                )
                .json(&serde_json::json!({"model": "qwen-test-model", "messages": messages}));
            if let Some(run) = run {
                req = req.header("x-loop-run-id", run);
            }
            let res = req.send().await.expect("proxy reachable");
            let status = res.status();
            let body = res.text().await.expect("body drains");
            let json: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            (status, json, body)
        }
    };

    // TRANSPARENT: the re-ask names the off-plan tool in `error.scope`.
    let (status, json, body) = send(OPEN_KEY, "ws_open", None, 1).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(json["error"]["type"], "policy_reask");
    assert_eq!(json["error"]["scope"]["tools"][0], "Bash", "{body}");

    // OPAQUE, in a loop run: two re-asks, then the run pauses.
    for n in 1..=2 {
        let (status, json, body) = send(OPAQUE_KEY, "ws_opaque", Some("lr_pause"), n).await;
        assert_eq!(status, 409, "attempt {n}: {body}");
        assert_eq!(json["error"]["message"], OPAQUE_MESSAGE, "{body}");
        assert!(
            json["error"].get("scope").is_none(),
            "OPAQUE leaked the scope: {body}"
        );
    }
    let (status, json, body) = send(OPAQUE_KEY, "ws_opaque", Some("lr_pause"), 3).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(json["error"]["type"], "LOOP_RUN_PENDING_REVIEW", "{body}");
    let message = json["error"]["message"].as_str().unwrap();
    assert!(message.contains("paused for human review"), "{message}");
    assert!(message.contains(OPAQUE_MESSAGE), "{message}");
    assert!(
        !message.contains("plan_adherence") && !message.contains("plan_steps"),
        "{message}"
    );

    // The counter was cleared: the next trip is a first attempt again.
    let (status, json, body) = send(OPAQUE_KEY, "ws_opaque", Some("lr_pause"), 4).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(json["error"]["type"], "policy_reask");

    // Without a loop run the third trip blocks, as before.
    for n in 1..=2 {
        let (status, _, body) = send(OPAQUE_KEY, "ws_opaque", None, n).await;
        assert_eq!(status, 409, "{body}");
    }
    let (status, json, body) = send(OPAQUE_KEY, "ws_opaque", None, 3).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(json["error"]["type"], "policy_denied", "{body}");

    let _ = std::fs::remove_dir_all(&sops_dir);
}
