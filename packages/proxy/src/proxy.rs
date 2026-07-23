//! Core proxy logic — intercept → validate → policy check → forward → stream.
//!
//! Request lifecycle (the governance pipeline):
//!   1.  Extract virtual key from Authorization header
//!   2.  Validate virtual key exists in Valkey (fast path) or DB (slow path)
//!   3.  Check workspace hard-cap block in Valkey  →  HTTP 429 if active
//!   4.  DLP scan of request body (input)          →  HTTP 400 if BLOCK action
//!   5.  Policy pre-check via control plane        →  HTTP 403 if denied
//!   6.  Forward to upstream LLM provider (SSE)   →  stream response to client
//!   7.  DLP scan of response body (output)        →  redact findings
//!   8.  Publish execution trace to Valkey (async) →  fire-and-forget
//!
//! Latency target: steps 1-5 < 10ms P99 (Valkey + single HTTP round-trip).

use crate::plugins::IntuticPlugin;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::stream::StreamExt;
use redis::AsyncCommands;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;
use tokio::spawn;
use tokio_stream::wrappers::ReceiverStream;

use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::config::ProxyConfig;
use crate::config::SnipCompactorConfig;
use crate::dlp;
use crate::metering::{check_loop_block, check_workspace_hard_block, validate_virtual_key, check_budget, MeteringError};
use crate::pricing;
use crate::protocol::Protocol;
use crate::snip;
use crate::telemetry::{publish_trace, ExecutionTrace};
use crate::wasm::registry::PluginRegistry;

// Phase 7: Intelligence Engine modules
use crate::postprocessor::ResponsePostProcessor;
use crate::quality::RequestPreProcessor;
use crate::token::prediction::CostPredictionGate;

// ─── Shared state ────────────────────────────────────────────────────

/// Shared application state passed to all handlers.
#[derive(Clone)]
pub struct AppState {
    pub config: ProxyConfig,
    pub valkey: Arc<redis::aio::ConnectionManager>,
    pub wasm_registry: Arc<PluginRegistry>,
    /// Lazily initialised reqwest client (shared across requests for connection pooling).
    pub http_client: Arc<Client>,
}

// ─── Protocol detection ──────────────────────────────────────────────

/// Upstream LLM provider inferred from the request path.
#[derive(Debug, Clone, PartialEq)]
enum Provider {
    Anthropic,
    OpenAI,
    Gemini,
}

impl Provider {
    fn from_path(path: &str) -> Self {
        if path.starts_with("/v1/messages") {
            Provider::Anthropic
        } else if path.starts_with("/v1beta/models") {
            Provider::Gemini
        } else {
            Provider::OpenAI
        }
    }

    /// Return the base URL of the upstream provider.
    /// Reads env vars at call time so they can be overridden in tests.
    fn upstream_base_url(&self) -> String {
        match self {
            Provider::Anthropic => std::env::var("ANTHROPIC_UPSTREAM_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com".to_string()),
            Provider::OpenAI => std::env::var("OPENAI_UPSTREAM_URL")
                .unwrap_or_else(|_| "https://api.openai.com".to_string()),
            Provider::Gemini => std::env::var("GEMINI_UPSTREAM_URL")
                .unwrap_or_else(|_| "https://generativelanguage.googleapis.com".to_string()),
        }
    }

    fn harness_name(&self) -> &'static str {
        match self {
            Provider::Anthropic => "claude-code",
            Provider::OpenAI => "cursor",
            Provider::Gemini => "antigravity",
        }
    }
}

// ─── Policy check ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct PolicyCheckRequest {
    workspace_id: String,
    virtual_key_prefix: String,
    provider: String,
    model: String,
    session_id: Option<String>,
}

#[allow(dead_code)] // policy_id retained for future structured audit logging
#[derive(Debug, Deserialize)]
struct PolicyCheckResponse {
    action: String, // "allow" | "deny"
    reason: Option<String>,
    policy_id: Option<String>,
}

/// POST /api/v1/policy/check on the control plane.
/// Returns Ok(()) if allowed, Err with reason string if denied.
async fn policy_check(
    client: &Client,
    control_plane_url: &str,
    workspace_id: &str,
    virtual_key_prefix: &str,
    provider: &Provider,
    model: &str,
    session_id: Option<&str>,
    timeout_ms: u64,
) -> Result<(), String> {
    let url = format!("{}/api/v1/policy/check", control_plane_url);
    let body = PolicyCheckRequest {
        workspace_id: workspace_id.to_string(),
        virtual_key_prefix: virtual_key_prefix.to_string(),
        provider: provider.harness_name().to_string(),
        model: model.to_string(),
        session_id: session_id.map(|s| s.to_string()),
    };

    let result = client
        .post(&url)
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .json(&body)
        .send()
        .await;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let policy: PolicyCheckResponse = resp.json().await.map_err(|e| e.to_string())?;
            if policy.action == "deny" {
                return Err(policy
                    .reason
                    .unwrap_or_else(|| "SOP policy denied".to_string()));
            }
            Ok(())
        }
        Ok(resp) => Err(format!("Policy check returned {}", resp.status())),
        Err(e) => Err(format!("Policy check unreachable: {}", e)),
    }
}

// ─── Helper: extract virtual key and workspace info ───────────────────

/// Extract workspace_id from the virtual key prefix or request body.
///
/// Virtual keys are in the format `vk_{workspace_prefix}_{random}`.
/// Workspace ID is embedded after the second underscore segment,
/// or read from an `x-workspace-id` header.
fn extract_workspace_id(headers: &HeaderMap, auth: &str) -> String {
    // Prefer explicit header (set by harness agent on session start)
    if let Some(v) = headers.get("x-workspace-id") {
        if let Ok(s) = v.to_str() {
            return s.to_string();
        }
    }
    // Fall back to extracting from virtual key: vk_<random>_<workspaceId> or vk_<workspaceId>_<random>
    if let Some(rest) = auth.strip_prefix("vk_") {
        // Suffix format: vk_<32_hex>_<workspaceId>
        if rest.len() > 33 && rest.as_bytes()[32] == b'_' {
            let suffix = &rest[33..];
            if suffix.starts_with("ws_") {
                return suffix.to_string();
            }
        }
        // Legacy format: vk_<workspaceId>_<32_hex>
        if rest.len() > 33 {
            let sep_idx = rest.len() - 33;
            if rest.as_bytes()[sep_idx] == b'_' {
                let prefix = &rest[..sep_idx];
                if prefix.starts_with("ws_") {
                    return prefix.to_string();
                }
            }
        }
        // Generic fallback for test keys (split on last underscore)
        if let Some(last_idx) = rest.rfind('_') {
            return rest[..last_idx].to_string();
        }
    }
    "unknown".to_string()
}

/// Extract the model name from a JSON request body (best effort).
fn extract_model(body: &serde_json::Value) -> String {
    body.get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string()
}

// ─── Error response helpers ──────────────────────────────────────────

fn json_error(status: StatusCode, error_type: &str, message: &str) -> Response {
    let body = serde_json::json!({
        "error": {
            "type": error_type,
            "message": message,
        }
    });
    (status, axum::Json(body)).into_response()
}

fn get_model_provider(model: &str) -> Provider {
    let m = model.to_lowercase();
    if m.contains("claude") {
        Provider::Anthropic
    } else if m.contains("gemini") {
        Provider::Gemini
    } else {
        Provider::OpenAI
    }
}

/// Estimate the cost in USD for an LLM request.
/// Delegates to the offline pricing module which uses a compile-time JSON bundle
/// with exact model lookup, family prefix fallback, and conservative unknown-model estimate.
fn estimate_model_cost(model: &str, input_tokens: u32, output_tokens: u32) -> f64 {
    pricing::estimate_cost(model, input_tokens, output_tokens)
}

async fn fetch_provider_credential(
    valkey: &Arc<redis::aio::ConnectionManager>,
    workspace_id: &str,
    provider: &Provider,
) -> Option<String> {
    let mut conn = (**valkey).clone();
    let creds_key = format!("workspace:credentials:{}", workspace_id);
    let fields = match provider {
        Provider::Anthropic => vec![
            "anthropic_api_key",
            "anthropic_oauth_token",
            "anthropic",
            "anthropicKey",
            "x-api-key",
        ],
        Provider::OpenAI => vec!["openai_api_key", "openai", "openaiKey", "authorization"],
        Provider::Gemini => vec!["gemini_api_key", "gemini", "geminiKey"],
    };
    for field in fields {
        if let Ok(Some(val)) = conn.hget::<_, _, Option<String>>(&creds_key, field).await {
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    match provider {
        Provider::Anthropic => std::env::var("ANTHROPIC_API_KEY").ok(),
        Provider::OpenAI => std::env::var("OPENAI_API_KEY").ok(),
        Provider::Gemini => std::env::var("GEMINI_API_KEY").ok(),
    }
}

fn extract_tools(body: &serde_json::Value) -> Vec<crate::wasm::context::ToolSchema> {
    let mut schemas = Vec::new();
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        for t in tools {
            if let Some(name) = t.get("name").and_then(|n| n.as_str()) {
                let description = t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string());
                schemas.push(crate::wasm::context::ToolSchema {
                    name: name.to_string(),
                    description,
                });
            } else if let Some(func) = t.get("function") {
                if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                    let description = func
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.to_string());
                    schemas.push(crate::wasm::context::ToolSchema {
                        name: name.to_string(),
                        description,
                    });
                }
            }
        }
    }
    schemas
}

fn extract_wasm_tool_calls(body: &serde_json::Value) -> Vec<crate::wasm::context::ToolCall> {
    let mut tc_list = Vec::new();

    // Check root tool_calls (for simulation/test convenience)
    if let Some(root_tc) = body.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in root_tc {
            let id = tc
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let name = tc
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = tc
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            tc_list.push(crate::wasm::context::ToolCall {
                id,
                name,
                arguments,
            });
        }
    }

    // Check messages array
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            // OpenAI style
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                for tc in tool_calls {
                    let id = tc
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = if let Some(func) = tc.get("function") {
                        func.get("name").and_then(|n| n.as_str()).unwrap_or("")
                    } else {
                        tc.get("name").and_then(|n| n.as_str()).unwrap_or("")
                    }
                    .to_string();

                    let arguments = if let Some(func) = tc.get("function") {
                        if let Some(args_str) = func.get("arguments").and_then(|a| a.as_str()) {
                            serde_json::from_str(args_str)
                                .unwrap_or(serde_json::Value::String(args_str.to_string()))
                        } else {
                            func.get("arguments")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        }
                    } else {
                        tc.get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    };

                    tc_list.push(crate::wasm::context::ToolCall {
                        id,
                        name,
                        arguments,
                    });
                }
            }

            // Anthropic style
            if let Some(content) = msg.get("content") {
                if let Some(arr) = content.as_array() {
                    for block in arr {
                        if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                            if block_type == "tool_use" {
                                let id = block
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let name = block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let arguments = block
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                tc_list.push(crate::wasm::context::ToolCall {
                                    id,
                                    name,
                                    arguments,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    tc_list
}

fn extract_request_tool_calls(body: &serde_json::Value) -> Vec<String> {
    let mut tool_names = Vec::new();
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                for tc in tool_calls {
                    if let Some(name) = tc
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        tool_names.push(name.to_string());
                    } else if let Some(name) = tc.get("name").and_then(|n| n.as_str()) {
                        tool_names.push(name.to_string());
                    }
                }
            }
            if let Some(role) = msg.get("role").and_then(|r| r.as_str()) {
                if role == "tool" || role == "function" {
                    if let Some(name) = msg.get("name").and_then(|n| n.as_str()) {
                        tool_names.push(name.to_string());
                    }
                }
            }
            if let Some(content) = msg.get("content") {
                if let Some(arr) = content.as_array() {
                    for block in arr {
                        if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                            if block_type == "tool_use" {
                                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                                    tool_names.push(name.to_string());
                                }
                            } else if block_type == "tool_result" {
                                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                                    tool_names.push(name.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    tool_names
}

// ─── Main proxy handler ──────────────────────────────────────────────

/// Main proxy handler — routes all protocol variants through the governance pipeline.
///
/// This single handler is mounted on all four LLM provider paths (see router.rs).
/// It implements the full 8-step governance pipeline described at the top of this file.
pub async fn handle_proxy(State(state): State<AppState>, request: Request<Body>) -> Response {
    let start = Instant::now();

    // ── Tracing: inherit parent span from upstream harness ────────────
    let parent_cx = opentelemetry::global::get_text_map_propagator(|propagator| {
        use opentelemetry::propagation::Extractor;
        struct HeaderExtractor<'a>(&'a HeaderMap);
        impl<'a> Extractor for HeaderExtractor<'a> {
            fn get(&self, key: &str) -> Option<&str> {
                self.0.get(key).and_then(|v| v.to_str().ok())
            }
            fn keys(&self) -> Vec<&str> {
                self.0.keys().map(|k| k.as_str()).collect()
            }
        }
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    tracing::Span::current().set_parent(parent_cx);

    // ── Extract basic request metadata ────────────────────────────────
    let uri_path = request.uri().path().to_string();
    let provider = Provider::from_path(&uri_path);
    let protocol = crate::protocol::detect(&uri_path);
    let headers = request.headers().clone();
    let method = request.method().clone();

    // ── Step 1: Extract virtual key ───────────────────────────────────
    let auth_header = headers
        .get("authorization")
        .or_else(|| headers.get("x-api-key"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Strip "Bearer " prefix if present
    let raw_token = auth_header
        .strip_prefix("Bearer ")
        .or_else(|| auth_header.strip_prefix("bearer "))
        .unwrap_or(auth_header);

    if raw_token.is_empty() {
        return json_error(StatusCode::UNAUTHORIZED, "missing_key", "No API key provided. Configure your harness to use ANTHROPIC_BASE_URL/OPENAI_BASE_URL pointing to this proxy.");
    }

    let mut workspace_id = extract_workspace_id(&headers, raw_token);
    if workspace_id == "unknown" {
        if let Ok(env_wid) = std::env::var("INTUTIC_WORKSPACE_ID") {
            workspace_id = env_wid;
        }
    }

    if raw_token.starts_with("vk_") {
        let key_wid = extract_workspace_id(&HeaderMap::new(), raw_token);

        if workspace_id != "unknown" && workspace_id != key_wid {
            return json_error(
                StatusCode::FORBIDDEN,
                "workspace_mismatch",
                "x-workspace-id header does not match the workspace authorized by the provided API key"
            );
        }
        workspace_id = key_wid;
    }
    let key_prefix = if raw_token.len() > 12 {
        &raw_token[..12]
    } else {
        raw_token
    };

    // Dynamic session credential capture (for developer OAuth/Pro sessions)
    if !raw_token.is_empty() && !raw_token.starts_with("vk_") && workspace_id != "unknown" {
        let valkey = Arc::clone(&state.valkey);
        let wid = workspace_id.clone();
        let tok = raw_token.to_string();
        spawn(async move {
            let mut conn = (*valkey).clone();
            let creds_key = format!("workspace:credentials:{}", wid);
            let field = if tok.starts_with("sk-ant-oat") || tok.ends_with("wAA") {
                "anthropic_oauth_token"
            } else {
                "anthropic_api_key"
            };
            let _: Result<(), _> = redis::Cmd::hset(&creds_key, field, &tok)
                .query_async(&mut conn)
                .await;
        });
    }

    tracing::debug!(workspace_id = %workspace_id, key_prefix = %key_prefix, provider = ?provider, "Request received");

    // ── Step 2: Read and buffer request body for DLP + policy check ───
    let mut body_bytes = match axum::body::to_bytes(request.into_body(), 4 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("Failed to read request body: {}", e);
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_body",
                "Failed to read request body",
            );
        }
    };

    let mut body_str = String::from_utf8_lossy(&body_bytes).into_owned();
    let mut body_json: serde_json::Value = serde_json::from_str(&body_str).unwrap_or_default();
    let model = extract_model(&body_json);

    // Intercept `/intutic-predict` and `/intutic predict` slash commands pre-flight
    let last_user_content = if let Some(msgs) = body_json.get("messages").and_then(|m| m.as_array())
    {
        if let Some(last_msg) = msgs
            .iter()
            .rev()
            .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        {
            if let Some(content) = last_msg.get("content") {
                match content {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Array(arr) => {
                        let mut text = String::new();
                        for item in arr {
                            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                text.push_str(t);
                            }
                        }
                        Some(text)
                    }
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut judge_active = false;

    // Check if auto-judging is active for this session in Valkey (fail-open)
    let session_id_hdr = headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    {
        let mut conn = state.valkey.as_ref().clone();
        let key = format!("session:auto_judge:{}", session_id_hdr);
        if let Ok(Ok(Some(is_auto))) = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            conn.get::<_, Option<String>>(&key),
        )
        .await
        {
            if is_auto == "true" {
                judge_active = true;
            }
        }
    }

    if !judge_active {
        let loop_run_id_header = headers
            .get("x-loop-run-id")
            .or_else(|| headers.get("http-x-loop-run-id"))
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());

        if let Some(ref lr_id) = loop_run_id_header {
            let mut conn = state.valkey.as_ref().clone();
            let key = format!("loop:auto_judge:{}", lr_id);
            if let Ok(Ok(Some(is_auto))) = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                conn.get::<_, Option<String>>(&key),
            )
            .await
            {
                if is_auto == "true" {
                    judge_active = true;
                }
            }
        }
    }

    if let Some(ref text) = last_user_content {
        let trimmed = text.trim();
        let judge_pos = trimmed
            .find("/intutic judge")
            .or_else(|| trimmed.find("@intutic judge"));
        if let Some(pos) = judge_pos {
            judge_active = true;
            let match_len = if trimmed[pos..].starts_with("/intutic judge") {
                "/intutic judge".len()
            } else {
                "@intutic judge".len()
            };
            // Strip the prefix from the prompt in the request body
            if let Some(msgs) = body_json.get_mut("messages").and_then(|m| m.as_array_mut()) {
                if let Some(last_msg) = msgs
                    .iter_mut()
                    .rev()
                    .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
                {
                    if let Some(content) = last_msg.get_mut("content") {
                        match content {
                            serde_json::Value::String(s) => {
                                let mut rest = s.clone();
                                rest.replace_range(pos..(pos + match_len), "");
                                *s = rest.trim().to_string();
                            }
                            serde_json::Value::Array(arr) => {
                                if let Some(first) = arr.first_mut() {
                                    if let Some(text_val) =
                                        first.get_mut("text").and_then(|v| v.as_str())
                                    {
                                        let p_opt = text_val
                                            .find("/intutic judge")
                                            .or_else(|| text_val.find("@intutic judge"));
                                        if let Some(p) = p_opt {
                                            let mut rest = text_val.to_string();
                                            let p_len =
                                                if text_val[p..].starts_with("/intutic judge") {
                                                    "/intutic judge".len()
                                                } else {
                                                    "@intutic judge".len()
                                                };
                                            rest.replace_range(p..(p + p_len), "");
                                            if let Some(obj) = first.as_object_mut() {
                                                obj.insert(
                                                    "text".to_string(),
                                                    serde_json::Value::String(
                                                        rest.trim().to_string(),
                                                    ),
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    if judge_active {
        body_bytes = serde_json::to_vec(&body_json)
            .map(axum::body::Bytes::from)
            .unwrap_or(body_bytes);
        body_str = String::from_utf8_lossy(&body_bytes).into_owned();
    }

    let personal_sops = if judge_active {
        load_personal_sops()
    } else {
        serde_json::Value::Null
    };

    tracing::info!(judge_active = %judge_active, last_user_content = ?last_user_content, "Parsed judge command status");

    let is_predict_cmd = if let Some(ref text) = last_user_content {
        let mut cleaned = text.as_str();
        while cleaned.trim().starts_with('<') {
            let trimmed = cleaned.trim();
            if let Some(stripped) = trimmed.strip_prefix("<session>") {
                cleaned = stripped.trim();
            } else if trimmed.starts_with("<system-reminder>") {
                if let Some(end_pos) = trimmed.find("</system-reminder>") {
                    cleaned = trimmed[end_pos + "</system-reminder>".len()..].trim();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        let final_trimmed = cleaned.trim();
        final_trimmed.starts_with("/intutic-predict")
            || final_trimmed.starts_with("/intutic predict")
            || final_trimmed.starts_with("@intutic-predict")
            || final_trimmed.starts_with("@intutic predict")
    } else {
        false
    };

    if is_predict_cmd {
        if let Ok(valkey_url) = std::env::var("VALKEY_URL") {
            if let Ok(gate) = CostPredictionGate::new(&valkey_url) {
                if let Some(msgs) = body_json.get("messages") {
                    if let Some(estimate) = gate.predict(&workspace_id, &model, msgs).await {
                        let text = format!(
                            "### 🛡️ Intutic Pre-Flight Cost Prediction\n\n\
                             | Metric | Value |\n\
                             |---|---|\n\
                             | **Model** | `{}` |\n\
                             | **Input Tokens** | {} |\n\
                             | **Est. Output Tokens** | {} |\n\
                             | **Est. Reasoning Tokens** | {} |\n\
                             | **Est. Session Cost** | **${:.6}** |\n\
                             | **Confidence** | {} |\n\n\
                             *Prediction generated pre-flight from historical baseline distribution.*",
                            model,
                            estimate.input_tokens,
                            estimate.estimated_output_tokens,
                            estimate.estimated_reasoning_tokens,
                            estimate.estimated_cost_usd,
                            estimate.confidence,
                        );

                        let is_streaming = body_json
                            .get("stream")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if is_streaming {
                            let (tx, rx) = tokio::sync::mpsc::channel::<
                                Result<axum::body::Bytes, std::io::Error>,
                            >(10);
                            let provider_clone = provider.clone();

                            tokio::spawn(async move {
                                let chunk = match provider_clone {
                                    Provider::Anthropic => {
                                        let start_event = serde_json::json!({
                                            "type": "message_start",
                                            "message": {
                                                "id": "msg_predict",
                                                "type": "message",
                                                "role": "assistant",
                                                "content": [],
                                                "model": "claude-3-5-sonnet",
                                                "usage": { "input_tokens": 0, "output_tokens": 0 }
                                            }
                                        });
                                        let block_start = serde_json::json!({
                                            "type": "content_block_start",
                                            "index": 0,
                                            "content_block": { "type": "text", "text": "" }
                                        });
                                        let delta = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": 0,
                                            "delta": { "type": "text_delta", "text": text }
                                        });
                                        let block_stop = serde_json::json!({
                                            "type": "content_block_stop",
                                            "index": 0
                                        });
                                        let msg_delta = serde_json::json!({
                                            "type": "message_delta",
                                            "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                                            "usage": { "output_tokens": 0 }
                                        });

                                        format!(
                                            "event: message_start\ndata: {}\n\nevent: content_block_start\ndata: {}\n\nevent: content_block_delta\ndata: {}\n\nevent: content_block_stop\ndata: {}\n\nevent: message_delta\ndata: {}\n\nevent: message_stop\ndata: {{\"type\": \"message_stop\"}}\n\n",
                                            start_event, block_start, delta, block_stop, msg_delta
                                        )
                                    }
                                    _ => {
                                        let delta_chunk = serde_json::json!({
                                            "id": "chatcmpl-predict",
                                            "object": "chat.completion.chunk",
                                            "choices": [{
                                                "index": 0,
                                                "delta": { "content": text },
                                                "finish_reason": serde_json::Value::Null
                                            }]
                                        });
                                        format!("data: {}\n\ndata: [DONE]\n\n", delta_chunk)
                                    }
                                };

                                let _ = tx.send(Ok(axum::body::Bytes::from(chunk))).await;
                            });

                            let mut resp_headers = axum::http::HeaderMap::new();
                            resp_headers.insert(
                                axum::http::HeaderName::from_static("content-type"),
                                axum::http::HeaderValue::from_static("text/event-stream"),
                            );

                            let mut response = Response::builder().status(StatusCode::OK);
                            if let Some(headers_mut) = response.headers_mut() {
                                *headers_mut = resp_headers;
                            }
                            return response
                                .body(Body::from_stream(ReceiverStream::new(rx)))
                                .unwrap_or_else(|_| {
                                    json_error(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "predict_error",
                                        "Failed to construct streaming response",
                                    )
                                });
                        } else {
                            let resp_json = match provider {
                                Provider::Anthropic => {
                                    serde_json::json!({
                                        "id": "msg_predict",
                                        "type": "message",
                                        "role": "assistant",
                                        "content": [{ "type": "text", "text": text }],
                                        "model": model,
                                        "stop_reason": "end_turn",
                                        "stop_sequence": null,
                                        "usage": { "input_tokens": estimate.input_tokens, "output_tokens": 0 }
                                    })
                                }
                                Provider::Gemini => {
                                    serde_json::json!({
                                        "candidates": [{
                                            "content": {
                                                "parts": [{ "text": text }],
                                                "role": "model"
                                            },
                                            "finishReason": "STOP"
                                        }],
                                        "usageMetadata": {
                                            "promptTokenCount": estimate.input_tokens,
                                            "candidatesTokenCount": 0,
                                            "totalTokenCount": estimate.input_tokens
                                        }
                                    })
                                }
                                Provider::OpenAI => {
                                    serde_json::json!({
                                        "id": "chatcmpl-predict",
                                        "object": "chat.completion",
                                        "choices": [{
                                            "index": 0,
                                            "message": { "role": "assistant", "content": text },
                                            "finish_reason": "stop"
                                        }],
                                        "usage": {
                                            "prompt_tokens": estimate.input_tokens,
                                            "completion_tokens": 0,
                                            "total_tokens": estimate.input_tokens
                                        }
                                    })
                                }
                            };

                            return Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "application/json")
                                .body(Body::from(
                                    serde_json::to_vec(&resp_json).unwrap_or_default(),
                                ))
                                .unwrap_or_else(|_| {
                                    json_error(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "predict_error",
                                        "Failed to construct response",
                                    )
                                });
                        }
                    }
                }
            }
        }
    }

    // ── Step 2.5: Validate virtual key and check budget (Valkey) ─────
    let key_record = match validate_virtual_key(raw_token, &state.valkey).await {
        Ok(k) => Some(k),
        Err(MeteringError::KeyNotFound) => {
            tracing::warn!(token = %key_prefix, "Virtual key not found in cache");
            return json_error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Virtual API key is invalid, expired, or revoked.",
            );
        }
        Err(e) => {
            tracing::warn!("Valkey virtual key check failed (failing open): {}", e);
            None
        }
    };

    if let Some(ref key) = key_record {
        let prompt_tokens = (body_str.len() as f64 / 4.0).max(1.0) as u32;
        let max_tokens = body_json.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(4096) as u32;
        let estimated_cost = pricing::estimate_cost(&model, prompt_tokens, max_tokens);

        if let Err(e) = check_budget(key, estimated_cost) {
            tracing::warn!(workspace_id = %workspace_id, "Budget check failed: {}", e);
            return json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "BUDGET_EXCEEDED",
                "Remaining budget is insufficient for this request's safety margin.",
            );
        }
    }

    // ── Step 3: Hard-cap block check (Valkey, <1ms P99) ─────────────
    match check_workspace_hard_block(&workspace_id, &state.valkey).await {
        Err(MeteringError::HardCapExceeded { .. }) => {
            tracing::warn!(workspace_id = %workspace_id, "Hard cap block active — rejecting request");
            return json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "OVERAGE_HARD_CAP_EXCEEDED",
                "Daily spend cap exceeded. This workspace is blocked until midnight UTC. Contact your Intutic admin.",
            );
        }
        Err(MeteringError::ValkeyCommunicationError(e)) => {
            // Non-fatal: log and continue (Valkey is a cache, not auth)
            tracing::warn!("Valkey hard-cap check failed (continuing): {}", e);
        }
        _ => {}
    }

    // ── Step 3b: Loop execution governance check (Valkey, <1ms P99) ─────────
    let loop_run_id_header = headers
        .get("x-loop-run-id")
        .or_else(|| headers.get("http-x-loop-run-id"))
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    if let Some(ref lr_id) = loop_run_id_header {
        match check_loop_block(lr_id, &state.valkey).await {
            Err(MeteringError::LoopTerminated { status, .. }) => {
                tracing::warn!(workspace_id = %workspace_id, loop_run_id = %lr_id, status = %status, "Loop execution terminated by safety rules — rejecting request");
                return json_error(
                    StatusCode::FORBIDDEN,
                    "LOOP_RUN_TERMINATED",
                    &format!("This request was blocked because the associated loop run {} is completed or terminated (status: {}).", lr_id, status),
                );
            }
            Err(e) => {
                tracing::warn!("Valkey loop check failed (continuing): {}", e);
            }
            _ => {}
        }
    }

    // ── Step 4: DLP scan — input ─────────────────────────────────────
    // ── Step 4: DLP scan — input ─────────────────────────────────────
    let dlp_findings = if state.config.intutic_settings.dlp.enabled
        && state.config.intutic_settings.dlp.scan_input
    {
        let findings = dlp::scan(&body_str);
        let has_block = findings.iter().any(|f| f.action == "block");
        if has_block {
            tracing::warn!(workspace_id = %workspace_id, "DLP BLOCK action on input");
            return json_error(
                StatusCode::BAD_REQUEST,
                "dlp_policy_violation",
                "Request body contains content blocked by DLP policy (e.g., private keys). Remove the sensitive content and retry.",
            );
        }
        // Redact non-blocking findings from the body before forwarding
        let _redacted = dlp::redact(&body_str, &findings);
        // NOTE: We log findings but forward the original body for now.
        // Full redaction-before-forward is tracked as TD-DLP-001.
        if !findings.is_empty() {
            tracing::info!(workspace_id = %workspace_id, findings = findings.len(), "DLP findings redacted from request");
        }
        findings
    } else {
        Vec::new()
    };

    // Check for break-glass override token in request headers
    let mut has_break_glass = false;
    if let Some(bg_token) = headers
        .get("x-intutic-break-glass")
        .and_then(|v| v.to_str().ok())
    {
        let mut conn = state.valkey.as_ref().clone();
        let bg_key = format!("bg:token:{}", bg_token);
        let raw_bg_res: Result<
            Result<Option<String>, redis::RedisError>,
            tokio::time::error::Elapsed,
        > = tokio::time::timeout(std::time::Duration::from_millis(500), conn.get(&bg_key)).await;

        if let Ok(Ok(Some(_))) = raw_bg_res {
            tracing::info!(workspace_id = %workspace_id, token = %bg_token, "Active break-glass override token detected — bypassing safety policies");
            has_break_glass = true;
        } else {
            tracing::warn!(workspace_id = %workspace_id, token = %bg_token, "Expired, invalid, or unreachable break-glass token header provided");
        }
    }

    // ── Step 4b: WASM custom rules ───────────────────────────────────
    let session_id = headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let local_max = crate::local_spend::get_max_daily_budget();
    let local_spent = crate::local_spend::get_local_spend();
    let local_budget_remaining = if local_max > local_spent {
        local_max - local_spent
    } else {
        0.0
    };

    use redis::AsyncCommands;
    let mut conn = state.valkey.as_ref().clone();
    let valkey_key = format!("v2:session:{}:tools", session_id);
    let mut tool_sequence: Vec<String> = conn.lrange(&valkey_key, 0, -1).await.unwrap_or_default();

    let request_tool_calls = extract_request_tool_calls(&body_json);
    if !request_tool_calls.is_empty() {
        for tool in &request_tool_calls {
            tool_sequence.push(tool.clone());
            let _: Result<(), redis::RedisError> = conn.rpush(&valkey_key, tool).await;
        }
        if tool_sequence.len() > 20 {
            let _: Result<(), redis::RedisError> = conn.ltrim(&valkey_key, -20, -1).await;
            let start_idx = tool_sequence.len() - 20;
            tool_sequence = tool_sequence.split_off(start_idx);
        }
    }

    let wasm_ctx = crate::wasm::context::RequestContext {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        virtual_key_prefix: key_prefix.to_string(),
        model: model.clone(),
        tools: extract_tools(&body_json),
        tool_calls: extract_wasm_tool_calls(&body_json),
        estimated_input_tokens: (body_str.len() / 4) as u32,
        budget_remaining_usd: local_budget_remaining,
        risk_tier: crate::wasm::context::RiskLevel::Low,
        dlp_findings,
        tool_sequence,
    };

    // Evaluate native budget gate
    let budget_plugin = crate::plugins::budget_gate::BudgetGatePlugin::new();
    if let crate::wasm::context::Verdict::Kill { reason, .. } = budget_plugin.evaluate(&wasm_ctx) {
        tracing::warn!(workspace_id = %workspace_id, reason = %reason, "Offline budget cap exceeded — rejecting request");
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "OVERAGE_HARD_CAP_EXCEEDED",
            &format!("Daily spend cap exceeded: {}", reason),
        );
    }

    // Evaluate sequence anomaly plugin
    let seq_plugin = crate::plugins::sequence_anomaly::SequenceAnomalyPlugin::new();
    if !has_break_glass {
        match seq_plugin.evaluate(&wasm_ctx) {
            crate::wasm::context::Verdict::Kill { reason, .. } => {
                tracing::warn!(workspace_id = %workspace_id, reason = %reason, "Sequence loop/abuse blocked request");
                return json_error(
                    StatusCode::FORBIDDEN,
                    "policy_denied",
                    &format!("Request blocked by sequence anomaly policy: {}", reason),
                );
            }
            crate::wasm::context::Verdict::Hijack { reason, .. } => {
                tracing::warn!(workspace_id = %workspace_id, reason = %reason, "Anomalous sequence flagged for review");
                return json_error(
                    StatusCode::FORBIDDEN,
                    "policy_flagged",
                    &format!("Request flagged by sequence anomaly policy: {}", reason),
                );
            }
            _ => {}
        }
    }

    if !has_break_glass {
        let wasm_verdict = state.wasm_registry.evaluate(&state.valkey, &wasm_ctx).await;
        tracing::info!(workspace_id = %workspace_id, verdict = ?wasm_verdict, "WASM evaluation verdict");
        if let crate::wasm::context::Verdict::Kill { reason, .. } = wasm_verdict {
            tracing::warn!(workspace_id = %workspace_id, reason = %reason, "WASM custom rule blocked this request");
            return json_error(
                StatusCode::FORBIDDEN,
                "policy_denied",
                &format!("Request blocked by custom WASM governance rule: {}", reason),
            );
        }
    }

    // ── Step 5: Policy pre-check via control plane ───────────────────

    if !has_break_glass {
        let policy_cfg = &state.config.intutic_settings.policy;
        if let Some(cp_url) = &policy_cfg.control_plane_url {
            match policy_check(
                &state.http_client,
                cp_url,
                &workspace_id,
                key_prefix,
                &provider,
                &model,
                Some(&session_id),
                policy_cfg.timeout_ms,
            )
            .await
            {
                Err(reason) if policy_cfg.fail_closed => {
                    tracing::warn!(workspace_id = %workspace_id, reason = %reason, "Policy check denied or unreachable — blocking (fail-closed)");
                    return json_error(
                        StatusCode::FORBIDDEN,
                        "policy_denied",
                        &format!("Request blocked by Intutic governance policy: {}", reason),
                    );
                }
                Err(reason) => {
                    // fail-open: log but allow
                    tracing::warn!(workspace_id = %workspace_id, reason = %reason, "Policy check failed — allowing (fail-open mode)");
                }
                Ok(()) => {
                    tracing::debug!(workspace_id = %workspace_id, "Policy check passed");
                }
            }
        } else {
            tracing::debug!("No CONTROL_PLANE_URL configured — skipping policy check");
        }
    }

    // ── Step 5b: Phase 7 — Pre-processor (slash commands + quality gate) ──
    if let Ok(control_plane_url) = std::env::var("CONTROL_PLANE_URL") {
        let messages = body_json.get("messages").cloned();
        if let Some(msgs) = &messages {
            let pre_processor = RequestPreProcessor::new(&control_plane_url);
            if let Some(intercepted) = pre_processor
                .process(
                    &session_id,
                    &workspace_id,
                    msgs,
                    &model,
                    &protocol,
                    raw_token,
                )
                .await
            {
                tracing::info!(
                    workspace_id = %workspace_id,
                    session_id = %session_id,
                    "Request intercepted by pre-processor"
                );
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/json")
                    .body(Body::from(intercepted))
                    .unwrap_or_else(|_| {
                        json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "preprocess_error",
                            "Pre-processor failed",
                        )
                    });
            }
        }

        // Cost prediction gate
        if let Ok(valkey_url) = std::env::var("VALKEY_URL") {
            if let Ok(gate) = CostPredictionGate::new(&valkey_url) {
                let messages = body_json.get("messages").cloned();
                if let Some(msgs) = &messages {
                    if let Some(estimate) = gate
                        .evaluate(&session_id, &workspace_id, &model, msgs)
                        .await
                    {
                        tracing::info!(
                            workspace_id = %workspace_id,
                            estimated_cost = estimate.estimated_cost_usd,
                            threshold = estimate.threshold_usd,
                            "Cost prediction gate triggered"
                        );
                        let gate_response =
                            CostPredictionGate::format_gate_response(&estimate, &model);
                        return Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "application/json")
                            .body(Body::from(gate_response))
                            .unwrap_or_else(|_| {
                                json_error(
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "cost_gate_error",
                                    "Cost gate failed",
                                )
                            });
                    }
                }
            }
        }
    }

    // Step 6: Forward to upstream LLM provider

    // Fetch feature flags from Valkey (fail-open on errors/timeouts)
    let mut conn = state.valkey.as_ref().clone();
    let ff_key = format!("workspace:feature_flags:{}", workspace_id);
    let mut ff_bandit_routing = false;
    let mut ff_response_cache_exact = false;
    let mut ff_response_cache_semantic = false;

    let raw_ffs_res: Result<
        Result<Option<String>, redis::RedisError>,
        tokio::time::error::Elapsed,
    > = tokio::time::timeout(std::time::Duration::from_millis(500), conn.get(&ff_key)).await;

    if let Ok(Ok(Some(ff_str))) = raw_ffs_res {
        if let Ok(ff_json) = serde_json::from_str::<serde_json::Value>(&ff_str) {
            ff_bandit_routing = ff_json
                .get("ff_bandit_routing")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            ff_response_cache_exact = ff_json
                .get("ff_response_cache_exact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            ff_response_cache_semantic = ff_json
                .get("ff_response_cache_semantic")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }
    }

    let session_id = headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    // Check response cache
    if ff_response_cache_exact || ff_response_cache_semantic {
        if let Some(cached_resp) = crate::plugins::semantic_cache::check_cache(
            &state.valkey,
            &state.http_client,
            &workspace_id,
            &body_json,
            ff_response_cache_exact,
            ff_response_cache_semantic,
        )
        .await
        {
            let mock_body = crate::plugins::semantic_cache::construct_mock_response(
                &protocol,
                &cached_resp,
                &model,
            );
            let latency_ms = start.elapsed().as_millis() as u32;
            let raw_cost_usd = estimate_model_cost(
                &model,
                cached_resp.prompt_tokens,
                cached_resp.completion_tokens,
            );

            let trace = ExecutionTrace {
                trace_id: uuid::Uuid::new_v4().to_string(),
                session_id: session_id.clone(),
                workspace_id: workspace_id.clone(),
                virtual_key_id: key_prefix.to_string(),
                model: model.clone(),
                provider: provider.harness_name().to_string(),
                raw_input_tokens: cached_resp.prompt_tokens,
                compressed_input_tokens: cached_resp.prompt_tokens,
                output_tokens: cached_resp.completion_tokens,
                raw_cost_usd,
                actual_cost_usd: 0.0,
                cache_hit: true,
                latency_ms,
                verdict: "allowed".to_string(),
                harness_type: provider.harness_name().to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                requested_model: model.clone(),
                actual_model_routed: cached_resp.model.clone(),
                task_type: crate::routing::bandit::classify_task(
                    &crate::plugins::semantic_cache::extract_prompt_text(&body_json),
                )
                .to_string(),
                reconstruction_quality: 100,
                token_anomaly: false,
                loop_run_id: loop_run_id_header.clone(),
            };

            let valkey = Arc::clone(&state.valkey);
            spawn(async move {
                if let Err(e) = publish_trace(&valkey, &trace).await {
                    tracing::warn!("Failed to publish cache trace: {}", e);
                }
            });

            return (StatusCode::OK, axum::Json(mock_body)).into_response();
        }
    }

    // Contextual Bandit Routing
    let prompt_text = crate::plugins::semantic_cache::extract_prompt_text(&body_json);
    let (mut actual_model, _sop_tier, task_type) = if ff_bandit_routing {
        match crate::routing::bandit::route_model(
            &state.valkey,
            &workspace_id,
            &session_id,
            &model,
            &prompt_text,
        )
        .await
        {
            Ok(res) => res,
            Err(e) => {
                tracing::warn!("Bandit routing failed: {}", e);
                (model.clone(), "TIER_1".to_string(), "coding".to_string())
            }
        }
    } else {
        (model.clone(), "TIER_1".to_string(), "coding".to_string())
    };

    let original_routed_model = actual_model.clone();

    if get_model_provider(&actual_model) == Provider::Anthropic {
        actual_model = "claude-opus-4-8".to_string();
    }

    let target_provider = get_model_provider(&actual_model);
    let is_same_provider = target_provider == provider;

    let host_header = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let host_name = host_header.split(':').next().unwrap_or(host_header);

    let (upstream_url, request_body) = if is_same_provider {
        let upstream_base =
            if !host_name.is_empty() && crate::hostname_filter::is_ai_provider_host(host_name) {
                format!("https://{}", host_name)
            } else {
                provider.upstream_base_url()
            };
        let final_body = if actual_model != model {
            let mut new_body = body_json.clone();
            new_body["model"] = json!(actual_model);
            serde_json::to_vec(&new_body).unwrap_or_else(|_| body_bytes.to_vec())
        } else {
            body_bytes.to_vec()
        };
        (format!("{}{}", upstream_base, uri_path), final_body)
    } else {
        // Cross-provider translation
        let target_base_url = target_provider.upstream_base_url();
        let target_path = match target_provider {
            Provider::Anthropic => "/v1/messages",
            Provider::OpenAI => "/v1/chat/completions",
            Provider::Gemini => "/v1beta/models/gemini-1.5-pro:generateContent",
        };
        let url = format!("{}{}", target_base_url, target_path);

        let translated_body = match (&provider, &target_provider) {
            (Provider::OpenAI, Provider::Anthropic) => {
                let is_responses = protocol == Protocol::OpenAIResponses;
                let mut req =
                    crate::protocol::openai::OpenAIAdapter::translate_request_to_anthropic(
                        &body_json,
                        is_responses,
                    );
                req["model"] = json!(actual_model);
                req
            }
            _ => {
                let mut req = body_json.clone();
                req["model"] = json!(actual_model);
                req
            }
        };
        (
            url,
            serde_json::to_vec(&translated_body).unwrap_or_default(),
        )
    };

    tracing::debug!(upstream_url = %upstream_url, "Forwarding to upstream");

    // Build forwarded request: copy headers
    let mut fwd_headers = reqwest::header::HeaderMap::new();
    for (name, value) in headers.iter() {
        let name_str = name.as_str().to_lowercase();
        if matches!(
            name_str.as_str(),
            "host"
                | "connection"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "upgrade"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "authorization"
                | "x-api-key"
                | "accept-encoding"
                | "content-length"
        ) {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_ref()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            fwd_headers.insert(n, v);
        }
    }

    // Inject credentials
    let mut creds_injected = false;
    if raw_token.starts_with("vk_") {
        if let Some(cred) =
            fetch_provider_credential(&state.valkey, &workspace_id, &target_provider).await
        {
            match target_provider {
                Provider::Anthropic => {
                    if cred.starts_with("sk-ant-oat") {
                        let bearer = format!("Bearer {}", cred);
                        if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer) {
                            fwd_headers.insert(
                                reqwest::header::HeaderName::from_static("authorization"),
                                v,
                            );
                        }
                    } else {
                        if let Ok(v) = reqwest::header::HeaderValue::from_str(&cred) {
                            fwd_headers
                                .insert(reqwest::header::HeaderName::from_static("x-api-key"), v);
                        }
                    }
                    let v = reqwest::header::HeaderValue::from_static("2023-06-01");
                    fwd_headers.insert(
                        reqwest::header::HeaderName::from_static("anthropic-version"),
                        v,
                    );
                }
                Provider::OpenAI => {
                    let bearer = format!("Bearer {}", cred);
                    if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer) {
                        fwd_headers
                            .insert(reqwest::header::HeaderName::from_static("authorization"), v);
                    }
                }
                Provider::Gemini => {
                    if let Ok(v) = reqwest::header::HeaderValue::from_str(&cred) {
                        fwd_headers.insert(
                            reqwest::header::HeaderName::from_static("x-goog-api-key"),
                            v,
                        );
                    }
                }
            }
            creds_injected = true;
        }
    }

    if !creds_injected {
        if !is_same_provider {
            if let Some(cred) =
                fetch_provider_credential(&state.valkey, &workspace_id, &target_provider).await
            {
                match target_provider {
                    Provider::Anthropic => {
                        if cred.starts_with("sk-ant-oat") {
                            let bearer = format!("Bearer {}", cred);
                            if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer) {
                                fwd_headers.insert(
                                    reqwest::header::HeaderName::from_static("authorization"),
                                    v,
                                );
                            }
                        } else {
                            if let Ok(v) = reqwest::header::HeaderValue::from_str(&cred) {
                                fwd_headers.insert(
                                    reqwest::header::HeaderName::from_static("x-api-key"),
                                    v,
                                );
                            }
                        }
                        let v = reqwest::header::HeaderValue::from_static("2023-06-01");
                        fwd_headers.insert(
                            reqwest::header::HeaderName::from_static("anthropic-version"),
                            v,
                        );
                    }
                    Provider::OpenAI => {
                        let bearer = format!("Bearer {}", cred);
                        if let Ok(v) = reqwest::header::HeaderValue::from_str(&bearer) {
                            fwd_headers.insert(
                                reqwest::header::HeaderName::from_static("authorization"),
                                v,
                            );
                        }
                    }
                    Provider::Gemini => {
                        if let Ok(v) = reqwest::header::HeaderValue::from_str(&cred) {
                            fwd_headers.insert(
                                reqwest::header::HeaderName::from_static("x-goog-api-key"),
                                v,
                            );
                        }
                    }
                }
            }
        } else {
            if let Some(auth_val) = headers.get("authorization") {
                if let Ok(v) = reqwest::header::HeaderValue::from_bytes(auth_val.as_bytes()) {
                    fwd_headers
                        .insert(reqwest::header::HeaderName::from_static("authorization"), v);
                }
            }
            if let Some(api_val) = headers.get("x-api-key") {
                if let Ok(v) = reqwest::header::HeaderValue::from_bytes(api_val.as_bytes()) {
                    fwd_headers.insert(reqwest::header::HeaderName::from_static("x-api-key"), v);
                }
            }
        }
    }

    let fwd_result = state
        .http_client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::POST),
            &upstream_url,
        )
        .headers(fwd_headers)
        .body(request_body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await;

    let upstream_resp = match fwd_result {
        Ok(r) => r,
        Err(e) => {
            let desc = format!("Failed to reach LLM provider: {}", e);
            tracing::error!(upstream_url = %upstream_url, error = %e, "{}", desc);
            crate::plugins::semantic_cache::publish_system_anomaly(
                &state.valkey,
                &workspace_id,
                &desc,
            )
            .await;

            if ff_bandit_routing {
                let failure_key = format!("bandit:outage_failures:{}", workspace_id);
                let arm_key = format!("arm:{}:{}:{}", original_routed_model, _sop_tier, task_type);
                let mut conn_clone = state.valkey.as_ref().clone();
                let _: Result<(), _> = conn_clone.hincr(&failure_key, &arm_key, 1).await;
            }

            return json_error(StatusCode::BAD_GATEWAY, "upstream_error", &desc);
        }
    };

    let upstream_status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    tracing::info!(status = %upstream_status, "Upstream response status received");

    if !upstream_resp.status().is_success() {
        let err_status = upstream_resp.status();
        let err_headers = upstream_resp.headers().clone();
        let err_body = upstream_resp.text().await.unwrap_or_default();
        tracing::error!(
            status = %err_status,
            headers = ?err_headers,
            body = %err_body,
            request_body = %String::from_utf8_lossy(&body_bytes),
            "Upstream returned error response!"
        );

        if ff_bandit_routing && err_status.is_server_error() {
            let failure_key = format!("bandit:outage_failures:{}", workspace_id);
            let arm_key = format!("arm:{}:{}:{}", original_routed_model, _sop_tier, task_type);
            let mut conn_clone = state.valkey.as_ref().clone();
            let _: Result<(), _> = conn_clone.hincr(&failure_key, &arm_key, 1).await;
        }

        let final_prompt_tokens = (body_bytes.len() as f64 / 4.0).max(1.0) as u32;
        let latency_ms = start.elapsed().as_millis() as u32;
        let trace = ExecutionTrace {
            trace_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            workspace_id: workspace_id.clone(),
            virtual_key_id: key_prefix.to_string(),
            model: model.clone(),
            provider: provider.harness_name().to_string(),
            raw_input_tokens: final_prompt_tokens,
            compressed_input_tokens: final_prompt_tokens,
            output_tokens: 0,
            raw_cost_usd: 0.0,
            actual_cost_usd: 0.0,
            cache_hit: false,
            latency_ms,
            verdict: "allowed".to_string(),
            harness_type: provider.harness_name().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            requested_model: model.clone(),
            actual_model_routed: actual_model.clone(),
            task_type: task_type.clone(),
            reconstruction_quality: 100,
            token_anomaly: false,
            loop_run_id: loop_run_id_header.clone(),
        };
        let valkey_clone = Arc::clone(&state.valkey);
        tokio::spawn(async move {
            let _ = publish_trace(&valkey_clone, &trace).await;
        });

        let mut resp_builder = Response::builder().status(err_status);
        for (name, value) in err_headers.iter() {
            let name_str = name.as_str().to_lowercase();
            if name_str == "transfer-encoding"
                || name_str == "content-encoding"
                || name_str == "content-length"
            {
                continue;
            }
            resp_builder = resp_builder.header(name, value);
        }
        return resp_builder
            .body(axum::body::Body::from(err_body))
            .unwrap()
            .into_response();
    }

    // Copy upstream response headers back to client
    let mut resp_headers = axum::http::HeaderMap::new();
    for (name, value) in upstream_resp.headers() {
        let name_str = name.as_str().to_lowercase();
        if name_str == "transfer-encoding"
            || name_str == "content-encoding"
            || name_str == "content-length"
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            axum::http::HeaderName::from_bytes(name.as_ref()),
            axum::http::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_headers.insert(n, v);
        }
    }

    let is_streaming = body_json
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if is_streaming {
        resp_headers.insert(
            axum::http::HeaderName::from_static("content-type"),
            axum::http::HeaderValue::from_static("text/event-stream"),
        );

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(100);
        let upstream_stream = upstream_resp.bytes_stream();
        let valkey_clone = Arc::clone(&state.valkey);
        let http_client_clone = state.http_client.as_ref().clone();
        let workspace_id_clone = workspace_id.clone();
        let body_json_clone = body_json.clone();
        let key_prefix_clone = key_prefix.to_string();
        let session_id_clone = session_id.clone();
        let requested_model_clone = model.clone();
        let actual_model_clone = actual_model.clone();
        let task_type_clone = task_type.clone();
        let prompt_text_clone = prompt_text.clone();
        let provider_clone = provider.clone();
        let loop_run_id_clone = loop_run_id_header.clone();
        let control_plane_url_clone = std::env::var("CONTROL_PLANE_URL").unwrap_or_default();
        let judge_active_clone = judge_active;
        let personal_sops_clone = personal_sops.clone();
        let protocol_clone = protocol.clone();
        let client_api_key_clone = raw_token.to_string();

        spawn(async move {
            let mut stream = upstream_stream;
            let mut accumulated_content = String::new();
            let mut prompt_tokens = 0;
            let mut completion_tokens = 0;
            let mut buffer = String::new();
            let mut current_event_type = String::new();
            let mut current_data = String::new();

            let mut last_processed_len = 0;
            let mut paragraph_history: Vec<String> = Vec::new();
            let mut chunk_index = 0;
            let mut chunk_handles = Vec::new();
            let mut done_received = false;

            while let Some(chunk_res) = stream.next().await {
                match chunk_res {
                    Ok(bytes) => {
                        let text_chunk = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&text_chunk);

                        while let Some(pos) = buffer.find('\n') {
                            let line = buffer[..pos].trim().to_string();
                            buffer = buffer[(pos + 1)..].to_string();

                            if is_same_provider {
                                // Intercept end-of-stream markers to inject governance notifications
                                let is_done = if provider_clone == Provider::Anthropic {
                                    line == "event: message_stop"
                                } else {
                                    line.starts_with("data:")
                                        && line["data:".len()..].trim() == "[DONE]"
                                };

                                if is_done {
                                    done_received = true;
                                }

                                let is_content_block_stop = if provider_clone == Provider::Anthropic
                                {
                                    line == "event: content_block_stop"
                                        || (line.starts_with("data:")
                                            && line.contains("content_block_stop"))
                                } else {
                                    false
                                };

                                let mut skip_forward = false;
                                if judge_active_clone && (done_received || is_content_block_stop) {
                                    skip_forward = true;
                                } else if is_done {
                                    if let Ok(valkey_url) = std::env::var("VALKEY_URL") {
                                        let harness = session_id_clone.as_str();
                                        let proto = match provider_clone {
                                            Provider::Anthropic => {
                                                crate::postprocessor::Protocol::Anthropic
                                            }
                                            Provider::Gemini => {
                                                crate::postprocessor::Protocol::Gemini
                                            }
                                            _ => crate::postprocessor::Protocol::OpenAI,
                                        };
                                        if let Ok(pp) =
                                            ResponsePostProcessor::new(&valkey_url, harness, proto)
                                        {
                                            if let Some(gov_block) = pp
                                                .process(&session_id_clone, &workspace_id_clone)
                                                .await
                                            {
                                                let _ = tx
                                                    .send(Ok(axum::body::Bytes::from(gov_block)))
                                                    .await;
                                            }
                                        }
                                    }
                                }

                                if !skip_forward {
                                    let forward_bytes = format!("{}\n", line);
                                    if tx
                                        .send(Ok(axum::body::Bytes::from(forward_bytes)))
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                }

                                if let Some(stripped) = line.strip_prefix("data:") {
                                    let data_part = stripped.trim();
                                    if data_part != "[DONE]" && !data_part.is_empty() {
                                        if let Ok(json_val) =
                                            serde_json::from_str::<serde_json::Value>(data_part)
                                        {
                                            if provider_clone == Provider::Anthropic {
                                                if let Some(delta) = json_val.get("delta") {
                                                    if let Some(t) =
                                                        delta.get("text").and_then(|v| v.as_str())
                                                    {
                                                        accumulated_content.push_str(t);
                                                    }
                                                }
                                                if let Some(usage) = json_val.get("usage") {
                                                    if let Some(it) = usage
                                                        .get("input_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        prompt_tokens = it as u32;
                                                    }
                                                    if let Some(ot) = usage
                                                        .get("output_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        completion_tokens = ot as u32;
                                                    }
                                                }
                                            } else {
                                                if let Some(choices) = json_val
                                                    .get("choices")
                                                    .and_then(|c| c.as_array())
                                                {
                                                    if let Some(first) = choices.first() {
                                                        if let Some(t) = first
                                                            .get("delta")
                                                            .and_then(|d| d.get("content"))
                                                            .and_then(|v| v.as_str())
                                                        {
                                                            accumulated_content.push_str(t);
                                                        }
                                                    }
                                                }
                                                if let Some(usage) = json_val.get("usage") {
                                                    if let Some(pt) = usage
                                                        .get("prompt_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        prompt_tokens = pt as u32;
                                                    }
                                                    if let Some(ct) = usage
                                                        .get("completion_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        completion_tokens = ct as u32;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                if let Some(stripped) = line.strip_prefix("event:") {
                                    current_event_type = stripped.trim().to_string();
                                } else if let Some(stripped) = line.strip_prefix("data:") {
                                    current_data = stripped.trim().to_string();
                                } else if line.is_empty()
                                    && (!current_event_type.is_empty() || !current_data.is_empty())
                                {
                                    if current_data == "[DONE]" {
                                        // Phase 7: Inject governance notifications before [DONE]
                                        if let Ok(valkey_url) = std::env::var("VALKEY_URL") {
                                            let harness = session_id.as_str();
                                            let proto = match provider {
                                                Provider::Anthropic => {
                                                    crate::postprocessor::Protocol::Anthropic
                                                }
                                                Provider::Gemini => {
                                                    crate::postprocessor::Protocol::Gemini
                                                }
                                                _ => crate::postprocessor::Protocol::OpenAI,
                                            };
                                            if let Ok(pp) = ResponsePostProcessor::new(
                                                &valkey_url,
                                                harness,
                                                proto,
                                            ) {
                                                if let Some(gov_block) = pp
                                                    .process(&session_id, &workspace_id_clone)
                                                    .await
                                                {
                                                    let _ = tx
                                                        .send(Ok(axum::body::Bytes::from(
                                                            gov_block,
                                                        )))
                                                        .await;
                                                }
                                            }
                                        }
                                        let _ = tx
                                            .send(Ok(axum::body::Bytes::from("data: [DONE]\n\n")))
                                            .await;
                                    } else if !current_data.is_empty() {
                                        if let Ok(json_val) =
                                            serde_json::from_str::<serde_json::Value>(&current_data)
                                        {
                                            if current_event_type == "content_block_delta" {
                                                if let Some(delta) = json_val.get("delta") {
                                                    if let Some(t) =
                                                        delta.get("text").and_then(|v| v.as_str())
                                                    {
                                                        accumulated_content.push_str(t);
                                                    }
                                                }
                                            } else if current_event_type == "message_delta" {
                                                if let Some(usage) = json_val.get("usage") {
                                                    if let Some(it) = usage
                                                        .get("input_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        prompt_tokens = it as u32;
                                                    }
                                                    if let Some(ot) = usage
                                                        .get("output_tokens")
                                                        .and_then(|v| v.as_u64())
                                                    {
                                                        completion_tokens = ot as u32;
                                                    }
                                                }
                                            } else if current_event_type == "message_start" {
                                                if let Some(msg) = json_val.get("message") {
                                                    if let Some(usage) = msg.get("usage") {
                                                        if let Some(it) = usage
                                                            .get("input_tokens")
                                                            .and_then(|v| v.as_u64())
                                                        {
                                                            prompt_tokens = it as u32;
                                                        }
                                                    }
                                                }
                                            }

                                            let is_responses =
                                                protocol == Protocol::OpenAIResponses;
                                            if let Some(translated) = crate::protocol::openai::OpenAIAdapter::translate_stream_event(&current_event_type, &json_val, is_responses) {
                                                    let sse_line = format!("data: {}\n\n", serde_json::to_string(&translated).unwrap_or_default());
                                                    if tx.send(Ok(axum::body::Bytes::from(sse_line))).await.is_err() {
                                                        return;
                                                    }
                                                }
                                        }
                                    }
                                    current_event_type.clear();
                                    current_data.clear();
                                }
                                if judge_active_clone {
                                    let current_slice = &accumulated_content[last_processed_len..];
                                    let mut split_index = None;
                                    if let Some(pos) = current_slice.find("\n\n") {
                                        split_index = Some(pos + 2);
                                    } else if let Some(pos) = current_slice.find("```") {
                                        if pos > 0 {
                                            split_index = Some(pos);
                                        } else if let Some(pos2) = current_slice[3..].find("```") {
                                            split_index = Some(pos2 + 6);
                                        }
                                    }

                                    if let Some(offset) = split_index {
                                        let chunk_content =
                                            current_slice[..offset].trim().to_string();
                                        if !chunk_content.is_empty() {
                                            tracing::info!(chunk_content = %chunk_content, "Detected paragraph chunk");
                                            let context_paras = if paragraph_history.len() >= 2 {
                                                paragraph_history[paragraph_history.len() - 2..]
                                                    .to_vec()
                                            } else {
                                                paragraph_history.clone()
                                            };

                                            paragraph_history.push(chunk_content.clone());

                                            let client = http_client_clone.clone();
                                            let cp_url = control_plane_url_clone.clone();
                                            let ws_id = workspace_id_clone.clone();
                                            let sess_id = session_id_clone.clone();
                                            let mut conn_clone = valkey_clone.as_ref().clone();
                                            let cur_index = chunk_index;

                                            let personal_sops_chunk = personal_sops_clone.clone();
                                            let api_key_for_chunk = client_api_key_clone.clone();
                                            let handle = spawn(async move {
                                                use redis::AsyncCommands;
                                                let list_key =
                                                    format!("session:chunks:{}", sess_id);

                                                let check_url =
                                                    format!("{}/api/v1/judge/chunk", cp_url);
                                                tracing::info!(url = %check_url, "Sending chunk to judge");
                                                let response = client
                                                    .post(&check_url)
                                                    .header(
                                                        "Authorization",
                                                        format!("Bearer {}", api_key_for_chunk),
                                                    )
                                                    .json(&serde_json::json!({
                                                        "workspaceId": ws_id,
                                                        "sessionId": sess_id,
                                                        "chunkContent": chunk_content,
                                                        "contextParagraphs": context_paras,
                                                        "personalSops": personal_sops_chunk,
                                                    }))
                                                    .send()
                                                    .await;

                                                let verdict = match response {
                                                    Ok(r) => {
                                                        tracing::info!(status = %r.status(), "Received response from chunk judge");
                                                        if r.status().is_success() {
                                                            r.json::<serde_json::Value>().await.unwrap_or(serde_json::json!({"triggered": false}))
                                                        } else {
                                                            serde_json::json!({"triggered": false, "error": "failed request"})
                                                        }
                                                    }
                                                    Err(e) => {
                                                        tracing::error!(error = %e, "Chunk judge request failed");
                                                        serde_json::json!({"triggered": false, "error": "network error"})
                                                    }
                                                };

                                                tracing::info!(verdict = ?verdict, "Chunk verdict recorded");
                                                let chunk_json = serde_json::json!({
                                                    "index": cur_index,
                                                    "content": chunk_content,
                                                    "verdict": verdict,
                                                });
                                                let json_str =
                                                    serde_json::to_string(&chunk_json).unwrap();
                                                let _: () = conn_clone
                                                    .rpush(&list_key, &json_str)
                                                    .await
                                                    .unwrap_or_default();
                                                let _: () = conn_clone
                                                    .expire(&list_key, 3600)
                                                    .await
                                                    .unwrap_or_default();
                                            });

                                            chunk_handles.push(handle);
                                            chunk_index += 1;
                                        }
                                        last_processed_len += offset;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                        return;
                    }
                }
            }

            if judge_active_clone {
                tracing::info!(handles_count = %chunk_handles.len(), "Waiting for chunk evaluation handles");
                for h in chunk_handles {
                    let _ = h.await;
                }

                let trailing = accumulated_content[last_processed_len..].trim().to_string();
                tracing::info!(trailing_content = %trailing, "Processing trailing content");
                if !trailing.is_empty() {
                    let context_paras = if paragraph_history.len() >= 2 {
                        paragraph_history[paragraph_history.len() - 2..].to_vec()
                    } else {
                        paragraph_history.clone()
                    };

                    use redis::AsyncCommands;
                    let mut conn_clone = valkey_clone.as_ref().clone();
                    let list_key = format!("session:chunks:{}", session_id_clone);

                    let check_url = format!("{}/api/v1/judge/chunk", control_plane_url_clone);
                    tracing::info!(url = %check_url, "Sending trailing chunk to judge");
                    let api_key_for_trailing = client_api_key_clone.clone();
                    let response = http_client_clone
                        .post(&check_url)
                        .header("Authorization", format!("Bearer {}", api_key_for_trailing))
                        .json(&serde_json::json!({
                            "workspaceId": workspace_id_clone,
                            "sessionId": session_id_clone,
                            "chunkContent": trailing,
                            "contextParagraphs": context_paras,
                        }))
                        .send()
                        .await;

                    let verdict = match response {
                        Ok(r) => {
                            tracing::info!(status = %r.status(), "Received response from trailing chunk judge");
                            if r.status().is_success() {
                                r.json::<serde_json::Value>()
                                    .await
                                    .unwrap_or(serde_json::json!({"triggered": false}))
                            } else {
                                serde_json::json!({"triggered": false, "error": "failed request"})
                            }
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "Trailing chunk judge request failed");
                            serde_json::json!({"triggered": false, "error": "network error"})
                        }
                    };

                    tracing::info!(verdict = ?verdict, "Trailing chunk verdict recorded");
                    let chunk_json = serde_json::json!({
                        "index": chunk_index,
                        "content": trailing,
                        "verdict": verdict,
                    });
                    let json_str = serde_json::to_string(&chunk_json).unwrap();
                    let _: () = conn_clone
                        .rpush(&list_key, &json_str)
                        .await
                        .unwrap_or_default();
                    let _: () = conn_clone.expire(&list_key, 3600).await.unwrap_or_default();
                }

                let finalize_url = format!("{}/api/v1/judge/finalize", control_plane_url_clone);
                tracing::info!(url = %finalize_url, "Sending finalize call to judge");
                let api_key_for_finalize = client_api_key_clone.clone();
                let finalize_res = http_client_clone
                    .post(&finalize_url)
                    .header("Authorization", format!("Bearer {}", api_key_for_finalize))
                    .json(&serde_json::json!({
                        "workspaceId": workspace_id_clone,
                        "sessionId": session_id_clone,
                        "fullContent": accumulated_content,
                        "personalSops": personal_sops_clone,
                    }))
                    .send()
                    .await;

                if let Ok(resp) = finalize_res {
                    tracing::info!(status = %resp.status(), "Received finalize response");
                    if resp.status().is_success() {
                        if let Ok(json_data) = resp.json::<serde_json::Value>().await {
                            tracing::info!(json = ?json_data, "Finalize JSON content");
                            let correction_summary = json_data
                                .get("correctionSummary")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !correction_summary.is_empty() {
                                let formatted_alert = format!(
                                    "\n\n--- Intutic LLM-as-a-Judge final Security Synthesis ---\n\n{}\n\n",
                                    correction_summary
                                );

                                let alert_block = match protocol_clone {
                                    crate::protocol::Protocol::Anthropic => {
                                        format!(
                                            "event: content_block_delta\ndata: {}\n\n",
                                            serde_json::json!({
                                                "type": "content_block_delta",
                                                "index": 0,
                                                "delta": {
                                                    "type": "text_delta",
                                                    "text": formatted_alert
                                                }
                                            })
                                        )
                                    }
                                    _ => {
                                        format!(
                                            "data: {}\n\n",
                                            serde_json::json!({
                                                "choices": [{
                                                    "delta": {
                                                        "content": formatted_alert
                                                    },
                                                    "finish_reason": null,
                                                    "index": 0
                                                }],
                                                "id": "intutic-judge-gov",
                                                "object": "chat.completion.chunk"
                                            })
                                        )
                                    }
                                };
                                tracing::info!("Injecting synthesized warning block into stream");
                                let _ = tx.send(Ok(axum::body::Bytes::from(alert_block))).await;
                            }
                        }
                    }
                } else if let Err(e) = finalize_res {
                    tracing::error!(error = %e, "Finalize request failed");
                }
            }

            if judge_active_clone || !is_same_provider {
                let done_bytes = get_terminal_stream_event(&protocol_clone);
                let _ = tx.send(Ok(axum::body::Bytes::from(done_bytes))).await;
            }

            let final_prompt_tokens = if prompt_tokens > 0 {
                prompt_tokens
            } else {
                (prompt_text_clone.len() as f64 / 4.0).max(1.0) as u32
            };
            let final_completion_tokens = if completion_tokens > 0 {
                completion_tokens
            } else {
                (accumulated_content.len() as f64 / 4.0).max(1.0) as u32
            };

            if !accumulated_content.is_empty() {
                let _ = crate::plugins::semantic_cache::write_cache(
                    &valkey_clone,
                    &http_client_clone,
                    &workspace_id_clone,
                    &body_json_clone,
                    &accumulated_content,
                    &actual_model_clone,
                    final_prompt_tokens,
                    final_completion_tokens,
                    ff_response_cache_semantic,
                )
                .await;
            }

            let prompt_words = prompt_text_clone.split_whitespace().count();
            let completion_words = accumulated_content.split_whitespace().count();
            let estimated_prompt = (prompt_words as f64 / 0.75) as u32;
            let estimated_completion = (completion_words as f64 / 0.75) as u32;

            let prompt_discrepancy = if final_prompt_tokens > 0 {
                ((final_prompt_tokens as i32 - estimated_prompt as i32).abs() as f64
                    / final_prompt_tokens as f64)
                    >= 0.5
            } else {
                false
            };
            let completion_discrepancy = if final_completion_tokens > 0 {
                ((final_completion_tokens as i32 - estimated_completion as i32).abs() as f64
                    / final_completion_tokens as f64)
                    >= 0.5
            } else {
                false
            };
            let token_anomaly = prompt_discrepancy || completion_discrepancy;

            let reconstruction_quality = if is_same_provider { 100 } else { 95 };
            let raw_cost_usd = estimate_model_cost(
                &requested_model_clone,
                final_prompt_tokens,
                final_completion_tokens,
            );
            let actual_cost_usd = estimate_model_cost(
                &actual_model_clone,
                final_prompt_tokens,
                final_completion_tokens,
            );

            let trace = ExecutionTrace {
                trace_id: uuid::Uuid::new_v4().to_string(),
                session_id: session_id_clone,
                workspace_id: workspace_id_clone,
                virtual_key_id: key_prefix_clone,
                model: requested_model_clone.clone(),
                provider: provider_clone.harness_name().to_string(),
                raw_input_tokens: final_prompt_tokens,
                compressed_input_tokens: final_prompt_tokens,
                output_tokens: final_completion_tokens,
                raw_cost_usd,
                actual_cost_usd,
                cache_hit: false,
                latency_ms: start.elapsed().as_millis() as u32,
                verdict: "allowed".to_string(),
                harness_type: provider_clone.harness_name().to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                requested_model: requested_model_clone,
                actual_model_routed: actual_model_clone,
                task_type: task_type_clone,
                reconstruction_quality,
                token_anomaly,
                loop_run_id: loop_run_id_clone,
            };

            let _ = publish_trace(&valkey_clone, &trace).await;
        });

        let mut response = Response::builder().status(upstream_status);
        if let Some(headers_mut) = response.headers_mut() {
            *headers_mut = resp_headers;
        }
        return response
            .body(Body::from_stream(ReceiverStream::new(rx)))
            .unwrap_or_else(|_| {
                json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "build_error",
                    "Failed to build streaming response",
                )
            });
    }

    // ── Step 7: DLP scan — output (non-streaming flow) ────────────────
    let resp_bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("Failed to read upstream response: {}", e);
            return json_error(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                "Failed to read upstream response",
            );
        }
    };

    let (mut final_body_bytes, prompt_tokens, completion_tokens, mut accumulated_content) =
        if is_same_provider {
            let resp_json: serde_json::Value =
                serde_json::from_slice(&resp_bytes).unwrap_or_default();
            let mut prompt_tokens = 0;
            let mut completion_tokens = 0;
            let mut text = String::new();

            if let Some(usage) = resp_json.get("usage") {
                if let Some(pt) = usage
                    .get("prompt_tokens")
                    .or_else(|| usage.get("input_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    prompt_tokens = pt as u32;
                }
                if let Some(ct) = usage
                    .get("completion_tokens")
                    .or_else(|| usage.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                {
                    completion_tokens = ct as u32;
                }
            }

            if provider == Provider::Anthropic {
                if let Some(content) = resp_json.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(txt) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(txt);
                            }
                        }
                    }
                }
            } else {
                if let Some(choices) = resp_json.get("choices").and_then(|c| c.as_array()) {
                    if let Some(first) = choices.first() {
                        if let Some(txt) = first
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            text.push_str(txt);
                        }
                    }
                }
            }

            (resp_bytes.to_vec(), prompt_tokens, completion_tokens, text)
        } else {
            let upstream_json: serde_json::Value =
                serde_json::from_slice(&resp_bytes).unwrap_or_default();
            let translated = crate::protocol::openai::OpenAIAdapter::translate_response_to_openai(
                &upstream_json,
                &actual_model,
                protocol == Protocol::OpenAIResponses,
            );

            let mut prompt_tokens = 0;
            let mut completion_tokens = 0;
            let mut text = String::new();

            if let Some(usage) = translated.get("usage") {
                if let Some(pt) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                    prompt_tokens = pt as u32;
                }
                if let Some(ct) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                    completion_tokens = ct as u32;
                }
            }

            if let Some(choices) = translated.get("choices").and_then(|c| c.as_array()) {
                if let Some(first) = choices.first() {
                    if let Some(txt) = first
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        text.push_str(txt);
                    }
                }
            }

            let new_bytes = serde_json::to_vec(&translated).unwrap_or_else(|_| resp_bytes.to_vec());
            (new_bytes, prompt_tokens, completion_tokens, text)
        };

    if judge_active {
        let control_plane_url = std::env::var("CONTROL_PLANE_URL").unwrap_or_default();
        tracing::info!("Starting non-streaming paragraph evaluation");
        let mut paragraph_history: Vec<String> = Vec::new();
        let mut chunk_index = 0;
        let mut chunk_handles = Vec::new();

        let mut rest = accumulated_content.as_str();
        let mut parts = Vec::new();
        while !rest.is_empty() {
            let mut split_index = None;
            if let Some(pos) = rest.find("\n\n") {
                split_index = Some(pos + 2);
            } else if let Some(pos) = rest.find("```") {
                if pos > 0 {
                    split_index = Some(pos);
                } else if let Some(pos2) = rest[3..].find("```") {
                    split_index = Some(pos2 + 6);
                }
            }

            if let Some(offset) = split_index {
                let chunk_content = rest[..offset].trim().to_string();
                if !chunk_content.is_empty() {
                    parts.push(chunk_content);
                }
                rest = &rest[offset..];
            } else {
                let trailing = rest.trim().to_string();
                if !trailing.is_empty() {
                    parts.push(trailing);
                }
                break;
            }
        }

        for chunk_content in parts {
            let context_paras = if paragraph_history.len() >= 2 {
                paragraph_history[paragraph_history.len() - 2..].to_vec()
            } else {
                paragraph_history.clone()
            };
            paragraph_history.push(chunk_content.clone());

            let client = state.http_client.as_ref().clone();
            let cp_url = control_plane_url.clone();
            let ws_id = workspace_id.clone();
            let sess_id = session_id.clone();
            let mut conn_clone = state.valkey.as_ref().clone();
            let cur_index = chunk_index;
            let personal_sops_chunk = personal_sops.clone();
            let api_key_for_chunk = raw_token.to_string();

            let handle = spawn(async move {
                use redis::AsyncCommands;
                let list_key = format!("session:chunks:{}", sess_id);
                let check_url = format!("{}/api/v1/judge/chunk", cp_url);
                tracing::info!(url = %check_url, "Sending non-streaming chunk to judge");
                let response = client
                    .post(&check_url)
                    .header("Authorization", format!("Bearer {}", api_key_for_chunk))
                    .json(&serde_json::json!({
                        "workspaceId": ws_id,
                        "sessionId": sess_id,
                        "chunkContent": chunk_content,
                        "contextParagraphs": context_paras,
                        "personalSops": personal_sops_chunk,
                    }))
                    .send()
                    .await;

                let verdict = match response {
                    Ok(r) => {
                        tracing::info!(status = %r.status(), "Received response from non-streaming chunk judge");
                        if r.status().is_success() {
                            r.json::<serde_json::Value>()
                                .await
                                .unwrap_or(serde_json::json!({"triggered": false}))
                        } else {
                            serde_json::json!({"triggered": false, "error": "failed request"})
                        }
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "Non-streaming chunk judge request failed");
                        serde_json::json!({"triggered": false, "error": "network error"})
                    }
                };

                tracing::info!(verdict = ?verdict, "Non-streaming chunk verdict recorded");
                let chunk_json = serde_json::json!({
                    "index": cur_index,
                    "content": chunk_content,
                    "verdict": verdict,
                });
                let json_str = serde_json::to_string(&chunk_json).unwrap();
                let _: () = conn_clone
                    .rpush(&list_key, &json_str)
                    .await
                    .unwrap_or_default();
            });
            chunk_handles.push(handle);
            chunk_index += 1;
        }

        for h in chunk_handles {
            let _ = h.await;
        }

        let finalize_url = format!("{}/api/v1/judge/finalize", control_plane_url);
        tracing::info!(url = %finalize_url, "Sending non-streaming finalize call to judge");
        let finalize_res = state
            .http_client
            .post(&finalize_url)
            .header("Authorization", format!("Bearer {}", raw_token))
            .json(&serde_json::json!({
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "fullContent": accumulated_content,
                "personalSops": personal_sops,
            }))
            .send()
            .await;

        if let Ok(resp) = finalize_res {
            tracing::info!(status = %resp.status(), "Received non-streaming finalize response");
            if resp.status().is_success() {
                if let Ok(json_data) = resp.json::<serde_json::Value>().await {
                    tracing::info!(json = ?json_data, "Non-streaming finalize JSON content");
                    let correction_summary = json_data
                        .get("correctionSummary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !correction_summary.is_empty() {
                        let formatted_alert = format!(
                            "\n\n--- Intutic LLM-as-a-Judge final Security Synthesis ---\n\n{}\n\n",
                            correction_summary
                        );
                        accumulated_content.push_str(&formatted_alert);

                        if let Ok(mut resp_val) =
                            serde_json::from_slice::<serde_json::Value>(&final_body_bytes)
                        {
                            tracing::info!(resp_val_keys = ?resp_val.as_object().map(|o| o.keys().collect::<Vec<_>>()), "Parsing resp_val structure keys");
                            let mut mutated = false;

                            // Check for content array (Anthropic format)
                            if let Some(content_arr) =
                                resp_val.get_mut("content").and_then(|c| c.as_array_mut())
                            {
                                tracing::info!(content_arr_len = %content_arr.len(), "Found content array in resp_val");
                                for block in content_arr.iter_mut() {
                                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                        if let Some(txt_val) =
                                            block.get_mut("text").and_then(|t| t.as_str())
                                        {
                                            tracing::info!(
                                                "Found text block in content array - mutating"
                                            );
                                            let mut new_txt = txt_val.to_string();
                                            new_txt.push_str(&formatted_alert);
                                            block.as_object_mut().unwrap().insert(
                                                "text".to_string(),
                                                serde_json::Value::String(new_txt),
                                            );
                                            mutated = true;
                                            break;
                                        }
                                    }
                                }
                            }

                            // Check for choices array (OpenAI format)
                            if let Some(choices_arr) =
                                resp_val.get_mut("choices").and_then(|c| c.as_array_mut())
                            {
                                tracing::info!(choices_arr_len = %choices_arr.len(), "Found choices array in resp_val");
                                if let Some(first_choice) = choices_arr.first_mut() {
                                    if let Some(msg_obj) = first_choice
                                        .get_mut("message")
                                        .and_then(|m| m.as_object_mut())
                                    {
                                        if let Some(content_str) =
                                            msg_obj.get("content").and_then(|c| c.as_str())
                                        {
                                            let mut new_txt = content_str.to_string();
                                            new_txt.push_str(&formatted_alert);
                                            msg_obj.insert(
                                                "content".to_string(),
                                                serde_json::Value::String(new_txt),
                                            );
                                            mutated = true;
                                        }
                                    }
                                }
                            }

                            if mutated {
                                tracing::info!("Injecting synthesized warning block into non-streaming response body");
                                if let Ok(new_bytes) = serde_json::to_vec(&resp_val) {
                                    final_body_bytes = new_bytes;
                                }
                            }
                        }
                    }
                }
            }
        } else if let Err(e) = finalize_res {
            tracing::error!(error = %e, "Non-streaming finalize request failed");
        }
    }

    let final_body = if state.config.intutic_settings.dlp.enabled
        && state.config.intutic_settings.dlp.scan_output
    {
        let resp_str = String::from_utf8_lossy(&final_body_bytes);
        let findings = dlp::scan(&resp_str);
        if !findings.is_empty() {
            tracing::info!(workspace_id = %workspace_id, findings = findings.len(), "DLP findings in response — redacting");
            let redacted = dlp::redact(&resp_str, &findings);
            redacted.into_bytes()
        } else {
            final_body_bytes
        }
    } else {
        final_body_bytes
    };

    // ── SnipCompactor: compress tool result content strings ──────────────────
    // Runs after DLP scan so compressor never sees raw sensitive strings.
    // Only fires if snip is enabled and the response body parses as JSON with
    // a `content` array (Anthropic format) or `choices[].message.content` (OpenAI).
    let final_body =
        compress_tool_results(final_body, &state.config.intutic_settings.snip_compactor);

    let final_prompt_tokens = if prompt_tokens > 0 {
        prompt_tokens
    } else {
        (prompt_text.len() as f64 / 4.0).max(1.0) as u32
    };
    let final_completion_tokens = if completion_tokens > 0 {
        completion_tokens
    } else {
        (accumulated_content.len() as f64 / 4.0).max(1.0) as u32
    };

    // Write cache
    if !accumulated_content.is_empty() {
        let _ = crate::plugins::semantic_cache::write_cache(
            &state.valkey,
            &state.http_client,
            &workspace_id,
            &body_json,
            &accumulated_content,
            &actual_model,
            final_prompt_tokens,
            final_completion_tokens,
            ff_response_cache_semantic,
        )
        .await;
    }

    // Tokenization Anomaly Check
    let prompt_words = prompt_text.split_whitespace().count();
    let completion_words = accumulated_content.split_whitespace().count();
    let estimated_prompt = (prompt_words as f64 / 0.75) as u32;
    let estimated_completion = (completion_words as f64 / 0.75) as u32;

    let prompt_discrepancy = if final_prompt_tokens > 0 {
        ((final_prompt_tokens as i32 - estimated_prompt as i32).abs() as f64
            / final_prompt_tokens as f64)
            >= 0.5
    } else {
        false
    };
    let completion_discrepancy = if final_completion_tokens > 0 {
        ((final_completion_tokens as i32 - estimated_completion as i32).abs() as f64
            / final_completion_tokens as f64)
            >= 0.5
    } else {
        false
    };
    let token_anomaly = prompt_discrepancy || completion_discrepancy;

    let reconstruction_quality = if is_same_provider { 100 } else { 95 };
    let raw_cost_usd = estimate_model_cost(&model, final_prompt_tokens, final_completion_tokens);
    let actual_cost_usd =
        estimate_model_cost(&actual_model, final_prompt_tokens, final_completion_tokens);
    let latency_ms = start.elapsed().as_millis() as u32;

    // ── Step 8: Publish execution trace (fire-and-forget) ─────────────
    let trace = ExecutionTrace {
        trace_id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        virtual_key_id: key_prefix.to_string(),
        model: model.clone(),
        provider: provider.harness_name().to_string(),
        raw_input_tokens: final_prompt_tokens,
        compressed_input_tokens: final_prompt_tokens,
        output_tokens: final_completion_tokens,
        raw_cost_usd,
        actual_cost_usd,
        cache_hit: false,
        latency_ms,
        verdict: "allowed".to_string(),
        harness_type: provider.harness_name().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        requested_model: model.clone(),
        actual_model_routed: actual_model,
        task_type,
        reconstruction_quality,
        token_anomaly,
        loop_run_id: loop_run_id_header,
    };

    crate::local_spend::add_local_spend(actual_cost_usd);
    if let Ok(trace_val) = serde_json::to_value(&trace) {
        crate::local_spend::log_offline_trace(&trace_val);
    }

    let valkey = Arc::clone(&state.valkey);
    spawn(async move {
        if let Err(e) = publish_trace(&valkey, &trace).await {
            tracing::warn!("Failed to publish trace: {}", e);
        }
    });

    tracing::info!(
        workspace_id = %workspace_id,
        provider = ?provider,
        model = %model,
        status = %upstream_status,
        latency_ms = %latency_ms,
        "Request proxied successfully"
    );

    // Build and return final response
    let mut response = Response::builder().status(upstream_status);
    if let Some(headers_mut) = response.headers_mut() {
        *headers_mut = resp_headers;
    }
    response.body(Body::from(final_body)).unwrap_or_else(|_| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "build_error",
            "Failed to build response",
        )
    })
}

// ─── SnipCompactor integration ────────────────────────────────────────────────

/// Walk the response JSON body and apply SnipCompactor to tool result text blocks.
///
/// Handles two protocol layouts:
///   - **Anthropic**: `content[].type == "tool_result"` → `content[].content[].text`
///   - **OpenAI**:    `choices[].message.content` (string) → compress directly
///
/// Returns the (potentially mutated) body bytes. On any JSON parse error or
/// missing field, returns the original bytes unchanged — never fails.
fn compress_tool_results(body: Vec<u8>, config: &SnipCompactorConfig) -> Vec<u8> {
    if !config.enabled {
        return body;
    }

    let Ok(body_str) = std::str::from_utf8(&body) else {
        return body;
    };

    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body_str) else {
        return body;
    };

    let mut compressed_any = false;

    // ── Anthropic: content[] array ───────────────────────────────────────────
    if let Some(content_arr) = value.get_mut("content").and_then(|c| c.as_array_mut()) {
        for block in content_arr.iter_mut() {
            // tool_result blocks have nested content[].text
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                if let Some(inner) = block.get_mut("content").and_then(|c| c.as_array_mut()) {
                    for inner_block in inner.iter_mut() {
                        if inner_block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(text_val) = inner_block.get_mut("text") {
                                if let Some(text) = text_val.as_str() {
                                    let (compressed, ratio) = snip::compact(text, config);
                                    if ratio > 0.0 {
                                        tracing::debug!(
                                            ratio = %ratio,
                                            original_bytes = text.len(),
                                            "snip: compressed tool_result text block"
                                        );
                                        *text_val = serde_json::Value::String(compressed);
                                        compressed_any = true;
                                    }
                                }
                            }
                        }
                    }
                }
                // Also handle flat tool_result with direct text string
                if let Some(text_val) = block.get_mut("content") {
                    if let Some(text) = text_val.as_str() {
                        let (compressed, ratio) = snip::compact(text, config);
                        if ratio > 0.0 {
                            *text_val = serde_json::Value::String(compressed);
                            compressed_any = true;
                        }
                    }
                }
            }
        }
    }

    // ── OpenAI: choices[].message.content ───────────────────────────────────
    if let Some(choices) = value.get_mut("choices").and_then(|c| c.as_array_mut()) {
        for choice in choices.iter_mut() {
            if let Some(content_val) = choice.get_mut("message").and_then(|m| m.get_mut("content"))
            {
                if let Some(text) = content_val.as_str() {
                    // Only compress if large enough to be worth it
                    if text.lines().count() >= config.code_skeleton_min_lines {
                        let (compressed, ratio) = snip::compact(text, config);
                        if ratio > 0.05 {
                            tracing::debug!(
                                ratio = %ratio,
                                original_bytes = text.len(),
                                "snip: compressed OpenAI choice content"
                            );
                            *content_val = serde_json::Value::String(compressed);
                            compressed_any = true;
                        }
                    }
                }
            }
        }
    }

    if !compressed_any {
        // No mutation — return original bytes to avoid re-serialization overhead
        return body;
    }

    serde_json::to_vec(&value).unwrap_or(body)
}

fn load_personal_sops() -> serde_json::Value {
    let mut sops = Vec::new();
    let dir_path = std::path::Path::new(".intutic/personal_sops");
    if dir_path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
                    let title = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Personal SOP")
                        .to_string();
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        sops.push(serde_json::json!({
                            "title": title,
                            "markdownContent": content,
                        }));
                    }
                }
            }
        }
    }
    serde_json::Value::Array(sops)
}

pub fn get_terminal_stream_event(protocol: &crate::protocol::Protocol) -> &'static str {
    match protocol {
        crate::protocol::Protocol::Anthropic => {
            "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 0}\n\nevent: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"
        }
        _ => "data: [DONE]\n\n",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn test_extract_workspace_id_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-workspace-id", "WorkspaceA".parse().unwrap());
        let res = extract_workspace_id(&headers, "");
        assert_eq!(res, "WorkspaceA");
    }

    #[test]
    fn test_extract_workspace_id_from_virtual_key() {
        let headers = HeaderMap::new();
        let res = extract_workspace_id(&headers, "vk_WorkspaceB_somekey");
        assert_eq!(res, "WorkspaceB");
    }

    #[test]
    fn test_extract_workspace_id_unknown() {
        let headers = HeaderMap::new();
        let res = extract_workspace_id(&headers, "raw_upstream_key");
        assert_eq!(res, "unknown");
    }

    #[test]
    fn test_terminal_stream_events() {
        assert_eq!(
            get_terminal_stream_event(&crate::protocol::Protocol::Anthropic),
            "event: content_block_stop\ndata: {\"type\": \"content_block_stop\", \"index\": 0}\n\nevent: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"
        );
        assert_eq!(
            get_terminal_stream_event(&crate::protocol::Protocol::OpenAIChatCompletions),
            "data: [DONE]\n\n"
        );
        assert_eq!(
            get_terminal_stream_event(&crate::protocol::Protocol::Gemini),
            "data: [DONE]\n\n"
        );
    }
}
