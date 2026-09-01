//! Route table — maps HTTP paths to proxy handlers.
//!
//! Supported protocols:
//! - POST /v1/messages          (Anthropic Messages API — Claude Code)
//! - POST /v1/chat/completions   (OpenAI Chat Completions — Cursor)
//! - POST /v1/responses          (OpenAI Responses API — Codex CLI)
//! - POST /v1beta/models/:model  (Gemini v1beta — Antigravity)
//! - GET  /health                (Health check)

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, Method, StatusCode},
    response::Json,
    routing::{any, get, post},
    Router,
};
use serde_json::json;

use tower_http::trace::TraceLayer;

use crate::proxy::AppState;
use crate::tls_mitm::handle_connect;

pub fn build_router(state: AppState) -> Router {
    let proxy_routes = Router::new()
        // Anthropic Messages API (Claude Code)
        .route("/v1/messages", post(crate::proxy::handle_proxy))
        // OpenAI Chat Completions (Cursor)
        .route("/v1/chat/completions", post(crate::proxy::handle_proxy))
        // OpenAI Responses API (Codex CLI)
        .route("/v1/responses", post(crate::proxy::handle_proxy))
        // Gemini v1beta (Antigravity)
        .route("/v1beta/models/:model_id", post(crate::proxy::handle_proxy))
        .layer(TraceLayer::new_for_http());

    Router::new()
        // Health check
        .route("/health", get(health))
        // Guard-liveness verdicts from the last scheduled run (main.rs's
        // startup + 15-minute loop — this route no longer runs the suite
        // itself, see `run_probes`'s doc comment). Loopback-only, same
        // reasoning and same guard as `/intutic/spend` below: binding probe
        // ids are shaped `binding.forbid_after.{first}->{then}` — a
        // workspace's declared tool-succession policy, verbatim — and the
        // listener binds `0.0.0.0` with no authentication on this path.
        .route("/intutic/probes", get(run_probes))
        // Egress enforcement posture + live deny counts (LLD #63 §4). Makes an
        // Enforce/Monitor decision observable rather than silent.
        .route("/intutic/egress", get(egress_status))
        // Today's local-machine spend, sourced from the same numbers the
        // budget gate already enforces (LLD #8 follow-up: "Live terminal
        // cost"). Loopback-only — see `spend_status` — because unlike
        // `/health` and `/intutic/egress` above, this number grows with the
        // developer's actual usage, and the listener binds `0.0.0.0`.
        .route("/intutic/spend", get(spend_status))
        // Sandbox attestation callback (LLD #63 §6, TD-333). A `--sandbox`
        // container's firewall permits egress ONLY to this proxy — it cannot
        // reach the control plane directly — so this is the one path a
        // sandboxed agent has to attest. The proxy forwards it, authenticated
        // with the same bearer every LLM call already carries.
        .route("/intutic/attest-sandbox", post(attest_sandbox))
        .route("/", get(root_info))
        .merge(proxy_routes)
        // HTTP CONNECT tunnel + Decrypted MITM requests fallback handler
        .fallback(any(
            |State(state): State<AppState>, req: axum::extract::Request| async move {
                if req.method() == Method::CONNECT {
                    handle_connect(req).await
                } else {
                    crate::proxy::handle_proxy(State(state), req).await
                }
            },
        ))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "intutic-proxy",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn root_info() -> Json<serde_json::Value> {
    Json(json!({
        "service": "Intutic Proxy Gateway",
        "version": env!("CARGO_PKG_VERSION"),
        "status": "running",
        // Only what actually works end to end.
        //
        // `gemini` was listed here and does not function: `/v1beta/models/:id`
        // is routed, but a Gemini body carries its model in the URL rather than
        // in `model`, so `extract_model` yields `"unknown"`,
        // `get_model_provider` answers OpenAI, `is_same_provider` is false for
        // every Gemini request, and the body is posted to OpenAI's
        // chat-completions endpoint — a 400. There is no Gemini stream
        // translator either. Advertising it made an unreachable path look like
        // a supported one, which is how it stayed unreachable: the request side
        // was built, the response side never was.
        //
        // The route stays (removing it would change behaviour for anyone
        // pointed at it), and `gemini_unsupported` says why rather than
        // leaving its absence to be read as an oversight. See
        // `proxy::DeltaShape::Unparsed` for the full chain.
        "protocols": ["anthropic", "openai", "openai-responses"],
        "gemini_unsupported": "requests to /v1beta/ are routed but not translated; the model name is not read from the URL"
    }))
}

/// `GET /intutic/egress` — the live egress posture. An operator (or a probe)
/// can confirm the mode is what they set and watch the deny counters move.
async fn egress_status() -> impl axum::response::IntoResponse {
    use crate::egress_policy::{denied_count, global_policy, would_deny_count, EgressMode};
    let mode = match global_policy().mode() {
        EgressMode::Off => "off",
        EgressMode::Monitor => "monitor",
        EgressMode::Enforce => "enforce",
    };
    axum::Json(serde_json::json!({
        "mode": mode,
        "denied": denied_count(),
        "would_deny": would_deny_count(),
    }))
}

/// Whether a peer may read `/intutic/spend`. Pure so the refusal is
/// unit-testable without standing up a listener or constructing a live TCP
/// connection.
///
/// This route is the one place the on-disk daily spend total — a number that
/// grows with what the developer is actually being charged — is exposed over
/// HTTP, and the proxy's listener binds `0.0.0.0` (`main.rs`) with no
/// authentication on this path (matching `/health` and `/intutic/egress`).
/// Without this check, anyone on the same LAN or Wi-Fi could read a
/// teammate's daily spend by hitting `<their-ip>:4000/intutic/spend`.
fn spend_peer_allowed(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// `GET /intutic/spend` — today's local-machine spend, loopback-only.
///
/// Sources every field from the existing local-budget accounting in
/// `local_spend.rs` / `proxy::local_budget_enforced` — nothing here computes
/// a new number, it only exposes what the budget gate already reads on every
/// request. Kept deliberately distinct from `GET /api/v1/budget` on the
/// control plane: that aggregates every member/machine in the workspace, this
/// is just what this one machine has spent today (see `local_spend.rs`'s
/// module docs for why the two numbers are not interchangeable).
async fn spend_status(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl axum::response::IntoResponse {
    if !spend_peer_allowed(&addr) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"error": "loopback only"})),
        );
    }

    (
        StatusCode::OK,
        axum::Json(json!({
            "local_spend_usd_today": crate::local_spend::get_local_spend(),
            "local_cap_usd": crate::local_spend::get_max_daily_budget(),
            "enforced": crate::proxy::local_budget_enforced(),
        })),
    )
}

/// `GET /intutic/probes` — the last SCHEDULED guard-liveness run, loopback-only.
///
/// Deliberately does not run the suite itself. Timestamping at the fetch
/// site would make a dead 15-minute loop (`main.rs`) indistinguishable from
/// a healthy one — every request would mint a fresh "just ran, all clear"
/// answer regardless of whether the scheduler was still alive. Reading
/// `probes::last_run()` instead means `ran_at` only advances when the
/// scheduled loop actually ticks; a stalled loop shows up here as a
/// timestamp that stops moving, exactly the inert-control shape this whole
/// module exists to catch.
async fn run_probes(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl axum::response::IntoResponse {
    if !spend_peer_allowed(&addr) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"error": "loopback only"})),
        );
    }

    let Some(run) = crate::probes::last_run() else {
        // Only reachable in the narrow window between process start and the
        // startup run completing — the loop's first tick fires immediately.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({"error": "guard-liveness probes have not run yet"})),
        );
    };
    let failed = run.verdicts.iter().filter(|v| !v.passed).count();
    (
        StatusCode::OK,
        axum::Json(json!({
            "probes": run.verdicts,
            "total": run.verdicts.len(),
            "failed": failed,
            "ran_at": run.ran_at,
        })),
    )
}

/// `POST /intutic/attest-sandbox` — forwards a sandboxed agent's attestation
/// callback to the control plane (LLD #63 §6, TD-333).
///
/// This exists because of what the sandbox's own firewall permits: the
/// `entrypoint.sh` that calls this runs AFTER the container's egress firewall
/// is installed and permits only the proxy and DNS — the sandboxed process
/// cannot reach the control plane directly to attest itself, only through the
/// one door its own isolation left open. That is the security property this
/// route depends on, not merely convenience: a request reaching this handler
/// came from something that, at minimum, resolved the proxy as its only
/// egress path, which a host-side process spoofing "I am sandboxed" (as the
/// pre-existing `executionMode: 'SANDBOX'` self-report from `intutic exec`
/// could always do) has no reason to be routed through.
///
/// What this does NOT prove, stated plainly rather than left implicit: that
/// the container's capability-drop and firewall-install steps in
/// `entrypoint.sh` actually ran as written. A custom `--sandbox-image` built
/// to skip those steps but still make this one call would still attest. Real
/// defense against that needs measured/attested boot (TPM, confidential
/// computing) that does not exist anywhere in this stack. What this closes is
/// the concrete gap named in TD-333: a session recorded as `SANDBOX` because
/// the host CLI said so, whether or not the sandboxed process ever started.
/// What must be true before this handler forwards anything: a configured
/// control plane, a `sessionId` in the body, and a non-empty bearer. Pure and
/// exported so these three checks — the entire request-shape contract — are
/// unit-testable without constructing a full `AppState` (which needs a live
/// `wasm_registry`/`reward_engine`/`store`/`control_plane`, none of which this
/// handler touches). Returns the forward URL and the bearer to send on
/// success, or the exact `(status, body)` this handler should return on
/// failure.
fn validate_attest_request(
    control_plane_url: Option<&str>,
    body: &serde_json::Value,
    headers: &HeaderMap,
) -> Result<(String, String), (StatusCode, serde_json::Value)> {
    let Some(control_plane_url) = control_plane_url else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "no control plane configured"}),
        ));
    };

    let Some(session_id) = body.get("sessionId").and_then(|v| v.as_str()) else {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({"error": "sessionId required"}),
        ));
    };

    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if auth.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            json!({"error": "authorization required"}),
        ));
    }

    let url = format!(
        "{}/api/v1/sessions/{}/attest-sandbox",
        control_plane_url.trim_end_matches('/'),
        session_id
    );
    Ok((url, auth.to_string()))
}

async fn attest_sandbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    let control_plane_url = state
        .config
        .intutic_settings
        .policy
        .control_plane_url
        .as_deref();
    let (url, auth) = match validate_attest_request(control_plane_url, &body, &headers) {
        Ok(v) => v,
        Err((status, body)) => {
            if status == StatusCode::SERVICE_UNAVAILABLE {
                tracing::warn!("attest-sandbox called with no CONTROL_PLANE_URL configured");
            }
            return (status, axum::Json(body));
        }
    };

    let resp = state
        .http_client
        .patch(&url)
        .header("authorization", auth)
        .timeout(std::time::Duration::from_millis(3000))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status =
                StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (status, axum::Json(json!({"attested": status.is_success()})))
        }
        Err(e) => {
            tracing::warn!(error = %e, "attest-sandbox forward to control plane failed");
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({"error": "control plane unreachable"})),
            )
        }
    }
}

#[cfg(test)]
mod attest_sandbox_tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with_auth(bearer: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        if !bearer.is_empty() {
            h.insert(
                "authorization",
                HeaderValue::from_str(&format!("Bearer {bearer}")).unwrap(),
            );
        }
        h
    }

    #[test]
    fn refuses_when_no_control_plane_is_configured() {
        let body = json!({"sessionId": "ses_1"});
        let err = validate_attest_request(None, &body, &headers_with_auth("vk_x"))
            .expect_err("must reject with no control plane configured");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn refuses_a_body_with_no_session_id() {
        let body = json!({});
        let err = validate_attest_request(Some("http://cp"), &body, &headers_with_auth("vk_x"))
            .expect_err("must reject a missing sessionId");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn refuses_a_request_with_no_authorization_header() {
        let body = json!({"sessionId": "ses_1"});
        let err = validate_attest_request(Some("http://cp"), &body, &HeaderMap::new())
            .expect_err("must reject an unauthenticated request");
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn builds_the_forward_url_from_control_plane_and_session_id() {
        let body = json!({"sessionId": "ses_abc123"});
        let (url, auth) = validate_attest_request(
            Some("http://control-plane:3001"),
            &body,
            &headers_with_auth("vk_x"),
        )
        .expect("a well-formed request must validate");
        assert_eq!(
            url,
            "http://control-plane:3001/api/v1/sessions/ses_abc123/attest-sandbox"
        );
        assert_eq!(auth, "Bearer vk_x");
    }

    #[test]
    fn trims_a_trailing_slash_on_the_control_plane_url_so_the_path_has_no_double_slash() {
        let body = json!({"sessionId": "ses_1"});
        let (url, _) = validate_attest_request(
            Some("http://control-plane:3001/"),
            &body,
            &headers_with_auth("vk_x"),
        )
        .expect("a well-formed request must validate");
        assert_eq!(
            url,
            "http://control-plane:3001/api/v1/sessions/ses_1/attest-sandbox"
        );
    }
}

#[cfg(test)]
mod spend_status_tests {
    use super::*;
    use axum::response::IntoResponse;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn v4(ip: [u8; 4], port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), port)
    }

    #[test]
    fn allows_ipv4_loopback() {
        assert!(spend_peer_allowed(&v4([127, 0, 0, 1], 54321)));
    }

    #[test]
    fn allows_ipv6_loopback() {
        let addr = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 54321);
        assert!(spend_peer_allowed(&addr));
    }

    #[test]
    fn refuses_a_lan_peer() {
        // The exact scenario this guard exists for: the listener binds
        // `0.0.0.0`, so a laptop on the same Wi-Fi reaches this route unless
        // something besides "bound address" gates it.
        assert!(!spend_peer_allowed(&v4([192, 168, 1, 42], 54321)));
    }

    #[test]
    fn refuses_any_other_non_loopback_address() {
        assert!(!spend_peer_allowed(&v4([10, 0, 0, 5], 1)));
        assert!(!spend_peer_allowed(&v4([8, 8, 8, 8], 443)));
    }

    /// The handler itself, not just the pure predicate: a non-loopback peer
    /// must actually get refused end to end, including the status code a
    /// real client would see, not merely a predicate returning false in
    /// isolation.
    #[tokio::test]
    async fn handler_refuses_a_non_loopback_peer_with_403() {
        let addr = v4([192, 168, 1, 42], 54321);
        let response = spend_status(ConnectInfo(addr)).await.into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "loopback only");
    }

    /// A loopback peer gets the three documented fields back, not a subset
    /// or a differently-named shape a client would need to guess at.
    #[tokio::test]
    async fn handler_serves_loopback_peers_the_documented_shape() {
        let addr = v4([127, 0, 0, 1], 54321);
        let response = spend_status(ConnectInfo(addr)).await.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body.get("local_spend_usd_today").is_some_and(|v| v.is_number()));
        assert!(body.get("local_cap_usd").is_some_and(|v| v.is_number()));
        assert!(body.get("enforced").is_some_and(|v| v.is_boolean()));
    }
}

#[cfg(test)]
mod run_probes_tests {
    use super::*;
    use axum::response::IntoResponse;
    use std::net::{IpAddr, Ipv4Addr};

    fn v4(ip: [u8; 4], port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), port)
    }

    /// `run_probes` reuses `spend_peer_allowed` — its own predicate coverage
    /// (IPv4/IPv6 loopback, LAN, other) lives in `spend_status_tests` above
    /// and is not duplicated here. This test is the same end-to-end shape as
    /// `handler_refuses_a_non_loopback_peer_with_403`, for the route the SOP
    /// content leak (`GET /intutic/probes`) was actually found on.
    #[tokio::test]
    async fn handler_refuses_a_non_loopback_peer_with_403() {
        let addr = v4([192, 168, 1, 42], 54321);
        let response = run_probes(ConnectInfo(addr)).await.into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "loopback only");
    }

    /// A loopback peer gets the last recorded run, not a fresh one computed
    /// on this request — `run_probes` must never call the suite itself. Seeds
    /// `LAST_RUN` first via the real recorder, since it is process-global and
    /// this test cannot assume ordering against every other test in the
    /// binary that might also seed it.
    #[tokio::test]
    async fn handler_serves_loopback_peers_the_last_recorded_run() {
        let registry = crate::plugins::anomaly::DetectorRegistry::with_defaults();
        let recorded = crate::probes::run_and_record(&registry, &[]);

        let addr = v4([127, 0, 0, 1], 54321);
        let response = run_probes(ConnectInfo(addr)).await.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body.get("probes").is_some_and(|v| v.is_array()));
        assert_eq!(body["total"], recorded.verdicts.len());
        assert!(body.get("failed").is_some_and(|v| v.is_number()));
        assert!(body.get("ran_at").is_some_and(|v| v.is_number()));
    }
}
