//! Integration tests for the local deterministic reward loop.
//!
//! Since the storage spike these run over *both* `LocalStore` implementations.
//! `MemoryStore` always runs; `ValkeyStore` runs additionally when `VALKEY_URL`
//! is set (e.g. `redis://127.0.0.1:6379`), so `cargo test` stays green on
//! machines without Valkey while still covering the path that ships.
//!
//! Backend-specific tests — wire format, cloud takeover — are marked as such
//! and skip when Valkey is absent.

use intutic_proxy::config::RewardConfig;
use intutic_proxy::routing::bandit::route_model;
use intutic_proxy::routing::reward::{apply_update, RewardEngine, RewardSignals};
use intutic_proxy::store::{
    CachedResponse, ControlPlaneAuth, ControlPlaneCache, FeatureFlags, JudgeScope, LocalStore,
    MemoryStore, NullControlPlaneCache, Ownership, ValkeyControlPlaneCache, ValkeyStore,
};
use redis::AsyncCommands;
use std::sync::Arc;

const MODEL: &str = "claude-3-5-sonnet";
const SOP_TIER: &str = "TIER_1";
const TASK_TYPE: &str = "coding";

/// Agreement bound between the Lua path and the Rust path. Two sources of
/// divergence, both bounded and both on the Valkey side:
///
///   * arithmetic — Lua computes `math.log(n)/math.log(2)`, Rust uses `log2`
///   * serialization — `cjson.encode` emits `%.14g`, so every arm round-trips
///     through 14 significant digits while `MemoryStore` keeps the f64
///
/// Serialization dominates by roughly three orders of magnitude, which is the
/// interesting direction: the in-memory store is *more* precise than Valkey,
/// so moving a workspace local cannot lose fidelity.
const EPSILON: f64 = 1e-12;

type Backend = (&'static str, Arc<dyn LocalStore>, Arc<dyn ControlPlaneCache>);

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

/// Every backend under test. Memory always; Valkey when reachable.
async fn backends() -> Vec<Backend> {
    let mut out: Vec<Backend> = vec![(
        "memory",
        Arc::new(MemoryStore::new()),
        Arc::new(NullControlPlaneCache),
    )];
    if let Some(conn) = valkey_conn().await {
        out.push((
            "valkey",
            Arc::new(ValkeyStore::new(conn.clone())),
            Arc::new(ValkeyControlPlaneCache::new(conn)),
        ));
    } else {
        eprintln!("note: VALKEY_URL not set or unreachable — Valkey backend skipped");
    }
    out
}

/// Unique workspace id per test run so parallel/repeated runs never collide.
fn unique_ws(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("test-reward-{}-{}", tag, nanos)
}

fn success_signals() -> RewardSignals {
    RewardSignals {
        upstream_ok: true,
        latency_ms: 1_000,
        token_anomaly: false,
        raw_cost_usd: 0.01,
        actual_cost_usd: 0.01,
    }
}

fn arm_field() -> String {
    format!("arm:{}:{}:{}", MODEL, SOP_TIER, TASK_TYPE)
}

/// Valkey-only cleanup; `MemoryStore` is dropped with the test.
async fn cleanup(ws: &str, session: Option<&str>) {
    let Some(valkey) = valkey_conn().await else {
        return;
    };
    let mut conn = valkey.as_ref().clone();
    let _: Result<(), _> = conn.del(format!("bandit:{}", ws)).await;
    let _: Result<(), _> = conn.del(format!("bandit:reward_mode:{}", ws)).await;
    if let Some(sid) = session {
        let _: Result<(), _> = conn.del(format!("session:metadata:{}", sid)).await;
    }
}

#[tokio::test]
async fn local_mode_claims_ownership_and_updates_arm() {
    for (name, store, _cp) in backends().await {
        let ws = unique_ws("claim");
        let engine = RewardEngine::new();
        let cfg = RewardConfig::default();

        engine
            .record(&store, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
            .await;

        assert_eq!(
            store.reward_mode(&ws).await.unwrap(),
            Some(Ownership::Local),
            "[{name}] first local update must claim ownership"
        );

        let arms = store.load_arms(&ws).await.unwrap();
        let arm = arms
            .get(&arm_field())
            .unwrap_or_else(|| panic!("[{name}] arm must exist"));
        // pulls 0 → scale 1.0; clean success reward = 1.0 → alpha 2.0, beta 1.0.
        assert_eq!(arm.pulls, 1, "[{name}]");
        assert!((arm.alpha - 2.0).abs() < 1e-6, "[{name}] alpha={}", arm.alpha);
        assert!((arm.beta - 1.0).abs() < 1e-6, "[{name}] beta={}", arm.beta);
        assert!(!arm.last_updated.is_empty(), "[{name}]");

        cleanup(&ws, None).await;
    }
}

/// Valkey-only by construction, not by omission: a `"cloud"` marker is written
/// by the control plane, and a standalone `MemoryStore` has no control plane
/// that could write one. The trait deliberately exposes no way to set it.
#[tokio::test]
async fn cloud_marker_suppresses_local_writes() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("cloud");
    let mut conn = valkey.as_ref().clone();
    let _: () = conn
        .set(format!("bandit:reward_mode:{}", ws), "cloud")
        .await
        .unwrap();

    let store: Arc<dyn LocalStore> = Arc::new(ValkeyStore::new(valkey.clone()));
    let engine = RewardEngine::new();
    engine
        .record(
            &store,
            &ws,
            MODEL,
            SOP_TIER,
            TASK_TYPE,
            success_signals(),
            &RewardConfig::default(),
        )
        .await;

    assert!(
        store.load_arms(&ws).await.unwrap().is_empty(),
        "cloud-owned workspace must receive no local arm writes"
    );

    cleanup(&ws, None).await;
}

#[tokio::test]
async fn twenty_rewards_exit_cold_start_and_enable_sampling() {
    for (name, store, cp) in backends().await {
        let ws = unique_ws("coldstart");
        let session = unique_ws("session");
        let engine = RewardEngine::new();
        let cfg = RewardConfig::default();

        for _ in 0..20 {
            engine
                .record(&store, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
                .await;
        }

        let arms = store.load_arms(&ws).await.unwrap();
        let arm = arms.get(&arm_field()).unwrap();
        assert_eq!(arm.pulls, 20, "[{name}]");
        assert!(arm.alpha > 1.0, "[{name}]");

        // With 20 cumulative pulls the router must leave the cold-start bypass
        // and Thompson-sample from the candidate pool.
        let candidates: Vec<String> = vec![
            "claude-3-5-sonnet".to_string(),
            "gpt-4o".to_string(),
            "gemini-2.0-flash".to_string(),
        ];
        let (selected, sop_tier, task_type) = route_model(
            &store,
            &cp,
            &ws,
            &session,
            "gpt-4o",
            "write a function to add two numbers",
            &candidates,
        )
        .await
        .unwrap();
        assert!(
            candidates.contains(&selected),
            "[{name}] sampled model {selected} must come from the candidate pool"
        );
        assert_eq!(sop_tier, "TIER_1", "[{name}]");
        assert_eq!(task_type, "coding", "[{name}]");

        // The sampled choice must be locked for the session.
        let locked = store.session_routing(&session).await.unwrap().locked_model;
        assert_eq!(locked.as_deref(), Some(selected.as_str()), "[{name}]");

        cleanup(&ws, Some(&session)).await;
    }
}

/// The bytes the enterprise reward cron reads must not change. Field names are
/// the contract — `lastUpdated` in particular is camelCase via serde rename,
/// and the Lua script writes it as a literal string key.
#[tokio::test]
async fn valkey_wire_format_is_unchanged() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("wire");
    let store: Arc<dyn LocalStore> = Arc::new(ValkeyStore::new(valkey.clone()));
    let engine = RewardEngine::new();

    engine
        .record(
            &store,
            &ws,
            MODEL,
            SOP_TIER,
            TASK_TYPE,
            success_signals(),
            &RewardConfig::default(),
        )
        .await;

    let mut conn = valkey.as_ref().clone();
    let raw: std::collections::HashMap<String, String> =
        conn.hgetall(format!("bandit:{}", ws)).await.unwrap();
    let arm_json = raw.get(&arm_field()).expect("arm must exist");
    let parsed: serde_json::Value = serde_json::from_str(arm_json).unwrap();

    for field in ["alpha", "beta", "pulls", "lastUpdated"] {
        assert!(
            parsed.get(field).is_some(),
            "wire format lost `{field}`: {arm_json}"
        );
    }
    // And it must still deserialize into the shared struct both sides use.
    let _: intutic_proxy::routing::bandit::BanditArmState =
        serde_json::from_str(arm_json).unwrap();

    cleanup(&ws, None).await;
}

/// No control plane → `None`, which is what lets `config.yaml` decide. Both
/// backends: standalone by construction, and Valkey with no key written.
#[tokio::test]
async fn absent_feature_flags_mean_no_control_plane() {
    for (name, _store, cp) in backends().await {
        let ws = unique_ws("flags-absent");
        assert_eq!(
            cp.feature_flags(&ws).await,
            None,
            "[{name}] absent flags must not resolve to all-false"
        );
        cleanup(&ws, None).await;
    }
}

/// The distinction the `Option` exists to protect: a present-but-malformed
/// payload keeps the control plane authoritative (every flag false) rather
/// than handing control back to local config. Previously this was a comment
/// beside a `flags_key_present` boolean; now it is the return type.
#[tokio::test]
async fn present_but_unparseable_flags_stay_authoritative() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("flags-garbage");
    let mut conn = valkey.as_ref().clone();
    let _: () = conn
        .set(format!("workspace:feature_flags:{}", ws), "}{ not json")
        .await
        .unwrap();

    let cp = ValkeyControlPlaneCache::new(valkey.clone());
    assert_eq!(
        cp.feature_flags(&ws).await,
        Some(FeatureFlags::default()),
        "a malformed payload must stay authoritative, not fall back to config"
    );

    let _: Result<(), _> = conn.del(format!("workspace:feature_flags:{}", ws)).await;
}

#[tokio::test]
async fn feature_flags_parse_from_control_plane_payload() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("flags-parse");
    let mut conn = valkey.as_ref().clone();
    let _: () = conn
        .set(
            format!("workspace:feature_flags:{}", ws),
            r#"{"ff_bandit_routing":true,"ff_response_cache_semantic":true,"ff_unknown":true}"#,
        )
        .await
        .unwrap();

    let cp = ValkeyControlPlaneCache::new(valkey.clone());
    assert_eq!(
        cp.feature_flags(&ws).await,
        Some(FeatureFlags {
            bandit_routing: true,
            response_cache_exact: false, // omitted → false, not an error
            response_cache_semantic: true,
        })
    );

    let _: Result<(), _> = conn.del(format!("workspace:feature_flags:{}", ws)).await;
}

/// The single most dangerous confusion in the port. `validate_virtual_key` used
/// to return `KeyNotFound` for a missing `v2:auth:apikey:*`, which `proxy.rs`
/// turns into a 401. Standalone has no such key for *any* token, so a null cache
/// that reported "not found" would reject every request ever made. `Unmanaged`
/// is a distinct variant precisely so that cannot happen.
#[tokio::test]
async fn standalone_auth_is_unmanaged_not_rejected() {
    let cp = NullControlPlaneCache;
    for token in ["", "sk-ant-whatever", "vk_live_123"] {
        assert!(
            matches!(cp.auth_context(token).await, ControlPlaneAuth::Unmanaged),
            "standalone must never reject a key it has no way to know about (token {token:?})"
        );
    }
}

/// The mirror of the above: with a control plane present, an unknown key is
/// still a 401. Standalone permissiveness must not leak into the managed path.
#[tokio::test]
async fn managed_auth_still_rejects_unknown_keys() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let cp = ValkeyControlPlaneCache::new(valkey);
    let unknown = format!("vk_nonexistent_{}", unique_ws("auth"));
    assert!(
        matches!(cp.auth_context(&unknown).await, ControlPlaneAuth::Rejected),
        "a managed deployment must still 401 an unrecognised key"
    );
}

/// Standalone must not silently enable paid-tier or control-plane-gated
/// behaviour. These are constants, but they are constants the standalone
/// security posture depends on.
#[tokio::test]
async fn standalone_gates_are_all_closed() {
    let cp = NullControlPlaneCache;
    assert!(!cp.hard_block("ws").await, "no cap without a control plane");
    assert!(
        !cp.break_glass_valid("any-token").await,
        "no issuer means no valid break-glass token"
    );
    assert!(
        !cp.auto_judge_active(JudgeScope::Session, "s").await,
        "auto-judge is a control-plane feature"
    );
    assert!(!cp.auto_judge_active(JudgeScope::Loop, "l").await);
    assert_eq!(cp.loop_status("run").await, None);
    assert_eq!(cp.wasm_plugins("ws").await.unwrap(), None);
    assert_eq!(cp.wasm_binary("deadbeef").await.unwrap(), None);
}

/// Tool-sequence anomaly detection keeps only the newest `cap` entries, and
/// both backends must agree on which ones — an off-by-one here silently changes
/// what the WASM rules see.
#[tokio::test]
async fn tool_sequence_trims_to_the_newest_entries() {
    for (name, store, _cp) in backends().await {
        let session = unique_ws("tools");
        let batch: Vec<String> = (0..25).map(|i| format!("tool_{i:02}")).collect();

        let got = store
            .record_tool_sequence(&session, &batch, 20)
            .await
            .unwrap();

        assert_eq!(got.len(), 20, "[{name}] must trim to the cap");
        assert_eq!(got.first().unwrap(), "tool_05", "[{name}] oldest kept");
        assert_eq!(got.last().unwrap(), "tool_24", "[{name}] newest kept");

        // A read with nothing new must not disturb the stored sequence.
        let again = store.record_tool_sequence(&session, &[], 20).await.unwrap();
        assert_eq!(again, got, "[{name}] empty append is a pure read");

        if let Some(valkey) = valkey_conn().await {
            let mut conn = valkey.as_ref().clone();
            let _: Result<(), _> = conn.del(format!("v2:session:{}:tools", session)).await;
        }
    }
}

/// The response cache round-trips through both backends with its camelCase
/// wire format intact — the field names the control plane also reads.
#[tokio::test]
async fn response_cache_round_trips_and_preserves_wire_format() {
    for (name, store, _cp) in backends().await {
        let hash = format!("spike{}", unique_ws("cache").replace('-', ""));
        assert!(
            store.cached_response(&hash).await.is_none(),
            "[{name}] cold cache must miss"
        );

        let entry = CachedResponse {
            prompt: "p".into(),
            response: "r".into(),
            model: MODEL.into(),
            prompt_tokens: 11,
            completion_tokens: 22,
            cached_at: chrono::Utc::now().to_rfc3339(),
        };
        store.store_response(&hash, &entry, 60).await.unwrap();

        let got = store.cached_response(&hash).await.expect("must hit");
        assert_eq!(got.prompt_tokens, 11, "[{name}]");
        assert_eq!(got.completion_tokens, 22, "[{name}]");
        assert_eq!(got.model, MODEL, "[{name}]");

        if let Some(valkey) = valkey_conn().await {
            let mut conn = valkey.as_ref().clone();
            let raw: Option<String> =
                conn.get(format!("cache:response:{}", hash)).await.unwrap();
            if let Some(raw) = raw {
                let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
                for field in ["promptTokens", "completionTokens", "cachedAt"] {
                    assert!(json.get(field).is_some(), "cache lost `{field}`: {raw}");
                }
                let _: Result<(), _> = conn.del(format!("cache:response:{}", hash)).await;
            }
        }
    }
}

/// The point of durability: a per-session CLI proxy restarts constantly, and
/// without this the `>= 20 pulls` gate would never open, so intelligent routing
/// — the headline open-core feature — would never activate.
#[tokio::test]
async fn standalone_learning_survives_restart() {
    let dir = std::env::temp_dir().join(unique_ws("durable"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bandit-state.json");
    let ws = unique_ws("persist");
    let cfg = RewardConfig::default();

    // First "process": 20 rewards, enough to clear the cold-start gate.
    {
        let store: Arc<dyn LocalStore> = Arc::new(MemoryStore::durable_at(path.clone()));
        let engine = RewardEngine::new();
        for _ in 0..20 {
            engine
                .record(&store, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
                .await;
        }
        store
            .set_workspace_credential(&ws, "anthropic_api_key", "sk-ant-secret")
            .await;
    }

    // Second "process": same path, fresh store.
    let store: Arc<dyn LocalStore> = Arc::new(MemoryStore::durable_at(path.clone()));
    let arms = store.load_arms(&ws).await.unwrap();
    let arm = arms.get(&arm_field()).expect("arm must survive restart");
    assert_eq!(arm.pulls, 20, "all pulls must survive");
    assert!(arm.alpha > 1.0);
    assert_eq!(
        store.reward_mode(&ws).await.unwrap(),
        Some(Ownership::Local),
        "local ownership must survive so the second process keeps writing"
    );

    // Credentials must NOT survive — they are never written to disk.
    assert_eq!(
        store
            .workspace_credential(&ws, &["anthropic_api_key"])
            .await,
        None,
        "credentials must never be persisted"
    );
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(
        !raw.contains("sk-ant-secret") && !raw.contains("anthropic_api_key"),
        "snapshot must contain no credential material: {raw}"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A corrupt snapshot must degrade to cold-start, never prevent boot.
#[tokio::test]
async fn corrupt_snapshot_starts_fresh_instead_of_failing() {
    let dir = std::env::temp_dir().join(unique_ws("corrupt"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bandit-state.json");
    std::fs::write(&path, "}{ not json at all").unwrap();

    let store: Arc<dyn LocalStore> = Arc::new(MemoryStore::durable_at(path.clone()));
    assert!(store.load_arms("anything").await.unwrap().is_empty());

    // And it must recover: a subsequent update overwrites the bad file.
    store.update_arm("ws", "arm:a:b:c", 1.0, "now").await.unwrap();
    let reloaded: Arc<dyn LocalStore> = Arc::new(MemoryStore::durable_at(path.clone()));
    assert_eq!(
        reloaded.load_arms("ws").await.unwrap().get("arm:a:b:c").unwrap().pulls,
        1
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// `MemoryStore::new()` must stay ephemeral — tests and the Valkey path rely on
/// it never touching disk.
#[tokio::test]
async fn ephemeral_store_writes_nothing() {
    let before = std::fs::metadata(
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .join(".intutic")
            .join("bandit-state.json"),
    )
    .and_then(|m| m.modified())
    .ok();

    let store: Arc<dyn LocalStore> = Arc::new(MemoryStore::new());
    store.update_arm("ws", "arm:x:y:z", 1.0, "now").await.unwrap();

    let after = std::fs::metadata(
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
            .join(".intutic")
            .join("bandit-state.json"),
    )
    .and_then(|m| m.modified())
    .ok();
    assert_eq!(before, after, "ephemeral store must not touch the snapshot");
}

/// The open-core → Cloud upgrade must not reset the workspace to cold start.
/// Without this, connecting a control plane silently discards every arm and the
/// user watches intelligent routing switch itself off.
#[tokio::test]
async fn upgrading_to_valkey_carries_standalone_learning() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let dir = std::env::temp_dir().join(unique_ws("upgrade"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bandit-state.json");
    let ws = unique_ws("upgrade");
    let cfg = RewardConfig::default();

    // Learn standalone, past the cold-start gate.
    {
        let local: Arc<dyn LocalStore> = Arc::new(MemoryStore::durable_at(path.clone()));
        let engine = RewardEngine::new();
        for _ in 0..20 {
            engine
                .record(&local, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
                .await;
        }
    }

    // Connect a control plane.
    let remote: Arc<dyn LocalStore> = Arc::new(ValkeyStore::new(valkey.clone()));
    let seeded = intutic_proxy::store::migrate_local_learning(&remote, &path)
        .await
        .unwrap();
    assert!(seeded >= 1, "at least the learned arm must carry over");

    let arms = remote.load_arms(&ws).await.unwrap();
    let arm = arms.get(&arm_field()).expect("arm must exist in Valkey");
    assert_eq!(arm.pulls, 20, "pull count must survive the upgrade");

    // Re-running must not double-apply or clobber.
    let again = intutic_proxy::store::migrate_local_learning(&remote, &path)
        .await
        .unwrap();
    assert_eq!(again, 0, "migration must be idempotent");
    let after = remote.load_arms(&ws).await.unwrap();
    assert_eq!(after.get(&arm_field()).unwrap().pulls, 20);

    // And it must never overwrite state the control plane already owns.
    remote
        .update_arm(&ws, &arm_field(), 1.0, "2026-01-01T00:00:00Z")
        .await
        .unwrap();
    let cloud_pulls = remote.load_arms(&ws).await.unwrap()[&arm_field()].pulls;
    intutic_proxy::store::migrate_local_learning(&remote, &path)
        .await
        .unwrap();
    assert_eq!(
        remote.load_arms(&ws).await.unwrap()[&arm_field()].pulls,
        cloud_pulls,
        "migration must never clobber control-plane state"
    );

    cleanup(&ws, None).await;
    std::fs::remove_dir_all(&dir).ok();
}

/// Differential: the Lua path and the Rust path must agree within [`EPSILON`]
/// after enough sequential updates for drift to accumulate. This is the test
/// that justifies the constant rather than asserting it.
#[tokio::test]
async fn backends_agree_within_epsilon() {
    let Some(valkey) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("differential");
    let valkey_store: Arc<dyn LocalStore> = Arc::new(ValkeyStore::new(valkey.clone()));
    let memory_store: Arc<dyn LocalStore> = Arc::new(MemoryStore::new());
    let field = arm_field();

    // Varied rewards — a constant 1.0 would hide scale-dependent divergence.
    let rewards: Vec<f64> = (0..40).map(|i| (i as f64 % 7.0) / 6.0).collect();
    let now = chrono::Utc::now().to_rfc3339();

    for r in &rewards {
        valkey_store.update_arm(&ws, &field, *r, &now).await.unwrap();
        memory_store.update_arm(&ws, &field, *r, &now).await.unwrap();
    }

    let v_arms = valkey_store.load_arms(&ws).await.unwrap();
    let m_arms = memory_store.load_arms(&ws).await.unwrap();
    let v = v_arms.get(&field).unwrap();
    let m = m_arms.get(&field).unwrap();

    assert_eq!(v.pulls, m.pulls, "pull counts are integers and must be exact");
    let d_alpha = (v.alpha - m.alpha).abs();
    let d_beta = (v.beta - m.beta).abs();
    eprintln!(
        "differential after {} updates: d_alpha={:e} d_beta={:e} (epsilon={:e})",
        rewards.len(),
        d_alpha,
        d_beta,
        EPSILON
    );
    assert!(d_alpha < EPSILON, "alpha drift {d_alpha:e} exceeds {EPSILON:e}");
    assert!(d_beta < EPSILON, "beta drift {d_beta:e} exceeds {EPSILON:e}");

    // Independently: the in-memory result is exactly the in-tree oracle, so
    // any drift is attributable to the Valkey side.
    let (mut a, mut b, mut p) = (1.0_f64, 1.0_f64, 0_u32);
    for r in &rewards {
        (a, b, p) = apply_update(a, b, p, *r);
    }
    assert_eq!(m.pulls, p);
    assert_eq!(m.alpha, a, "memory must match apply_update exactly");
    assert_eq!(m.beta, b, "memory must match apply_update exactly");

    cleanup(&ws, None).await;
}
