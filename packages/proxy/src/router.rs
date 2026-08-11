//! Route table — maps HTTP paths to proxy handlers.
//!
//! Supported protocols:
//! - POST /v1/messages          (Anthropic Messages API — Claude Code)
//! - POST /v1/chat/completions   (OpenAI Chat Completions — Cursor)
//! - POST /v1/responses          (OpenAI Responses API — Codex CLI)
//! - POST /v1beta/models/:model  (Gemini v1beta — Antigravity)
//! - GET  /health                (Health check)

use axum::{
    extract::State,
    http::Method,
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
        // Guard-liveness verdicts, on demand. Same suite the startup/periodic
        // runner executes; an operator asking "is my rule live?" gets the
        // two-sided evidence, per guard, with latency. Local diagnostics only —
        // it evaluates synthetic contexts and calls no upstream.
        .route("/intutic/probes", get(run_probes))
        // Egress enforcement posture + live deny counts (LLD #63 §4). Makes an
        // Enforce/Monitor decision observable rather than silent.
        .route("/intutic/egress", get(egress_status))
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

/// `GET /intutic/probes` — run the guard-liveness suite and return verdicts.
async fn run_probes() -> impl axum::response::IntoResponse {
    let registry = crate::plugins::anomaly::DetectorRegistry::with_defaults();
    let sops = crate::sops::loaded_sops();
    let verdicts = crate::probes::run_guard_probes(&registry, &sops);
    let failed = verdicts.iter().filter(|v| !v.passed).count();
    axum::Json(serde_json::json!({
        "probes": verdicts,
        "total": verdicts.len(),
        "failed": failed,
    }))
}
