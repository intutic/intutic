//! End-to-end: a Responses request for a Claude model is translated to
//! Messages with its whole input, and the answer comes back as a Responses
//! body.
//!
//! ## What is pinned
//!
//! * a Codex-shaped `/v1/responses` turn (system prompt in `instructions`,
//!   `input_text` / `output_text` message items, a `function_call` and its
//!   `function_call_output`, flat function tools) reaches Anthropic's
//!   `/v1/messages` with `system`, the user text, the assistant's `tool_use`
//!   and the paired `tool_result`, and the tool;
//! * the client gets `object: "response"` with an `output_text` message and a
//!   `function_call` item (not Chat Completions `choices`);
//! * a tool call the SOPs deny is refused in the Responses shape too.
//!
//! Not streamed: a streamed Responses request translated to Messages still
//! gets Chat Completions chunks back (`OpenAIAdapter::translate_stream_event`
//! documents the gap).
//!
//! ONE `#[tokio::test]`: upstream URLs and the SOP directory are
//! process-global env.

use std::sync::Arc;

use serde_json::{json, Value};
use wiremock::matchers::{body_partial_json, body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\n---\nNo deletes.\n";
const WS: &str = "ws_responses_to_messages";
const INSTRUCTIONS: &str = "You are Codex, a coding agent running in the Codex CLI.";

// Runtime-assembled, per the repo's fixture rule.
fn anthropic_key() -> String {
    ["an", "-provisioned-", "test"].concat()
}

fn codex_turn(marker: &str) -> Value {
    json!({
        "model": "claude-sonnet-4-5",
        "instructions": INSTRUCTIONS,
        "input": [
            {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": format!("{marker}: run the tests and tell me what fails.")}
            ]},
            {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAAAB"},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "I'll run the test suite.", "annotations": []}
            ]},
            {"type": "function_call", "id": "fc_1", "call_id": "call_abc", "name": "shell",
             "arguments": "{\"command\":[\"bash\",\"-lc\",\"npm test\"]}"},
            {"type": "function_call_output", "call_id": "call_abc",
             "output": "1 failing: auth.spec.ts"}
        ],
        "tools": [{
            "type": "function",
            "name": "shell",
            "description": "Runs a shell command and returns its output.",
            "parameters": {"type": "object", "properties": {
                "command": {"type": "array", "items": {"type": "string"}}
            }}
        }],
        "tool_choice": "auto",
        "store": false,
        "stream": false
    })
}

fn anthropic_answer(tool: &str, call_id: &str) -> Value {
    json!({
        "id": "msg_01",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [
            {"type": "text", "text": "auth.spec.ts fails; reading it."},
            {"type": "tool_use", "id": call_id, "name": tool,
             "input": {"command": ["bash", "-lc", "cat auth.spec.ts"]}}
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 120, "output_tokens": 30}
    })
}

#[tokio::test]
async fn a_responses_turn_reaches_messages_whole_and_returns_as_a_response() {
    let anthropic = MockServer::start().await;

    // What the translated request must carry: the user's text, the
    // assistant's tool_use and the tool_result paired to it (the system
    // prompt is checked below, since the SOPs are injected ahead of it).
    let expected = json!({
        "model": "claude-sonnet-4-5",
        "messages": [
            {"role": "user", "content": "plain: run the tests and tell me what fails."},
            {"role": "assistant", "content": [
                {"type": "text", "text": "I'll run the test suite."},
                {"type": "tool_use", "id": "call_abc", "name": "shell",
                 "input": {"command": ["bash", "-lc", "npm test"]}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_abc", "content": "1 failing: auth.spec.ts"}
            ]}
        ],
        "tools": [{"name": "shell", "description": "Runs a shell command and returns its output."}]
    });
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", anthropic_key().as_str()))
        .and(body_partial_json(expected))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(anthropic_answer("shell", "toolu_plain")),
        )
        .expect(1)
        .named("plain")
        .mount(&anthropic)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(body_string_contains("deny: run the tests"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(anthropic_answer("delete_everything", "toolu_deny")),
        )
        .expect(1)
        .named("deny")
        .mount(&anthropic)
        .await;

    let sops_dir = std::env::temp_dir().join(format!(
        "intutic-responses-to-messages-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", anthropic.uri());
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    std::env::remove_var("ANTHROPIC_API_KEY");
    std::env::remove_var("CONTROL_PLANE_URL");
    std::env::remove_var("INTUTIC_WORKSPACE_ID");

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
    {
        use intutic_proxy::store::LocalStore as _;
        store
            .set_workspace_credential(WS, "anthropic_api_key", &anthropic_key())
            .await;
    }
    let config: intutic_proxy::config::ProxyConfig =
        serde_yaml::from_str("model_list: []\nintutic_settings:\n  routing:\n    enabled: false\n")
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

    let vk = concat!(
        "Bearer vk_",
        "0123456789abcdef0123456789abcdef",
        "_ws_responses_to_messages"
    );
    let send = |marker: &'static str| {
        reqwest::Client::new()
            .post(format!("http://{addr}/v1/responses"))
            .header("authorization", vk)
            .header("x-workspace-id", WS)
            .header("x-session-id", format!("ses_{marker}"))
            .json(&codex_turn(marker))
            .send()
    };

    // The answer is a Responses body: text as an output_text message, the
    // tool call as a function_call item the client answers by call_id.
    let res = send("plain").await.expect("proxy reachable");
    let status = res.status();
    let body: Value = res.json().await.expect("JSON body");
    assert!(status.is_success(), "{status}: {body}");
    assert_eq!(body["object"], "response", "{body}");
    assert!(body.get("choices").is_none(), "{body}");
    let output = body["output"].as_array().expect("output items");
    assert_eq!(output[0]["type"], "message", "{body}");
    assert_eq!(
        output[0]["content"][0],
        json!({"type": "output_text", "text": "auth.spec.ts fails; reading it.", "annotations": []})
    );
    assert_eq!(output[1]["type"], "function_call", "{body}");
    assert_eq!(output[1]["call_id"], "toolu_plain");
    assert_eq!(output[1]["name"], "shell");
    assert_eq!(
        serde_json::from_str::<Value>(output[1]["arguments"].as_str().unwrap()).unwrap(),
        json!({"command": ["bash", "-lc", "cat auth.spec.ts"]})
    );

    let sent: Value =
        serde_json::from_slice(&anthropic.received_requests().await.expect("recorded")[0].body)
            .unwrap();
    let system = sent["system"].as_str().expect("a system prompt");
    assert!(
        system.contains("No deletes.") && system.ends_with(INSTRUCTIONS),
        "the SOPs and the instructions are the system prompt: {system:?}"
    );

    // A denied tool call is refused, in the shape the client reads.
    let res = send("deny").await.expect("proxy reachable");
    let status = res.status();
    let text = res.text().await.unwrap();
    assert!(status.is_success(), "{status}: {text}");
    let body: Value = serde_json::from_str(&text).expect("JSON body");
    assert_eq!(body["object"], "response", "{body}");
    assert!(
        !text.contains("toolu_deny"),
        "the refused call reached the client: {text}"
    );
    assert!(
        text.contains("[Intutic] Blocked tool call"),
        "no refusal: {text}"
    );
    assert_eq!(body["output"][0]["type"], "message", "{body}");
}
