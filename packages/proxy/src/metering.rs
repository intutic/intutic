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
    /// Per-key model allowlist — `api_keys.allowed_models` (migration 181),
    /// carried on the control plane's cached auth entry as `allowedModels`
    /// and on `/auth/key-context` under the same name. Empty when the key
    /// set none, which was every key before interview-audit closeout Wave 6
    /// and is still the default.
    ///
    /// Read by `check_model_allowed` and ONLY as a narrowing of the
    /// workspace-level list (`WorkspaceSettings.allowedModels`, read via
    /// `store::ControlPlaneCache::allowed_models`): a model must be on the
    /// workspace list (when that list is non-empty) AND on this list (when
    /// this list is non-empty). An empty list inherits the workspace list
    /// unchanged; a non-empty list can refuse models the workspace approves,
    /// never admit ones it does not. That keeps one authority — the
    /// workspace — and lets a key be scoped below it.
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
/// `store::ControlPlaneCache::allowed_models`) intersected with the key's own
/// list (`VirtualKeyRecord.models`).
///
/// `workspace_allowed` is `None` for "no control plane / no allowlist
/// configured" and `Some(&[])` for "configured but empty" — both mean
/// UNRESTRICTED at the workspace level, mirroring how `egressAllow` treats an
/// absent/empty list. `key_allowed` is empty for a key that set no list of
/// its own (the default), which inherits the workspace verdict unchanged.
///
/// The two are ANDed, so a non-empty key list can only narrow: a model the
/// workspace refuses stays refused whatever the key lists, and a key that
/// lists no model the workspace approves refuses everything rather than
/// falling back to unrestricted. There is no "empty intersection means
/// inherit" — that would let a key widen by listing the wrong models.
pub fn check_model_allowed(
    model: &str,
    workspace_allowed: Option<&[String]>,
    key_allowed: &[String],
) -> Result<(), MeteringError> {
    if let Some(list) = workspace_allowed {
        if !list.is_empty() && !list.iter().any(|m| m == model) {
            return Err(MeteringError::ModelNotAllowed);
        }
    }
    if !key_allowed.is_empty() && !key_allowed.iter().any(|m| m == model) {
        return Err(MeteringError::ModelNotAllowed);
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
        assert!(check_model_allowed("claude-opus-4-1", None, &[]).is_ok());
        assert!(check_model_allowed("gpt-4o", None, &[]).is_ok());

        let empty: Vec<String> = vec![];
        assert!(check_model_allowed("claude-opus-4-1", Some(&empty), &[]).is_ok());
    }

    #[test]
    fn a_model_on_the_list_is_allowed() {
        let allowed = vec!["claude-sonnet-4-5".to_string(), "claude-opus-4-1".to_string()];
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&allowed), &[]).is_ok());
        assert!(check_model_allowed("claude-opus-4-1", Some(&allowed), &[]).is_ok());
    }

    #[test]
    fn a_model_not_on_a_non_empty_list_is_refused() {
        let allowed = vec!["claude-sonnet-4-5".to_string()];
        let err = check_model_allowed("gpt-4o", Some(&allowed), &[])
            .expect_err("a model missing from a non-empty allowlist must be refused");
        assert!(matches!(err, MeteringError::ModelNotAllowed));
    }

    #[test]
    fn matching_is_exact_not_a_prefix() {
        // "claude-sonnet-4" must not match "claude-sonnet-4-5" — a
        // substring/prefix match would silently admit newer point releases
        // an operator never approved.
        let allowed = vec!["claude-sonnet-4".to_string()];
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&allowed), &[]).is_err());
    }

    // ── Per-key list (interview-audit closeout Wave 6) ──────────────────

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// The default for every key: an empty key list changes nothing, whether
    /// the workspace is unrestricted or restricted.
    #[test]
    fn an_empty_key_list_inherits_the_workspace_verdict() {
        let ws = list(&["claude-sonnet-4-5"]);
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&ws), &[]).is_ok());
        assert!(check_model_allowed("gpt-4o", Some(&ws), &[]).is_err());
        assert!(check_model_allowed("gpt-4o", None, &[]).is_ok());
    }

    /// A key list narrows an unrestricted workspace: with no workspace list,
    /// the key list is the whole allowlist.
    #[test]
    fn a_key_list_restricts_an_unrestricted_workspace() {
        let key = list(&["claude-haiku-4-5"]);
        assert!(check_model_allowed("claude-haiku-4-5", None, &key).is_ok());
        assert!(check_model_allowed("claude-opus-4-1", None, &key).is_err());
        let empty: Vec<String> = vec![];
        assert!(check_model_allowed("claude-opus-4-1", Some(&empty), &key).is_err());
    }

    /// The intersection: a model must be on BOTH non-empty lists.
    #[test]
    fn both_lists_non_empty_is_the_intersection() {
        let ws = list(&["claude-sonnet-4-5", "claude-opus-4-1"]);
        let key = list(&["claude-sonnet-4-5", "gpt-4o"]);
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&ws), &key).is_ok());
        // On the workspace list, not the key's.
        assert!(check_model_allowed("claude-opus-4-1", Some(&ws), &key).is_err());
        // On the key's list, not the workspace's.
        assert!(check_model_allowed("gpt-4o", Some(&ws), &key).is_err());
    }

    /// The load-bearing direction: a key can never admit a model its
    /// workspace refuses. This is the whole reason the field was left unread
    /// until it could be read this way.
    #[test]
    fn a_key_list_can_never_widen_the_workspace_list() {
        let ws = list(&["claude-sonnet-4-5"]);
        let key = list(&["gpt-4o"]);
        let err = check_model_allowed("gpt-4o", Some(&ws), &key)
            .expect_err("a key listing a model the workspace refuses must not admit it");
        assert!(matches!(err, MeteringError::ModelNotAllowed));
        // And the disjoint case refuses everything rather than falling back
        // to unrestricted — an empty intersection is not an absent list.
        assert!(check_model_allowed("claude-sonnet-4-5", Some(&ws), &key).is_err());
    }
}
