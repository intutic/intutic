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
    /// Per-key model allowlist from the LiteLLM-shaped auth record. Always
    /// written as `["*"]` by `ValkeyControlPlaneCache::auth_context` — no
    /// writer ever populates it with a real, narrower list — and nothing
    /// reads it. Left unread deliberately rather than wired up: the
    /// workspace-level allowlist (`WorkspaceSettings.allowedModels`, read via
    /// `store::ControlPlaneCache::allowed_models` and enforced in
    /// `proxy.rs` with `check_model_allowed`) is this proxy's one approved-
    /// models control. Reading this field too would mean two allowlists that
    /// can silently disagree, for a source that has never carried real data.
    /// If a genuine per-key override becomes a real requirement, this is
    /// where it would be read — intersected with, not instead of, the
    /// workspace-level list.
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

/// Check whether `model` is permitted by the workspace's approved-models
/// allowlist (`WorkspaceSettings.allowedModels`, read from
/// `store::ControlPlaneCache::allowed_models`).
///
/// `allowed` is `None` for "no control plane / no allowlist configured" and
/// `Some(&[])` for "configured but empty" — both mean UNRESTRICTED, mirroring
/// how `egressAllow` treats an absent/empty list. Only a non-empty `Some`
/// that does not contain `model` refuses. This is `VirtualKeyRecord.models`'
/// natural counterpart at the workspace level, not the key level — see the
/// comment on that field for why the key-level list stays unread.
pub fn check_model_allowed(model: &str, allowed: Option<&[String]>) -> Result<(), MeteringError> {
    if let Some(list) = allowed {
        if !list.is_empty() && !list.iter().any(|m| m == model) {
            return Err(MeteringError::ModelNotAllowed);
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

#[cfg(test)]
mod check_model_allowed_tests {
    use super::*;

    /// The load-bearing invariant: a workspace that never configured (or
    /// explicitly cleared) an allowlist must never start refusing models.
    /// `None` is the control-plane-absent/never-set case;
    /// `Some(&[])` is what `resolveWorkspaceSettings` merges an empty stored
    /// array into — both must allow every model.
    #[test]
    fn absent_or_empty_list_allows_any_model() {
        assert!(check_model_allowed("claude-opus-4-1", None).is_ok());
        assert!(check_model_allowed("gpt-4o", None).is_ok());

        let empty: Vec<String> = vec![];
        assert!(check_model_allowed("claude-opus-4-1", Some(&empty)).is_ok());
    }

    #[test]
    fn a_model_on_the_list_is_allowed() {
        let allowed = vec!["claude-sonnet-4-5".to_string(), "claude-opus-4-1".to_string()];
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&allowed)).is_ok());
        assert!(check_model_allowed("claude-opus-4-1", Some(&allowed)).is_ok());
    }

    #[test]
    fn a_model_not_on_a_non_empty_list_is_refused() {
        let allowed = vec!["claude-sonnet-4-5".to_string()];
        let err = check_model_allowed("gpt-4o", Some(&allowed))
            .expect_err("a model missing from a non-empty allowlist must be refused");
        assert!(matches!(err, MeteringError::ModelNotAllowed));
    }

    #[test]
    fn matching_is_exact_not_a_prefix() {
        // "claude-sonnet-4" must not match "claude-sonnet-4-5" — a
        // substring/prefix match would silently admit newer point releases
        // an operator never approved.
        let allowed = vec!["claude-sonnet-4".to_string()];
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&allowed)).is_err());
    }
}
