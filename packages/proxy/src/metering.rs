//! Virtual key validation and budget enforcement.
//!
//! Reads LiteLLM's LiteLLMVerificationToken table via Valkey cache,
//! with PostgreSQL fallback on cache miss.
//!
//! WS5: Hard budget cap enforcement (LLD #20 §4.4)
//! Key: `v2:budget:hard_block:{workspace_id}` (String '1')
//! Set by: Node.js billingCron.ts → enforceOverageCap() → EXPIREAT midnight UTC
//! Cleared by: EXPIREAT rolling daily reset (no explicit clear needed)

use redis::AsyncCommands;
use serde::Deserialize;
use std::sync::Arc;

/// Virtual key record from LiteLLM DB
#[derive(Debug, Deserialize, Clone)]
pub struct VirtualKeyRecord {
    pub token: String,
    pub key_name: Option<String>,
    pub team_id: Option<String>,
    pub user_id: Option<String>,
    pub max_budget: Option<f64>,
    pub spend: f64,
    pub models: Vec<String>,
    pub expires: Option<String>,
}

/// Validate a virtual key against Valkey cache
pub async fn validate_virtual_key(
    token: &str,
    valkey: &Arc<redis::aio::ConnectionManager>,
) -> Result<VirtualKeyRecord, MeteringError> {
    if token.is_empty() {
        return Err(MeteringError::KeyNotFound);
    }

    let key_prefix = if token.len() > 12 {
        &token[..12]
    } else {
        token
    };

    let cache_key = format!("v2:auth:apikey:{}", key_prefix);
    let mut conn = (**valkey).clone();

    // 1. Query Valkey for the AuthContext JSON string
    let cache_val: Option<String> = conn
        .get(&cache_key)
        .await
        .map_err(|e| MeteringError::ValkeyCommunicationError(e.to_string()))?;

    let auth_str = match cache_val {
        Some(s) => s,
        None => {
            return Err(MeteringError::KeyNotFound);
        }
    };

    // 2. Parse the JSON to get workspace_id and member_id
    let auth_json: serde_json::Value = serde_json::from_str(&auth_str)
        .map_err(|e| MeteringError::ValkeyCommunicationError(e.to_string()))?;

    let workspace_id = auth_json
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| MeteringError::ValkeyCommunicationError("Missing workspaceId in AuthContext".to_string()))?;

    let member_id = auth_json
        .get("memberId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    // 3. Fetch current spend and limit from Valkey (or use defaults)
    let spend_key = format!("v2:budget:daily:{}", workspace_id);
    let limit_key = format!("v2:budget:limit:daily:{}", workspace_id);

    let spend_val: Option<String> = conn.get(&spend_key).await.unwrap_or(None);
    let limit_val: Option<String> = conn.get(&limit_key).await.unwrap_or(None);

    let spend: f64 = spend_val
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let max_budget: Option<f64> = limit_val
        .and_then(|s| s.parse::<f64>().ok())
        .or(Some(100.0)); // fallback to 100.0 if not configured

    Ok(VirtualKeyRecord {
        token: token.to_string(),
        key_name: Some(format!("key_{}", key_prefix)),
        team_id: Some(workspace_id.to_string()),
        user_id: Some(member_id.to_string()),
        max_budget,
        spend,
        models: vec!["*".to_string()],
        expires: None,
    })
}

/// Check if the estimated cost fits within the remaining budget (with 20% safety margin)
pub fn check_budget(key: &VirtualKeyRecord, estimated_cost: f64) -> Result<(), MeteringError> {
    if let Some(max_budget) = key.max_budget {
        let remaining = max_budget - key.spend;
        let safety_cost = estimated_cost * 1.20;
        if safety_cost > remaining {
            return Err(MeteringError::BudgetExceeded {
                remaining,
                estimated: estimated_cost,
            });
        }
    }
    Ok(())
}

/// Check if this workspace is under a hard spend cap block.
///
/// Reads `v2:budget:hard_block:{workspace_id}` from Valkey.
/// The key is written by the Node.js `enforceOverageCap()` function when
/// the workspace's daily spend exceeds `daily_spend_cap_usd` with
/// `enforcement_mode=hard`. The key expires at midnight UTC (EXPIREAT).
///
/// This is the hot-path enforcement gate — target <1ms P99 (single Valkey GET).
/// When the key exists, returns `MeteringError::HardCapExceeded` which the
/// proxy translates to HTTP 429 with body `{ "error": "OVERAGE_HARD_CAP_EXCEEDED" }`.
///
/// LLD #20 §4.4
pub async fn check_workspace_hard_block(
    workspace_id: &str,
    valkey: &Arc<redis::aio::ConnectionManager>,
) -> Result<(), MeteringError> {
    let key = format!("v2:budget:hard_block:{}", workspace_id);

    // Clone the inner ConnectionManager to get an owned mutable handle.
    // ConnectionManager implements Clone and AsyncCommands requires &mut self.
    let mut conn = (**valkey).clone();
    let value: Option<String> = conn
        .get(&key)
        .await
        .map_err(|e| MeteringError::ValkeyCommunicationError(e.to_string()))?;

    if value.as_deref() == Some("1") {
        return Err(MeteringError::HardCapExceeded {
            workspace_id: workspace_id.to_string(),
        });
    }

    Ok(())
}

pub async fn check_loop_block(
    loop_run_id: &str,
    valkey: &Arc<redis::aio::ConnectionManager>,
) -> Result<(), MeteringError> {
    let key = format!("intutic:loop:{}", loop_run_id);
    let mut conn = (**valkey).clone();
    let value: Option<String> = conn
        .get(&key)
        .await
        .map_err(|e| MeteringError::ValkeyCommunicationError(e.to_string()))?;

    if let Some(val_str) = value {
        if let Ok(state_json) = serde_json::from_str::<serde_json::Value>(&val_str) {
            if let Some(status) = state_json.get("status").and_then(|v| v.as_str()) {
                if status == "KILLED" || status == "COMPLETED" {
                    return Err(MeteringError::LoopTerminated {
                        loop_run_id: loop_run_id.to_string(),
                        status: status.to_string(),
                    });
                }
            }
        }
    }

    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum MeteringError {
    #[error("Virtual key not found")]
    KeyNotFound,
    #[error("Virtual key expired")]
    KeyExpired,
    #[error("Budget exceeded")]
    BudgetExceeded { remaining: f64, estimated: f64 },
    #[error("Model not allowed for this key")]
    ModelNotAllowed,
    #[error("Not implemented")]
    NotImplemented,
    /// WS5 (LLD #20 §4.4) — workspace hard daily spend cap is active.
    /// Set by billingCron.enforceOverageCap() when spend > daily_spend_cap_usd.
    /// Translates to HTTP 429 OVERAGE_HARD_CAP_EXCEEDED.
    #[error("Workspace {workspace_id} is hard-capped: daily spend limit exceeded")]
    HardCapExceeded { workspace_id: String },
    #[error("Valkey communication error: {0}")]
    ValkeyCommunicationError(String),
    #[error("Loop run {loop_run_id} is terminated: status is {status}")]
    LoopTerminated { loop_run_id: String, status: String },
}
