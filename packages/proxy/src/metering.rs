//! Virtual key records and budget arithmetic.
//!
//! The *lookups* — `v2:auth:apikey:*`, `v2:budget:*`, `intutic:loop:*` — moved
//! to `store::ControlPlaneCache` during the storage port, because every one of
//! them is a key the Node control plane writes and the proxy only reads. What
//! stays here is the domain type and the pure budget check, neither of which
//! needs a connection.
//!
//! WS5: Hard budget cap enforcement (LLD #20 §4.4) is now
//! `ControlPlaneCache::hard_block`.

use serde::Deserialize;

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
    /// The org owning the key's workspace (LLD #71). `None` on cached auth
    /// entries written before the control plane carried the field — a
    /// managed cell (INTUTIC_GATEWAY_ORG_ID set) treats `None` as
    /// "unverified", revalidates via the control plane, and fail-closes if
    /// still unknown. Never used for anything on the shared gateway.
    pub org_id: Option<String>,
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
