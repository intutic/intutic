//! Integration test for L1 egress enforcement (LLD #63 §4).
//!
//! Unlike the unit tests in `egress_policy.rs` — which prove the pure
//! `decide()` function — this exercises the *wired* CONNECT handler
//! (`tls_mitm::handle_connect`) against the process-global policy, proving the
//! decision is actually consulted on the request path: a denied host gets a
//! 403 with no tunnel, an allowed host and an AI host get a 200.
//!
//! All assertions live in one test function because the egress policy is a
//! process-global `OnceLock` and the deny counter is process-wide: a single
//! function keeps initialisation and the counter deterministic within this
//! test binary.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, Uri};

use intutic_proxy::egress_policy::{
    denied_count, init_global_policy, EgressMode, EgressPolicy,
};
use intutic_proxy::tls_mitm::handle_connect;

fn connect_req(authority: &str) -> Request<Body> {
    let uri: Uri = authority.parse().expect("authority-form uri parses");
    Request::builder()
        .method(Method::CONNECT)
        .uri(uri)
        .body(Body::empty())
        .expect("request builds")
}

#[tokio::test]
async fn enforce_denies_unlisted_allows_listed_and_mitms_ai() {
    // Install an Enforce policy that allows only github.com.
    init_global_policy(EgressPolicy::from_entries(
        EgressMode::Enforce,
        ["github.com".to_string()].into_iter(),
    ));

    let before = denied_count();

    // 1. A host that is neither an AI provider nor on the allow policy is
    //    denied — 403, and no tunnel is opened.
    let denied = handle_connect(connect_req("exfil.evil.com:443")).await;
    assert_eq!(
        denied.status(),
        StatusCode::FORBIDDEN,
        "an unlisted host must be denied under Enforce"
    );

    // The denial is counted, so `GET /intutic/egress` can show enforcement is
    // live rather than silent.
    assert_eq!(
        denied_count(),
        before + 1,
        "a denied CONNECT must increment the deny counter exactly once"
    );

    // 2. A host on the allow policy is permitted — the handler returns 200
    //    Connection Established (the tunnel then runs in the background).
    let allowed = handle_connect(connect_req("github.com:443")).await;
    assert_eq!(
        allowed.status(),
        StatusCode::OK,
        "an allow-listed host must be permitted under Enforce"
    );

    // 3. An AI provider host is still intercepted (200), never blocked by
    //    Enforce — governing AI traffic is the whole point.
    let ai = handle_connect(connect_req("api.anthropic.com:443")).await;
    assert_eq!(
        ai.status(),
        StatusCode::OK,
        "an AI provider host must be MITM'd, not denied, under Enforce"
    );

    // The AI and allowed cases did not add to the deny counter.
    assert_eq!(
        denied_count(),
        before + 1,
        "only the one unlisted host should have been denied"
    );
}
