//! Storage abstraction — the proxy's entire Valkey surface, behind two traits.
//!
//! The goal it serves: open core runs standalone with no Valkey, while Valkey
//! remains the backend whenever a control plane is connected.
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
    /// Run routing in shadow: select, record, serve the requested model anyway.
    ///
    /// **Its own flag, not a mode field on the routing config.** Once
    /// `ff_bandit_routing` exists as a key for a workspace, `config.yaml` is
    /// ignored for that workspace forever — so "enable the flag and set a
    /// config toggle" cannot be rolled back by editing the config, which is the
    /// only lever a self-hosted operator has in that state.
    ///
    /// Read independently of `bandit_routing`, so shadow can be turned on for a
    /// workspace that has never enforced.
    pub shadow_routing: bool,
    pub response_cache_exact: bool,
    pub response_cache_semantic: bool,
    /// Evaluate every detector, record what it would have done, and **allow the
    /// request anyway**.
    ///
    /// For a workspace that wants to see what enforcement would cost before
    /// enabling it, and for measuring a detector's false-positive rate on
    /// traffic that was never actually blocked.
    ///
    /// Defaults to false, like every other flag, and `None` from the control
    /// plane means no control plane — so an unreachable flag service can never
    /// silently disable enforcement. That direction matters more here than for
    /// the others: the failure mode of a mis-resolved shadow flag is a proxy
    /// that governs nothing while reporting that it did.
    pub shadow_enforcement: bool,
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

/// Whether a workspace's hard spend cap could be verified, and what it said.
///
/// Three-valued rather than `bool` because "verified not capped" and "could not
/// check" must not collapse. This gate protects against unbounded spend on a
/// workspace whose operator explicitly chose `enforcement_mode=hard`, so an
/// unverifiable answer is not a licence to proceed — the workspace most likely
/// to be capped is exactly the one that would resume spending.
///
/// This is deliberately the opposite of the usual rate-limiter convention,
/// where fail-open is right because a brief lapse in throttling beats an
/// outage. A spend cap is a financial control, not a throttle: the cost of
/// wrongly allowing is unbounded and unrecoverable, while the cost of wrongly
/// denying is a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardCapStatus {
    /// Verified: no cap is active. Standalone always answers this — there is
    /// no control plane to have set a cap, so nothing is unverifiable.
    Clear,
    /// Verified: the cap is active → 429.
    Blocked,
    /// The control plane could not be reached, so spend is unverifiable → 503.
    Unverifiable,
}

/// Which governance notification queue to address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyScope {
    /// One agent turn.
    Session,
    /// Every node sharing a `graph_id` — siblings in one multi-agent graph.
    ///
    /// Distinct from [`NotifyScope::Workspace`] in both reach and delivery.
    /// Workspace notifications are drain-on-read: whichever session polls
    /// first consumes them, which is right for "tell somebody once" and wrong
    /// for a graph, where a sibling that never learns of a KILL carries on
    /// working against a decision that has already been made.
    Graph,
    /// Everything in a workspace.
    Workspace,
}

impl NotifyScope {
    /// Key prefix for this scope's queue. Session and workspace keys keep the
    /// shapes the control plane already writes and the postprocessor already
    /// drains; only the graph tier is new.
    pub fn key_prefix(self) -> &'static str {
        match self {
            Self::Session => "gov:notify:",
            // Composite id is "{workspaceId}:{graphId}:{nodeId}". The
            // workspace segment is load-bearing: graph_id is client-supplied
            // free text, so without it two tenants choosing the same graph id
            // on a shared Valkey would drain each other's queues.
            Self::Graph => "gov:notify:graph:",
            Self::Workspace => "gov:notify:workspace:",
        }
    }
}

/// Historical token-usage baseline for a (workspace, model, size-bucket).
/// Raw counters as stored; the caller derives averages.
#[derive(Debug, Clone, Copy)]
pub struct TokenBaseline {
    pub count: u64,
    pub sum: f64,
    pub reasoning_sum: f64,
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
    /// Records what a mirrored call learned, per workspace and candidate model.
    ///
    /// Mirroring spends real money on a second upstream call for exactly one
    /// reason: it is the only evidence that a cheaper model would have answered
    /// as well. That evidence went to a `tracing::info!` and nowhere else, so
    /// C6/C7 — enforce per workspace on a mirror-measured fault-rate delta —
    /// were waiting on data that existed only as unaggregated log lines.
    ///
    /// A counter hash rather than a row per call: the question is a rate, the
    /// volume is capped at 5% of traffic, and nothing downstream needs the
    /// individual samples.
    async fn record_mirror_outcome(
        &self,
        workspace_id: &str,
        candidate_model: &str,
        faulted: bool,
        measured: bool,
        cost_usd: f64,
    ) -> anyhow::Result<()>;

    async fn incr_outage_failure(&self, workspace_id: &str, arm_key: &str)
        -> anyhow::Result<()>;

    // ── Session routing ──────────────────────────────────────────────

    /// Session's pinned model and SOP tier, if routing has recorded them.
    async fn session_routing(&self, session_id: &str) -> anyhow::Result<SessionRouting>;

    /// Pin a model for the session.
    async fn set_session_locked_model(&self, session_id: &str, model: &str)
        -> anyhow::Result<()>;

    /// Release the session's model pin.
    ///
    /// The lock is set the moment the bandit selects and, until this existed,
    /// released never. A pick the upstream cannot serve was therefore locked in
    /// for the session's whole life: every subsequent request took the
    /// session-lock branch, re-sent the unservable model, and failed the same
    /// way. Called when an upstream error is attributed to the routed model, so
    /// the next request re-selects from arms that have since been penalised.
    async fn clear_session_locked_model(&self, session_id: &str) -> anyhow::Result<()>;

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

    /// Swap the count of tool calls extracted from this session's request
    /// bodies so far, returning the previous count (0 when unseen).
    ///
    /// Exists because agent harnesses resend the whole message history on
    /// every request, so the extractor yields the cumulative call list each
    /// time. The caller subtracts the previous count to recover the per-turn
    /// delta; appending the raw extract instead duplicates the entire history
    /// into the stored sequence on every turn, which is exactly what it did
    /// before this method existed.
    ///
    /// GETSET semantics, not INCR: when the history *shrinks* (harness
    /// compaction), the count resets to the new length in the same call.
    async fn swap_extracted_tool_count(&self, session_id: &str, new_count: u64) -> u64;

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

    /// Queue a governance notification for later delivery.
    ///
    /// This is the producer counterpart to `ControlPlaneCache::drain_notifications`.
    /// Until now only the control plane could write into those queues, so a
    /// standalone proxy could detect a graph-wide problem and have no way to
    /// tell the other nodes about it.
    ///
    /// Deliberately on `LocalStore` rather than `ControlPlaneCache`: producing
    /// is something the proxy does from its own findings, and gating it on a
    /// control plane would put graph broadcast behind a component open core
    /// does not ship.
    ///
    /// Fire-and-forget. A notification that fails to queue must never fail the
    /// request — the enforcement decision has already been made and returned;
    /// this only informs siblings.
    ///
    /// # Delivery
    ///
    /// [`NotifyScope::Graph`] fans out: one copy per registered sibling, so
    /// each reads its own. Session and workspace scopes keep their existing
    /// drain-on-read behaviour.
    async fn publish_notification(&self, scope: NotifyScope, id: &str, payload: &str);

    /// Mark this node live in its graph.
    ///
    /// Called on **every** graph request, not only when something is detected:
    /// a node that behaves perfectly still has to be a known member, or a
    /// sibling's finding has nowhere to be delivered. Membership is TTL'd and
    /// refreshed per call, so a node that goes quiet ages out instead of
    /// accumulating forever.
    ///
    /// Write-only and fire-and-forget, deliberately separate from
    /// [`LocalStore::graph_members`]: this is on the hot path for every request
    /// in a graph, while reading the membership is only needed on the rare
    /// request that actually has something to broadcast.
    async fn touch_graph_node(&self, workspace_id: &str, graph_id: &str, node_id: &str, ttl_secs: u64);

    /// Current members of a graph, including the caller.
    ///
    /// An empty result means the store cannot track membership — standalone
    /// without Valkey — in which case broadcast degrades to nothing rather
    /// than guessing at a topology it cannot see.
    async fn graph_members(&self, workspace_id: &str, graph_id: &str) -> Vec<String>;

    /// Pin a workspace's tool definitions on first sight, returning the pin.
    ///
    /// Trust-on-first-use: the first definition seen is recorded, and every
    /// later request is compared against it.
    ///
    /// **Workspace-scoped and durable, not per-session.** A per-session pin
    /// re-pins on every new session, so it only catches a swap that happens
    /// mid-conversation — the least likely timing. A real rug pull arrives
    /// with a server update between sessions, and a per-session pin would
    /// silently adopt the poisoned definition as its new baseline. OWASP's MCP
    /// guidance is explicit that pinning is per-installation and must survive
    /// session boundaries.
    ///
    /// Returns the pinned signature, which is `signature` itself on the first
    /// request. `None` when the store cannot remember, in which case a rug
    /// pull is simply not detectable and no claim is made that it is.
    ///
    /// # Scoped per harness, not per workspace
    ///
    /// The tool set is a property of the harness. Claude Code and Cursor
    /// advertise genuinely different tools, so a workspace-wide pin meant
    /// whichever harness arrived first pinned, and every request from any other
    /// harness reported drift forever — a permanent false positive in the
    /// expected configuration, since this product ships eighteen harness
    /// integrations.
    ///
    /// Per-harness is also the correct granularity on the merits: a rug pull is
    /// *one* server changing what it serves, and the harness is the finest
    /// origin the proxy can observe. It cannot see individual MCP servers behind
    /// the harness, which is the residual limit — see the module notes on
    /// cross-origin escalation.
    ///
    /// `harness` comes from the route (`Provider::harness_name`), not from a
    /// caller-supplied header, so it cannot be spoofed into a fresh pin.
    async fn pinned_tool_signature(
        &self,
        workspace_id: &str,
        harness: &str,
        signature: &str,
    ) -> Option<String>;

    /// How many nodes are currently live in a graph.
    ///
    /// A count rather than the member list, because this is read on every
    /// graph request and the names are only needed when something is actually
    /// being broadcast.
    async fn graph_node_count(&self, workspace_id: &str, graph_id: &str) -> Option<u32>;

    /// Whether a specific node is currently a live member of a graph.
    ///
    /// A single-key membership test rather than fetching the whole set,
    /// because this runs on the request path to check whether a caller's
    /// declared parent is still alive.
    ///
    /// `None` means the store cannot answer — standalone, or the graph is
    /// unknown. Callers must treat that as "no opinion" and not as "dead",
    /// since concluding a parent is gone on the basis of a store that never
    /// tracked it would orphan every node in a graph.
    async fn is_graph_member(&self, workspace_id: &str, graph_id: &str, node_id: &str) -> Option<bool>;

    /// Add to a graph's running cost and return the new total.
    ///
    /// Aggregated across every node so fan-out is visible: a graph spawning
    /// eight workers spends eight times what any one of them was budgeted, and
    /// a per-node view cannot see that at all.
    ///
    /// Returns `None` when the store cannot aggregate, which reads as "no
    /// spend signal" rather than zero.
    async fn add_graph_spend(&self, workspace_id: &str, graph_id: &str, amount: f64, ttl_secs: u64) -> Option<f64>;

    /// A graph's cost so far, across all nodes.
    async fn graph_spend(&self, workspace_id: &str, graph_id: &str) -> Option<f64>;

    /// Claim the right to broadcast a finding of `kind` into `graph_id`.
    ///
    /// Returns `false` when the broadcast should be suppressed. Two things are
    /// enforced together because they guard the same failure:
    ///
    /// **Loop-suppression.** A finding delivered to a sibling lands in that
    /// sibling's context, which becomes part of its next request. Without a
    /// guard the same fact can ricochet around a graph, and each hop makes it
    /// look independently corroborated when it is one observation being
    /// repeated. The same category is therefore broadcast once per graph per
    /// window, not once per request.
    ///
    /// **Rate ceiling.** A graph tripping detectors on every request would
    /// otherwise broadcast on every request, to every sibling — quadratic in
    /// graph size, and a way for a pathological graph to bury real findings
    /// under its own noise.
    ///
    /// Returns `false` when the store cannot arbitrate, which correctly makes
    /// broadcast a no-op rather than an unbounded one.
    async fn claim_broadcast(&self, workspace_id: &str, graph_id: &str, kind: &str) -> bool;

    /// Add to a loop run's running cost and return the new total.
    ///
    /// A loop run is the workflow: one named unit of work that may span many
    /// requests, many nodes and many turns. Its ceiling is set once when the
    /// run starts, so this is what a `--budget` on the run is actually
    /// measured against.
    async fn add_workflow_spend(&self, loop_run_id: &str, amount: f64) -> Option<f64>;

    /// Hold a loop run for human review, recording why.
    ///
    /// On `LocalStore` rather than `ControlPlaneCache` because the proxy is the
    /// writer here — the cache trait is deliberately the read-only view of what
    /// the control plane publishes. The proxy already writes loop-scoped keys
    /// this way for spend.
    ///
    /// Idempotent: the first reason to arrive wins, so concurrent replicas
    /// tripping the same hold do not overwrite each other's message.
    async fn request_loop_review(&self, loop_run_id: &str, reason: &str);

    /// Why a run is being held, for the 403 body. `None` when it is not held.
    async fn loop_review_reason(&self, loop_run_id: &str) -> Option<String>;

    /// Actions a human has already cleared on this run, if any.
    ///
    /// Read before writing a hold, so an approved action cannot re-trip it when
    /// a fresh session re-presents the whole history as new.
    async fn loop_review_cleared(&self, loop_run_id: &str) -> Option<String>;

    /// Count one reask against a session, returning how many it has now had.
    ///
    /// Scoped per `(session, detector)` so correcting one problem does not
    /// consume the allowance for a different one, and TTL'd so yesterday's
    /// three reasks cannot block today's first request.
    ///
    /// **Per detector, not per anomaly kind.** It was per kind, and that was
    /// wrong in a way the type system could not catch: five detectors report
    /// `LoopDetected`, four of which reask, so they shared one three-strike
    /// budget. An agent that spun twice and then legitimately fanned out wide
    /// hit the ceiling on its second *distinct* correction — punishing exactly
    /// the agent that did what it was asked.
    ///
    /// Returns the count **including** this trip, so the first ever call
    /// returns 1. The caller escalates when it reaches
    /// [`REASK_MAX_ATTEMPTS`](crate::plugins::anomaly::REASK_MAX_ATTEMPTS).
    ///
    /// Failure returns 1, not an error: an unreachable counter must degrade to
    /// "this is the first time", because the alternative — degrading to
    /// "escalate" — would turn a Valkey outage into a wave of blocked agents.
    /// Under-counting means an agent gets more chances than configured when the
    /// cache is down, which is the harmless direction.
    async fn incr_reask_attempt(&self, session_id: &str, detector_id: &str) -> u32;

    /// A loop run's cost so far, and the ceiling it was started with.
    ///
    /// The ceiling is written by whoever started the run, so `None` means no
    /// budget was ever set — not a budget of zero. Treating it as zero would
    /// refuse every request in a run nobody capped.
    async fn workflow_budget(&self, loop_run_id: &str) -> (Option<f64>, Option<f64>);

    /// Set a loop run's ceiling, but only if it does not already have one.
    ///
    /// Set-if-absent, not set: in the enterprise deployment the control plane
    /// writes this when the run starts, and that value is the authority — a
    /// per-proxy default must never overwrite an operator's explicit budget.
    /// In open core there is no control plane, so nothing wrote the key at all
    /// and `WorkflowBudgetDetector` had no reachable input. Returns whether
    /// this call was the one that set it.
    async fn set_workflow_budget_if_absent(&self, loop_run_id: &str, budget: f64) -> bool;

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

    /// Whether the workspace is under a hard daily spend cap. See
    /// [`HardCapStatus`] for why this is not `bool`.
    async fn hard_block(&self, workspace_id: &str) -> HardCapStatus;

    /// Daily spend and limit for a workspace, as `(spend, limit)`.
    ///
    /// `auth_context` folds these into the record it returns, but the
    /// control-plane fallback path in `handle_proxy` establishes identity only —
    /// without this it would leave `max_budget: None`, and `check_budget` is a no-op
    /// on `None`, silently skipping the pre-flight budget check for exactly the
    /// requests that took the fallback. Returns `None` when unknown, which the
    /// caller must treat as "no pre-flight opinion", not "no limit".
    async fn daily_budget(&self, workspace_id: &str) -> Option<(f64, Option<f64>)>;

    /// Status of a governed loop run, if the control plane is tracking it.
    async fn loop_status(&self, loop_run_id: &str) -> Option<String>;

    /// The loop run this caller is currently executing under, when no
    /// `x-loop-run-id` header is present.
    ///
    /// Needed because nothing sets that header: the CLI exports
    /// `INTUTIC_LOOP_RUN_ID`/`HTTP_X_LOOP_RUN_ID` into the agent's environment
    /// and no component translates env into headers, so loop governance — the
    /// kill gate, the budget breach detector, spend accrual and `loop_run_id`
    /// on published traces — was unreachable in practice. The control plane
    /// publishes a pointer keyed by the same workspace/member pair this proxy
    /// already resolved from the API key.
    async fn active_loop_run(&self, workspace_id: &str, member_id: Option<&str>)
        -> Option<String>;

    // ── Paid-tier gates ──────────────────────────────────────────────

    /// Whether auto-judging is active for this session or loop run. Judging is
    /// a control-plane feature, so standalone this is always `false`.
    async fn auto_judge_active(&self, scope: JudgeScope, id: &str) -> bool;

    /// Whether a break-glass override token is currently valid.
    async fn break_glass_valid(&self, token: &str) -> bool;

    // ── WASM rule distribution ───────────────────────────────────────

    /// Fitted tool-transition probabilities for a workspace, as a raw JSON object
    /// mapping `"from to"` to a probability in 0..1.
    ///
    /// Produced by the control-plane transition sweep over that workspace's
    /// SUCCESSFUL runs, not computed here — fitting a distribution is not something
    /// the request path should do. `None` means the workspace has no fitted model
    /// (too little history, or the sweep has not run), and the detector falls back
    /// to its built-in table rather than treating an absent model as a permissive one.
    async fn transition_baseline(&self, workspace_id: &str) -> Option<String>;

    /// Plugin descriptors for a workspace, as a raw JSON array.
    async fn wasm_plugins(&self, workspace_id: &str) -> anyhow::Result<Option<String>>;

    /// A rule binary by content hash. The only `Vec<u8>` value in the whole
    /// surface, and it lands on the null side — which is why the byte/string
    /// split never reaches the half that needed real work.
    async fn wasm_binary(&self, sha256: &str) -> anyhow::Result<Option<Vec<u8>>>;

    // ── Token intelligence ───────────────────────────────────────────

    /// Per-workspace cost-gate threshold in USD.
    async fn predict_gate_threshold(&self, workspace_id: &str) -> Option<f64>;

    /// Historical output-token baseline, workspace-specific if present and
    /// global otherwise. Both are written by the control plane's rollups.
    async fn token_baseline(
        &self,
        workspace_id: &str,
        model: &str,
        bucket: &str,
    ) -> Option<TokenBaseline>;

    // ── Governance notifications ─────────────────────────────────────

    /// Atomically drain a notification queue, returning the raw JSON payloads.
    ///
    /// Read-and-delete is one atomic step so a crash between them cannot
    /// deliver the same notification twice. Returns raw strings rather than
    /// parsed values to keep the store layer independent of the postprocessor's
    /// types.
    async fn drain_notifications(&self, scope: NotifyScope, id: &str) -> Vec<String>;
}
