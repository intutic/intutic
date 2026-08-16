//! End-to-end: a routed model the upstream cannot serve falls back, penalises,
//! and unlocks — instead of failing the caller and repeating forever.
//!
//! ## The defect this pins
//!
//! Before the fallback existed the sequence was: the bandit locks a pick into
//! the session the moment it selects; the proxy rewrites the request to that
//! model; the upstream 404s with "model does not exist"; the error branch calls
//! it "the caller's fault" because it is a 4xx and generates **no reward
//! signal**; the raw 404 goes to the caller; and the session lock guarantees
//! the next request in the session does exactly the same thing. A fresh
//! session re-samples from priors nothing ever penalised, and repeats it.
//! Meanwhile `model_list` — the one structure that could have caught the bad
//! candidate at config load — was parsed and read by nothing.
//!
//! ## What this observes
//!
//! A real request through the real router against a wiremock upstream that
//! serves a 404 model-not-found for the routed model and a 200 for the
//! requested one. The session is pre-locked to the bad model, exactly the
//! state a poisoned session is stuck in. Assertions:
//!
//! - the caller gets the 200, served by the model they asked for
//! - the substitution failure is disclosed (`x-intutic-routing-fallback-from`)
//! - the session lock is RELEASED, so the next request re-selects
//! - the upstream saw exactly two calls: the bad pick, then the original
//!
//! ONE `#[tokio::test]` in this file: the upstream address travels through a
//! process-global env var, and integration-test files are each their own
//! process, so one file = one env universe.

use std::sync::Arc;

use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn an_unservable_pick_falls_back_penalises_and_unlocks() {
    let upstream = MockServer::start().await;

    // The routed model: the provider has never heard of it. OpenAI's real
    // error shape for this case.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("stub-bad-model"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "error": {
                "message": "The model `stub-bad-model` does not exist or you do not have access to it.",
                "type": "invalid_request_error",
                "param": "model",
                "code": "model_not_found"
            }
        })))
        .expect(1)
        .mount(&upstream)
        .await;

    // The requested model: serves fine.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_string_contains("stub-good-model"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "chatcmpl-fallback-test",
            "object": "chat.completion",
            "model": "stub-good-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "served by the model you asked for"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}
        })))
        .expect(1)
        .mount(&upstream)
        .await;

    // Process-global on purpose — see the module doc.
    std::env::set_var("OPENAI_UPSTREAM_URL", upstream.uri());
    std::env::remove_var("CONTROL_PLANE_URL");

    // Standalone routing, enforced, with both models in the pool. The
    // requested model must be in the pool for the bandit to engage at all, and
    // the bad one must be in it for the session lock below to be a state the
    // router itself could have produced.
    let config: intutic_proxy::config::ProxyConfig = serde_yaml::from_str(
        r#"
model_list: []
intutic_settings:
  routing:
    enabled: true
    mode: enforce
    candidate_models: ["stub-good-model", "stub-bad-model"]
"#,
    )
    .expect("config parses");

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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // The poisoned state: a previous selection locked the unservable model
    // into this session. Every request in the session will be rewritten to it.
    let session_id = "ses_unservable_test";
    use intutic_proxy::store::LocalStore as _;
    store
        .set_session_locked_model(session_id, "stub-bad-model")
        .await
        .expect("pre-lock");

    let res = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header(
            "Authorization",
            "Bearer vk_0123456789abcdef0123456789abcdef_ws_unservable_test",
        )
        .header("x-workspace-id", "ws_unservable_test")
        .header("x-session-id", session_id)
        .json(&serde_json::json!({
            "model": "stub-good-model",
            "messages": [{"role": "user", "content": "hello"}]
        }))
        .send()
        .await
        .expect("proxy reachable");

    let status = res.status();
    let fallback_hdr = res
        .headers()
        .get("x-intutic-routing-fallback-from")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let routed_to_hdr = res.headers().get("x-intutic-routed-to").cloned();
    let body = res.text().await.expect("body reads");

    // The caller is served, by the model they asked for.
    assert!(
        status.is_success(),
        "the caller must not eat the router's 404. status={status} body={body}"
    );
    assert!(
        body.contains("served by the model you asked for"),
        "response must come from the requested model's completion: {body}"
    );

    // The failure is disclosed, and no routed-to header lies about a
    // substitution that did not survive.
    assert_eq!(
        fallback_hdr.as_deref(),
        Some("stub-bad-model"),
        "the fallback must be disclosed by name"
    );
    assert!(
        routed_to_hdr.is_none(),
        "a request served by the requested model must not claim it was routed"
    );

    // The lock is released: the session is no longer condemned to repeat the
    // pick. This is the half that stops the failure from being permanent.
    let session = store
        .session_routing(session_id)
        .await
        .expect("session readable");
    assert!(
        session.locked_model.is_none(),
        "the session lock must be released on an unservable pick, or every \
         subsequent request in the session repeats the same 404"
    );

    // And the arm learned. In standalone the local reward loop owns learning;
    // a zero-reward pull moves the Beta posterior, which is observable as arm
    // state existing for the bad model where a fresh store has none.
    // (The precise posterior maths is reward.rs's own test surface.)
    let arms = store.load_arms("ws_unservable_test").await.unwrap_or_default();
    assert!(
        arms.keys().any(|k| k.contains("stub-bad-model")),
        "the unservable pick must leave a learning record against the arm; \
         found arms: {:?}",
        arms.keys().collect::<Vec<_>>()
    );

    // Exactly two upstream calls: the bad pick, then the one-shot fallback.
    // (.expect(1) on each mock enforces this on drop as well.)
    upstream.verify().await;
}
