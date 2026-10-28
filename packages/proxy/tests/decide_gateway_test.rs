//! End-to-end: the gateway evaluates its SOPs' decide rules through a stub
//! decide engine on 127.0.0.1.
//!
//! Real requests go through the real router to a wiremock upstream. The SOPs
//! are files in `INTUTIC_SOPS_DIR`; the engine is configured the way an
//! operator configures it, from `~/.intutic/decide/engine.json` (under a
//! temporary `HOME`) and the `INTUTIC_DECIDE_*` variables, and reinstalled
//! between scenarios with `decide::gateway::install_from_env`. Pins are files
//! under `~/.intutic/decide/evals/<ruleHash>/`, read per request, so a
//! scenario can take one away.
//!
//! The stub engine speaks the `logprobs` adapter. It answers each yes/no
//! question from the keyword in the question (`ALPHA`, `BETA`, `GAMMA`) and
//! a marker in the state: `<KEYWORD>-YES` is yes at 0.99, `<KEYWORD>-MAYBE`
//! 0.5, anything else no at 0.01. It answers the known-answer canary
//! correctly, so the canary passes and is cached.
//!
//! The rules:
//! - `alpha-leak`, `on: response`, enforce, pinned;
//! - `beta-tone`, `on: response`, shadow;
//! - `gamma-export`, `on: tool_call` on `Bash`, enforce, pinned.
//!
//! ONE `#[tokio::test]` for the end-to-end cases: `HOME`, the upstream URL,
//! the SOP directory and the engine are process-global. The log rotation case
//! is a plain test on its own directory.
#![cfg(feature = "control-plane")]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const STUB_MODEL: &str = "stub-model";

const RESPONSE_SOP: &str = r#"---
decide: {"id":"alpha-leak","on":"response","questions":{"leak":{"type":"yes_no","ask":"Does the response reveal the ALPHA project codename?"}},"when":"leak","rollout":"enforce"}
decide: {"id":"beta-tone","on":"response","questions":{"rude":{"type":"yes_no","ask":"Is the response rude about the BETA team?"}},"when":"rude","rollout":"shadow"}
---
# Response rules

Responses stay on topic.
"#;

const TOOL_SOP: &str = r#"---
decide: {"id":"gamma-export","on":"tool_call","tools":["Bash"],"questions":{"exports":{"type":"yes_no","ask":"Does this command export the GAMMA customer table?"}},"when":"exports","rollout":"enforce"}
---
# Tool rules

Customer data stays in production.
"#;

/// The stub decide engine: `POST /v1/chat/completions` with one-token
/// log-probabilities.
struct StubEngine;

fn logprobs(tokens: &[(&str, f64)]) -> ResponseTemplate {
    let top: Vec<Value> = tokens
        .iter()
        .map(|(t, p)| json!({ "token": t, "logprob": p.ln() }))
        .collect();
    ResponseTemplate::new(200).set_body_json(json!({
        "choices": [{ "logprobs": { "content": [{ "top_logprobs": top }] } }]
    }))
}

impl Respond for StubEngine {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let prompt = body["messages"][0]["content"].as_str().unwrap_or("");
        let (state, question) = prompt.rsplit_once("\n\nQUESTION: ").unwrap_or((prompt, ""));
        if question.contains("\nOPTIONS:\n") {
            // Only the canary asks a choice: the mass goes on delete_files.
            let letter = question
                .lines()
                .find_map(|l| l.strip_suffix(") delete_files"))
                .unwrap_or("A");
            let others: Vec<&str> = ["A", "B", "C"]
                .into_iter()
                .filter(|l| *l != letter)
                .collect();
            return logprobs(&[(letter, 0.98), (others[0], 0.01), (others[1], 0.01)]);
        }
        let p = if state.contains("rm -rf / --no-preserve-root") {
            0.99
        } else {
            match ["ALPHA", "BETA", "GAMMA"]
                .iter()
                .find(|k| question.contains(*k))
            {
                Some(k) if state.contains(&format!("{k}-YES")) => 0.99,
                Some(k) if state.contains(&format!("{k}-MAYBE")) => 0.5,
                _ => 0.01,
            }
        };
        logprobs(&[("yes", p), ("no", 1.0 - p)])
    }
}

fn chunk(delta: Value, finish: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl-decide",
            "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
        })
    )
}

fn text_stream(parts: &[&str]) -> String {
    let mut body = chunk(json!({"role": "assistant", "content": ""}), Value::Null);
    for p in parts {
        body.push_str(&chunk(json!({ "content": p }), Value::Null));
    }
    body.push_str(&chunk(json!({}), json!("stop")));
    body.push_str("data: [DONE]\n\n");
    body
}

fn tool_call_stream(command: &str) -> String {
    let args = json!({ "command": command }).to_string();
    let (a, b) = args.split_at(args.len() / 2);
    let mut body = chunk(
        json!({"role": "assistant", "content": "Running it."}),
        Value::Null,
    );
    body.push_str(&chunk(
        json!({"tool_calls": [{"index": 0, "id": "call_decide", "type": "function",
            "function": {"name": "Bash", "arguments": ""}}]}),
        Value::Null,
    ));
    for part in [a, b] {
        body.push_str(&chunk(
            json!({"tool_calls": [{"index": 0, "function": {"arguments": part}}]}),
            Value::Null,
        ));
    }
    body.push_str(&chunk(json!({}), json!("tool_calls")));
    body.push_str("data: [DONE]\n\n");
    body
}

fn sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// An Anthropic Messages stream of one text block.
fn anthropic_text_stream(text: &str) -> String {
    let mut s = sse(
        "message_start",
        json!({"type": "message_start", "message": {"id": "msg_d", "type": "message",
               "role": "assistant", "content": [], "model": "claude-3-5-haiku-20241022",
               "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    );
    s += &sse(
        "content_block_start",
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    );
    s += &sse(
        "content_block_delta",
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
    );
    s += &sse(
        "content_block_stop",
        json!({"type": "content_block_stop", "index": 0}),
    );
    s += &sse(
        "message_delta",
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}}),
    );
    s += &sse("message_stop", json!({"type": "message_stop"}));
    s
}

/// An OpenAI Responses stream of one message item.
fn responses_text_stream(text: &str) -> String {
    let mut s = sse(
        "response.created",
        json!({"type": "response.created", "response": {"id": "resp_d", "status": "in_progress"}}),
    );
    s += &sse(
        "response.output_item.added",
        json!({"type": "response.output_item.added", "output_index": 0,
               "item": {"id": "msg_d", "type": "message", "role": "assistant", "content": []}}),
    );
    s += &sse(
        "response.output_text.delta",
        json!({"type": "response.output_text.delta", "item_id": "msg_d",
               "output_index": 0, "content_index": 0, "delta": text}),
    );
    s += &sse(
        "response.output_item.done",
        json!({"type": "response.output_item.done", "output_index": 0,
               "item": {"id": "msg_d", "type": "message"}}),
    );
    s += &sse(
        "response.completed",
        json!({"type": "response.completed", "response": {"id": "resp_d", "status": "completed",
               "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}),
    );
    s
}

/// The `data:` payloads of the stream's events, in order, by event name.
fn events(body: &str) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let mut name = String::new();
    for line in body.lines() {
        if let Some(e) = line.strip_prefix("event:") {
            name = e.trim().to_string();
        } else if let Some(d) = line.strip_prefix("data:") {
            if let Ok(v) = serde_json::from_str::<Value>(d.trim()) {
                out.push((std::mem::take(&mut name), v));
            }
        }
    }
    out
}

fn text_body(content: &str) -> Value {
    json!({
        "id": "chatcmpl-decide", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })
}

fn tool_call_body(command: &str) -> Value {
    json!({
        "id": "chatcmpl-decide", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_decide",
                    "type": "function",
                    "function": { "name": "Bash", "arguments": json!({ "command": command }).to_string() }
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    })
}

/// The hash a rule line's pins are stored under.
fn hash_of(sop: &str, id: &str) -> String {
    let line = sop
        .lines()
        .filter_map(|l| l.strip_prefix("decide:"))
        .find(|l| l.contains(&format!("\"id\":\"{id}\"")))
        .expect("the rule is in the SOP");
    match intutic_proxy::decide::parse_line(line) {
        intutic_proxy::decide::DecideDecl::Rule(r) => intutic_proxy::decide::rule_hash(&r),
        other => panic!("{id} does not read: {other:?}"),
    }
}

fn pin_path(home: &Path, hash: &str) -> PathBuf {
    home.join(".intutic/decide/evals")
        .join(hash)
        .join("pin.json")
}

fn write_pin(home: &Path, hash: &str) {
    let p = pin_path(home, hash);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(
        &p,
        json!({"modelDigest": format!("id:{STUB_MODEL}"), "evalRunId": "run-test", "source": "local"})
            .to_string(),
    )
    .unwrap();
}

const DECIDE_ENV: [&str; 4] = [
    "INTUTIC_DECIDE_ENGINE_URL",
    "INTUTIC_DECIDE_MODEL",
    "INTUTIC_DECIDE_MODEL_DIGEST",
    "INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES",
];

/// Installs the engine from `engine.json` and `env`, every other decide
/// variable unset.
fn engine(env: &[(&str, &str)]) {
    for k in DECIDE_ENV {
        std::env::remove_var(k);
    }
    for (k, v) in env {
        std::env::set_var(k, v);
    }
    intutic_proxy::decide::gateway::install_from_env();
}

#[tokio::test]
async fn the_gateway_evaluates_decide_rules_on_responses_and_tool_calls() {
    let stub = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(StubEngine)
        .mount(&stub)
        .await;

    let upstream = MockServer::start().await;
    let text_cases: [(&str, &str); 4] = [
        ("case-refuse", "The ALPHA-YES codename is Bluebird."),
        ("case-allow", "Here is the deployment plan."),
        ("case-escalate", "It might be ALPHA-MAYBE, hard to say."),
        ("case-shadow", "BETA-YES people are slow."),
    ];
    for (marker, content) in text_cases {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(format!("{marker}:")))
            .respond_with(ResponseTemplate::new(200).set_body_json(text_body(content)))
            .mount(&upstream)
            .await;
    }
    for (marker, body) in [
        (
            "case-stream-refuse",
            text_stream(&["The ALPHA-", "YES codename ", "is Bluebird."]),
        ),
        ("case-stream-allow", text_stream(&["Here is ", "the plan."])),
        (
            "case-stream-tool-refuse",
            tool_call_stream("pg_dump GAMMA-YES > /tmp/out.sql"),
        ),
        (
            "case-stream-tool-allow",
            tool_call_stream("ls -la GAMMA-NO"),
        ),
    ] {
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_string_contains(format!("{marker}:")))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(body, "text/event-stream"),
            )
            .mount(&upstream)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("case-json-tool-refuse:"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(tool_call_body("pg_dump GAMMA-YES > /tmp/out.sql")),
        )
        .mount(&upstream)
        .await;
    for (route, body) in [
        (
            "/v1/messages",
            anthropic_text_stream("The ALPHA-YES codename is Bluebird."),
        ),
        (
            "/v1/responses",
            responses_text_stream("The ALPHA-YES codename is Bluebird."),
        ),
    ] {
        Mock::given(method("POST"))
            .and(path(route))
            .and(body_string_contains("case-wire-refuse:"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(body, "text/event-stream"),
            )
            .mount(&upstream)
            .await;
    }

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

    let root = std::env::temp_dir().join(format!("intutic-decide-gw-{}", std::process::id()));
    let home = root.join("home");
    let sops_dir = root.join("sops");
    std::fs::create_dir_all(home.join(".intutic/decide")).unwrap();
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("responses.md"), RESPONSE_SOP).unwrap();
    std::fs::write(sops_dir.join("tools.md"), TOOL_SOP).unwrap();
    let alpha = hash_of(RESPONSE_SOP, "alpha-leak");
    let gamma = hash_of(TOOL_SOP, "gamma-export");
    write_pin(&home, &alpha);
    write_pin(&home, &gamma);
    // The engine as `intutic decide configure` writes it.
    std::fs::write(
        home.join(".intutic/decide/engine.json"),
        json!({"url": stub.uri(), "adapter": "logprobs", "model": STUB_MODEL}).to_string(),
    )
    .unwrap();

    std::env::set_var("HOME", &home);
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", upstream.uri());
    std::env::set_var("ANTHROPIC_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    engine(&[]);
    let installed = intutic_proxy::decide::gateway::current();
    assert!(
        installed.engine().is_ok(),
        "the engine is read from engine.json"
    );
    assert_eq!(installed.url(), stub.uri());

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

    let send = |marker: &'static str, stream: bool| {
        let url = format!("http://{addr}/v1/chat/completions");
        async move {
            let res = reqwest::Client::new()
                .post(url)
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
            let status = res.status();
            let rule = res
                .headers()
                .get(intutic_proxy::refusal::RULE_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let body = res.text().await.expect("body drains");
            assert!(status.is_success(), "{marker}: {status}: {body}");
            (rule, body)
        }
    };
    const VIOLATION: &str = "Intutic Decide (gateway): VIOLATION";
    const AMBIGUOUS: &str = "Intutic Decide (gateway): AMBIGUOUS";
    let alpha_ref = "decide.local:responses.md#alpha-leak";
    let gamma_ref = "decide.local:tools.md#gamma-export";

    // ── Refuse: the enforcing response rule's `when` is true ──
    let (_, body) = send("case-refuse", false).await;
    assert!(body.contains(VIOLATION), "{body}");
    assert!(body.contains("DECIDE_REFUSED"), "{body}");
    assert!(body.contains(alpha_ref), "{body}");
    assert!(
        body.contains("The ALPHA-YES codename is Bluebird."),
        "the note follows the text: {body}"
    );
    // The engine was asked about the response, in the judge's layout, and
    // ran the canary first.
    let asked: Vec<String> = stub
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter_map(|r| serde_json::from_slice::<Value>(&r.body).ok())
        .filter_map(|b| b["messages"][0]["content"].as_str().map(str::to_string))
        .collect();
    assert!(
        asked.iter().any(|p| p.starts_with(
            "ACTIVE SOP CONSTRAINTS:\n# Response rules\n\nResponses stay on topic.\n\nASSISTANT RESPONSE:\nThe ALPHA-YES"
        )),
        "{asked:?}"
    );
    assert!(
        asked
            .iter()
            .any(|p| p.contains("rm -rf / --no-preserve-root")),
        "the canary ran"
    );
    assert!(home.join(".intutic/decide/canary.json").exists());
    // The evaluation is in the decide log under the gateway's home, as a
    // gate writes it; a proxy reading its SOPs from disk uploads nothing.
    let logs = home.join(".intutic/logs");
    let decisions: Vec<Value> = std::fs::read_dir(&logs)
        .expect("the logs directory")
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("decide-2"))
        .flat_map(|e| {
            std::fs::read_to_string(e.path())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .collect::<Vec<_>>()
        })
        .filter(|l| l["event"] == "decide.decision")
        .collect();
    let refused = decisions
        .iter()
        .find(|l| l["outcome"] == "refuse")
        .unwrap_or_else(|| panic!("{decisions:?}"));
    assert_eq!(refused["tool"], "");
    assert_eq!(refused["sessionId"], "ses_case-refuse");
    assert_eq!(refused["code"], "DECIDE_REFUSED");
    assert_eq!(
        refused["rules"][0]["ref"],
        alpha_ref.trim_start_matches("decide.")
    );
    assert_eq!(refused["rules"][0]["effective"], "enforce");
    assert!(home
        .join(".intutic/decide/stats")
        .join(format!("{alpha}.json"))
        .exists());
    assert!(!cp
        .received_requests()
        .await
        .unwrap()
        .iter()
        .any(|r| r.url.path() == "/api/v1/decide/events"));

    // ── Allow ──
    let (_, body) = send("case-allow", false).await;
    assert!(!body.contains("Intutic Decide"), "{body}");

    // ── Escalate: unknown, `escalate: ask`, and the gateway has no ask ──
    let (_, body) = send("case-escalate", false).await;
    assert!(body.contains(AMBIGUOUS), "{body}");
    assert!(body.contains("DECIDE_ESCALATED"), "{body}");

    // ── Shadow: the shadow rule's `when` is true, and nothing changes ──
    let (_, body) = send("case-shadow", false).await;
    assert!(!body.contains("Intutic Decide"), "{body}");

    // ── Streaming: the note goes in ahead of the terminal event ──
    let (_, body) = send("case-stream-refuse", true).await;
    let note_at = body.find(VIOLATION).unwrap_or_else(|| panic!("{body}"));
    let done_at = body.rfind("data: [DONE]").expect("terminal");
    assert!(note_at < done_at, "the note precedes the terminal:\n{body}");
    assert_eq!(body.matches("data: [DONE]").count(), 1, "{body}");
    let (_, body) = send("case-stream-allow", true).await;
    assert!(!body.contains("Intutic Decide"), "{body}");

    // ── The note in each stream shape: a block or an item of its own ──
    for (route, request) in [
        (
            "/v1/messages",
            json!({"model": "claude-3-5-haiku-20241022", "max_tokens": 64, "stream": true,
                   "messages": [{"role": "user", "content": "case-wire-refuse: go"}]}),
        ),
        (
            "/v1/responses",
            json!({"model": "qwen-test-model", "stream": true, "input": "case-wire-refuse: go"}),
        ),
    ] {
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
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
            .header("x-session-id", format!("ses_wire{}", route.len()))
            .json(&request)
            .send()
            .await
            .expect("proxy reachable");
        assert!(res.status().is_success(), "{route}");
        let body = res.text().await.expect("body drains");
        let evs = events(&body);
        let note = evs
            .iter()
            .position(|(_, v)| v.to_string().contains(VIOLATION))
            .unwrap_or_else(|| panic!("{route}: no note:\n{body}"));
        let terminal = evs
            .iter()
            .position(|(n, _)| n == "message_stop" || n == "response.completed")
            .unwrap_or_else(|| panic!("{route}: no terminal:\n{body}"));
        assert!(
            note < terminal,
            "{route}: the note follows the terminal:\n{body}"
        );
        // Each event's name matches its payload's type: nothing was spliced
        // between an `event:` line and its `data:` line.
        for (name, v) in &evs {
            assert_eq!(Some(name.as_str()), v["type"].as_str(), "{route}:\n{body}");
        }
        // Its own block or item, after the model's.
        let (_, opened) = &evs[note - 1];
        if route == "/v1/messages" {
            assert_eq!(opened["type"], "content_block_start", "{body}");
            assert_eq!(opened["index"], 1, "{body}");
        } else {
            assert_eq!(
                evs[note - 2].1["type"],
                "response.output_item.added",
                "{body}"
            );
            assert_eq!(evs[note - 2].1["output_index"], 1, "{body}");
        }
    }

    // ── Tool calls on the stream hold ──
    let (_, body) = send("case-stream-tool-refuse", true).await;
    assert!(
        !body.contains("call_decide"),
        "the refused call leaked:\n{body}"
    );
    assert!(body.contains("[Intutic] Blocked tool call: Bash"), "{body}");
    assert!(body.contains("DECIDE_REFUSED"), "{body}");
    let marker = body
        .lines()
        .find(|l| l.starts_with(": intutic-refusal "))
        .unwrap_or_else(|| panic!("no refusal marker:\n{body}"));
    assert!(marker.contains(r#""code":"TOOL_DENIED""#), "{marker}");
    assert!(marker.contains(gamma_ref), "{marker}");

    let (_, body) = send("case-stream-tool-allow", true).await;
    assert!(
        body.contains("call_decide"),
        "an allowed call was dropped:\n{body}"
    );
    assert!(!body.contains("Blocked tool call"), "{body}");
    let mut args = String::new();
    for line in body.lines() {
        let Some(d) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if let Ok(v) = serde_json::from_str::<Value>(d) {
            if let Some(a) =
                v["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].as_str()
            {
                args.push_str(a);
            }
        }
    }
    assert_eq!(
        serde_json::from_str::<Value>(&args).expect("whole arguments"),
        json!({"command": "ls -la GAMMA-NO"})
    );

    // ── Tool calls off the stream ──
    let (rule, body) = send("case-json-tool-refuse", false).await;
    assert!(!body.contains("call_decide"), "{body}");
    assert!(body.contains("[Intutic] Blocked tool call: Bash"), "{body}");
    assert_eq!(rule.as_deref(), Some(gamma_ref));

    // ── A digest the pins were not earned on: every rule runs as shadow ──
    engine(&[("INTUTIC_DECIDE_MODEL_DIGEST", "sha256:another-model")]);
    let (_, body) = send("case-refuse", false).await;
    assert!(!body.contains("Intutic Decide"), "{body}");
    let (_, body) = send("case-stream-tool-refuse", true).await;
    assert!(body.contains("call_decide"), "{body}");

    // ── Over the response-state limit: unknown, never truncated ──
    engine(&[("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES", "64")]);
    let (_, body) = send("case-refuse", false).await;
    assert!(body.contains(AMBIGUOUS), "{body}");
    assert!(body.contains("DECIDE_ESCALATED"), "{body}");
    // A tool call's state keeps its own limit.
    let (_, body) = send("case-stream-tool-refuse", true).await;
    assert!(body.contains("DECIDE_REFUSED"), "{body}");

    // ── Engine down: a closed port. Enforcing rules refuse ──
    engine(&[("INTUTIC_DECIDE_ENGINE_URL", "http://127.0.0.1:1")]);
    let (_, body) = send("case-allow", false).await;
    assert!(body.contains(VIOLATION), "{body}");
    assert!(body.contains("GOVERNANCE_UNAVAILABLE"), "{body}");
    let (_, body) = send("case-stream-tool-allow", true).await;
    assert!(!body.contains("call_decide"), "{body}");
    assert!(body.contains("GOVERNANCE_UNAVAILABLE"), "{body}");
    // ... and a shadow one allows: without its pin the rule is shadow.
    std::fs::remove_file(pin_path(&home, &alpha)).unwrap();
    let (_, body) = send("case-refuse", false).await;
    assert!(!body.contains("Intutic Decide"), "{body}");
    write_pin(&home, &alpha);

    // ── Not configured: no engine.json and no model ──
    std::fs::remove_file(home.join(".intutic/decide/engine.json")).unwrap();
    engine(&[]);
    assert!(intutic_proxy::decide::gateway::current().engine().is_err());
    let (_, body) = send("case-allow", false).await;
    assert!(body.contains(VIOLATION), "{body}");
    assert!(body.contains("GOVERNANCE_UNAVAILABLE"), "{body}");
    let (rule, body) = send("case-json-tool-refuse", false).await;
    assert!(body.contains("GOVERNANCE_UNAVAILABLE"), "{body}");
    assert_eq!(rule.as_deref(), Some(gamma_ref));

    let _ = std::fs::remove_dir_all(&root);
}

/// The decision-traffic log keeps 30 days, as the decide log does: a file
/// goes once its UTC day ended 30 days ago, and nothing else in the
/// directory is touched.
#[test]
fn decision_traffic_logs_are_kept_for_thirty_days() {
    use chrono::TimeZone;
    let dir = std::env::temp_dir().join(format!("intutic-dt-rotation-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let now = chrono::Utc
        .with_ymd_and_hms(2026, 10, 31, 12, 0, 0)
        .unwrap();
    for name in [
        "decision-traffic-2026-09-30.jsonl",
        "decision-traffic-2026-10-01.jsonl",
        "decision-traffic-2026-10-02.jsonl",
        "decision-traffic-2026-10-31.jsonl",
        "decide-2026-09-01.jsonl",
        "decision-traffic-notes.txt",
        "traces-2026-09-01.jsonl",
    ] {
        std::fs::write(dir.join(name), "{}\n").unwrap();
    }
    let mut removed = intutic_proxy::decision_traffic::prune_logs(&dir, now);
    removed.sort();
    // The cutoff is 30 days before now, 2026-10-01T12:00Z: only a day that
    // ended by then goes.
    assert_eq!(removed, vec!["decision-traffic-2026-09-30.jsonl"]);
    for kept in [
        "decision-traffic-2026-10-01.jsonl",
        "decision-traffic-2026-10-02.jsonl",
        "decision-traffic-2026-10-31.jsonl",
        "decide-2026-09-01.jsonl",
        "decision-traffic-notes.txt",
        "traces-2026-09-01.jsonl",
    ] {
        assert!(dir.join(kept).exists(), "{kept} was deleted");
    }
    // A day later, 2026-10-01 is past retention too.
    let removed =
        intutic_proxy::decision_traffic::prune_logs(&dir, now + chrono::Duration::days(1));
    assert_eq!(removed, vec!["decision-traffic-2026-10-01.jsonl"]);
    // A missing directory prunes nothing.
    assert!(intutic_proxy::decision_traffic::prune_logs(&dir.join("missing"), now).is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}
