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
    JudgeScope, LocalStore, NotifyScope, Ownership, SessionRouting, TokenBaseline,
};
use crate::metering::VirtualKeyRecord;
use crate::routing::bandit::BanditArmState;
use crate::telemetry::ExecutionTrace;

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

fn bandit_key(workspace_id: &str) -> String {
    format!("bandit:{}", workspace_id)
}

fn marker_key(workspace_id: &str) -> String {
    format!("bandit:reward_mode:{}", workspace_id)
}

fn outage_key(workspace_id: &str) -> String {
    format!("bandit:outage_failures:{}", workspace_id)
}

fn session_key(session_id: &str) -> String {
    format!("session:metadata:{}", session_id)
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
        Ok(SessionRouting {
            locked_model: locked_model.filter(|s| !s.is_empty()),
            sop_tier: sop_tier.filter(|s| !s.is_empty()),
        })
    }

    async fn set_session_locked_model(
        &self,
        session_id: &str,
        model: &str,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn();
        let _: () = conn
            .hset(session_key(session_id), "lockedModel", model)
            .await?;
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
        }
        Ok(sequence)
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
                "toolName": trace.task_type,
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

    async fn touch_graph_node(&self, graph_id: &str, node_id: &str, ttl_secs: u64) {
        let mut conn = self.conn();
        let key = format!("graph:{graph_id}:nodes");
        // Two writes, no read — this runs on every request in a graph, so the
        // membership read is deferred to the broadcast path.
        let _: Result<(), redis::RedisError> = conn.sadd(&key, node_id).await;
        let _: Result<(), redis::RedisError> = conn.expire(&key, ttl_secs as i64).await;
    }

    async fn graph_members(&self, graph_id: &str) -> Vec<String> {
        let mut conn = self.conn();
        conn.smembers(format!("graph:{graph_id}:nodes"))
            .await
            .unwrap_or_default()
    }

    async fn first_tool_signature(&self, session_id: &str, signature: &str) -> Option<String> {
        let mut conn = self.conn();
        let key = format!("session:tools:{session_id}");
        // SET NX then GET: the first writer wins and every later request reads
        // back what it recorded, so the comparison is against the session's
        // opening toolset rather than merely the previous request's.
        let _: Result<Option<String>, redis::RedisError> = redis::cmd("SET")
            .arg(&key)
            .arg(signature)
            .arg("NX")
            .arg("EX")
            .arg(86_400)
            .query_async(&mut conn)
            .await;
        conn.get::<_, Option<String>>(&key).await.ok().flatten()
    }

    async fn graph_node_count(&self, graph_id: &str) -> Option<u32> {
        let mut conn = self.conn();
        conn.scard::<_, u32>(format!("graph:{graph_id}:nodes"))
            .await
            .ok()
    }

    async fn is_graph_member(&self, graph_id: &str, node_id: &str) -> Option<bool> {
        let mut conn = self.conn();
        let key = format!("graph:{graph_id}:nodes");
        // An unknown graph is not the same as a dead node — if we never
        // tracked this graph, we have no opinion on who is alive in it.
        let exists: bool = conn.exists(&key).await.ok()?;
        if !exists {
            return None;
        }
        conn.sismember(&key, node_id).await.ok()
    }

    async fn add_graph_spend(&self, graph_id: &str, amount: f64, ttl_secs: u64) -> Option<f64> {
        let mut conn = self.conn();
        let key = format!("graph:{graph_id}:spend");
        let total: f64 = conn.incr(&key, amount).await.ok()?;
        // Same TTL as membership, so a finished graph's cost does not linger
        // and get attributed to a later graph that reuses the id.
        let _: Result<(), redis::RedisError> = conn.expire(&key, ttl_secs as i64).await;
        Some(total)
    }

    async fn graph_spend(&self, graph_id: &str) -> Option<f64> {
        let mut conn = self.conn();
        conn.get::<_, Option<f64>>(format!("graph:{graph_id}:spend"))
            .await
            .ok()
            .flatten()
    }

    async fn claim_broadcast(&self, graph_id: &str, kind: &str) -> bool {
        let mut conn = self.conn();

        // Loop-suppression first, and it is the cheaper check. SET NX EX
        // succeeds only for the first caller in the window; every repeat of
        // the same category within it is a re-statement of a fact the graph
        // has already been told.
        let claimed: Option<String> = redis::cmd("SET")
            .arg(format!("graph:{graph_id}:bcast:{kind}"))
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
        let rate_key = format!("graph:{graph_id}:bcast:rate");
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

    async fn add_workflow_spend(&self, loop_run_id: &str, amount: f64) -> Option<f64> {
        let mut conn = self.conn();
        // No TTL: a loop run's lifetime is bounded by its own status, which is
        // already tracked, and expiring the spend under a live run would reset
        // its budget to zero-spent halfway through.
        conn.incr(format!("intutic:loop:{loop_run_id}:spend"), amount)
            .await
            .ok()
    }

    async fn workflow_budget(&self, loop_run_id: &str) -> (Option<f64>, Option<f64>) {
        let mut conn = self.conn();
        let spend = conn
            .get::<_, Option<f64>>(format!("intutic:loop:{loop_run_id}:spend"))
            .await
            .ok()
            .flatten();
        let budget = conn
            .get::<_, Option<f64>>(format!("intutic:loop:{loop_run_id}:budget"))
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
            response_cache_exact: flag("ff_response_cache_exact"),
            response_cache_semantic: flag("ff_response_cache_semantic"),
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
        let Some(workspace_id) = auth_json.get("workspaceId").and_then(|v| v.as_str()) else {
            return ControlPlaneAuth::Unavailable;
        };
        let member_id = auth_json
            .get("memberId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let spend_val: Option<String> = conn
            .get(format!("v2:budget:daily:{}", workspace_id))
            .await
            .unwrap_or(None);
        let limit_val: Option<String> = conn
            .get(format!("v2:budget:limit:daily:{}", workspace_id))
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
            models: vec!["*".to_string()],
            expires: None,
        }))
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
        let mut conn = self.conn();
        let stored: Option<String> = conn
            .get(format!("intutic:loop:{}", loop_run_id))
            .await
            .unwrap_or(None);
        let raw = stored?;
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()?
            .get("status")?
            .as_str()
            .map(str::to_string)
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
        let ws_key = format!("tok:baseline:{}:{}:coding:{}", workspace_id, model, bucket);
        if let Some(stats) = read_baseline_hash(&mut conn, &ws_key).await {
            return Some(stats);
        }
        let global_key = format!("tok:baseline:global:{}:coding:{}", model, bucket);
        read_baseline_hash(&mut conn, &global_key).await
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
