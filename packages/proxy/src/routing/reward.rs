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
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
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
}

/// Deterministic reward in `[0, 1]`. Upstream failure is always 0.
pub fn compute_reward(s: &RewardSignals, cfg: &RewardConfig) -> f64 {
    if !s.upstream_ok {
        return 0.0;
    }
    let mut r = 1.0;
    if s.latency_ms > cfg.latency_slo_ms && cfg.latency_slo_ms > 0 {
        let over = s.latency_ms as f64 / cfg.latency_slo_ms as f64 - 1.0;
        r -= cfg.latency_penalty * over.min(1.0);
    }
    if s.token_anomaly {
        r -= cfg.token_anomaly_penalty;
    }
    if s.raw_cost_usd > 0.0 {
        // ratio > 1 means the bandit routed to a costlier model than requested.
        let ratio = s.actual_cost_usd / s.raw_cost_usd;
        r -= cfg.cost_penalty * (ratio - 1.0).clamp(0.0, 1.0);
    }
    r.clamp(0.0, 1.0)
}

/// Pure mirror of [`ARM_UPDATE_SCRIPT`] for unit tests and documentation.
/// The Lua script is the runtime source of truth; keep both in sync.
pub fn apply_update(alpha: f64, beta: f64, pulls: u32, reward: f64) -> (f64, f64, u32) {
    let scale = (1.0 / ((pulls as f64) + 2.0).log2()).max(0.1);
    (
        alpha + reward * scale,
        beta + (1.0 - reward) * scale,
        pulls + 1,
    )
}

/// Atomic read-modify-write of one arm inside `bandit:{ws}`.
///
/// KEYS[1] = bandit hash key, ARGV[1] = arm field, ARGV[2] = reward,
/// ARGV[3] = RFC3339 timestamp. A corrupt arm JSON self-heals to a fresh
/// `Beta(1,1)` arm rather than erroring.
const ARM_UPDATE_SCRIPT: &str = r#"
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local arm = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then arm = decoded end
end
local alpha = tonumber(arm.alpha) or 1.0
local beta = tonumber(arm.beta) or 1.0
local pulls = tonumber(arm.pulls) or 0
local scale = 1.0 / (math.log(pulls + 2) / math.log(2))
if scale < 0.1 then scale = 0.1 end
local r = tonumber(ARGV[2])
arm.alpha = alpha + r * scale
arm.beta = beta + (1.0 - r) * scale
arm.pulls = pulls + 1
arm.lastUpdated = ARGV[3]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(arm))
return 1
"#;

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
    update_script: redis::Script,
    mode_cache: RwLock<HashMap<String, (Instant, RewardMode)>>,
}

impl Default for RewardEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RewardEngine {
    pub fn new() -> Self {
        Self {
            update_script: redis::Script::new(ARM_UPDATE_SCRIPT),
            mode_cache: RwLock::new(HashMap::new()),
        }
    }

    /// Record one routed request's outcome against its bandit arm.
    /// Silent on Valkey errors — learning loss is preferable to noise on a
    /// path that runs for every request.
    pub async fn record(
        &self,
        valkey: &Arc<ConnectionManager>,
        workspace_id: &str,
        routed_model: &str,
        sop_tier: &str,
        task_type: &str,
        signals: RewardSignals,
        cfg: &RewardConfig,
    ) {
        let mut conn = valkey.as_ref().clone();
        if self.resolve_mode(&mut conn, workspace_id).await == RewardMode::Cloud {
            return;
        }

        let reward = compute_reward(&signals, cfg);
        let bandit_key = format!("bandit:{}", workspace_id);
        let arm_key = format!("arm:{}:{}:{}", routed_model, sop_tier, task_type);
        let now = chrono::Utc::now().to_rfc3339();

        let res: Result<i64, redis::RedisError> = self
            .update_script
            .key(&bandit_key)
            .arg(&arm_key)
            .arg(reward)
            .arg(&now)
            .invoke_async(&mut conn)
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
    async fn refresh_local_ownership(
        &self,
        conn: &mut ConnectionManager,
        workspace_id: &str,
        marker_key: &str,
    ) {
        let _: Result<(), redis::RedisError> =
            conn.expire(marker_key, MARKER_TTL_SECS as i64).await;
        let _: Result<(), redis::RedisError> = conn
            .del(format!("bandit:outage_failures:{}", workspace_id))
            .await;
    }

    /// Resolve arm-update ownership for a workspace, claiming `"local"` via
    /// `SET NX` when unset. Results are cached in-process for 60 s so a
    /// control-plane takeover (`"cloud"`) demotes this writer within one TTL.
    ///
    /// Fail-safe: when the marker cannot be read or claimed (Valkey error),
    /// this stands down (`Cloud`) WITHOUT caching the result, so a transient
    /// outage can never elect a second writer on a cloud-owned workspace.
    async fn resolve_mode(&self, conn: &mut ConnectionManager, workspace_id: &str) -> RewardMode {
        if let Some(mode) = self.cached_mode(workspace_id) {
            return mode;
        }

        let marker_key = format!("bandit:reward_mode:{}", workspace_id);
        let current: Option<String> = match conn.get(&marker_key).await {
            Ok(v) => v,
            Err(_) => return RewardMode::Cloud, // uncached — re-resolve next request
        };
        let mode = match current.as_deref() {
            Some("cloud") => RewardMode::Cloud,
            Some(_) => {
                self.refresh_local_ownership(conn, workspace_id, &marker_key)
                    .await;
                RewardMode::Local
            }
            None => {
                let claimed: Result<Option<String>, redis::RedisError> = redis::cmd("SET")
                    .arg(&marker_key)
                    .arg("local")
                    .arg("NX")
                    .arg("EX")
                    .arg(MARKER_TTL_SECS)
                    .query_async(conn)
                    .await;
                match claimed {
                    Ok(Some(_)) => {
                        // Fresh claim: drop any stale outage backlog so a later
                        // cloud takeover cannot double-count failures the local
                        // loop learns as 0-rewards from here on.
                        let _: Result<(), redis::RedisError> = conn
                            .del(format!("bandit:outage_failures:{}", workspace_id))
                            .await;
                        RewardMode::Local
                    }
                    Ok(None) => {
                        // Lost the race — a control plane may have claimed "cloud".
                        match conn.get::<_, Option<String>>(&marker_key).await {
                            Ok(Some(v)) if v == "cloud" => RewardMode::Cloud,
                            Ok(_) => RewardMode::Local,
                            Err(_) => return RewardMode::Cloud, // uncached
                        }
                    }
                    Err(_) => return RewardMode::Cloud, // uncached
                }
            }
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
        };
        assert_eq!(compute_reward(&s, &cfg), 0.0);
    }

    #[test]
    fn clean_success_is_full_reward() {
        assert_eq!(compute_reward(&ok_signals(), &default_cfg()), 1.0);
    }

    #[test]
    fn latency_at_slo_is_not_penalised() {
        let cfg = default_cfg();
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms,
            ..ok_signals()
        };
        assert_eq!(compute_reward(&s, &cfg), 1.0);
    }

    #[test]
    fn latency_overrun_penalty_is_proportional_and_capped() {
        let cfg = default_cfg();
        // 2× SLO → full latency penalty (over = 1.0).
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms * 2,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.7).abs() < 1e-9);
        // 10× SLO → still capped at the full penalty.
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms * 10,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.7).abs() < 1e-9);
        // 1.5× SLO → half the penalty.
        let s = RewardSignals {
            latency_ms: cfg.latency_slo_ms + cfg.latency_slo_ms / 2,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.85).abs() < 1e-9);
    }

    #[test]
    fn token_anomaly_deducts_fixed_penalty() {
        let cfg = default_cfg();
        let s = RewardSignals {
            token_anomaly: true,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn cheaper_routed_model_earns_no_bonus() {
        let cfg = default_cfg();
        let s = RewardSignals {
            raw_cost_usd: 0.02,
            actual_cost_usd: 0.001,
            ..ok_signals()
        };
        assert_eq!(compute_reward(&s, &cfg), 1.0);
    }

    #[test]
    fn costlier_routed_model_is_penalised_and_capped() {
        let cfg = default_cfg();
        // 2× cost → full cost penalty.
        let s = RewardSignals {
            raw_cost_usd: 0.01,
            actual_cost_usd: 0.02,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.8).abs() < 1e-9);
        // 100× cost → still capped.
        let s = RewardSignals {
            raw_cost_usd: 0.01,
            actual_cost_usd: 1.0,
            ..ok_signals()
        };
        assert!((compute_reward(&s, &cfg) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn zero_raw_cost_skips_cost_term() {
        let cfg = default_cfg();
        let s = RewardSignals {
            raw_cost_usd: 0.0,
            actual_cost_usd: 0.5,
            ..ok_signals()
        };
        assert_eq!(compute_reward(&s, &cfg), 1.0);
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