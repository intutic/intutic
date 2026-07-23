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
        "protocols": ["anthropic", "openai", "gemini"]
    }))
}
