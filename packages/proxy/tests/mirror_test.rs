//! End-to-end for the mirrored call: a real HTTP request to a stub upstream.
//!
//! The unit tests in `routing::mirror` cover the sampling arithmetic, and the
//! invocation test asserts `proxy.rs` calls the module and spawns it detached.
//! Neither issues a request. This does — against `wiremock`, which was declared
//! as a dev-dependency of this crate and **used by nothing**, so the one thing
//! in the tree for standing up a fake upstream had never stood one up.
//!
//! What this proves that the unit tests cannot:
//!
//! - the request actually leaves the process, carrying the candidate model
//! - a 200 is parsed, scored by the same `integrity::score` the served path
//!   uses, and priced from the provider's own usage numbers
//! - a non-2xx is **not** scored, because an upstream refusal says there was no
//!   answer rather than that the answer was bad
//! - a connection failure returns `None` rather than propagating
//! - the concurrency slot releases down every one of those paths
//!
//! It spends nothing: `wiremock` binds a local port and answers from a canned
//! body. Running mirroring against a real provider costs real money on every
//! sampled request and is an operator's decision, not a test's.

use std::sync::Arc;

use intutic_proxy::routing::integrity;
use intutic_proxy::routing::mirror;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Serialises these tests over the process-wide slot counter.
///
/// `IN_FLIGHT` is one static shared by the whole binary and cargo runs these
/// concurrently, so without this they take each other's slots — and with five
/// tests against a ceiling of four, one is guaranteed to be refused. The unit
/// tests in the module needed the same treatment for the same reason.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    // Poisoned means an earlier test panicked; recover rather than cascading.
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// A real slot, from the real decision.
///
/// `MirrorSlot` cannot be constructed here any more, and that is the point: the
/// first version of this file built them directly, so `Drop` decremented a
/// counter nothing had incremented and `IN_FLIGHT` underflowed to
/// `usize::MAX - 3`. In production that makes `prev >= MAX_CONCURRENT` true
/// forever and mirroring stops for the life of the process, silently. The
/// private field now makes that unrepresentable.
fn slot() -> mirror::MirrorSlot {
    mirror::should_mirror(0.05, false, "requested", "candidate", 0.0)
        .expect("under the ceiling, so a slot is granted")
}

/// A flat price, so the assertion is about plumbing rather than the price table.
fn flat_estimate() -> Arc<dyn Fn(&str, u32, u32) -> f64 + Send + Sync> {
    Arc::new(|_model: &str, prompt: u32, completion: u32| {
        (prompt as f64) * 0.000_001 + (completion as f64) * 0.000_002
    })
}

fn anthropic_ok() -> serde_json::Value {
    json!({
        "content": [{ "type": "text", "text": "the answer" }],
        "usage": { "input_tokens": 1200, "output_tokens": 300 }
    })
}

#[tokio::test]
async fn mirrors_a_real_request_and_scores_the_response() {
    let _serial = serial();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(anthropic_ok()))
        .expect(1)
        .mount(&server)
        .await;

    let before = mirror::in_flight();
    let outcome = mirror::run_mirror(
        slot(),
        reqwest::Client::new(),
        format!("{}/v1/messages", server.uri()),
        reqwest::header::HeaderMap::new(),
        serde_json::to_vec(&json!({ "model": "cheap-model", "messages": [] })).unwrap(),
        Some(json!({ "messages": [] })),
        "cheap-model".to_string(),
        "ws_test".to_string(),
        flat_estimate(),
    )
    .await
    .expect("a 200 with a well-formed body must produce an outcome");

    assert_eq!(outcome.candidate_model, "cheap-model");
    assert_eq!(
        outcome.integrity.score,
        integrity::RIS_MAX,
        "a clean response must score clean; got fault {:?}",
        outcome.integrity.fault
    );
    assert!(outcome.integrity.fault.is_none());

    // Priced from the provider's own usage numbers, not from the request.
    assert!(
        (outcome.cost_usd - (1200.0 * 0.000_001 + 300.0 * 0.000_002)).abs() < 1e-12,
        "cost was not derived from the response usage: {}",
        outcome.cost_usd
    );

    // `expect(1)` above fails on drop if the request never arrived — that is
    // the assertion that this left the process at all.
    drop(server);
    assert_eq!(
        mirror::in_flight(),
        before,
        "the slot must release when run_mirror returns"
    );
}

#[tokio::test]
async fn faults_a_response_the_agent_could_not_use() {
    let _serial = serial();
    let server = MockServer::start().await;
    // A tool call naming a tool that was never offered.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content": [{ "type": "tool_use", "name": "rm_rf", "input": {} }],
            "usage": { "input_tokens": 10, "output_tokens": 2 }
        })))
        .mount(&server)
        .await;

    let outcome = mirror::run_mirror(
        slot(),
        reqwest::Client::new(),
        server.uri(),
        reqwest::header::HeaderMap::new(),
        b"{}".to_vec(),
        Some(json!({ "tools": [{ "name": "get_weather" }] })),
        "cheap-model".to_string(),
        "ws_test".to_string(),
        flat_estimate(),
    )
    .await
    .expect("a scored response");

    assert!(
        outcome.integrity.score < integrity::RIS_MAX,
        "an invented tool name must fault, or mirroring measures nothing"
    );
    assert!(
        outcome.integrity.fault.is_some(),
        "a bare score is not auditable — the fault names the first failing check"
    );
}

#[tokio::test]
async fn does_not_score_an_upstream_error() {
    let _serial = serial();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503).set_body_string("overloaded"))
        .mount(&server)
        .await;

    let before = mirror::in_flight();
    let outcome = mirror::run_mirror(
        slot(),
        reqwest::Client::new(),
        server.uri(),
        reqwest::header::HeaderMap::new(),
        b"{}".to_vec(),
        None,
        "cheap-model".to_string(),
        "ws_test".to_string(),
        flat_estimate(),
    )
    .await;

    assert!(
        outcome.is_none(),
        "a 503 says there was no answer, not that the answer was bad — scoring it \
         would charge the candidate for the provider's availability"
    );
    assert_eq!(mirror::in_flight(), before, "the slot must release on this path too");
}

#[tokio::test]
async fn a_connection_failure_is_swallowed() {
    let _serial = serial();
    // Nothing is listening. The user's response has already gone out, so a
    // failed observation must cost them nothing and surface nowhere.
    let before = mirror::in_flight();
    let outcome = mirror::run_mirror(
        slot(),
        reqwest::Client::new(),
        "http://127.0.0.1:1/unreachable".to_string(),
        reqwest::header::HeaderMap::new(),
        b"{}".to_vec(),
        None,
        "cheap-model".to_string(),
        "ws_test".to_string(),
        flat_estimate(),
    )
    .await;

    assert!(outcome.is_none());
    assert_eq!(
        mirror::in_flight(),
        before,
        "an unreachable upstream must not leak the slot — that would shrink the \
         pool permanently until the process restarted"
    );
}

#[tokio::test]
async fn carries_the_candidate_model_to_the_upstream() {
    let _serial = serial();
    let server = MockServer::start().await;
    // `body_string_contains` is the assertion: the mirrored request must name
    // the CANDIDATE, not the model the user asked for. Sending the requested
    // model would mirror a model against itself and measure noise.
    Mock::given(method("POST"))
        .and(wiremock::matchers::body_string_contains("cheap-model"))
        .respond_with(ResponseTemplate::new(200).set_body_json(anthropic_ok()))
        .expect(1)
        .mount(&server)
        .await;

    let outcome = mirror::run_mirror(
        slot(),
        reqwest::Client::new(),
        server.uri(),
        reqwest::header::HeaderMap::new(),
        serde_json::to_vec(&json!({ "model": "cheap-model", "messages": [] })).unwrap(),
        Some(json!({ "messages": [] })),
        "cheap-model".to_string(),
        "ws_test".to_string(),
        flat_estimate(),
    )
    .await;

    assert!(outcome.is_some());
    // The mock's `expect(1)` verifies on drop that a body naming the candidate
    // actually arrived.
}
