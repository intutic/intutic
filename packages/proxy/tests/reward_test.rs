//! Integration tests for the local deterministic reward loop.
//!
//! These require a reachable Valkey. Set `VALKEY_URL`
//! (e.g. `redis://127.0.0.1:6379`) to enable them; they skip silently
//! otherwise so `cargo test` stays green on machines without Valkey.

use intutic_proxy::config::RewardConfig;
use intutic_proxy::routing::bandit::{route_model, BanditArmState};
use intutic_proxy::routing::reward::{RewardEngine, RewardSignals};
use redis::AsyncCommands;
use std::sync::Arc;

const MODEL: &str = "claude-3-5-sonnet";
const SOP_TIER: &str = "TIER_1";
const TASK_TYPE: &str = "coding";

async fn connect() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
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

async fn cleanup(valkey: &Arc<redis::aio::ConnectionManager>, ws: &str, session: Option<&str>) {
    let mut conn = valkey.as_ref().clone();
    let _: Result<(), _> = conn.del(format!("bandit:{}", ws)).await;
    let _: Result<(), _> = conn.del(format!("bandit:reward_mode:{}", ws)).await;
    if let Some(sid) = session {
        let _: Result<(), _> = conn.del(format!("session:metadata:{}", sid)).await;
    }
}

#[tokio::test]
async fn local_mode_claims_marker_and_updates_arm() {
    let Some(valkey) = connect().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("claim");
    let engine = RewardEngine::new();
    let cfg = RewardConfig::default();

    engine
        .record(&valkey, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
        .await;

    let mut conn = valkey.as_ref().clone();
    let marker: Option<String> = conn
        .get(format!("bandit:reward_mode:{}", ws))
        .await
        .unwrap();
    assert_eq!(
        marker.as_deref(),
        Some("local"),
        "first local update must claim ownership via SET NX"
    );

    let raw: Option<String> = conn
        .hget(
            format!("bandit:{}", ws),
            format!("arm:{}:{}:{}", MODEL, SOP_TIER, TASK_TYPE),
        )
        .await
        .unwrap();
    let arm: BanditArmState = serde_json::from_str(&raw.expect("arm must exist")).unwrap();
    // pulls 0 → scale 1.0; clean success reward = 1.0 → alpha 2.0, beta 1.0.
    assert_eq!(arm.pulls, 1);
    assert!((arm.alpha - 2.0).abs() < 1e-6, "alpha={}", arm.alpha);
    assert!((arm.beta - 1.0).abs() < 1e-6, "beta={}", arm.beta);
    assert!(!arm.last_updated.is_empty());

    cleanup(&valkey, &ws, None).await;
}

#[tokio::test]
async fn cloud_marker_suppresses_local_writes() {
    let Some(valkey) = connect().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("cloud");
    let mut conn = valkey.as_ref().clone();
    let _: () = conn
        .set(format!("bandit:reward_mode:{}", ws), "cloud")
        .await
        .unwrap();

    let engine = RewardEngine::new();
    engine
        .record(
            &valkey,
            &ws,
            MODEL,
            SOP_TIER,
            TASK_TYPE,
            success_signals(),
            &RewardConfig::default(),
        )
        .await;

    let arms: std::collections::HashMap<String, String> =
        conn.hgetall(format!("bandit:{}", ws)).await.unwrap();
    assert!(
        arms.is_empty(),
        "cloud-owned workspace must receive no local arm writes"
    );

    cleanup(&valkey, &ws, None).await;
}

#[tokio::test]
async fn twenty_rewards_exit_cold_start_and_enable_sampling() {
    let Some(valkey) = connect().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let ws = unique_ws("coldstart");
    let session = unique_ws("session");
    let engine = RewardEngine::new();
    let cfg = RewardConfig::default();

    for _ in 0..20 {
        engine
            .record(&valkey, &ws, MODEL, SOP_TIER, TASK_TYPE, success_signals(), &cfg)
            .await;
    }

    let mut conn = valkey.as_ref().clone();
    let raw: Option<String> = conn
        .hget(
            format!("bandit:{}", ws),
            format!("arm:{}:{}:{}", MODEL, SOP_TIER, TASK_TYPE),
        )
        .await
        .unwrap();
    let arm: BanditArmState = serde_json::from_str(&raw.unwrap()).unwrap();
    assert_eq!(arm.pulls, 20);
    assert!(arm.alpha > 1.0);

    // With 20 cumulative pulls the router must leave the cold-start bypass and
    // Thompson-sample from the candidate pool.
    let candidates: Vec<String> = vec![
        "claude-3-5-sonnet".to_string(),
        "gpt-4o".to_string(),
        "gemini-2.0-flash".to_string(),
    ];
    let (selected, sop_tier, task_type) = route_model(
        &valkey,
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
        "sampled model {selected} must come from the candidate pool"
    );
    assert_eq!(sop_tier, "TIER_1");
    assert_eq!(task_type, "coding");

    // The sampled choice must be locked for the session.
    let locked: Option<String> = conn
        .hget(format!("session:metadata:{}", session), "lockedModel")
        .await
        .unwrap();
    assert_eq!(locked.as_deref(), Some(selected.as_str()));

    cleanup(&valkey, &ws, Some(&session)).await;
}