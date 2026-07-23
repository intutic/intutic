//! Telemetry — async Valkey pub/sub for execution traces.
//!
//! Traces are published to Valkey channel `intutic:traces:{workspace_id}`.
//! Node.js control plane subscribes and batch-inserts to PostgreSQL.

use serde::Serialize;
use std::sync::Arc;

/// Connect to Valkey (Redis-compatible)
pub async fn connect_valkey(url: &str) -> anyhow::Result<Arc<redis::aio::ConnectionManager>> {
    let client = redis::Client::open(url)?;
    let manager = redis::aio::ConnectionManager::new(client).await?;
    Ok(Arc::new(manager))
}

/// Execution trace published after each proxied request
#[derive(Debug, Serialize)]
pub struct ExecutionTrace {
    pub trace_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub virtual_key_id: String,
    pub model: String,
    pub provider: String,
    pub raw_input_tokens: u32,
    pub compressed_input_tokens: u32,
    pub output_tokens: u32,
    pub raw_cost_usd: f64,
    pub actual_cost_usd: f64,
    pub cache_hit: bool,
    pub latency_ms: u32,
    pub verdict: String,
    pub harness_type: String,
    pub created_at: String,
    pub requested_model: String,
    pub actual_model_routed: String,
    pub task_type: String,
    pub reconstruction_quality: u8,
    pub token_anomaly: bool,
    pub loop_run_id: Option<String>,
}

/// Publish a trace event to Valkey (fire-and-forget).
///
/// Publishes to channel `intutic:traces:{workspace_id}`. The Node.js
/// control plane's Valkey subscriber batch-inserts these into the
/// `execution_traces` PostgreSQL table on the next flush cycle.
pub async fn publish_trace(
    valkey: &Arc<redis::aio::ConnectionManager>,
    trace: &ExecutionTrace,
) -> anyhow::Result<()> {
    use redis::AsyncCommands;

    let channel = format!("intutic:traces:{}", trace.workspace_id);
    let payload = serde_json::to_string(trace)?;

    let mut conn = valkey.as_ref().clone();
    let _: () = conn.publish(&channel, &payload).await?;

    // Also publish to trace:live:{session_id} if session_id is present and not "unknown"
    if !trace.session_id.is_empty() && trace.session_id != "unknown" {
        let live_channel = format!("trace:live:{}", trace.session_id);
        let live_event = serde_json::json!({
            "sessionId": trace.session_id,
            "workspaceId": trace.workspace_id,
            "toolName": trace.task_type,
            "model": trace.model,
            "inputTokens": trace.raw_input_tokens,
            "outputTokens": trace.output_tokens,
            "status": if trace.verdict == "allowed" { "success" } else { "error" },
            "timestamp": trace.created_at,
        });
        if let Ok(live_payload) = serde_json::to_string(&live_event) {
            let _: Result<(), _> = conn.publish(&live_channel, &live_payload).await;
        }
    }

    tracing::debug!(trace_id = %trace.trace_id, channel = %channel, "Execution trace published to Valkey");
    Ok(())
}
