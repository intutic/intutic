//! A provider credential goes to its provider's upstream and nowhere else.
//!
//! A request's bearer is an Intutic virtual key or, on a passthrough proxy,
//! the caller's own provider key. Several control-plane calls used to take the
//! bearer as it came: `/fix` memory enhancement, the tool-call substitution
//! report, the judge, slash commands and the sandbox attestation forward all
//! sent a provider key to the control plane as their bearer, and the policy
//! check sent its first 12 characters in the body. Traces and logs carried the
//! same 12 characters as the request's "virtual key id".
//!
//! This drives every one of those paths twice through the real router, first
//! with a provider key and then with a virtual key, against a mock control
//! plane that records what it receives:
//!
//! - with the virtual key, each path reaches the control plane carrying it,
//!   which is what shows the requests below exercise those paths;
//! - with the provider key, no request to the control plane carries any part
//!   of it, the upstream still receives it, and neither the log output nor
//!   the trace file contains its prefix.
//!
//! ONE `#[tokio::test]`: upstream and control-plane URLs, `HOME` and the log
//! subscriber are process-global.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use wiremock::matchers::{any, body_string_contains, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const WORKSPACE: &str = "ws_egress";
const SESSION: &str = "ses_egress";

/// Control-plane paths each request shape below reaches with a virtual key.
const CONTROL_PLANE_PATHS: &[&str] = &[
    "/api/v1/fix/enhance",
    "/api/v1/slash-command",
    "/api/v1/policy/check",
    "/api/v1/auth/key-context",
    "/api/v1/judge/chunk",
    "/api/v1/judge/finalize",
    "/api/v1/decisions/substitutions",
    "/api/v1/sessions/ses_egress/attest-sandbox",
];

// Runtime-assembled per the repo's fixture rule.
fn provider_key() -> String {
    ["sk-", "egress-", "PROVIDERSECRET", "0123456789"].concat()
}
fn virtual_key() -> String {
    ["vk_", "0123456789abcdef0123456789abcdef", "_", WORKSPACE].concat()
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn sse_body() -> String {
    let mut body = String::new();
    for d in ["First paragraph.", "\n\n", "Second paragraph."] {
        let chunk = json!({
            "id": "chatcmpl-egress", "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {"content": d}, "finish_reason": null}]
        });
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    let finish = json!({
        "id": "chatcmpl-egress", "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 5}
    });
    body.push_str(&format!("data: {finish}\n\ndata: [DONE]\n\n"));
    body
}

fn completion(message: Value) -> Value {
    json!({
        "id": "chatcmpl-egress", "object": "chat.completion", "model": "qwen-test-model",
        "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
    })
}

/// Output DLP redacts the access key inside the call's arguments, which is
/// the substitution the proxy reports.
fn tool_call_completion() -> Value {
    let command = [
        "aws configure set aws_access_key_id ",
        "AKIA",
        "IOSFODNN7EXAMPLE",
    ]
    .concat();
    completion(json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": "bash", "arguments": json!({"command": command}).to_string()}
        }]
    }))
}

/// Everything a request may carry: headers, URL and body.
fn request_text(r: &Request) -> String {
    let headers: Vec<String> = r
        .headers
        .iter()
        .map(|(k, v)| format!("{k}: {}", String::from_utf8_lossy(v.as_bytes())))
        .collect();
    format!(
        "{}\n{}\n{}",
        r.url,
        headers.join("\n"),
        String::from_utf8_lossy(&r.body)
    )
}

/// Sends every request shape that reaches the control plane, authenticated
/// with `bearer`, and returns the response bodies of those that go upstream.
async fn exercise(addr: std::net::SocketAddr, bearer: &str) -> Vec<String> {
    let client = reqwest::Client::new();
    let chat = |body: Value| {
        client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {bearer}"))
            .header("x-workspace-id", WORKSPACE)
            .header("x-session-id", SESSION)
            .json(&body)
            .send()
    };
    let user = |content: &str| json!([{"role": "user", "content": content}]);
    let mut upstream_bodies = Vec::new();

    for (body, goes_upstream) in [
        (
            json!({"model": "qwen-test-model", "messages": user("/fix make the build faster")}),
            false,
        ),
        (
            json!({"model": "qwen-test-model", "messages": user("/intutic status")}),
            false,
        ),
        (
            json!({"model": "qwen-test-model", "messages": user("/intutic judge Describe it.")}),
            true,
        ),
        (
            json!({"model": "qwen-test-model", "stream": true,
                   "messages": user("/intutic judge Describe it as a stream.")}),
            true,
        ),
        (
            json!({"model": "qwen-test-model", "messages": user("please call the tool")}),
            true,
        ),
    ] {
        let res = chat(body.clone()).await.expect("proxy reachable");
        let status = res.status();
        let text = res.text().await.expect("body reads");
        assert!(status.is_success(), "{body} -> {status}: {text}");
        if goes_upstream {
            upstream_bodies.push(text);
        }
    }

    // Answered from inside a sandbox with the session's bearer.
    let _ = client
        .post(format!("http://{addr}/intutic/attest-sandbox"))
        .header("Authorization", format!("Bearer {bearer}"))
        .json(&json!({"sessionId": SESSION}))
        .send()
        .await
        .expect("proxy reachable");

    upstream_bodies
}

/// Waits for the detached reports (substitution, judge chunks) to land.
async fn settle(cp: &MockServer, wanted: impl Fn(&[Request]) -> bool) -> Vec<Request> {
    for _ in 0..50 {
        let received = cp.received_requests().await.expect("recording on");
        if wanted(&received) {
            return received;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    cp.received_requests().await.expect("recording on")
}

#[tokio::test]
async fn a_provider_key_reaches_only_its_upstream() {
    let home = std::env::temp_dir().join(format!(
        "intutic-egress-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    let logs = Captured::default();
    let writer = logs.clone();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("intutic_proxy=trace"))
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .try_init()
        .expect("the only subscriber in this binary");

    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("\"stream\":true"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_body(), "text/event-stream"),
        )
        .with_priority(1)
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("please call the tool"))
        .respond_with(ResponseTemplate::new(200).set_body_json(tool_call_completion()))
        .with_priority(1)
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(completion(json!({"role": "assistant", "content": "Done."}))),
        )
        .mount(&upstream)
        .await;

    // Answers every route with one body holding each field a caller reads.
    let cp = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "action": "allow",
            "workspaceId": WORKSPACE,
            "ssoGroups": {"policy": null, "memberGroups": null},
            "data": {"chunks": []},
            "responseText": "status from the control plane",
            "verdict": "PASS",
            "triggered": false,
            "correctionSummary": "",
            "accepted": 1,
            "bypasses": []
        })))
        .mount(&cp)
        .await;

    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    // A virtual key is never forwarded upstream: its requests need a provider
    // key, which the operator fallback supplies.
    std::env::set_var("OPENAI_API_KEY", ["test", "-operator-", "key"].concat());
    std::env::set_var("CONTROL_PLANE_URL", cp.uri());
    std::env::remove_var("INTUTIC_SOPS_DIR");

    // Fail-open, so a provider-key request is not stopped by the policy check
    // it can no longer pass, and goes on to reach every later path.
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
        axum::serve(listener, app).await.ok();
    });

    // ── Provider key ─────────────────────────────────────────────────────
    let provider = provider_key();
    let provider_prefix = &provider[..12];
    let bodies = exercise(addr, &provider).await;
    // Detached work (the judge's chunk calls, the substitution report) would
    // have been spawned by now; give it the same time the virtual-key phase
    // gets before looking.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let leaked: Vec<String> = cp
        .received_requests()
        .await
        .expect("recording on")
        .iter()
        .map(request_text)
        .filter(|t| t.contains(provider_prefix))
        .collect();
    assert!(
        leaked.is_empty(),
        "the control plane received the provider key:\n{leaked:#?}"
    );
    assert!(
        bodies[0].contains("verdict UNAVAILABLE"),
        "the judge says it was not asked, rather than staying silent: {}",
        bodies[0]
    );
    let upstream_auth: Vec<String> = upstream
        .received_requests()
        .await
        .expect("recording on")
        .iter()
        .filter_map(|r| r.headers.get("authorization"))
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .collect();
    assert_eq!(upstream_auth.len(), 3, "{upstream_auth:?}");
    assert!(
        upstream_auth
            .iter()
            .all(|a| a == &format!("Bearer {provider}")),
        "passthrough still sends the provider key to its upstream: {upstream_auth:?}"
    );
    let provider_phase_count = cp.received_requests().await.expect("recording on").len();

    // ── Virtual key ──────────────────────────────────────────────────────
    let vk = virtual_key();
    exercise(addr, &vk).await;
    let received = settle(&cp, |r| {
        CONTROL_PLANE_PATHS
            .iter()
            .all(|p| r.iter().any(|req| req.url.path() == *p))
    })
    .await;
    let vk_phase = &received[provider_phase_count..];
    for p in CONTROL_PLANE_PATHS {
        let hits: Vec<&Request> = vk_phase.iter().filter(|r| r.url.path() == *p).collect();
        assert!(!hits.is_empty(), "nothing reached {p} with a virtual key");
        for r in hits {
            assert_eq!(
                r.headers
                    .get("authorization")
                    .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()),
                Some(format!("Bearer {vk}")),
                "{p}"
            );
        }
    }

    // ── Logs and traces ──────────────────────────────────────────────────
    let log_text = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    assert!(
        log_text.contains("Request received"),
        "the log capture saw the request path"
    );
    assert!(
        !log_text.contains(provider_prefix),
        "the provider key's prefix was logged"
    );
    let trace_dir = home.join(".intutic").join("logs");
    let traces: String = std::fs::read_dir(&trace_dir)
        .expect("traces were written")
        .filter_map(|e| std::fs::read_to_string(e.ok()?.path()).ok())
        .collect();
    assert!(
        traces.contains(&vk[..12]),
        "the trace file names the virtual key"
    );
    assert!(
        !traces.contains(provider_prefix),
        "a trace recorded the provider key's prefix"
    );

    let _ = std::fs::remove_dir_all(&home);
}
