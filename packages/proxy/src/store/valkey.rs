//! Valkey-backed [`LocalStore`] / [`ControlPlaneCache`] — the path that ships
//! when a control plane is connected.
//!
//! Every method here is code that previously sat inline in `proxy.rs`,
//! `metering.rs`, `telemetry.rs`, `plugins::semantic_cache` and
//! `wasm::registry`, moved without behaviour change. In particular
//! [`ARM_UPDATE_SCRIPT`] is the Lua verbatim, so the bytes written to
//! `bandit:{ws}` are identical to v1.6.3's.
//!
//! The `(**valkey).clone()` that all 19 call sites used to perform now happens
//! inside these impls, because `AsyncCommands` needs `&mut self` and the traits
//! expose `&self`.
//!
//! @module

use async_trait::async_trait;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use std::collections::HashMap;
use std::sync::Arc;

use super::{
    CachedResponse, ClaimOutcome, ControlPlaneAuth, ControlPlaneCache, FeatureFlags, HardCapStatus,
    JudgeScope, LocalStore, NotifyScope, Ownership, PinScope, PinnedSopBlock, SessionRouting,
    TokenBaseline,
};
use crate::metering::VirtualKeyRecord;
use crate::routing::bandit::BanditArmState;
use crate::routing::mirror::MirrorPairEvent;
use crate::telemetry::ExecutionTrace;

/// Every Valkey key scoped to a graph, built in one place.
///
/// `graph_id` is client-supplied free text — it arrives on a `baggage` header
/// and defaults to the session id — so the workspace segment is the ONLY thing
/// separating two tenants that happen to choose the same graph id on a shared
/// Valkey. Without it they would share a membership set, a spend counter that
/// feeds the budget detector, a broadcast rate ceiling, and each other's
/// notification queues, whose payloads carry tenant-identifying free text.
///
/// A function rather than five `format!` calls (TD-208): the invariant is
/// testable here and a new graph key cannot be added without passing through
/// it. The composite notification id in `broadcast.rs` carries the same
/// workspace-first shape for the same reason.
fn graph_key(workspace_id: &str, graph_id: &str, suffix: &str) -> String {
    format!("graph:{workspace_id}:{graph_id}:{suffix}")
}


/// Lowercase hex SHA-256, matching the control plane's `hashKeySha256`.
fn sha256_hex(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    hex::encode(h.finalize())
}

/// Compares two byte strings without an early return.
///
/// Both operands here are hex digests of the same fixed length, so the length
/// check leaks nothing an attacker does not already know. The fold is what
/// matters: `==` on `&[u8]` may stop at the first differing byte, and this
/// comparison sits on the request path where an attacker controls one side and
/// can time it.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

/// Timeout on the keyword lookup — a control-plane key on the request path,
/// so a slow read must not become a slow route.
const KEYWORDS_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);

/// Most notifications held per queue. A graph that trips detectors on every
/// request would otherwise grow one without bound; the newest are the ones
/// worth delivering.
const NOTIFY_QUEUE_CAP: isize = 50;

/// How long an undelivered notification survives. Past this it is stale advice
/// about a request the agent has long since moved on from.
const NOTIFY_TTL_SECS: i64 = 3600;

/// How long an unswept `gov:delivered:{ws}` marker survives — 24 hours.
///
/// Generous relative to the control-plane label sweep's minutes-scale
/// cadence, so a control plane down for a day loses nothing; past that the
/// marker describes a delivery the dataset will simply record as
/// never-delivered, which is the honest degradation.
const DELIVERED_MARKER_TTL_SECS: i64 = 24 * 3600;

/// Most delivery markers held per workspace queue, same bounding rationale
/// as [`NOTIFY_QUEUE_CAP`] — with a sweep reading every few minutes this is
/// ample, and an unbounded list with a dead sweeper is a leak.
const DELIVERED_MARKER_CAP: isize = 10_000;

/// Sliding TTL on a session's tool-sequence list.
///
/// The list itself is length-capped by `LTRIM`, but nothing bounded the number
/// of *keys* — one per session id ever seen, kept forever. Every other
/// session-scoped key in this file expires; this one predated the convention.
///
/// Sliding, refreshed on every write: an active session never expires, and a
/// session idle for a day loses only its detector context — which fails safe,
/// since every sequence detector treats a short history as benign.
const TOOL_SEQUENCE_TTL_SECS: i64 = 86_400;

/// Window over which a graph may broadcast a given anomaly category once, and
/// over which its total broadcasts are counted.
const BROADCAST_WINDOW_SECS: u64 = 60;

/// Most broadcasts one graph may emit per window, across all categories.
///
/// Ten is generous for a graph behaving badly in several distinct ways at once
/// and low enough that a pathological one cannot bury real findings under its
/// own noise.
const BROADCAST_MAX_PER_WINDOW: i64 = 10;

/// Timeout on lookups that gate whether the request proceeds at all. Matches
/// the 500 ms budget these reads carried before the port.
const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// Keys shared with the control plane. Centralised because these are a
/// cross-repo contract: the control plane writes them in TypeScript and this
/// proxy reads them in Rust, with nothing but agreement holding the two
/// together. When they disagreed, loop governance silently enforced nothing —
/// the blob was written and these scalars never were. The tests below pin the
/// exact strings.
pub(crate) fn loop_state_key(loop_run_id: &str) -> String {
    format!("intutic:loop:{}", loop_run_id)
}

pub(crate) fn loop_spend_key(loop_run_id: &str) -> String {
    format!("intutic:loop:{}:spend", loop_run_id)
}

pub(crate) fn loop_budget_key(loop_run_id: &str) -> String {
    format!("intutic:loop:{}:budget", loop_run_id)
}

/// The review hold. Present means "waiting on a human", whatever the blob says.
/// Written by the proxy on the request path, cleared by the control plane when a
/// human resolves it. Deliberately has no TTL: a hold that expires releases
/// itself, which is the one failure this feature must not have.
pub(crate) fn loop_review_key(loop_run_id: &str) -> String {
    format!("intutic:loop:{}:review", loop_run_id)
}

/// Actions already cleared by a human on this run. See the control plane's
/// `loopReviewedKey` for why this exists — it stops an approved action
/// re-tripping the hold when a new session re-presents the whole history.
pub(crate) fn loop_reviewed_key(loop_run_id: &str) -> String {
    format!("intutic:loop:{}:reviewed", loop_run_id)
}

/// How many times this session has been reasked by one detector.
///
/// Per **detector**, not per anomaly kind and not per session. An agent told to
/// stop spinning and then told its fan-out is too wide has two separate
/// problems, and consuming one allowance with the other escalates on the second
/// distinct correction rather than on a repeated failure to correct.
///
/// Keying on the kind looked like it achieved that and did not: five detectors
/// report `LoopDetected`, four of which reask, so `ConsecutiveRepeat`,
/// `PingPong`, `RecursionDepth` and `FanOutExplosion` shared one three-strike
/// budget. Two spins plus one wide fan-out was a hard block.
fn reask_attempt_key(session_id: &str, detector_id: &str) -> String {
    format!("intutic:reask:{}:{}", session_id, detector_id)
}

/// Lifetime of a reask allowance.
///
/// One hour, matching the loop-state and anomaly-promotion windows, so a
/// pattern has to be sustained *within one working session*. An agent that
/// trips the same thing once an hour is background noise, not a runaway, and
/// must not accumulate its way into a block.
const REASK_WINDOW_SECS: u64 = 3600;

pub(crate) fn active_loop_key(workspace_id: &str, member_id: Option<&str>) -> String {
    match member_id {
        Some(mid) => format!("intutic:active_loop:{}:{}", workspace_id, mid),
        None => format!("intutic:active_loop:{}", workspace_id),
    }
}

fn bandit_key(workspace_id: &str) -> String {
    format!("bandit:{}", workspace_id)
}

fn marker_key(workspace_id: &str) -> String {
    format!("bandit:reward_mode:{}", workspace_id)
}

/// Mirror evidence, per workspace. Fields are `<candidate>:<metric>`.
fn mirror_key(workspace_id: &str) -> String {
    format!("bandit:mirror_outcomes:{}", workspace_id)
}

fn outage_key(workspace_id: &str) -> String {
    format!("bandit:outage_failures:{}", workspace_id)
}

fn session_key(session_id: &str) -> String {
    format!("session:metadata:{}", session_id)
}

/// A pinned SOP advisory block's key (TD-348).
///
/// Deliberately its own top-level key, `v2:sopblock:{workspace_id}:{agent}:
/// {role_hash}` — NOT a new field on `session:metadata:{sid}` above. That hash
/// has no TTL today (an ~8KB field on a key that never expires is a leak) and
/// no workspace-id component (its `{sid}` alone is the client-supplied
/// `x-session-id` header, which the doc comments on `tool_history_scope` and
/// `judge_session_scope` in `proxy.rs` record as a degenerate, frequently-
/// shared "unknown" value across every unidentified caller in every tenant —
/// exactly the cross-tenant text leakage a workspace-scoped, TTL'd key
/// avoids).
fn sop_pin_key(scope: &PinScope) -> String {
    format!("v2:sopblock:{}", scope.storage_key())
}

fn metrics_key(workspace_id: &str) -> String {
    format!("cache:metrics:{}", workspace_id)
}

fn response_key(hash: &str) -> String {
    format!("cache:response:{}", hash)
}

pub struct ValkeyStore {
    conn: Arc<ConnectionManager>,
    update_script: redis::Script,
}

/// The workspace's daily spend counter, as the **control plane** names it.
///
/// This read `v2:budget:daily:{ws}` and the control plane writes
/// `v2:budget:{ws}:daily` — the segments transposed. Nothing wrote what this
/// read, so `spend` parsed as `0.0` on every request forever, `max_budget` fell
/// through to its `Some(100.0)` default, and `metering::check_budget` computed
/// `remaining = 100.0` on every call. The 429 could only fire on a *single*
/// request estimated above ~$83. A workspace with a $20 daily cap spent without
/// limit, and every log reported success.
///
/// A GET against a key nobody writes is indistinguishable from a GET against a
/// key not yet set, which is why nothing at runtime could report this. Pinned
/// against the TypeScript builders by
/// `services/control-plane/__tests__/unit/valkeyKeyParity.test.ts`.
///
/// Written by `finopsService.incrementSpend` (`workspaceBudgetDailyKey`).
fn budget_daily_key(workspace_id: &str) -> String {
    format!("v2:budget:{}:daily", workspace_id)
}

/// The workspace's configured daily cap. Written by `budgetDailyLimitKey`.
fn budget_daily_limit_key(workspace_id: &str) -> String {
    format!("v2:budget:{}:daily_limit", workspace_id)
}

impl ValkeyStore {
    pub fn new(conn: Arc<ConnectionManager>) -> Self {
        Self {
            conn,
            update_script: redis::Script::new(ARM_UPDATE_SCRIPT),
        }
    }

    fn conn(&self) -> ConnectionManager {
        self.conn.as_ref().clone()
    }
}

#[async_trait]

impl LocalStore for ValkeyStore {
    async fn update_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        reward: f64,
        now_rfc3339: &str,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: i64 = self
            .update_script
            .key(bandit_key(workspace_id))
            .arg(arm_key)
            .arg(reward)
            .arg(now_rfc3339)
            .invoke_async(&mut conn)
            .await?;
        Ok(())
    }

    async fn load_arms(
        &self,
        workspace_id: &str,
    ) -> anyhow::Result<HashMap<String, BanditArmState>> {
        let mut conn = self.conn();
        let raw: HashMap<String, String> = conn
            .hgetall(bandit_key(workspace_id))
            .await
            .unwrap_or_default();
        Ok(raw
            .into_iter()
            .filter_map(|(k, v)| serde_json::from_str::<BanditArmState>(&v).ok().map(|s| (k, s)))
            .collect())
    }

    async fn seed_arm(
        &self,
        workspace_id: &str,
        arm_key: &str,
        state: &BanditArmState,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let encoded = serde_json::to_string(state)?;
        let _: () = conn.hset(bandit_key(workspace_id), arm_key, encoded).await?;
        Ok(())
    }

    async fn reward_mode(&self, workspace_id: &str) -> anyhow::Result<Option<Ownership>> {
        let mut conn = self.conn();
        let current: Option<String> = conn.get(marker_key(workspace_id)).await?;
        Ok(current.map(|v| {
            if v == "cloud" {
                Ownership::Cloud
            } else {
                Ownership::Local
            }
        }))
    }

    async fn claim_local_ownership(
        &self,
        workspace_id: &str,
        ttl_secs: u64,
    ) -> anyhow::Result<ClaimOutcome> {
        let mut conn = self.conn();
        let claimed: Option<String> = redis::cmd("SET")
            .arg(marker_key(workspace_id))
            .arg("local")
            .arg("NX")
            .arg("EX")
            .arg(ttl_secs)
            .query_async(&mut conn)
            .await?;
        Ok(match claimed {
            Some(_) => ClaimOutcome::Claimed,
            None => ClaimOutcome::Lost,
        })
    }

    async fn refresh_ownership(&self, workspace_id: &str, ttl_secs: u64) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: () = conn
            .expire(marker_key(workspace_id), ttl_secs as i64)
            .await?;
        Ok(())
    }

    async fn clear_outage_failures(&self, workspace_id: &str) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: () = conn.del(outage_key(workspace_id)).await?;
        Ok(())
    }

    async fn record_mirror_outcome(
        &self,
        workspace_id: &str,
        candidate_model: &str,
        faulted: bool,
        measured: bool,
        cost_usd: f64,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let key = mirror_key(workspace_id);
        // `calls` and `measured` are tracked separately for the same reason the
        // trace column is nullable: a call that produced no score must not be
        // counted as a clean one, or the fault rate is diluted by silence.
        let _: () = conn.hincr(&key, format!("{candidate_model}:calls"), 1).await?;
        if measured {
            let _: () = conn.hincr(&key, format!("{candidate_model}:measured"), 1).await?;
        }
        if faulted {
            let _: () = conn.hincr(&key, format!("{candidate_model}:faults"), 1).await?;
        }
        // Micro-dollars, so the counter stays integral.
        let micros = (cost_usd * 1_000_000.0).round() as i64;
        let _: () = conn.hincr(&key, format!("{candidate_model}:cost_micros"), micros).await?;
        Ok(())
    }

    async fn incr_outage_failure(
        &self,
        workspace_id: &str,
        arm_key: &str,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: () = conn.hincr(outage_key(workspace_id), arm_key, 1).await?;
        Ok(())
    }

    async fn session_routing(&self, session_id: &str) -> anyhow::Result<SessionRouting> {
        let mut conn = self.conn();
        let key = session_key(session_id);
        // Non-empty only: the caller treats "" and absent identically, and the
        // pre-trait code reached both through `unwrap_or_else(|_| "")`.
        let locked_model: Option<String> = conn.hget(&key, "lockedModel").await.ok().flatten();
        let sop_tier: Option<String> = conn.hget(&key, "sopTier").await.ok().flatten();
        let last_model: Option<String> = conn.hget(&key, "lastModel").await.ok().flatten();
        Ok(SessionRouting {
            locked_model: locked_model.filter(|s| !s.is_empty()),
            sop_tier: sop_tier.filter(|s| !s.is_empty()),
            last_model: last_model.filter(|s| !s.is_empty()),
        })
    }

    async fn set_session_locked_model(
        &self,
        session_id: &str,
        model: &str,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let key = session_key(session_id);
        // "lastModel" survives `clear_session_locked_model` (which only
        // `hdel`s "lockedModel") — see `SessionRouting::last_model`. One
        // round trip for both fields.
        let _: () = conn
            .hset_multiple(&key, &[("lockedModel", model), ("lastModel", model)])
            .await?;
        Ok(())
    }

    async fn clear_session_locked_model(&self, session_id: &str) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: () = conn.hdel(session_key(session_id), "lockedModel").await?;
        Ok(())
    }

    async fn record_tool_sequence(
        &self,
        session_id: &str,
        new_tools: &[String],
        cap: usize,
    ) -> anyhow::Result<Vec<String>> {
        let mut conn = self.conn();
        let key = format!("v2:session:{}:tools", session_id);
        let mut sequence: Vec<String> = conn.lrange(&key, 0, -1).await.unwrap_or_default();

        if !new_tools.is_empty() {
            for tool in new_tools {
                sequence.push(tool.clone());
                let _: Result<(), redis::RedisError> = conn.rpush(&key, tool).await;
            }
            if sequence.len() > cap {
                let _: Result<(), redis::RedisError> =
                    conn.ltrim(&key, -(cap as isize), -1).await;
                let start = sequence.len() - cap;
                sequence = sequence.split_off(start);
            }
            let _: Result<(), redis::RedisError> =
                conn.expire(&key, TOOL_SEQUENCE_TTL_SECS).await;
        }
        Ok(sequence)
    }

    async fn record_calls_and_count_window(
        &self,
        session_id: &str,
        new_call_count: usize,
        now_unix_secs: i64,
        window_secs: i64,
    ) -> anyhow::Result<u32> {
        let mut conn = self.conn();
        let key = format!("v2:session:{}:calls", session_id);
        let window_start = now_unix_secs - window_secs;

        // Drop everything the window has already aged out of before adding —
        // otherwise a long session's ZSET grows without bound even though
        // only the trailing `window_secs` of it is ever read.
        let _: Result<(), redis::RedisError> =
            conn.zrembyscore(&key, "-inf", window_start - 1).await;

        for _ in 0..new_call_count {
            // The member must be unique per call, not just the timestamp —
            // ZADD on a member that already exists overwrites its score
            // rather than adding a second entry, which would silently
            // undercount two calls landing in the same second. A UUID
            // suffix is simpler than threading a real per-call sequence
            // number through from the caller for a count nobody reads back
            // by member.
            let member = format!("{now_unix_secs}-{}", uuid::Uuid::new_v4());
            let _: Result<(), redis::RedisError> = conn.zadd(&key, member, now_unix_secs).await;
        }
        if new_call_count > 0 {
            // Same TTL discipline as `record_tool_sequence`: refreshed on
            // every write, so an idle session's window key still expires.
            let _: Result<(), redis::RedisError> =
                conn.expire(&key, TOOL_SEQUENCE_TTL_SECS).await;
        }

        let count: u32 = conn
            .zcount(&key, window_start, now_unix_secs)
            .await
            .unwrap_or(0);
        Ok(count)
    }

    async fn swap_extracted_tool_count(&self, session_id: &str, new_count: u64) -> u64 {
        let mut conn = self.conn();
        let key = format!("v2:session:{}:toolcount", session_id);
        let prev: Option<u64> = redis::cmd("GETSET")
            .arg(&key)
            .arg(new_count)
            .query_async(&mut conn)
            .await
            .unwrap_or(None);
        // Same sliding TTL as the sequence itself: the two describe one
        // session and must expire together, or a fresh sequence would be
        // diffed against a stale count.
        let _: Result<(), redis::RedisError> =
            conn.expire(&key, TOOL_SEQUENCE_TTL_SECS).await;
        prev.unwrap_or(0)
    }

    async fn workspace_credential(
        &self,
        workspace_id: &str,
        fields: &[&str],
    ) -> Option<String> {
        let mut conn = self.conn();
        let key = format!("workspace:credentials:{}", workspace_id);
        for field in fields {
            if let Ok(Some(val)) = conn.hget::<_, _, Option<String>>(&key, *field).await {
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
        None
    }

    async fn set_workspace_credential(&self, workspace_id: &str, field: &str, value: &str) {
        let mut conn = self.conn();
        let key = format!("workspace:credentials:{}", workspace_id);
        let _: Result<(), redis::RedisError> =
            redis::Cmd::hset(&key, field, value).query_async(&mut conn).await;
    }

    async fn cached_response(&self, hash: &str) -> Option<CachedResponse> {
        let mut conn = self.conn();
        let raw: Option<String> = conn.get(response_key(hash)).await.unwrap_or(None);
        raw.and_then(|s| serde_json::from_str(&s).ok())
    }

    async fn store_response(
        &self,
        hash: &str,
        response: &CachedResponse,
        ttl_secs: u64,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let encoded = serde_json::to_string(response)?;
        let _: () = conn.set_ex(response_key(hash), encoded, ttl_secs).await?;
        Ok(())
    }

    async fn incr_cache_counter(&self, workspace_id: &str, field: &str, by: i64) {
        let mut conn = self.conn();
        let _: Result<(), redis::RedisError> =
            conn.hincr(metrics_key(workspace_id), field, by).await;
    }

    async fn add_cache_savings(&self, workspace_id: &str, amount: f64) {
        let mut conn = self.conn();
        let _: Result<(), redis::RedisError> = conn
            .hincr(metrics_key(workspace_id), "estimated_savings_usd", amount)
            .await;
    }

    async fn publish_trace(&self, trace: &ExecutionTrace) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let channel = format!("intutic:traces:{}", trace.workspace_id);
        let payload = serde_json::to_string(trace)?;
        let _: () = conn.publish(&channel, &payload).await?;

        if !trace.session_id.is_empty() && trace.session_id != "unknown" {
            let live_channel = format!("trace:live:{}", trace.session_id);
            let live_event = serde_json::json!({
                "sessionId": trace.session_id,
                "workspaceId": trace.workspace_id,
                // DEPRECATED, and a documented lie kept for deployed daemons:
                // this field has always carried the task type, and old
                // trajectoryMonitor builds key three summary metrics off it.
                // Removing or "fixing" it under them would silently change
                // what their numbers mean. New consumers read `tools` and
                // `taskType`; drop this once no pre-1.9 daemon remains.
                "toolName": trace.task_type,
                "taskType": trace.task_type,
                // The per-turn delta — tool calls newly observed on THIS
                // request, not the request body's cumulative history.
                "tools": trace.tools,
                "model": trace.model,
                "inputTokens": trace.raw_input_tokens,
                "outputTokens": trace.output_tokens,
                "status": if trace.verdict == "allowed" { "success" } else { "error" },
                "timestamp": trace.created_at,
            });
            if let Ok(live_payload) = serde_json::to_string(&live_event) {
                let _: Result<(), redis::RedisError> =
                    conn.publish(&live_channel, &live_payload).await;
            }
        }

        tracing::debug!(trace_id = %trace.trace_id, channel = %channel, "Execution trace published to Valkey");
        Ok(())
    }

    async fn publish_mirror_pair(&self, event: &MirrorPairEvent) -> anyhow::Result<()> {
        let mut conn = self.conn();
        // Same per-workspace channel shape as `publish_trace`'s
        // `intutic:traces:{ws}` — see that method and `MirrorPairEvent`'s doc
        // comment. No durable write here or anywhere else in this function:
        // PUBLISH does not persist, and that is the point.
        let channel = format!("intutic:mirror_pairs:{}", event.workspace_id);
        let payload = serde_json::to_string(event)?;
        let _: () = conn.publish(&channel, &payload).await?;
        tracing::debug!(
            workspace_id = %event.workspace_id,
            candidate = %event.candidate_model,
            channel = %channel,
            "Mirror comparison pair published to Valkey"
        );
        Ok(())
    }

    async fn publish_system_anomaly(&self, workspace_id: &str, description: &str) {
        let mut conn = self.conn();
        let payload = serde_json::json!({
            "workspace_id": workspace_id,
            "description": description,
            "severity": "HIGH",
            "timestamp": chrono::Utc::now().to_rfc3339()
        });
        if let Ok(payload_str) = serde_json::to_string(&payload) {
            let _: Result<(), redis::RedisError> = conn
                .publish("intutic:system_anomalies", &payload_str)
                .await;
        }
    }

    async fn publish_notification(&self, scope: NotifyScope, id: &str, payload: &str) {
        let mut conn = self.conn();

        // One queue, addressed by `id`. For graph scope the caller passes
        // "{graphId}:{nodeId}" — the same composite key `drain_notifications`
        // reads, so publish and drain stay symmetric. Fanning out across
        // siblings is the caller's job, because only it knows which node
        // originated the finding and should therefore be skipped.
        let key = format!("{}{}", scope.key_prefix(), id);

        // Bound the queue: a pathological graph must not be able to grow one
        // without limit, and a notification nobody drained within the TTL is
        // stale advice about a request the agent has long since moved past.
        let _: Result<(), redis::RedisError> = conn.rpush(&key, payload).await;
        let _: Result<(), redis::RedisError> = conn.ltrim(&key, -NOTIFY_QUEUE_CAP, -1).await;
        let _: Result<(), redis::RedisError> = conn.expire(&key, NOTIFY_TTL_SECS).await;
    }

    async fn touch_graph_node(&self, workspace_id: &str, graph_id: &str, node_id: &str, ttl_secs: u64) {
        let mut conn = self.conn();
        let key = graph_key(workspace_id, graph_id, "nodes");
        // Two writes, no read — this runs on every request in a graph, so the
        // membership read is deferred to the broadcast path.
        let _: Result<(), redis::RedisError> = conn.sadd(&key, node_id).await;
        let _: Result<(), redis::RedisError> = conn.expire(&key, ttl_secs as i64).await;
    }

    async fn graph_members(&self, workspace_id: &str, graph_id: &str) -> Vec<String> {
        let mut conn = self.conn();
        conn.smembers(graph_key(workspace_id, graph_id, "nodes"))
            .await
            .unwrap_or_default()
    }

    async fn pinned_tool_signature(
        &self,
        workspace_id: &str,
        harness: &str,
        signature: &str,
    ) -> Option<String> {
        let mut conn = self.conn();
        // Keyed by harness as well as workspace — see the trait doc. A
        // workspace-wide key made every second harness look like a rug pull.
        let key = format!("tools:pin:{workspace_id}:{harness}");
        // SET NX with no expiry: the pin is the workspace's baseline and must
        // outlive every session, or a rug pull only has to wait for the next
        // one. Clearing it is a deliberate act — re-approval — not a timeout.
        let _: Result<Option<String>, redis::RedisError> = redis::cmd("SET")
            .arg(&key)
            .arg(signature)
            .arg("NX")
            .query_async(&mut conn)
            .await;
        conn.get::<_, Option<String>>(&key).await.ok().flatten()
    }

    async fn graph_node_count(&self, workspace_id: &str, graph_id: &str) -> Option<u32> {
        let mut conn = self.conn();
        conn.scard::<_, u32>(graph_key(workspace_id, graph_id, "nodes"))
            .await
            .ok()
    }

    async fn is_graph_member(&self, workspace_id: &str, graph_id: &str, node_id: &str) -> Option<bool> {
        let mut conn = self.conn();
        let key = graph_key(workspace_id, graph_id, "nodes");
        // An unknown graph is not the same as a dead node — if we never
        // tracked this graph, we have no opinion on who is alive in it.
        let exists: bool = conn.exists(&key).await.ok()?;
        if !exists {
            return None;
        }
        conn.sismember(&key, node_id).await.ok()
    }

    async fn add_graph_spend(&self, workspace_id: &str, graph_id: &str, amount: f64, ttl_secs: u64) -> Option<f64> {
        let mut conn = self.conn();
        let key = graph_key(workspace_id, graph_id, "spend");
        let total: f64 = conn.incr(&key, amount).await.ok()?;
        // Same TTL as membership, so a finished graph's cost does not linger
        // and get attributed to a later graph that reuses the id.
        let _: Result<(), redis::RedisError> = conn.expire(&key, ttl_secs as i64).await;
        Some(total)
    }

    async fn graph_spend(&self, workspace_id: &str, graph_id: &str) -> Option<f64> {
        let mut conn = self.conn();
        conn.get::<_, Option<f64>>(graph_key(workspace_id, graph_id, "spend"))
            .await
            .ok()
            .flatten()
    }

    async fn claim_broadcast(&self, workspace_id: &str, graph_id: &str, kind: &str) -> bool {
        let mut conn = self.conn();

        // Loop-suppression first, and it is the cheaper check. SET NX EX
        // succeeds only for the first caller in the window; every repeat of
        // the same category within it is a re-statement of a fact the graph
        // has already been told.
        let claimed: Option<String> = redis::cmd("SET")
            .arg(graph_key(workspace_id, graph_id, &format!("bcast:{kind}")))
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(BROADCAST_WINDOW_SECS)
            .query_async(&mut conn)
            .await
            .unwrap_or(None);
        if claimed.is_none() {
            return false;
        }

        // Then the ceiling across all categories. Counted after the dedupe so
        // repeats of one category cannot consume the budget that lets a
        // genuinely different finding through.
        let rate_key = graph_key(workspace_id, graph_id, "bcast:rate");
        let count: i64 = conn.incr(&rate_key, 1).await.unwrap_or(0);
        if count == 1 {
            let _: Result<(), redis::RedisError> =
                conn.expire(&rate_key, BROADCAST_WINDOW_SECS as i64).await;
        }
        if count > BROADCAST_MAX_PER_WINDOW {
            tracing::warn!(
                graph_id,
                kind,
                count,
                "Graph broadcast rate ceiling reached — suppressing"
            );
            return false;
        }
        true
    }

    async fn request_loop_review(&self, loop_run_id: &str, reason: &str) {
        let mut conn = self.conn();
        // SET NX: the first reason wins. Concurrent replicas tripping the same
        // hold must not overwrite each other's message, and re-tripping must not
        // reset anything. No TTL — a hold that expires releases itself.
        let _: Result<bool, redis::RedisError> = redis::cmd("SET")
            .arg(loop_review_key(loop_run_id))
            .arg(reason)
            .arg("NX")
            .query_async(&mut conn)
            .await;
    }

    async fn incr_reask_attempt(&self, session_id: &str, detector_id: &str) -> u32 {
        let mut conn = self.conn();
        let key = reask_attempt_key(session_id, detector_id);

        let n: Result<i64, redis::RedisError> = redis::cmd("INCR")
            .arg(&key)
            .query_async(&mut conn)
            .await;

        let Ok(n) = n else {
            // Counter unreachable. Report "first time" — see the trait doc: the
            // alternative direction turns a cache outage into blocked agents.
            tracing::warn!(
                session_id = %session_id,
                detector = %detector_id,
                "Reask counter unavailable; treating this as the first attempt"
            );
            return 1;
        };

        // Set the TTL only on the key we just created. Refreshing it on every
        // trip would make a slow drip immortal: an agent tripping this once
        // every 59 minutes would keep the window alive forever and eventually
        // escalate, which is exactly the "background noise" case the window
        // exists to forgive.
        if n == 1 {
            let _: Result<bool, redis::RedisError> = redis::cmd("EXPIRE")
                .arg(&key)
                .arg(REASK_WINDOW_SECS)
                .query_async(&mut conn)
                .await;
        }

        n.clamp(1, u32::MAX as i64) as u32
    }

    async fn loop_review_reason(&self, loop_run_id: &str) -> Option<String> {
        let mut conn = self.conn();
        conn.get::<_, Option<String>>(loop_review_key(loop_run_id))
            .await
            .ok()
            .flatten()
    }

    async fn loop_review_cleared(&self, loop_run_id: &str) -> Option<String> {
        let mut conn = self.conn();
        conn.get::<_, Option<String>>(loop_reviewed_key(loop_run_id))
            .await
            .ok()
            .flatten()
    }

    async fn add_workflow_spend(&self, loop_run_id: &str, amount: f64) -> Option<f64> {
        let mut conn = self.conn();
        // No TTL: a loop run's lifetime is bounded by its own status, which is
        // already tracked, and expiring the spend under a live run would reset
        // its budget to zero-spent halfway through.
        conn.incr(loop_spend_key(loop_run_id), amount)
            .await
            .ok()
    }

    async fn set_workflow_budget_if_absent(&self, loop_run_id: &str, budget: f64) -> bool {
        let mut conn = self.conn();
        // NX so a control-plane-set ceiling always wins. No TTL, for the same
        // reason the spend counter has none: expiring the ceiling mid-run would
        // silently uncap a workflow that was capped.
        conn.set_nx::<_, _, bool>(loop_budget_key(loop_run_id), budget)
            .await
            .unwrap_or(false)
    }

    async fn workflow_budget(&self, loop_run_id: &str) -> (Option<f64>, Option<f64>) {
        let mut conn = self.conn();
        let spend = conn
            .get::<_, Option<f64>>(loop_spend_key(loop_run_id))
            .await
            .ok()
            .flatten();
        let budget = conn
            .get::<_, Option<f64>>(loop_budget_key(loop_run_id))
            .await
            .ok()
            .flatten();
        (spend, budget)
    }

    async fn push_session_chunk(
        &self,
        session_id: &str,
        payload: &str,
        ttl_secs: Option<u64>,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let key = format!("session:chunks:{}", session_id);
        let _: () = conn.rpush(&key, payload).await?;
        if let Some(ttl) = ttl_secs {
            let _: Result<(), redis::RedisError> = conn.expire(&key, ttl as i64).await;
        }
        Ok(())
    }

    async fn pinned_sop_block(&self, scope: &PinScope) -> Option<PinnedSopBlock> {
        let mut conn = self.conn();
        let raw: Option<String> = conn.get(sop_pin_key(scope)).await.unwrap_or(None);
        // A present key is unexpired by construction — Valkey drops the key
        // itself once its TTL elapses, so there is no separate staleness
        // check to make here the way `MemoryStore` needs one.
        raw.and_then(|s| serde_json::from_str(&s).ok())
    }

    async fn pin_sop_block(
        &self,
        scope: &PinScope,
        block: &PinnedSopBlock,
        ttl_secs: u64,
    ) -> PinnedSopBlock {
        let mut conn = self.conn();
        let key = sop_pin_key(scope);
        let Ok(encoded) = serde_json::to_string(block) else {
            // Cannot even serialise our own render — nothing to pin, fail
            // toward serving what we just built rather than blocking.
            return block.clone();
        };

        // `SET key val NX EX ttl GET` in one round trip: NX means the write
        // only lands if the key is absent (the concurrency guard two racing
        // "first request in this window" callers need); GET returns
        // whatever was already there regardless of whether NX blocked this
        // write, or nil when the key was absent and our write won. That is
        // exactly the "converge on one winner" signal `resolve_injection_block`
        // needs, in one call rather than a check-then-set race of our own.
        let previous: Option<String> = redis::cmd("SET")
            .arg(&key)
            .arg(&encoded)
            .arg("NX")
            .arg("EX")
            .arg(ttl_secs)
            .arg("GET")
            .query_async(&mut conn)
            .await
            .unwrap_or(None);

        match previous.and_then(|s| serde_json::from_str::<PinnedSopBlock>(&s).ok()) {
            // A concurrent writer already held the key — its bytes are the
            // pin now; use them instead of our own, so every racer converges
            // on one block.
            Some(winner) => winner,
            // Either no key existed (our SET won and wrote `block`), or the
            // existing value failed to parse (corrupt entry — proceed as if
            // we won; our fresh write already overwrote it as far as NX is
            // concerned only when absent, but a parse failure here is not
            // worth a second round trip to disambiguate).
            None => block.clone(),
        }
    }
}

pub struct ValkeyControlPlaneCache {
    conn: Arc<ConnectionManager>,
}

impl ValkeyControlPlaneCache {
    pub fn new(conn: Arc<ConnectionManager>) -> Self {
        Self { conn }
    }

    fn conn(&self) -> ConnectionManager {
        self.conn.as_ref().clone()
    }

    /// Read a key under [`GATE_TIMEOUT`], collapsing error and timeout into
    /// `None` — every caller of this fails open.
    async fn get_gated(&self, key: String) -> Option<String> {
        let mut conn = self.conn();
        match tokio::time::timeout(GATE_TIMEOUT, conn.get::<_, Option<String>>(&key)).await {
            Ok(Ok(v)) => v,
            _ => None,
        }
    }

    /// Read two keys in one round trip, under the same gate.
    ///
    /// Exists so the loop gate can consult the state blob and the review hold
    /// without paying twice. Two sequential `get_gated` calls would double both
    /// the latency and the timeout budget on a path taken by every request of
    /// every governed run.
    async fn mget_gated(
        &self,
        a: String,
        b: String,
    ) -> Option<(Option<String>, Option<String>)> {
        let mut conn = self.conn();
        let mut cmd = redis::cmd("MGET");
        cmd.arg(&a).arg(&b);
        let fut = cmd.query_async::<_, (Option<String>, Option<String>)>(&mut conn);
        match tokio::time::timeout(GATE_TIMEOUT, fut).await {
            Ok(Ok(v)) => Some(v),
            _ => None,
        }
    }
}

#[async_trait]
impl ControlPlaneCache for ValkeyControlPlaneCache {
    async fn bandit_keywords(&self, workspace_id: &str) -> Option<serde_json::Value> {
        let mut conn = self.conn();
        let key = format!("workspace:bandit_keywords:{}", workspace_id);
        match tokio::time::timeout(KEYWORDS_TIMEOUT, conn.get::<_, Option<String>>(&key)).await {
            Ok(Ok(Some(s))) => serde_json::from_str(&s).ok(),
            _ => None,
        }
    }

    async fn active_sop_tier(&self, workspace_id: &str) -> Option<String> {
        let mut conn = self.conn();
        let key = format!("workspace:active_sop_tier:{}", workspace_id);
        conn.get::<_, Option<String>>(&key)
            .await
            .ok()
            .flatten()
            .filter(|s| !s.is_empty())
    }

    async fn allowed_models(&self, workspace_id: &str) -> Option<Vec<String>> {
        let mut conn = self.conn();
        let key = format!("workspace:allowed_models:{}", workspace_id);
        match tokio::time::timeout(KEYWORDS_TIMEOUT, conn.get::<_, Option<String>>(&key)).await {
            Ok(Ok(Some(s))) => serde_json::from_str::<Vec<String>>(&s).ok(),
            _ => None,
        }
    }

    async fn feature_flags(&self, workspace_id: &str) -> Option<FeatureFlags> {
        // Absent, unreadable, or too slow — all fail open to "no control
        // plane", which is what the pre-trait code did via its
        // `flags_key_present` sentinel.
        let raw = self
            .get_gated(format!("workspace:feature_flags:{}", workspace_id))
            .await?;

        // Present but unparseable is still present: all flags false, never a
        // fallback to local config.
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return Some(FeatureFlags::default());
        };
        let flag = |name: &str| json.get(name).and_then(|v| v.as_bool()).unwrap_or(false);
        Some(FeatureFlags {
            bandit_routing: flag("ff_bandit_routing"),
            shadow_routing: flag("ff_shadow_routing"),
            response_cache_exact: flag("ff_response_cache_exact"),
            response_cache_semantic: flag("ff_response_cache_semantic"),
            shadow_enforcement: flag("ff_shadow_enforcement"),
        })
    }

    async fn auth_context(&self, token: &str) -> ControlPlaneAuth {
        if token.is_empty() {
            return ControlPlaneAuth::Rejected;
        }
        let key_prefix = if token.len() > 12 { &token[..12] } else { token };

        let mut conn = self.conn();
        let cache_val: Option<String> =
            match conn.get(format!("v2:auth:apikey:{}", key_prefix)).await {
                Ok(v) => v,
                // A control plane exists but is unreachable — fail open, as
                // `Err(e) => None` did before the port.
                Err(_) => return ControlPlaneAuth::Unavailable,
            };

        let Some(auth_str) = cache_val else {
            return ControlPlaneAuth::Rejected;
        };
        let Ok(auth_json) = serde_json::from_str::<serde_json::Value>(&auth_str) else {
            return ControlPlaneAuth::Unavailable;
        };

        // Prove the caller holds the whole token, not just the cache key.
        //
        // This entry is keyed by the token's first 12 characters and, until this
        // check existed, a hit was admitted on that prefix alone — nothing here
        // ever looked at the rest of the token. Those 12 characters are not a
        // secret: the control plane returns them from `listApiKeys` as a "safe
        // projection", the dashboard renders them in its settings panel, the
        // public `POST /api/v1/policy/check` route accepts them in a request
        // body, and **this file's own caller logs them at warn level** — see the
        // `tracing::warn!(token = %key_prefix, …)` sites in `proxy.rs`. So
        // read access to production logs was LLM proxy access for as long as an
        // entry stayed warm.
        //
        // `tokenVerifier` is SHA-256 of the full plaintext token, written by the
        // control plane's API-key middleware, which performs the same check on
        // its own REST surface. A fast hash is right here: the input is a
        // machine-generated token of at least 128 bits, so there is nothing to
        // brute-force, and this runs on the request hot path.
        //
        // A mismatch returns `Rejected` rather than denying, because `Rejected`
        // is this codebase's "not answered from cache" signal — the caller falls
        // through to `validate_key_via_control_plane`, which checks the whole
        // token authoritatively and raises the 401 itself. That endpoint tries
        // every key sharing the prefix, so a collision resolves rather than
        // 401-ing a valid key — the prefix is only 36 bits of entropy, which is
        // not as remote as it sounds. An entry with no
        // verifier predates this field, so it takes the same path: one
        // control-plane round trip per key until the cache turns over, rather
        // than the hole staying open.
        let verifier_ok = auth_json
            .get("tokenVerifier")
            .and_then(|v| v.as_str())
            .is_some_and(|stored| constant_time_eq(stored.as_bytes(), sha256_hex(token).as_bytes()));
        if !verifier_ok {
            return ControlPlaneAuth::Rejected;
        }

        let Some(workspace_id) = auth_json.get("workspaceId").and_then(|v| v.as_str()) else {
            return ControlPlaneAuth::Unavailable;
        };
        let member_id = auth_json
            .get("memberId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        // Deactivation tombstone. The control plane purges this key's cache entry
        // when a member is deactivated, but two cases leave a live entry behind: an
        // in-flight validation that re-writes it just after the purge, and a purge
        // DEL that errors. In both, the control plane rejects the key while the
        // proxy would admit it for the rest of the 300s TTL — and an offboarded
        // agent's traffic comes here, not to the control plane, so nothing cleans
        // it up. Checking the tombstone is what makes deactivation immediate at
        // this layer rather than eventually.
        if member_id != "unknown" {
            match conn
                .get::<_, Option<String>>(format!("v2:auth:member_deactivated:{}", member_id))
                .await
            {
                Ok(Some(_)) => return ControlPlaneAuth::Rejected,
                Ok(None) => {}
                // Cannot tell: fail closed via Unavailable (503, retryable) rather
                // than admit a key we could not fully validate.
                Err(_) => return ControlPlaneAuth::Unavailable,
            }
        }

        let spend_val: Option<String> = conn
            .get(budget_daily_key(workspace_id))
            .await
            .unwrap_or(None);
        let limit_val: Option<String> = conn
            .get(budget_daily_limit_key(workspace_id))
            .await
            .unwrap_or(None);

        ControlPlaneAuth::Known(Box::new(VirtualKeyRecord {
            token: token.to_string(),
            key_name: Some(format!("key_{}", key_prefix)),
            team_id: Some(workspace_id.to_string()),
            user_id: Some(member_id.to_string()),
            max_budget: limit_val
                .and_then(|s| s.parse::<f64>().ok())
                .or(Some(100.0)),
            spend: spend_val.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            // Always "*" — see the doc comment on `VirtualKeyRecord::models`
            // in metering.rs. Model enforcement is workspace-level
            // (`ControlPlaneCache::allowed_models`), not per-key.
            models: vec!["*".to_string()],
            expires: None,
            // Written by the control plane's API-key middleware since LLD #71;
            // absent on older cache entries, which org-pinned cells resolve by
            // revalidating rather than guessing.
            org_id: auth_json
                .get("orgId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        }))
    }

    async fn daily_budget(&self, workspace_id: &str) -> Option<(f64, Option<f64>)> {
        let mut conn = self.conn();
        let spend_val: Option<String> = conn
            .get(budget_daily_key(workspace_id))
            .await
            .unwrap_or(None);
        let limit_val: Option<String> = conn
            .get(budget_daily_limit_key(workspace_id))
            .await
            .unwrap_or(None);
        Some((
            spend_val.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            limit_val.and_then(|s| s.parse::<f64>().ok()),
        ))
    }

    async fn hard_block(&self, workspace_id: &str) -> HardCapStatus {
        let mut conn = self.conn();
        match conn
            .get::<_, Option<String>>(format!("v2:budget:hard_block:{}", workspace_id))
            .await
        {
            Ok(Some(v)) if v == "1" => HardCapStatus::Blocked,
            Ok(_) => HardCapStatus::Clear,
            // Unreachable control plane: spend cannot be verified, so the
            // caller must not admit the request on an unverifiable budget.
            Err(e) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %e,
                    "hard-cap check failed; spend is unverifiable"
                );
                HardCapStatus::Unverifiable
            }
        }
    }

    async fn loop_status(&self, loop_run_id: &str) -> Option<String> {
        // Gated like every other control-plane read: this sits on the request
        // path, so a hung Valkey must fail open in bounded time rather than
        // stall the proxy. It previously used a bare `get`, outside GATE_TIMEOUT.
        //
        // The hold is checked in the same round trip as the state blob, so a run
        // held on the previous request is refused on this one even though the
        // status write is still travelling through the trace pipeline. One MGET,
        // same latency as the single GET it replaced — this must not become two
        // sequential reads on the request path.
        let pair: Option<(Option<String>, Option<String>)> = self
            .mget_gated(loop_state_key(loop_run_id), loop_review_key(loop_run_id))
            .await;
        let (raw, held) = pair?;

        if held.is_some() {
            // A terminal status still wins: a rejected run is KILLED, and saying
            // PENDING_REVIEW would invite someone to approve something already
            // refused.
            let status = raw.as_deref().and_then(|r| {
                serde_json::from_str::<serde_json::Value>(r)
                    .ok()?
                    .get("status")?
                    .as_str()
                    .map(str::to_string)
            });
            return match status.as_deref() {
                Some("COMPLETED") | Some("FAILED") | Some("KILLED") => status,
                _ => Some("PENDING_REVIEW".to_string()),
            };
        }

        serde_json::from_str::<serde_json::Value>(&raw?)
            .ok()?
            .get("status")?
            .as_str()
            .map(str::to_string)
    }

    async fn active_loop_run(&self, workspace_id: &str, member_id: Option<&str>) -> Option<String> {
        // Most specific first. The control plane writes both on loop start:
        // the member-scoped pointer, and a workspace-level one for requests
        // whose key record carries no member.
        if let Some(mid) = member_id {
            if let Some(id) = self
                .get_gated(active_loop_key(workspace_id, Some(mid)))
                .await
            {
                return Some(id);
            }
        }
        self.get_gated(active_loop_key(workspace_id, None)).await
    }

    async fn auto_judge_active(&self, scope: JudgeScope, id: &str) -> bool {
        let key = match scope {
            JudgeScope::Session => format!("session:auto_judge:{}", id),
            JudgeScope::Loop => format!("loop:auto_judge:{}", id),
        };
        self.get_gated(key).await.as_deref() == Some("true")
    }

    async fn break_glass_valid(&self, token: &str) -> bool {
        self.get_gated(format!("bg:token:{}", token)).await.is_some()
    }

    async fn transition_baseline(&self, workspace_id: &str) -> Option<String> {
        // Deliberately swallows the error into None, unlike `wasm_plugins` above.
        // A missing or unreachable baseline means "score with the built-in table",
        // which is exactly what None already means here — there is no third outcome
        // to report, and a Result would invite a caller to fail the request over a
        // cache miss on an advisory heuristic.
        let mut conn = self.conn();
        conn.get(format!("v2:transition:{}", workspace_id)).await.ok().flatten()
    }

    async fn wasm_plugins(&self, workspace_id: &str) -> anyhow::Result<Option<String>> {
        let mut conn = self.conn();
        Ok(conn.get(format!("wasm:plugins:{}", workspace_id)).await?)
    }

    async fn wasm_binary(&self, sha256: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let mut conn = self.conn();
        Ok(conn.get(format!("wasm:binary:{}", sha256)).await?)
    }

    async fn predict_gate_threshold(&self, workspace_id: &str) -> Option<f64> {
        let mut conn = self.conn();
        let raw: Option<String> = conn
            .get(format!("tok:predict:gate:{}", workspace_id))
            .await
            .ok()?;
        raw.and_then(|v| v.parse().ok())
    }

    async fn token_baseline(
        &self,
        workspace_id: &str,
        model: &str,
        bucket: &str,
    ) -> Option<TokenBaseline> {
        let mut conn = self.conn();
        // Workspace-specific first, then the global rollup.
        //
        // No task segment. This read `:coding:` as a literal while the writer
        // keyed on the trace's own task type, so only a coding trace could ever
        // have produced a readable baseline — and the writer had no caller at
        // all, so none did. A task-aware baseline needs the task type at
        // *predict* time, which is before the request has been classified, so
        // the agnostic key is the one this reader can actually use.
        let ws_key = format!("tok:baseline:{}:{}:{}", workspace_id, model, bucket);
        if let Some(stats) = read_baseline_hash(&mut conn, &ws_key).await {
            return Some(stats);
        }
        let global_key = format!("tok:baseline:global:{}:{}", model, bucket);
        read_baseline_hash(&mut conn, &global_key).await
    }

    /// `GET session:sandbox_attested:{id}` under the same gated-timeout
    /// pattern as `feature_flags`. Written by the control plane's
    /// attest-sandbox handler with a 24h TTL — memory hygiene only, since
    /// attestation is idempotent and never goes stale in the correctness
    /// sense (a session attested once stays attested). Trade-off: a
    /// legitimately long-running sandboxed session with no further requests
    /// to refresh the key could see this read as `false` after 24h — fails
    /// in the safe direction (false negative on a security gate), not
    /// treated as a permanent design.
    async fn is_sandbox_attested(&self, session_id: &str) -> bool {
        self.get_gated(format!("session:sandbox_attested:{}", session_id))
            .await
            .is_some()
    }

    async fn drain_notifications(&self, scope: NotifyScope, id: &str) -> Vec<String> {
        let mut conn = self.conn();
        // For graph scope the caller passes "{graph_id}:{node_id}", because
        // fan-out gives each sibling its own queue — draining a shared one
        // would mean the first reader consumed everyone else's copy.
        let key = format!("{}{}", scope.key_prefix(), id);

        // Fast path — most requests have nothing queued.
        let len: usize = conn.llen(&key).await.unwrap_or(0);
        if len == 0 {
            return Vec::new();
        }

        // Read and delete in one atomic step, so a crash in between cannot
        // deliver the same notification twice.
        let mut pipe = redis::pipe();
        pipe.atomic()
            .cmd("LRANGE")
            .arg(&key)
            .arg(0i64)
            .arg(-1i64)
            .cmd("DEL")
            .arg(&key);

        let drained: Result<(Vec<String>, i64), redis::RedisError> =
            pipe.query_async(&mut conn).await;
        match drained {
            Ok((items, _)) => items,
            Err(e) => {
                tracing::debug!(error = %e, "failed to drain notifications");
                Vec::new()
            }
        }
    }

    async fn record_card_deliveries(&self, workspace_id: &str, payloads: &[String]) {
        if payloads.is_empty() {
            return;
        }
        let mut conn = self.conn();
        let key = format!("gov:delivered:{}", workspace_id);
        // Fire-and-forget, same posture as `publish_notification`: the cards
        // were already appended to the response, and a lost marker only costs
        // one dataset row its `delivered_at`.
        let _: Result<(), redis::RedisError> = conn.rpush(&key, payloads).await;
        let _: Result<(), redis::RedisError> = conn.ltrim(&key, -DELIVERED_MARKER_CAP, -1).await;
        let _: Result<(), redis::RedisError> = conn.expire(&key, DELIVERED_MARKER_TTL_SECS).await;
    }
}

/// `HMGET count sum reasoning_sum` on a baseline hash. `None` when the hash is
/// absent or reports zero samples.
async fn read_baseline_hash(
    conn: &mut ConnectionManager,
    key: &str,
) -> Option<TokenBaseline> {
    let values: Vec<Option<String>> = redis::cmd("HMGET")
        .arg(key)
        .arg("count")
        .arg("sum")
        .arg("reasoning_sum")
        .query_async(conn)
        .await
        .ok()?;

    let count: u64 = values.first()?.as_ref()?.parse().ok()?;
    if count == 0 {
        return None;
    }
    let sum: f64 = values.get(1)?.as_ref()?.parse().ok()?;
    let reasoning_sum: f64 = values
        .get(2)
        .and_then(|v| v.as_ref())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);

    Some(TokenBaseline {
        count,
        sum,
        reasoning_sum,
    })
}

#[cfg(test)]
mod token_verifier {
    //! The cache key is a published prefix, so the entry must prove more than it.
    //!
    //! `auth_context` looks the entry up by `token[..12]`, and those twelve
    //! characters are handed out deliberately: the control plane returns them as
    //! a "safe projection", the dashboard prints them, and `proxy.rs` logs them
    //! at warn level. Admitting on the key alone made log-read access equal to
    //! proxy access for the lifetime of a warm entry.

    use super::{constant_time_eq, sha256_hex};

    /// Must match the control plane's `hashKeySha256`, which is plain lowercase
    /// hex SHA-256 of the token. A different encoding on either side turns every
    /// cache hit into a control-plane round trip — a silent performance cliff
    /// rather than a visible break, which is why this pins the digest itself.
    #[test]
    fn digest_matches_the_control_plane_encoding() {
        // SHA-256 of "abc", the standard vector.
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex("abc").len(), 64, "lowercase hex, not base64");
    }

    #[test]
    fn a_forged_tail_does_not_match_a_real_prefix() {
        // The attack: the first 12 characters are known, the rest is guessed.
        let real = "vk_0123456789abcdef_ws_victim";
        let forged = "vk_0123456789_the_rest_is_guessed";
        assert_eq!(&real[..12], &forged[..12], "the premise: prefixes collide");
        assert!(
            !constant_time_eq(sha256_hex(real).as_bytes(), sha256_hex(forged).as_bytes()),
            "a shared prefix must not produce a shared verifier",
        );
    }

    #[test]
    fn the_whole_token_matches_itself() {
        let t = "vk_0123456789abcdef_ws_victim";
        assert!(constant_time_eq(
            sha256_hex(t).as_bytes(),
            sha256_hex(t).as_bytes()
        ));
    }

    /// The comparison must not return early on the first differing byte.
    #[test]
    fn comparison_examines_every_byte() {
        // Differing in the LAST byte must be as false as differing in the first,
        // and neither may short-circuit. `==` on slices is permitted to stop at
        // the first mismatch, which is what this replaces.
        assert!(!constant_time_eq(b"aaaaaaaa", b"aaaaaaab"));
        assert!(!constant_time_eq(b"baaaaaaa", b"aaaaaaaa"));
        assert!(!constant_time_eq(b"short", b"longer_value"));
        assert!(constant_time_eq(b"identical", b"identical"));
    }

    /// An entry written before `tokenVerifier` existed must not be usable.
    ///
    /// Read as source text because the alternative — admitting a verifier-less
    /// entry "for compatibility" — is precisely how this hole would be reopened
    /// during a rollout, and it would look like a considerate migration.
    #[test]
    fn a_missing_verifier_is_not_a_pass() {
        let src = include_str!("valkey.rs");
        let guard = src
            .split("let verifier_ok = auth_json")
            .nth(1)
            .expect("the verifier check is present in auth_context");
        let body = &guard[..guard.find("if !verifier_ok").unwrap_or(guard.len())];
        assert!(
            body.contains("is_some_and"),
            "an absent tokenVerifier must fail the check, not skip it: {body}"
        );
        assert!(
            src.contains("if !verifier_ok {\n            return ControlPlaneAuth::Rejected;"),
            "a mismatch must return Rejected, which falls through to the control plane",
        );
    }
}

#[cfg(test)]
mod deactivation_contract {
    //! The proxy and the control plane must agree on the deactivation tombstone,
    //! byte for byte. They are written in different languages and read at different
    //! layers, so a rename on either side silently reopens the hole this closes:
    //! the control plane would reject a deactivated member's key while the proxy
    //! kept admitting it for the rest of the cache TTL — and an offboarded agent's
    //! traffic goes to the proxy, not the control plane.

    /// Must match `memberDeactivatedKey` in `packages/db/src/valkey.ts`.
    #[test]
    fn tombstone_key_matches_the_control_plane() {
        // Reads the production line, not a re-typed copy of it.
        //
        // This asserted that the tombstone format string interpolated its
        // argument — that a format macro works. It named the control plane in
        // its own title and never consulted
        // it, so versioning the auth namespace on the TypeScript side would
        // leave it green while every deactivation tombstone became unreadable.
        //
        // The cross-language half lives in the control plane, which can see
        // both: `__tests__/unit/valkeyKeyParity.test.ts` derives the expected
        // template from `memberDeactivatedKey` and greps this file for it. What
        // is checkable from here is that the source contains exactly one such
        // literal, so that test has a single unambiguous thing to match.
        let src = include_str!("valkey.rs");
        let needle = ["v2:auth:member_", "deactivated:{}"].concat();
        assert_eq!(
            src.matches(&needle).count(),
            1,
            "exactly one tombstone key literal, or the parity test cannot pin it",
        );
    }

    /// The control plane sets MEMBER_DEACTIVATED_TTL = API_KEY_LOOKUP_TTL * 4.
    /// If the tombstone could expire before a cached auth entry, a deactivated
    /// member's key would come back to life when the tombstone lapsed.
    #[test]
    fn tombstone_outlives_any_cached_auth_entry() {
        // The relationship is asserted where both constants are visible.
        //
        // This declared its own `API_KEY_LOOKUP_TTL = 300` and
        // `MEMBER_DEACTIVATED_TTL = 300 * 4` and then asserted `1200 > 300`.
        // Arithmetic on local copies, not a contract: shortening the real
        // tombstone TTL in the control plane would leave this passing while a
        // deactivated member's cached key came back to life the moment the
        // tombstone lapsed.
        //
        // Both constants live in `packages/db/src/valkey.ts`, which is where
        // the ordering is now asserted. This side keeps only what it can see:
        // that the proxy reads the tombstone at all, on the auth path.
        let src = include_str!("valkey.rs");
        let needle = ["v2:auth:member_", "deactivated:"].concat();
        assert!(
            src.contains(&needle),
            "the proxy no longer reads the deactivation tombstone",
        );
    }

    /// `auth_context` skips the tombstone read when memberId is absent from the
    /// cached blob, since there is nothing to key it on — and that is exactly why
    /// the control-plane side treats a missing memberId as an unusable cache entry
    /// rather than trusting it.
    #[test]
    fn unknown_member_sentinel_is_the_documented_value() {
        assert_eq!("unknown", "unknown");
    }
}

#[cfg(test)]
mod loop_key_contract {
    use super::*;

    /// These strings are a cross-repo contract with
    /// `services/control-plane/src/services/loopGovernanceService.ts`. The
    /// control plane wrote only the state blob while this proxy read the two
    /// scalars, so budgets never enforced and the dashboard Kill never
    /// reached the request path. The detector unit tests could not catch it:
    /// they populate RequestContext directly and never touch a key name.
    #[test]
    fn loop_keys_match_the_control_plane() {
        assert_eq!(loop_state_key("lr_1"), "intutic:loop:lr_1");
        assert_eq!(loop_spend_key("lr_1"), "intutic:loop:lr_1:spend");
        assert_eq!(loop_budget_key("lr_1"), "intutic:loop:lr_1:budget");
    }

    #[test]
    fn active_loop_pointer_prefers_the_member_scope() {
        assert_eq!(
            active_loop_key("ws_1", Some("mbr_9")),
            "intutic:active_loop:ws_1:mbr_9"
        );
        assert_eq!(active_loop_key("ws_1", None), "intutic:active_loop:ws_1");
    }

    /// The state key must not collide with its own scalars — a prefix bug here
    /// would make `loop_status` parse a bare decimal as JSON and fail open.
    #[test]
    fn state_key_is_not_a_prefix_of_a_scalar_read() {
        let state = loop_state_key("lr_1");
        assert_ne!(state, loop_spend_key("lr_1"));
        assert_ne!(state, loop_budget_key("lr_1"));
        assert!(loop_spend_key("lr_1").starts_with(&state));
    }

    /// The loop gate must consult the state blob and the hold in ONE round trip.
    ///
    /// This sits on the request path of every governed run. Two sequential
    /// `get_gated` calls would double both the latency and the timeout budget
    /// there — and the change would look harmless in review, because the
    /// behaviour is identical and only the cost differs. Asserted against the
    /// source because a behavioural test cannot see the difference.
    #[test]
    fn the_loop_gate_reads_the_hold_in_one_round_trip() {
        let src = include_str!("valkey.rs");
        let body_start = src
            .find("async fn loop_status(&self, loop_run_id: &str) -> Option<String> {")
            .expect("loop_status must exist");
        let body_end = body_start
            + src[body_start..]
                .find("\n    }\n")
                .expect("loop_status must terminate");
        let body = &src[body_start..body_end];

        assert!(
            body.contains("mget_gated"),
            "loop_status must read the state blob and the review hold together"
        );
        // `self.get_gated(` and not `get_gated(` — the latter is a substring of
        // `mget_gated(` and would match the very call this test wants.
        assert_eq!(
            body.matches("self.get_gated(").count(),
            0,
            "a second single-key read on this path doubles the gate's cost per request"
        );
    }

    /// The hold key and the state key must not collide, or writing one would
    /// destroy the other. Same class of check as the spend/budget key test.
    #[test]
    fn the_review_keys_are_distinct_from_the_state_key() {
        let id = "lr_1";
        let keys = [
            loop_state_key(id),
            loop_review_key(id),
            loop_reviewed_key(id),
        ];
        assert_eq!(keys[0], "intutic:loop:lr_1");
        assert_eq!(keys[1], "intutic:loop:lr_1:review");
        assert_eq!(keys[2], "intutic:loop:lr_1:reviewed");
        let mut sorted = keys.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "loop keys must not collide");
    }
}

#[cfg(test)]
mod graph_tenancy_tests {
    use super::*;

    /// TD-208: the workspace segment is the whole tenancy boundary here.
    ///
    /// `graph_id` arrives as client-supplied free text on a `baggage` header
    /// and defaults to the session id, so two tenants CAN choose the same one.
    /// If the workspace segment were ever dropped they would share a
    /// membership set, a spend counter feeding the budget detector, a
    /// broadcast rate ceiling, and each other's notification queues — and
    /// isolation would be an accident of id uniqueness rather than a property.
    #[test]
    fn two_tenants_sharing_a_graph_id_share_no_key() {
        let a = "ws_alpha";
        let b = "ws_beta";
        let shared_graph = "graph-1"; // the collision the header makes possible

        for suffix in ["nodes", "spend", "bcast:rate", "bcast:BUDGET_BREACH"] {
            let ka = graph_key(a, shared_graph, suffix);
            let kb = graph_key(b, shared_graph, suffix);
            assert_ne!(
                ka, kb,
                "tenants {a} and {b} collide on graph key `{suffix}` — a shared spend \
                 counter, membership set or notification queue across tenants"
            );
            assert!(ka.contains(a), "workspace segment missing from {ka}");
            assert!(kb.contains(b), "workspace segment missing from {kb}");
        }
    }

    /// The workspace comes FIRST, so a prefix scan by tenant is possible and a
    /// graph id cannot be crafted to impersonate one.
    #[test]
    fn the_workspace_segment_leads_the_key() {
        let k = graph_key("ws_alpha", "g1", "nodes");
        assert_eq!(k, "graph:ws_alpha:g1:nodes");
        assert!(
            k.starts_with("graph:ws_alpha:"),
            "workspace must lead: a trailing segment lets a crafted graph_id \
             like `x:nodes` reshape the key"
        );
    }
}
