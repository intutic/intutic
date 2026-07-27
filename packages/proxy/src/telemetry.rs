//! Telemetry — the execution-trace record, and Valkey connection setup.
//!
//! Publishing moved to `store::LocalStore::publish_trace` during the storage
//! port. The Valkey impl publishes to `intutic:traces:{workspace_id}`, where
//! the Node control plane's subscriber batch-inserts into PostgreSQL; the
//! standalone impl has no subscriber and logs instead.

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

