//! Local Deterministic Reward Loop — open-core bandit arm learning.
//!
//! Updates Thompson-sampling arm state (the `bandit:{ws}` hash) from signals
//! the proxy already observes: upstream success, latency vs SLO, token
//! anomaly, and routed-vs-requested cost ratio. No LLM judge involved.
//!
//! ## Ownership
//! Arm learning has exactly one writer per workspace, tracked in the Valkey
//! key `bandit:reward_mode:{ws}`:
//! - `"local"` — this proxy owns the update loop (standalone open-core).
//! - `"cloud"` — the control-plane reward cron / LLMProbe owns it; the local
//!   loop stands down entirely.
//!
//! The first local update claims ownership with `SET NX`. A control plane
//! taking over a workspace overwrites the marker with `"cloud"`, which
//! demotes the local writer within one mode-cache TTL (60 s).
//!
//! ## Continuity
//! The update rule is byte-for-byte the enterprise reward cron's
//! (LLD #26 §4.3): `scale = max(1/log2(pulls+2), 0.1)`, `alpha += r*scale`,
//! `beta += (1-r)*scale`, `pulls += 1` — so arm state carries over without
//! distortion when a workspace upgrades to cloud-managed learning.

use crate::config::RewardConfig;
use crate::store::{ClaimOutcome, LocalStore, Ownership};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Signals available at trace-emission time, from which the reward is derived.
#[derive(Debug, Clone, Copy)]
pub struct RewardSignals {
    /// Transport success and a non-5xx upstream status.
    pub upstream_ok: bool,
    /// End-to-end latency (includes full stream duration for streaming).
    pub latency_ms: u32,
    /// Token-count anomaly detected between reported and estimated usage.
    pub token_anomaly: bool,
    /// Estimated cost had the *requested* model served the response.
    pub raw_cost_usd: f64,
    /// Estimated cost of the *routed* model's response.
    pub actual_cost_usd: f64,
    /// Response Integrity Score, 0–100. 100 means clean OR not measured.
    ///
    /// The only signal here that says anything about the *answer*. Everything
    /// above describes delivery: whether the call succeeded, how long it took,
    /// and whether the metering added up. Without this a cheap model returning
    /// a confidently wrong answer, quickly, scored a perfect reward.
    ///
    /// It detects malformed, truncated and unusable responses — **not**
    /// wrong-but-well-formed ones, which is most of the real harm from
    /// downgrading. The reward is guarded against unusable answers, not worse
    /// ones.
    pub response_integrity: u8,
}

/// A clean, equal-cost response's score.
///
/// Deliberately below 1.0 so the two-sided cost term has room to move upward.
/// At 1.0 the clamp eats every cheapness bonus and the term is a silent no-op
/// for the exact case it exists to reward.
pub const NO_FAULT_BASELINE: f64 = 0.8;

/// How much a fully-faulted response loses.
///
/// Larger than `cost_penalty` (0.2) on purpose: no price advantage may buy back
/// a response the agent cannot use.
pub const QUALITY_WEIGHT: f64 = 0.5;

/// Deterministic reward in `[0, 1]`. Upstream failure is always 0.
pub fn compute_reward(s: &RewardSignals, cfg: &RewardConfig) -> f64 {
    if !s.upstream_ok {
        return 0.0;
    }
    // The no-fault baseline, NOT 1.0.
    //
    // This is what makes the cost term below do anything. `r` starting at 1.0
    // and clamping at 1.0 means a clean cheap response's bonus is entirely
    // eaten by the clamp — the change would look shipped and be a no-op for
    // exactly the case it targets. At 0.8: equal-cost clean scores 0.8, cheap
    // rises toward 1.0, costly falls toward 0.6.
    let mut r = NO_FAULT_BASELINE;

    if s.latency_ms > cfg.latency_slo_ms && cfg.latency_slo_ms > 0 {
        let over = s.latency_ms as f64 / cfg.latency_slo_ms as f64 - 1.0;
        r -= cfg.latency_penalty * over.min(1.0);
    }
    if s.token_anomaly {
        r -= cfg.token_anomaly_penalty;
    }

    // Quality, scaled to the same range as the other penalties. A response the
    // integrity check faulted loses more than any price advantage can return —
    // see `quality_fault_outweighs_any_price_advantage`.
    let integrity = (s.response_integrity as f64 / 100.0).clamp(0.0, 1.0);
    r -= QUALITY_WEIGHT * (1.0 - integrity);

    if s.raw_cost_usd > 0.0 {
        // TWO-SIDED. `cheaper_routed_model_earns_no_bonus` asserted the
        // opposite, deliberately, so this is a product reversal rather than a
        // bug fix — and it is only safe now that `response_integrity` exists,
        // because rewarding cheapness without a quality signal is how a router
        // learns to save money by being wrong.
        //
        // The asymmetry is deliberate: +cost_penalty needs ratio→0, while
        // −cost_penalty arrives at ratio=2. Cheap is capped; expensive is
        // punished fast.
        let ratio = s.actual_cost_usd / s.raw_cost_usd;
        let signed = (1.0 - ratio).clamp(-1.0, 1.0);
        r += cfg.cost_penalty * signed;
    }

    r.clamp(0.0, 1.0)
}

/// The arm update rule. Mirrors the Lua script in
/// [`crate::store::valkey`] — which remains the source of truth for the
/// Valkey-backed path — and is what [`crate::store::MemoryStore`] applies
/// directly. Keep both in sync.
pub fn apply_update(alpha: f64, beta: f64, pulls: u32, reward: f64) -> (f64, f64, u32) {
    let scale = (1.0 / ((pulls as f64) + 2.0).log2()).max(0.1);
    (
        alpha + reward * scale,
        beta + (1.0 - reward) * scale,
        pulls + 1,
    )
}

/// Who owns arm updates for a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewardMode {
    Local,
    Cloud,
}

const MODE_CACHE_TTL: Duration = Duration::from_secs(60);
/// Soft bound on the in-process mode cache; stale entries are evicted when
/// the map fills (workspace ids are attacker-influencable header values).
const MODE_CACHE_MAX: usize = 1024;
/// TTL on the `"local"` ownership marker — refreshed on every cache refresh,
/// so it only expires when no local proxy has run rewards for a day.
const MARKER_TTL_SECS: u64 = 86_400;

/// Fire-and-forget writer for local bandit rewards. One instance per proxy,
/// held in `AppState`; all methods are called off the request latency path.
pub struct RewardEngine {
    mode_cache: RwLock<HashMap<String, (Instant, RewardMode)>>,
}

impl From<Ownership> for RewardMode {
    fn from(o: Ownership) -> Self {
        match o {
            Ownership::Local => RewardMode::Local,
            Ownership::Cloud => RewardMode::Cloud,
        }
    }
}

impl Default for RewardEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RewardEngine {
    pub fn new() -> Self {
        Self {
            mode_cache: RwLock::new(HashMap::new()),
        }
    }

    /// Record one routed request's outcome against its bandit arm.
    /// Silent on Valkey errors — learning loss is preferable to noise on a
    /// path that runs for every request.
    // Seven parameters plus &self. The routing keys and the signals payload are
    // already grouped as far as they usefully can be; splitting further would
    // separate values that are always supplied together.
    #[allow(clippy::too_many_arguments)]
    pub async fn record(
        &self,
        store: &Arc<dyn LocalStore>,
        workspace_id: &str,
        routed_model: &str,
        sop_tier: &str,
        task_type: &str,
        signals: RewardSignals,
        cfg: &RewardConfig,
    ) {
        if self.resolve_mode(store.as_ref(), workspace_id).await == RewardMode::Cloud {
            return;
        }

        let reward = compute_reward(&signals, cfg);
        let arm_key = format!("arm:{}:{}:{}", routed_model, sop_tier, task_type);
        let now = chrono::Utc::now().to_rfc3339();

        let res = store
            .update_arm(workspace_id, &arm_key, reward, &now)
            .await;

        match res {
            Ok(_) => {
                tracing::debug!(
                    workspace_id = %workspace_id,
                    arm = %arm_key,
                    reward = %reward,
                    "local bandit reward applied"
                );
            }
            Err(e) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    arm = %arm_key,
                    error = %e,
                    "local bandit reward update failed"
                );
            }
        }
    }

    /// Non-blocking view of the cached ownership mode (fresh entries only).
    /// The request path uses this to skip cloud-oriented outage counters when
    /// this proxy owns arm learning locally.
    pub fn cached_mode(&self, workspace_id: &str) -> Option<RewardMode> {
        let cache = self.mode_cache.read().ok()?;
        let (at, mode) = cache.get(workspace_id)?;
        (at.elapsed() < MODE_CACHE_TTL).then_some(*mode)
    }

    fn store_mode(&self, workspace_id: &str, mode: RewardMode) {
        if let Ok(mut cache) = self.mode_cache.write() {
            if cache.len() >= MODE_CACHE_MAX && !cache.contains_key(workspace_id) {
                cache.retain(|_, (at, _)| at.elapsed() < MODE_CACHE_TTL);
            }
            cache.insert(workspace_id.to_string(), (Instant::now(), mode));
        }
    }

    /// Local-mode housekeeping, run once per cache refresh (≤ every 60 s):
    /// keep the ownership marker alive and drain the outage-failure counter
    /// the request path may still write. That counter is a cloud-cron input;
    /// in local mode the reward loop already learns the same failures as
    /// 0-rewards, so leaving a backlog would double-penalize the arms if a
    /// control plane later takes over.
    async fn refresh_local_ownership(&self, store: &dyn LocalStore, workspace_id: &str) {
        let _ = store.refresh_ownership(workspace_id, MARKER_TTL_SECS).await;
        let _ = store.clear_outage_failures(workspace_id).await;
    }

    /// Resolve arm-update ownership for a workspace, claiming `"local"` via
    /// `SET NX` when unset. Results are cached in-process for 60 s so a
    /// control-plane takeover (`"cloud"`) demotes this writer within one TTL.
    ///
    /// Fail-safe: when the marker cannot be read or claimed (Valkey error),
    /// this stands down (`Cloud`) WITHOUT caching the result, so a transient
    /// outage can never elect a second writer on a cloud-owned workspace.
    async fn resolve_mode(&self, store: &dyn LocalStore, workspace_id: &str) -> RewardMode {
        if let Some(mode) = self.cached_mode(workspace_id) {
            return mode;
        }

        let current = match store.reward_mode(workspace_id).await {
            Ok(v) => v,
            Err(_) => return RewardMode::Cloud, // uncached — re-resolve next request
        };
        let mode = match current {
            Some(Ownership::Cloud) => RewardMode::Cloud,
            Some(Ownership::Local) => {
                self.refresh_local_ownership(store, workspace_id).await;
                RewardMode::Local
            }
            None => match store.claim_local_ownership(workspace_id, MARKER_TTL_SECS).await {
                Ok(ClaimOutcome::Claimed) => {
                    // Fresh claim: drop any stale outage backlog so a later
                    // cloud takeover cannot double-count failures the local
                    // loop learns as 0-rewards from here on.
                    let _ = store.clear_outage_failures(workspace_id).await;
                    RewardMode::Local
                }
                Ok(ClaimOutcome::Lost) => {
                    // Lost the race — a control plane may have claimed "cloud".
                    match store.reward_mode(workspace_id).await {
                        Ok(Some(o)) => o.into(),
                        Ok(None) => RewardMode::Local,
                        Err(_) => return RewardMode::Cloud, // uncached
                    }
                }
                Err(_) => return RewardMode::Cloud, // uncached
            },
        };

        self.store_mode(workspace_id, mode);
        mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_cfg() -> RewardConfig {
        RewardConfig::default()
    }

    fn ok_signals() -> RewardSignals {
        RewardSignals {
            upstream_ok: true,
            latency_ms: 1_000,
            token_anomaly: false,
            raw_cost_usd: 0.01,
            actual_cost_usd: 0.01,
            response_integrity: crate::routing::integrity::RIS_MAX,
        }
    }

    #[test]
    fn failure_is_zero_regardless_of_other_signals() {
        let cfg = default_cfg();
        let s = RewardSignals {
            upstream_ok: false,
            latency_ms: 1,
            token_anomaly: false,
            raw_cost_usd: 0.01,
            actual_cost_usd: 0.001,
            response_integrity: crate::routing::integrity::RIS_MAX,
        };
        assert_eq!(compute_reward(&s, &cfg), 0.0);
    }

    /// A clean, equal-cost response scores the no-fault baseline, not 1.0.
    ///
    /// The rebase is the load-bearing part of the two-sided cost term. At a 1.0
    /// baseline the clamp eats every cheapness bonus, so the term would be a
    /// silent no-op for exactly the case it exists to reward — shipped-looking
    /// and inert.
    #[test]
    fn clean_success_is_the_no_fault_baseline() {
        let r = compute_reward(&ok_signals(), &default_cfg());
        assert!(
            (r - NO_FAULT_BASELINE).abs() < 1e-9,
            "expected the {NO_FAULT_BASELINE} baseline, got {r}"
        );
        assert!(r < 1.0, "a 1.0 baseline leaves no headroom for a cheapness bonus");
    }

    #[test]
    fn latency_at_slo_is_not_penalised() {
        let cfg = default_cfg();
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms,
            ..ok_signals()
        };
        assert_eq!(compute_reward(&s, &cfg), NO_FAULT_BASELINE);
    }

    #[test]
    fn latency_overrun_penalty_is_proportional_and_capped() {
        let cfg = default_cfg();
        // 2× SLO → full latency penalty (over = 1.0).
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms * 2,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - 0.3)).abs() < 1e-9);
        // 10× SLO → still capped at the full penalty.
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms * 10,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - 0.3)).abs() < 1e-9);
        // 1.5× SLO → half the penalty.
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms + cfg.latency_slo_ms / 2,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - 0.15)).abs() < 1e-9);
    }

    #[test]
    fn token_anomaly_deducts_fixed_penalty() {
        let cfg = default_cfg();
        let s = RewardSignals {
            token_anomaly: true,
            ..ok_signals()
        };
        // Penalties are relative to the baseline now, not to 1.0.
        assert!(
            (compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - cfg.token_anomaly_penalty)).abs()
                < 1e-9
        );
    }

    #[test]
    /// **A deliberate product reversal.**
    ///
    /// This test asserted the opposite — that a cheaper route earns nothing —
    /// as a specification, not an oversight. Rewriting an asserted spec is only
    /// legitimate if the replacement states the new invariant as explicitly as
    /// the old one did, so: a cheaper route now earns MORE than an equal-cost
    /// one, and it is safe to reward that only because `response_integrity`
    /// exists. Rewarding cheapness without a quality signal is how a router
    /// learns to save money by being wrong.
    fn cheaper_routed_model_earns_a_bonus() {
        let cfg = default_cfg();
        let cheap = RewardSignals {
            raw_cost_usd: 0.02,
            actual_cost_usd: 0.001,
            ..ok_signals()
        };
        let equal = ok_signals();
        let r_cheap = compute_reward(&cheap, &cfg);
        let r_equal = compute_reward(&equal, &cfg);
        assert!(
            r_cheap > r_equal,
            "a 20x cheaper clean route scored {r_cheap}, no better than {r_equal}"
        );
        assert!(r_cheap <= 1.0);
    }

    #[test]
    fn costlier_routed_model_is_penalised_and_capped() {
        let cfg = default_cfg();
        // 2× cost → full cost penalty.
        let s = RewardSignals {
            raw_cost_usd: 0.01,
            actual_cost_usd: 0.02,
            response_integrity: crate::routing::integrity::RIS_MAX,
            ..ok_signals()
        };
        // Baseline minus the full cost penalty. The asymmetry is deliberate:
        // −cost_penalty arrives at ratio 2, while +cost_penalty needs ratio→0.
        // Cheap is capped; expensive is punished fast.
        assert!(
            (compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - cfg.cost_penalty)).abs() < 1e-9
        );
        // 100× cost → still capped.
        let s = RewardSignals {
            raw_cost_usd: 0.01,
            actual_cost_usd: 1.0,
            response_integrity: crate::routing::integrity::RIS_MAX,
            ..ok_signals()
        };
        assert!(
            (compute_reward(&s, &cfg) - (NO_FAULT_BASELINE - cfg.cost_penalty)).abs() < 1e-9
        );
    }

    #[test]
    fn zero_raw_cost_skips_cost_term() {
        let cfg = default_cfg();
        let s = RewardSignals {
            raw_cost_usd: 0.0,
            actual_cost_usd: 0.5,
            response_integrity: crate::routing::integrity::RIS_MAX,
            ..ok_signals()
        };
        // No requested-model cost to compare against, so no cost term either
        // way — neither bonus nor penalty. The baseline stands.
        assert_eq!(compute_reward(&s, &cfg), NO_FAULT_BASELINE);
    }

    /// The invariant that makes the two-sided cost term safe to ship.
    ///
    /// Without it, C3 is a router that learns to buy cheap failures: a
    /// 20×-cheaper model that returns something the agent cannot use would earn
    /// the full cheapness bonus, and the bandit would converge on it.
    #[test]
    fn quality_fault_outweighs_any_price_advantage() {
        let cfg = default_cfg();
        let cheap_and_broken = RewardSignals {
            raw_cost_usd: 0.02,
            actual_cost_usd: 0.001,
            response_integrity: 0,
            ..ok_signals()
        };
        let clean_equal_cost = ok_signals();
        let broken = compute_reward(&cheap_and_broken, &cfg);
        let clean = compute_reward(&clean_equal_cost, &cfg);
        assert!(
            broken < clean,
            "a 20x cheaper UNUSABLE response scored {broken}, at or above a clean \
             equal-cost one at {clean} — the router would learn to buy failures"
        );
    }

    /// A partial fault still costs more than it can earn back.
    #[test]
    fn a_partial_fault_is_not_bought_back_by_price() {
        let cfg = default_cfg();
        // 40/100: one truncation. Cheap enough to earn nearly the full bonus.
        let s = RewardSignals {
            raw_cost_usd: 0.02,
            actual_cost_usd: 0.0001,
            response_integrity: 40,
            ..ok_signals()
        };
        assert!(compute_reward(&s, &cfg) < compute_reward(&ok_signals(), &cfg));
    }

    /// Not measured must not read as broken.
    ///
    /// A proxy too old to send the score sends nothing, and the ingest defaults
    /// it to 100. Treating an absent score as 0 would drag every arm in every
    /// such workspace to the floor.
    #[test]
    fn an_unmeasured_response_is_not_penalised() {
        let cfg = default_cfg();
        let s = RewardSignals {
            response_integrity: crate::routing::integrity::RIS_MAX,
            ..ok_signals()
        };
        assert_eq!(compute_reward(&s, &cfg), NO_FAULT_BASELINE);
    }

    #[test]
    fn stacked_penalties_clamp_at_zero() {
        let mut cfg = default_cfg();
        cfg.latency_penalty = 0.5;
        cfg.token_anomaly_penalty = 0.5;
        cfg.cost_penalty = 0.5;
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms * 3,
            token_anomaly: true,
            raw_cost_usd: 0.01,
            actual_cost_usd: 0.05,
            response_integrity: crate::routing::integrity::RIS_MAX,
            upstream_ok: true,
        };
        assert_eq!(compute_reward(&s, &cfg), 0.0);
    }

    #[test]
    fn update_rule_matches_enterprise_cron() {
        // pulls = 0 → scale = 1/log2(2) = 1.0
        let (a, b, p) = apply_update(1.0, 1.0, 0, 0.75);
        assert!((a - 1.75).abs() < 1e-9);
        assert!((b - 1.25).abs() < 1e-9);
        assert_eq!(p, 1);

        // pulls = 14 → scale = 1/log2(16) = 0.25
        let (a, b, p) = apply_update(2.0, 3.0, 14, 1.0);
        assert!((a - 2.25).abs() < 1e-9);
        assert!((b - 3.0).abs() < 1e-9);
        assert_eq!(p, 15);
    }

    #[test]
    fn update_scale_floors_at_point_one() {
        // pulls = 2^20 → 1/log2(~2^20) ≈ 0.05 → floored to 0.1.
        let (a, b, _) = apply_update(1.0, 1.0, 1 << 20, 1.0);
        assert!((a - 1.1).abs() < 1e-9);
        assert!((b - 1.0).abs() < 1e-9);
    }

    #[test]
    fn arm_state_tolerates_extra_fields() {
        // Enterprise writers may add fields; deserialization must not break.
        let json = r#"{"alpha":2.5,"beta":1.5,"pulls":7,"lastUpdated":"2026-01-01T00:00:00Z","rewardSource":"cron"}"#;
        let arm: crate::routing::bandit::BanditArmState = serde_json::from_str(json).unwrap();
        assert!((arm.alpha - 2.5).abs() < 1e-9);
        assert_eq!(arm.pulls, 7);
    }
}