//! Storage abstraction — the proxy's entire Valkey surface, behind two traits.
//!
//! Grew out of a spike scoped to the bandit/reward slice (see
//! `SPIKE-FINDINGS.md`); this is the full port that spike recommended. The goal
//! it serves: open core runs standalone with no Valkey, while Valkey remains
//! the backend whenever a control plane is connected.
//!
//! Deliberately domain-level rather than command-level. A command-level trait
//! (`get`/`hset`/`hincr`) is dyn-compatible if return types are pinned, so
//! object safety is not the reason — the reason is that it cannot *express*
//! the hard cases, only smuggle them:
//!
//!   * the arm update is a Lua script; a command trait degrades it to
//!     `eval(body, keys, args)`, forcing a local impl to embed Lua
//!   * `SET NX EX` ownership degrades to `Option<String>`, stranding the
//!     claimed-vs-lost semantics above the abstraction
//!   * `HINCRBY` and `HINCRBYFLOAT` are the same call at the command level but
//!     write different value types, which is a wire-format difference
//!
//! All become ordinary methods here.
//!
//! ## The split
//!
//! [`LocalStore`] is what the proxy both writes and reads — it needs a real
//! second implementation, and gets one in [`memory`]. [`ControlPlaneCache`] is
//! what the Node control plane writes and the proxy only reads; standalone,
//! every method is absent, which is why `Option` (and [`ControlPlaneAuth`]) is
//! in the signature rather than a convention above it.
//!
//! That split is what makes the port tractable: the byte-valued `wasm:binary`
//! payload, all of auth, and all of budget land on the null side, so the half
//! needing real work never has to deal with them.
//!
//! @module

use async_trait::async_trait;
use std::collections::HashMap;

use crate::metering::VirtualKeyRecord;
use crate::routing::bandit::BanditArmState;
use crate::telemetry::ExecutionTrace;

pub mod memory;
pub mod valkey;

pub use memory::{migrate_local_learning, MemoryStore, NullControlPlaneCache};

/// Path to the standalone learning snapshot. Exposed so the Valkey path can
/// carry it over on first connect.
pub fn local_snapshot_path() -> std::path::PathBuf {
    memory::default_snapshot_path()
}
pub use valkey::{ValkeyControlPlaneCache, ValkeyStore};

/// Who owns arm updates for a workspace. Mirrors `reward::RewardMode`; kept
/// separate so the store layer does not depend on the reward engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Local,
    Cloud,
}

/// Outcome of an ownership claim. The distinction is load-bearing: losing the
/// race means a cloud writer owns this workspace and the local writer must
/// stand down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    Claimed,
    Lost,
}

/// The two `session:metadata:{sid}` fields routing reads. Returned together
/// because `route_model` always needs both, and one method beats two round
/// trips on the request path.
#[derive(Debug, Clone, Default)]
pub struct SessionRouting {
    pub locked_model: Option<String>,
    pub sop_tier: Option<String>,
}

/// A cached upstream response, as stored under `cache:response:{sha256}`.
/// Defined here rather than in `plugins::semantic_cache` so the store layer
/// does not depend on the plugin layer; re-exported from there for callers.
///
/// The camelCase renames are wire format — entries written by earlier versions
/// and by the control plane use them. Do not drop them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CachedResponse {
    pub prompt: String,
    pub response: String,
    pub model: String,
    #[serde(rename = "promptTokens")]
    pub prompt_tokens: u32,
    #[serde(rename = "completionTokens")]
    pub completion_tokens: u32,
    #[serde(rename = "cachedAt")]
    pub cached_at: String,
}

/// Workspace feature flags, as published by the control plane.
///
/// Only ever handed out as `Option<FeatureFlags>`, and that is the whole
/// design: `Some` means a control plane manages this workspace and is
/// authoritative; `None` means there is none, and local `config.yaml` decides.
/// The distinction used to live in a `flags_key_present` boolean sitting beside
/// three flag booleans — correct, but a convention any future edit could break
/// by reading a flag without consulting the sentinel. Here it is unrepresentable.
///
/// Note that a *present but unparseable* value is `Some(FeatureFlags::default())`,
/// not `None`: presence is what confers authority, so a malformed payload
/// resolves every flag to false rather than silently handing control back to
/// local config. That matches enterprise behaviour.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeatureFlags {
    pub bandit_routing: bool,
    pub response_cache_exact: bool,
    pub response_cache_semantic: bool,
}

/// Result of asking the control plane about a virtual key.
///
/// The three-way split exists because "no control plane" and "control plane
/// says no" must not collapse into the same value. Before the port they did:
/// `validate_virtual_key` returned `KeyNotFound` for a missing
/// `v2:auth:apikey:*`, and a standalone deployment has no such key for *any*
/// token — so a null cache returning "not found" would have 401'd every
/// request. Which implementation is in use is what distinguishes them, so the
/// distinction lives in the impl, not in the key lookup.
#[derive(Debug, Clone)]
pub enum ControlPlaneAuth {
    /// No control plane manages this deployment. Local limits apply
    /// (`local_spend`), and the request is not rejected on this basis.
    Unmanaged,
    /// A control plane is present and recognises this key.
    Known(Box<VirtualKeyRecord>),
    /// A control plane is present and does not recognise this key → 401.
    Rejected,
    /// A control plane is present but could not be reached. Callers fail open,
    /// matching the pre-port `Err(e) => None` arm.
    Unavailable,
}

/// Which auto-judge marker to consult. Two keys, one shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JudgeScope {
    Session,
    Loop,
}

/// State the proxy both writes and reads. Needs a real second implementation —
/// unlike control-plane-written keys, which are simply absent when standalone.
#[async_trait]
pub trait LocalStore: Send + Sync + 'static {
    // ── Bandit arms ──────────────────────────────────────────────────

    /// Atomic read-modify-write of a single arm. The Valkey impl runs the
    /// existing Lua script verbatim; the local impl applies
    /// `reward::apply_update` under a lock.
    async fn update_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        reward: f64,
        now_rfc3339: &str,
    ) -> anyhow::Result<()>;

    /// All arms for a workspace, keyed by `arm:{model}:{tier}:{task}`. Arms
    /// that fail to decode are dropped, matching the caller's existing
    /// per-arm `.ok()` — a corrupt arm re-seeds rather than failing the route.
    async fn load_arms(&self, workspace_id: &str)
        -> anyhow::Result<HashMap<String, BanditArmState>>;

    /// Seed a fresh `Beta(1,1)` arm. Separate from `update_arm` because
    /// seeding must not count as a pull.
    async fn seed_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        state: &BanditArmState,
    ) -> anyhow::Result<()>;

    // ── Arm-update ownership ─────────────────────────────────────────

    /// Current owner, or `None` when unclaimed.
    async fn reward_mode(&self, workspace_id: &str) -> anyhow::Result<Option<Ownership>>;

    /// `SET NX EX` — claim only if unclaimed.
    async fn claim_local_ownership(
        &self,
        workspace_id: &str,
        ttl_secs: u64,
    ) -> anyhow::Result<ClaimOutcome>;

    /// Extend an existing claim.
    async fn refresh_ownership(&self, workspace_id: &str, ttl_secs: u64) -> anyhow::Result<()>;

    /// Drop the outage-failure counters for a workspace.
    async fn clear_outage_failures(&self, workspace_id: &str) -> anyhow::Result<()>;

    /// Count one upstream failure against an arm. A cloud-cron input, written
    /// only when the local reward loop does *not* own learning for this
    /// workspace — otherwise the same failure is counted twice.
    async fn incr_outage_failure(&self, workspace_id: &str, arm_key: &str)
        -> anyhow::Result<()>;

    // ── Session routing ──────────────────────────────────────────────

    /// Session's pinned model and SOP tier, if routing has recorded them.
    async fn session_routing(&self, session_id: &str) -> anyhow::Result<SessionRouting>;

    /// Pin a model for the session.
    async fn set_session_locked_model(&self, session_id: &str, model: &str)
        -> anyhow::Result<()>;

    // ── Tool-sequence anomaly detection ──────────────────────────────

    /// Append `new_tools` to the session's tool sequence, trim to the newest
    /// `cap`, and return the resulting sequence. One method rather than
    /// `lrange` + N × `rpush` + `ltrim` because the trim bound is part of the
    /// contract, not a caller's bookkeeping.
    async fn record_tool_sequence(
        &self,
        session_id: &str,
        new_tools: &[String],
        cap: usize,
    ) -> anyhow::Result<Vec<String>>;

    // ── Provider credentials ─────────────────────────────────────────

    /// First non-empty value among `fields` in `workspace:credentials:{ws}`.
    ///
    /// Holds OAuth tokens and API keys. `MemoryStore` keeps these in process
    /// memory and never writes them to disk — see its module docs before
    /// making the local store durable.
    async fn workspace_credential(
        &self,
        workspace_id: &str,
        fields: &[&str],
    ) -> Option<String>;

    /// Capture a credential observed on an inbound request (developer OAuth /
    /// Pro sessions), so later requests to the same workspace can reuse it.
    async fn set_workspace_credential(&self, workspace_id: &str, field: &str, value: &str);

    // ── Response cache ───────────────────────────────────────────────

    async fn cached_response(&self, hash: &str) -> Option<CachedResponse>;

    async fn store_response(
        &self,
        hash: &str,
        response: &CachedResponse,
        ttl_secs: u64,
    ) -> anyhow::Result<()>;

    /// `HINCRBY` — integer counters (`exact_hits`, `semantic_hits`, `misses`,
    /// `cache_size`).
    async fn incr_cache_counter(&self, workspace_id: &str, field: &str, by: i64);

    /// `HINCRBYFLOAT` — the one float-valued metric. Kept separate from
    /// [`Self::incr_cache_counter`] because collapsing them would silently
    /// change integer counters into floats in Valkey.
    async fn add_cache_savings(&self, workspace_id: &str, amount: f64);

    // ── Publish channels ─────────────────────────────────────────────

    /// Publish an execution trace to `intutic:traces:{ws}` (and the live
    /// session channel). Fire-and-forget; the control plane's subscriber
    /// batch-inserts these into Postgres.
    async fn publish_trace(&self, trace: &ExecutionTrace) -> anyhow::Result<()>;

    /// Publish an infrastructure anomaly to `intutic:system_anomalies`.
    async fn publish_system_anomaly(&self, workspace_id: &str, description: &str);

    /// Append a judged chunk to `session:chunks:{sid}`.
    ///
    /// `ttl_secs` is `Some` on the streaming paths and `None` on the
    /// non-streaming one. That asymmetry predates the port and is preserved
    /// rather than quietly normalised — see `push_session_chunk` call sites.
    async fn push_session_chunk(
        &self,
        session_id: &str,
        payload: &str,
        ttl_secs: Option<u64>,
    ) -> anyhow::Result<()>;
}

/// Keys the control plane writes and the proxy only reads. Standalone, every
/// method is absent — modelling absence in the type is the point, because key
/// presence is load-bearing today and is currently only a convention.
#[async_trait]
pub trait ControlPlaneCache: Send + Sync + 'static {
    // ── Routing inputs ───────────────────────────────────────────────

    /// Per-workspace task-classifier keyword overrides.
    async fn bandit_keywords(&self, workspace_id: &str) -> Option<serde_json::Value>;

    /// Workspace-level SOP tier, used when the session carries none.
    async fn active_sop_tier(&self, workspace_id: &str) -> Option<String>;

    /// `None` when no control plane manages this workspace. Fails open — a
    /// read error or timeout is indistinguishable from absence by design, so a
    /// Valkey blip cannot strand a workspace with all features off.
    async fn feature_flags(&self, workspace_id: &str) -> Option<FeatureFlags>;

    // ── Auth and budget ──────────────────────────────────────────────

    /// Resolve a virtual key. See [`ControlPlaneAuth`] for why this is not
    /// `Option`.
    async fn auth_context(&self, token: &str) -> ControlPlaneAuth;

    /// `true` when the workspace is under a hard daily spend cap. Failure to
    /// read is `false` — this is a cache, not auth.
    async fn hard_block(&self, workspace_id: &str) -> bool;

    /// Status of a governed loop run, if the control plane is tracking it.
    async fn loop_status(&self, loop_run_id: &str) -> Option<String>;

    // ── Paid-tier gates ──────────────────────────────────────────────

    /// Whether auto-judging is active for this session or loop run. Judging is
    /// a control-plane feature, so standalone this is always `false`.
    async fn auto_judge_active(&self, scope: JudgeScope, id: &str) -> bool;

    /// Whether a break-glass override token is currently valid.
    async fn break_glass_valid(&self, token: &str) -> bool;

    // ── WASM rule distribution ───────────────────────────────────────

    /// Plugin descriptors for a workspace, as a raw JSON array.
    async fn wasm_plugins(&self, workspace_id: &str) -> anyhow::Result<Option<String>>;

    /// A rule binary by content hash. The only `Vec<u8>` value in the whole
    /// surface, and it lands on the null side — which is why the byte/string
    /// split never reaches the half that needed real work.
    async fn wasm_binary(&self, sha256: &str) -> anyhow::Result<Option<Vec<u8>>>;
}
