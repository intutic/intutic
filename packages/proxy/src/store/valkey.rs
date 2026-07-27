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
    CachedResponse, ClaimOutcome, ControlPlaneAuth, ControlPlaneCache, FeatureFlags, JudgeScope,
    LocalStore, Ownership, SessionRouting,
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

    async fn hard_block(&self, workspace_id: &str) -> bool {
        let mut conn = self.conn();
        let value: Option<String> = conn
            .get(format!("v2:budget:hard_block:{}", workspace_id))
            .await
            .unwrap_or(None);
        value.as_deref() == Some("1")
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
}
