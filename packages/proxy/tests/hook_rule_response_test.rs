//! End-to-end: a hook-rule guardrail withholds a model-emitted tool call
//! before the client sees it — on a stream and off one — and refuses the
//! request that reports a refused call it ran anyway.
//!
//! The SOP files are the control plane's own projection, read out of
//! `packages/shared-types/fixtures/guardrail-layer-vectors.json` (the
//! `served.sops` of three vectors) and written where a standalone proxy reads
//! them — the file `intutic guardrails pull` writes. A real request goes
//! through the real router to a wiremock upstream. `plugins::hook_rules`
//! pins the decisions and `guardrail_layer_vectors_test.rs` pins them
//! against every layer; this pins the wiring: the name check on the first
//! line, the hold that re-enters released lines into the proxy's loop, the
//! non-streaming body swap and the request-side refusal.
//!
//! ONE `#[tokio::test]`, for the reason `judge_stream_test.rs` gives: the
//! upstream URL, control-plane URL and SOP directory are process-global env.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// `served.sops[0]` of the named layer vector: `(title, markdown)`.
fn served_sop(vector: &str) -> (String, String) {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../shared-types/fixtures/guardrail-layer-vectors.json");
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the fixture exists"))
            .expect("the fixture parses");
    let v = file["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == vector)
        .unwrap_or_else(|| panic!("no vector named {vector:?}"));
    let sop = &v["served"]["sops"][0];
    (
        sop["title"].as_str().unwrap().to_string(),
        sop["markdownContent"].as_str().unwrap().to_string(),
    )
}

fn chunk(delta: serde_json::Value, finish: serde_json::Value) -> String {
    format!(
        "data: {}\n\n",
        serde_json::json!({
            "id": "chatcmpl-hookrule",
            "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
        })
    )
}

/// An OpenAI-shaped stream carrying one call, its arguments split across two
/// deltas so no single line holds the whole command.
fn tool_call_stream(tool: &str, input: serde_json::Value) -> String {
    let args = input.to_string();
    let (a, b) = args.split_at(args.len() / 2);
    let mut body = chunk(
        serde_json::json!({"role": "assistant", "content": "Applying."}),
        serde_json::Value::Null,
    );
    body.push_str(&chunk(
        serde_json::json!({"tool_calls": [{"index": 0, "id": "call_hookrule", "type": "function",
            "function": {"name": tool, "arguments": ""}}]}),
        serde_json::Value::Null,
    ));
    for part in [a, b] {
        body.push_str(&chunk(
            serde_json::json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
            serde_json::Value::Null,
        ));
    }
    body.push_str(&chunk(
        serde_json::json!({}),
        serde_json::json!("tool_calls"),
    ));
    body.push_str("data: [DONE]\n\n");
    body
}

fn tool_call_body(tool: &str, input: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": "chatcmpl-hookrule",
        "object": "chat.completion",
        "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_hookrule",
                    "type": "function",
                    "function": { "name": tool, "arguments": input.to_string() }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

#[tokio::test]
async fn an_enforcing_hook_rule_withholds_the_call_and_a_shadow_one_does_not() {
    const APPLY: &str = "kubectl apply -f deploy.yaml";
    const DRY: &str = "kubectl apply --dry-run=client -f deploy.yaml";
    const TF: &str = "cd infra && terraform apply";

    let upstream = MockServer::start().await;
    let stream_cases = [
        (
            "case-stream-apply",
            "Bash",
            serde_json::json!({ "command": APPLY }),
        ),
        (
            "case-stream-dry",
            "Bash",
            serde_json::json!({ "command": DRY }),
        ),
        (
            "case-stream-issue",
            "mcp__github__create_issue",
            serde_json::json!({ "title": "flaky" }),
        ),
        (
            "case-stream-shadow",
            "Bash",
            serde_json::json!({ "command": TF }),
        ),
    ];
    for (marker, tool, input) in stream_cases {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(marker))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(tool_call_stream(tool, input), "text/event-stream"),
            )
            .mount(&upstream)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-apply"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_body(
            "Bash",
            serde_json::json!({ "command": APPLY }),
        )))
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-history"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-hookrule", "object": "chat.completion", "model": "qwen-test-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}
        })))
        .mount(&upstream)
        .await;

    let cp = MockServer::start().await;
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
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "action": "allow"
        })))
        .mount(&cp)
        .await;

    let sops_dir = std::env::temp_dir().join(format!("intutic-hookrule-{}", std::process::id()));
    std::fs::create_dir_all(&sops_dir).unwrap();
    for (i, vector) in [
        "an exclusion refuses without it",
        "a name-only rule refuses any input",
        "a shadow literal flags and allows",
    ]
    .into_iter()
    .enumerate()
    {
        let (_, markdown) = served_sop(vector);
        std::fs::write(sops_dir.join(format!("guardrail-{i}.md")), markdown).unwrap();
    }

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

    let send = |marker: &'static str, stream: bool, history: Option<serde_json::Value>| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let mut messages = vec![
                serde_json::json!({"role": "user", "content": format!("{marker}: deploy it")}),
            ];
            if let Some(h) = history {
                messages.extend(h.as_array().unwrap().iter().cloned());
            }
            let res = reqwest::Client::new()
                .post(url)
                // Runtime-assembled virtual key, per the repo's fixture rule.
                .header(
                    "Authorization",
                    concat!(
                        "Bearer vk_",
                        "0123456789abcdef0123456789abcdef",
                        "_ws_hookrule"
                    ),
                )
                .header("x-workspace-id", "ws_hookrule")
                .header("x-session-id", format!("ses_{marker}"))
                .json(&serde_json::json!({
                    "model": "qwen-test-model",
                    "stream": stream,
                    "messages": messages
                }))
                .send()
                .await
                .expect("proxy reachable");
            let status = res.status();
            let rule = res
                .headers()
                .get(intutic_proxy::refusal::RULE_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let body = res.text().await.expect("body drains");
            (status, rule, body)
        }
    };

    // Streaming, the argument rule fires: the held call is withheld whole and
    // the refusal arrives in band, naming the guardrail.
    let (status, _, body) = send("case-stream-apply", true, None).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(
        !body.contains("call_hookrule"),
        "the refused call reached the client:\n{body}"
    );
    assert!(body.contains("[Intutic] Blocked tool call: Bash"), "{body}");
    assert!(body.contains("guardrail.pgr_lv08"), "{body}");
    let marker = body
        .lines()
        .find(|l| l.starts_with(": intutic-refusal "))
        .unwrap_or_else(|| panic!("no refusal marker:\n{body}"));
    assert!(marker.contains(r#""code":"TOOL_DENIED""#), "{marker}");
    assert!(
        marker.contains(r#""rule":"guardrail.pgr_lv08""#),
        "{marker}"
    );

    // Streaming, the exclusion holds: released in order, nothing refused.
    let (_, _, body) = send("case-stream-dry", true, None).await;
    assert!(
        body.contains("call_hookrule"),
        "an allowed call was dropped:\n{body}"
    );
    assert!(!body.contains("Blocked tool call"), "{body}");
    let mut args = String::new();
    for line in body.lines() {
        let Some(d) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(d) else {
            continue;
        };
        if let Some(a) = v["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].as_str()
        {
            args.push_str(a);
        }
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&args).expect("released arguments reassemble");
    assert_eq!(parsed["command"], DRY);

    // Streaming, a name-only rule: refused on the call's first line.
    let (_, _, body) = send("case-stream-issue", true, None).await;
    assert!(!body.contains("call_hookrule"), "{body}");
    assert!(body.contains("guardrail.pgr_lv12"), "{body}");

    // Streaming, a shadow rule fires: reported, never refused.
    let (_, _, body) = send("case-stream-shadow", true, None).await;
    assert!(
        body.contains("call_hookrule"),
        "a shadow rule withheld a call:\n{body}"
    );
    assert!(!body.contains("Blocked tool call"), "{body}");

    // Non-streaming: the whole body is replaced, the rule named in the header.
    let (status, rule, body) = send("case-json-apply", false, None).await;
    assert!(status.is_success(), "{status}: {body}");
    assert!(!body.contains("call_hookrule"), "{body}");
    assert!(body.contains("[Intutic] Blocked tool call"), "{body}");
    assert_eq!(rule.as_deref(), Some("guardrail.pgr_lv08"));

    // Request side: the turn this request reports on carries a refused call
    // the harness ran anyway. Refused like a deny_tools call in history.
    let history = serde_json::json!([
        {"role": "assistant", "content": null, "tool_calls": [{"id": "call_ran", "type": "function",
            "function": {"name": "Bash", "arguments": serde_json::json!({"command": APPLY}).to_string()}}]},
        {"role": "tool", "tool_call_id": "call_ran", "name": "Bash", "content": "deployment.apps/web configured"}
    ]);
    let (status, _, body) = send("case-json-history", false, Some(history)).await;
    assert!(
        !status.is_success(),
        "a refused call in the reported turn was let through: {body}"
    );
    assert!(body.contains("hook rule guardrail.pgr_lv08"), "{body}");
    // A call the rule does not match is fine. (Not the dry run: any
    // `kubectl apply` is an `action:deploy`, which the built-in ordering rule
    // refuses without a prior test run — a different rule's decision.)
    let history = serde_json::json!([
        {"role": "assistant", "content": null, "tool_calls": [{"id": "call_ran", "type": "function",
            "function": {"name": "Bash", "arguments": serde_json::json!({"command": "kubectl get pods"}).to_string()}}]},
        {"role": "tool", "tool_call_id": "call_ran", "name": "Bash", "content": "web-1 Running"}
    ]);
    // Its own session: the one above already recorded a deploy.
    let (status, _, body) = send("case-json-history-ok", false, Some(history)).await;
    assert!(status.is_success(), "{status}: {body}");

    let _ = std::fs::remove_dir_all(&sops_dir);
}
