//! End-to-end: `judge_local::local_judge` reads its typed-stage config from
//! the environment and wires the free-text judge in behind it. The
//! cascade's own branches are unit-tested in `judge_local.rs`
//! with injected config; this file checks the env wiring against one
//! wiremock LiteLLM that answers both kinds of request.
//!
//! Typed requests carry `max_tokens: 1` and `logprobs`; free-text requests
//! carry `response_format`. The mock tells them apart by body.
//!
//! ONE `#[tokio::test]` in this file: the env vars are process-global, so the
//! scenarios run in sequence within it rather than racing as separate tests.

use intutic_proxy::judge_local::{local_judge, LocalVerdict};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const SOP: &str = "Never delete the production database.";

fn typed_body(p_yes: f64) -> serde_json::Value {
    serde_json::json!({
        "choices": [{
            "message": { "content": "no" },
            "logprobs": { "content": [{
                "token": "no",
                "logprob": (1.0 - p_yes).ln(),
                "top_logprobs": [
                    { "token": "yes", "logprob": p_yes.ln() },
                    { "token": "no", "logprob": (1.0 - p_yes).ln() },
                ],
            }] },
        }],
    })
}

/// A LiteLLM stand-in: typed requests get `p_yes`, free-text requests get a
/// VIOLATION verdict.
async fn litellm(p_yes: f64) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(
            serde_json::json!({ "max_tokens": 1, "logprobs": true }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(typed_body(p_yes)))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(
            serde_json::json!({ "response_format": { "type": "json_object" } }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{ "message": {
                "content": "{\"verdict\": \"VIOLATION\", \"reasoning\": \"Free-text: dropped a table.\"}"
            } }]
        })))
        .mount(&server)
        .await;
    server
}

/// (typed request models, free-text request models).
async fn requests(server: &MockServer) -> (Vec<String>, Vec<String>) {
    let mut typed = Vec::new();
    let mut free_text = Vec::new();
    for r in server.received_requests().await.expect("recording on") {
        let body: serde_json::Value = serde_json::from_slice(&r.body).expect("JSON body");
        let model = body["model"].as_str().unwrap_or_default().to_string();
        if body["max_tokens"] == 1 && body["logprobs"] == true {
            typed.push(model);
        } else if body.get("response_format").is_some() {
            free_text.push(model);
        } else {
            panic!("unexpected request body: {body}");
        }
    }
    (typed, free_text)
}

#[tokio::test]
async fn local_judge_reads_the_typed_stage_from_env() {
    let http = reqwest::Client::new();
    std::env::set_var("LITELLM_LOCAL_JUDGE_MODEL", "free-text-model");
    std::env::remove_var("LITELLM_LOCAL_TYPED_JUDGE_MODEL");
    std::env::remove_var("LITELLM_LOCAL_API_KEY");

    // ── 1. No band configured: free text only, as before Phase 4. ──
    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO");
    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "DROP TABLE users;", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    assert_eq!(
        requests(&server).await,
        (vec![], vec!["free-text-model".to_string()])
    );

    // ── 2. Band set, clean score: two typed requests, no free-text one. ──
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO", "-4");
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI", "2.461");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "Here is the report.", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Compliant);
    assert!(
        out.reasoning.starts_with("Typed judge:"),
        "{}",
        out.reasoning
    );
    assert_eq!(
        requests(&server).await,
        (vec!["free-text-model".to_string(); 2], vec![]),
        "typed questions fall back to LITELLM_LOCAL_JUDGE_MODEL"
    );

    // ── 3. Violation score, typed model override: the free-text judge runs
    //    once on its own model and its reasoning is used. ──
    std::env::set_var("LITELLM_LOCAL_TYPED_JUDGE_MODEL", "typed-model");
    let server = litellm(0.999).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "DROP TABLE users;", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    assert_eq!(out.reasoning, "Free-text: dropped a table.");
    assert_eq!(
        requests(&server).await,
        (
            vec!["typed-model".to_string(); 2],
            vec!["free-text-model".to_string()]
        )
    );

    // ── 4. Invalid band (lo >= hi): the typed stage stays off. ──
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO", "3");
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI", "1");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "DROP TABLE users;", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    assert_eq!(
        requests(&server).await,
        (vec![], vec!["free-text-model".to_string()])
    );
}
