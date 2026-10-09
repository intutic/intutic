//! End-to-end: requests naming Bedrock, Vertex AI and Azure OpenAI models go
//! through the real router to mocked cloud upstreams, and every governance
//! step that runs for first-party providers runs for them too.
//!
//! What is pinned, per provider:
//!
//! * the upstream receives the provider's own request (path, auth, body) —
//!   Bedrock InvokeModel, Converse and mantle, Vertex `rawPredict` and
//!   `streamGenerateContent`, Azure's OpenAI v1 API;
//! * the client receives its own wire back, streaming included: Anthropic SSE
//!   on `/v1/messages`, OpenAI chunks on `/v1/chat/completions` (translated
//!   from an Anthropic-wire cloud upstream);
//! * the response gate refuses an SOP-denied tool call streamed from Bedrock
//!   (event-stream) and from Azure, and DLP redacts a secret the model
//!   returns;
//! * a `model_list` alias routes a plain model name to a cloud deployment;
//! * cost is metered from the cloud usage at the vendor model's price
//!   (offline trace log), streamed and not;
//! * cloud errors arrive as the client wire's error (429 `rate_limit_error`),
//!   and a route with no translation to the provider is refused;
//! * a fallback target that names only a provider serves the same model
//!   there once retries are spent: Anthropic's API → Bedrock, Bedrock →
//!   Vertex AI, each with the id rewritten into the target's scheme.
//!
//! No real cloud endpoint is contacted: AWS credentials are fixed fake
//! values, the Google token comes from a mocked metadata server with `HOME`
//! and `GOOGLE_APPLICATION_CREDENTIALS` pointed away from any real login, and
//! every endpoint is the mock.
//!
//! ONE `#[tokio::test]`: endpoints, credentials and `HOME` are process env.

use std::sync::Arc;

use base64::Engine;
use serde_json::{json, Value};
use wiremock::matchers::{body_string_contains, header, header_exists, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "---\ndeny_tools: delete_everything\n---\nNo deletes.\n";
const WS: &str = "ws_cloud_providers";

/// One AWS event-stream frame (prelude, string headers, payload, CRCs).
fn frame(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
    let mut h = Vec::new();
    for (name, value) in headers {
        h.push(name.len() as u8);
        h.extend_from_slice(name.as_bytes());
        h.push(7);
        h.extend_from_slice(&(value.len() as u16).to_be_bytes());
        h.extend_from_slice(value.as_bytes());
    }
    let total = (16 + h.len() + payload.len()) as u32;
    let mut m = total.to_be_bytes().to_vec();
    m.extend_from_slice(&(h.len() as u32).to_be_bytes());
    let c = crc32fast::hash(&m);
    m.extend_from_slice(&c.to_be_bytes());
    m.extend_from_slice(&h);
    m.extend_from_slice(payload);
    let c = crc32fast::hash(&m);
    m.extend_from_slice(&c.to_be_bytes());
    m
}

/// A Bedrock InvokeModelWithResponseStream body for these Anthropic events.
fn bedrock_stream(events: &[Value]) -> Vec<u8> {
    events
        .iter()
        .flat_map(|ev| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(ev.to_string());
            frame(
                &[(":event-type", "chunk"), (":message-type", "event")],
                json!({"bytes": b64}).to_string().as_bytes(),
            )
        })
        .collect()
}

fn anthropic_events(text: &str, tool: Option<(&str, &str)>) -> Vec<Value> {
    let mut ev = vec![
        json!({"type": "message_start", "message": {"id": "msg_c", "type": "message", "role": "assistant",
               "content": [], "model": "claude", "usage": {"input_tokens": 1000, "output_tokens": 1}}}),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        json!({"type": "content_block_stop", "index": 0}),
    ];
    let mut stop = "end_turn";
    if let Some((name, id)) = tool {
        stop = "tool_use";
        ev.push(json!({"type": "content_block_start", "index": 1,
                       "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}}));
        ev.push(json!({"type": "content_block_delta", "index": 1,
                       "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"/\"}"}}));
        ev.push(json!({"type": "content_block_stop", "index": 1}));
    }
    // Bedrock's InvokeModel stream reports output only on message_delta.
    ev.push(json!({"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 500}}));
    ev.push(json!({"type": "message_stop"}));
    ev
}

fn sse_of(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect()
}

fn fake_aws_key() -> String {
    ["AKIA", "IOSFODNN7", "EXAMPLE"].concat()
}

async fn mock(server: &MockServer, up_path: &str, marker: &str, resp: ResponseTemplate) {
    Mock::given(method("POST"))
        .and(path(up_path))
        .and(body_string_contains(marker))
        .respond_with(resp)
        .expect(1)
        .named(marker)
        .mount(server)
        .await;
}

#[tokio::test]
async fn cloud_upstreams_are_served_and_governed_end_to_end() {
    let up = MockServer::start().await;

    // ── Bedrock ──
    // Legacy Claude via InvokeModel, streamed, with a denied tool call.
    Mock::given(method("POST"))
        .and(path(
            "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke-with-response-stream",
        ))
        .and(header_exists("x-amz-date"))
        .and(body_string_contains(
            "\"anthropic_version\":\"bedrock-2023-05-31\"",
        ))
        .and(body_string_contains("bedrock-deny"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/vnd.amazon.eventstream")
                .set_body_bytes(bedrock_stream(&anthropic_events(
                    "Cleaning up.",
                    Some(("delete_everything", "toolu_bdrkdeny")),
                ))),
        )
        .expect(1)
        .mount(&up)
        .await;
    // An alias in model_list, non-streaming, returning a secret.
    mock(
        &up,
        "/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke",
        "bedrock-alias-dlp",
        ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_a", "type": "message", "role": "assistant", "model": "claude-3-5-haiku-20241022",
            "content": [{"type": "text", "text": format!("served by bedrock alias, key {}", fake_aws_key())}],
            "stop_reason": "end_turn", "stop_sequence": null,
            "usage": {"input_tokens": 2000, "output_tokens": 100}
        })),
    )
    .await;
    // A non-Anthropic model via Converse, reached on the OpenAI wire.
    mock(
        &up,
        "/model/meta.llama3-1-70b-instruct-v1%3A0/converse",
        "bedrock-converse",
        ResponseTemplate::new(200).set_body_json(json!({
            "output": {"message": {"role": "assistant", "content": [{"text": "served by bedrock converse"}]}},
            "stopReason": "end_turn",
            "usage": {"inputTokens": 12, "outputTokens": 5, "totalTokens": 17}
        })),
    )
    .await;
    // Opus 4.7+ via the mantle Messages API.
    mock(
        &up,
        "/anthropic/v1/messages",
        "bedrock-mantle",
        ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_raw(
                sse_of(&anthropic_events("served by bedrock mantle", None)),
                "text/event-stream",
            ),
    )
    .await;
    // Throttling.
    Mock::given(method("POST"))
        .and(path(
            "/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke",
        ))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("x-amzn-errortype", "ThrottlingException")
                .set_body_json(json!({"message": "Too many requests"})),
        )
        .mount(&up)
        .await;

    // ── Vertex AI ──
    Mock::given(method("GET"))
        .and(path(
            "/computeMetadata/v1/instance/service-accounts/default/token",
        ))
        .and(header("metadata-flavor", "Google"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token": "ya29.cloudtest", "expires_in": 3600})),
        )
        .mount(&up)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict"))
        .and(header("authorization", "Bearer ya29.cloudtest"))
        .and(body_string_contains("\"anthropic_version\":\"vertex-2023-10-16\""))
        .and(body_string_contains("vertex-claude"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_v", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "served by vertex claude"}],
            "stop_reason": "end_turn", "stop_sequence": null,
            "usage": {"input_tokens": 10, "output_tokens": 4}
        })))
        .expect(1)
        .mount(&up)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/projects/proj-1/locations/us-east5/publishers/google/models/gemini-2.5-flash:streamGenerateContent"))
        .and(query_param("alt", "sse"))
        .and(body_string_contains("vertex-gemini"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"served by \"}]}}]}\r\n\r\n\
             data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"vertex gemini\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":9,\"candidatesTokenCount\":4}}\r\n\r\n",
            "text/event-stream",
        ))
        .expect(1)
        .mount(&up)
        .await;

    // ── Azure OpenAI ──
    let azure_chunk = |delta: Value, finish: Value| {
        format!(
            "data: {}\n\n",
            json!({"id": "chatcmpl-az", "object": "chat.completion.chunk", "model": "gpt-4o",
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        )
    };
    let mut azure_stream =
        "data: {\"choices\":[],\"created\":0,\"id\":\"\",\"model\":\"\",\"object\":\"\",\"prompt_filter_results\":[]}\n\n".to_string();
    azure_stream += &azure_chunk(
        json!({"role": "assistant", "content": "Cleaning up."}),
        Value::Null,
    );
    azure_stream += &azure_chunk(
        json!({"tool_calls": [{"index": 0, "id": "call_azdeny", "type": "function",
                               "function": {"name": "delete_everything", "arguments": ""}}]}),
        Value::Null,
    );
    azure_stream += &azure_chunk(json!({}), json!("tool_calls"));
    azure_stream += "data: [DONE]\n\n";
    Mock::given(method("POST"))
        .and(path("/openai/v1/chat/completions"))
        .and(header("api-key", "azure-cloud-test-key"))
        .and(body_string_contains("\"model\":\"gpt4o-prod\""))
        .and(body_string_contains("azure-deny"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(azure_stream, "text/event-stream"))
        .expect(1)
        .mount(&up)
        .await;

    // ── Fallbacks: "same model, another provider" ──
    let anthropic = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(body_string_contains("fallback-anthropic-to-bedrock"))
        .respond_with(ResponseTemplate::new(529).set_body_json(
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ))
        .expect(2)
        .mount(&anthropic)
        .await;
    mock(
        &up,
        "/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke",
        "fallback-anthropic-to-bedrock",
        ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_fb1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5-20250929",
            "content": [{"type": "text", "text": "served by bedrock after anthropic"}],
            "stop_reason": "end_turn", "stop_sequence": null, "usage": {"input_tokens": 5, "output_tokens": 5}
        })),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/anthropic/v1/messages"))
        .and(body_string_contains("fallback-bedrock-to-vertex"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("x-amzn-errortype", "ThrottlingException")
                .set_body_json(json!({"message": "Too many requests"})),
        )
        .expect(2)
        .mount(&up)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-opus-4-7:rawPredict"))
        .and(body_string_contains("fallback-bedrock-to-vertex"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg_fb2", "type": "message", "role": "assistant", "model": "claude-opus-4-7",
            "content": [{"type": "text", "text": "served by vertex after bedrock"}],
            "stop_reason": "end_turn", "stop_sequence": null, "usage": {"input_tokens": 5, "output_tokens": 5}
        })))
        .expect(1)
        .mount(&up)
        .await;

    // ── Process environment: nothing real is reachable ──
    let home = std::env::temp_dir().join(format!("intutic-cloud-e2e-{}", std::process::id()));
    let sops_dir = home.join("sops");
    std::fs::create_dir_all(&sops_dir).unwrap();
    std::fs::write(sops_dir.join("policy.md"), SOP).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("INTUTIC_SOPS_DIR", &sops_dir);
    std::env::set_var("AWS_ACCESS_KEY_ID", "AKIDCLOUDE2E");
    std::env::set_var(
        "AWS_SECRET_ACCESS_KEY",
        ["cloud", "-e2e-", "secret"].concat(),
    );
    std::env::set_var("GCE_METADATA_HOST", up.address().to_string());
    std::env::set_var("TEST_AZURE_KEY", "azure-cloud-test-key");
    std::env::set_var("ANTHROPIC_UPSTREAM_URL", anthropic.uri());
    std::env::set_var(
        "ANTHROPIC_API_KEY",
        ["anthropic", "-cloud-e2e-", "key"].concat(),
    );
    for v in [
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AZURE_OPENAI_API_KEY",
        "CONTROL_PLANE_URL",
        "INTUTIC_WORKSPACE_ID",
    ] {
        std::env::remove_var(v);
    }

    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(&format!(
        r#"
model_list:
  - model_name: claude-corp
    litellm_params:
      model: bedrock/anthropic.claude-3-5-haiku-20241022-v1:0
intutic_settings:
  routing:
    enabled: false
    retry:
      max_attempts: 2
      initial_backoff_ms: 1
      max_backoff_ms: 5
    fallbacks:
      claude-sonnet-4-5-20250929:
        - provider: bedrock
      bedrock/anthropic.claude-opus-4-7:
        - provider: vertex_ai
  providers:
    bedrock:
      region: us-east-1
      runtime_endpoint: {u}
      mantle_endpoint: {u}
    vertex:
      project: proj-1
      location: us-east5
      endpoint: {u}
    azure:
      endpoint: {u}
      api_key: os.environ/TEST_AZURE_KEY
"#,
        u = up.uri()
    ))
    .expect("config parses");
    intutic_proxy::cloud::install_aliases(&config.model_list);

    let store = Arc::new(intutic_proxy::store::MemoryStore::new());
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
        "_ws_cloud_providers"
    );

    // (marker, route, model, stream, expected status, expected text, refused call id)
    type Case<'a> = (
        &'a str,
        &'a str,
        &'a str,
        bool,
        u16,
        &'a str,
        Option<&'a str>,
    );
    let cases: Vec<Case> = vec![
        (
            "bedrock-deny",
            "/v1/messages",
            "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            true,
            200,
            "Cleaning up.",
            Some("toolu_bdrkdeny"),
        ),
        (
            "bedrock-alias-dlp",
            "/v1/messages",
            "claude-corp",
            false,
            200,
            "served by bedrock alias",
            None,
        ),
        (
            "bedrock-converse",
            "/v1/chat/completions",
            "bedrock/meta.llama3-1-70b-instruct-v1:0",
            false,
            200,
            "served by bedrock converse",
            None,
        ),
        (
            "bedrock-mantle",
            "/v1/messages",
            "bedrock/anthropic.claude-opus-4-7",
            true,
            200,
            "served by bedrock mantle",
            None,
        ),
        (
            "bedrock-throttled",
            "/v1/messages",
            "bedrock/anthropic.claude-3-haiku-20240307-v1:0",
            false,
            429,
            "rate_limit_error",
            None,
        ),
        (
            "vertex-claude",
            "/v1/messages",
            "vertex/claude-sonnet-4-5@20250929",
            false,
            200,
            "served by vertex claude",
            None,
        ),
        (
            "vertex-gemini",
            "/v1/chat/completions",
            "vertex/gemini-2.5-flash",
            true,
            200,
            "vertex gemini",
            None,
        ),
        (
            "azure-deny",
            "/v1/chat/completions",
            "azure/gpt4o-prod",
            true,
            200,
            "Cleaning up.",
            Some("call_azdeny"),
        ),
        (
            "azure-wrong-wire",
            "/v1/messages",
            "azure/gpt4o-prod",
            false,
            400,
            "unsupported_route",
            None,
        ),
        (
            "fallback-anthropic-to-bedrock",
            "/v1/messages",
            "claude-sonnet-4-5-20250929",
            false,
            200,
            "served by bedrock after anthropic",
            None,
        ),
        (
            "fallback-bedrock-to-vertex",
            "/v1/messages",
            "bedrock/anthropic.claude-opus-4-7",
            false,
            200,
            "served by vertex after bedrock",
            None,
        ),
    ];

    let mut failures = Vec::new();
    for (marker, route, model, stream, want_status, expected, refused) in &cases {
        let prompt = format!("{marker}: tidy up");
        let body = if *route == "/v1/messages" {
            json!({"model": model, "max_tokens": 64, "stream": stream,
                   "messages": [{"role": "user", "content": prompt}]})
        } else {
            json!({"model": model, "stream": stream,
                   "messages": [{"role": "user", "content": prompt}]})
        };
        let res = reqwest::Client::new()
            .post(format!("http://{addr}{route}"))
            .header("authorization", vk)
            .header("x-workspace-id", WS)
            .header("x-session-id", format!("ses_{marker}"))
            .json(&body)
            .send()
            .await
            .expect("proxy reachable");
        let status = res.status().as_u16();
        let fallback_from = res
            .headers()
            .get("x-intutic-upstream-fallback-from")
            .map(|v| v.to_str().unwrap().to_string());
        let text = res.text().await.expect("body reads");
        if marker.starts_with("fallback-") && fallback_from.as_deref() != Some(*model) {
            failures.push(format!(
                "{marker}: fallback-from header {fallback_from:?}, wanted {model}"
            ));
        }
        if status != *want_status {
            failures.push(format!(
                "{marker}: status {status}, wanted {want_status}: {text}"
            ));
            continue;
        }
        if !text.contains(expected) {
            failures.push(format!("{marker}: expected {expected:?} in\n{text}"));
        }
        if let Some(call_id) = refused {
            if !text.contains("[Intutic] Blocked tool call") {
                failures.push(format!("{marker}: no refusal in the stream\n{text}"));
            }
            if text.contains(call_id) {
                failures.push(format!(
                    "{marker}: the refused call reached the client\n{text}"
                ));
            }
        }
        if text.contains(&fake_aws_key()) {
            failures.push(format!("{marker}: DLP let an AWS key through\n{text}"));
        }
        if *route == "/v1/chat/completions"
            && *want_status == 200
            && !stream
            && !text.contains("\"chat.completion\"")
        {
            failures.push(format!("{marker}: not an OpenAI chat completion\n{text}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));

    // ── Cost metering: the offline trace log records the cloud usage at the
    // vendor price (claude-3-5-haiku for the alias) ──
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log = home
        .join(".intutic/logs")
        .join(format!("traces-{today}.jsonl"));
    let mut traces: Vec<Value> = Vec::new();
    for _ in 0..50 {
        traces = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        if traces.iter().any(|t| t["model"] == "claude-corp")
            && traces
                .iter()
                .any(|t| t["session_id"] == "ses_bedrock-mantle")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let alias = traces
        .iter()
        .find(|t| t["model"] == "claude-corp")
        .unwrap_or_else(|| panic!("no trace for the alias request in {traces:?}"));
    let usage = intutic_proxy::usage::TokenUsage {
        uncached_input: Some(2000),
        output: Some(100),
        ..Default::default()
    };
    let expected =
        intutic_proxy::pricing::estimate_cost_cached("claude-3-5-haiku-20241022", &usage);
    let actual = alias["actual_cost_usd"].as_f64().unwrap();
    assert!(
        expected > 0.0 && (actual - expected).abs() < 1e-9,
        "alias cost {actual}, expected {expected}"
    );
    assert_eq!(alias["output_tokens"], 100);

    // A stream the response gate stops is metered only up to the refusal,
    // as for any provider; the mantle stream runs to the end. Its input count
    // is on `message_start` only.
    let streamed = traces
        .iter()
        .find(|t| t["session_id"] == "ses_bedrock-mantle")
        .expect("trace for the streamed Bedrock request");
    let usage = intutic_proxy::usage::TokenUsage {
        uncached_input: Some(1000),
        output: Some(500),
        ..Default::default()
    };
    let expected = intutic_proxy::pricing::estimate_cost_cached("claude-opus-4-7", &usage);
    let actual = streamed["actual_cost_usd"].as_f64().unwrap();
    assert!(
        (actual - expected).abs() < 1e-9,
        "streamed cost {actual}, expected {expected}"
    );

    let _ = std::fs::remove_dir_all(&home);
}
