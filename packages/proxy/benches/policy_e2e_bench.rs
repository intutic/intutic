//! E2E Criterion benchmarks with a LIVE Valkey instance.
//!
//! Run:
//!   docker compose up -d valkey
//!   cargo bench --bench policy_e2e_bench
//!
//! This benchmark measures the REAL proxy overhead including async I/O to
//! Valkey — validating the ADR-003 "<5ms P95" claim under realistic conditions.
//!
//! If Valkey is not available on 127.0.0.1:6379, the benchmark **panics** with
//! a clear message (it cannot degrade to in-memory — that's what policy_bench does).

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use redis::AsyncCommands;
use std::time::Duration;

// ── Fixtures ────────────────────────────────────────────────────────────────

const VALKEY_URL: &str = "redis://127.0.0.1:6379";
const TEST_WORKSPACE: &str = "ws_bench_e2e";
const TEST_VK: &str = "sk-bench-e2e-001";

/// Build a tokio Runtime for async benchmarks.
fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
}

/// Connect to Valkey or panic with a helpful message.
async fn connect() -> redis::aio::ConnectionManager {
    let client = redis::Client::open(VALKEY_URL).expect("Invalid Valkey URL");
    match tokio::time::timeout(
        Duration::from_secs(3),
        redis::aio::ConnectionManager::new(client),
    )
    .await
    {
        Ok(Ok(mgr)) => mgr,
        Ok(Err(e)) => panic!(
            "Cannot connect to Valkey at {VALKEY_URL}: {e}\n\
             Hint: run `docker compose up -d valkey` first."
        ),
        Err(_) => panic!(
            "Timeout connecting to Valkey at {VALKEY_URL}.\n\
             Hint: run `docker compose up -d valkey` first."
        ),
    }
}

/// Seed test keys into Valkey for realistic bench conditions.
async fn seed_keys(conn: &mut redis::aio::ConnectionManager) {
    // Budget key: ABSENT means "not hard-blocked" → pass
    let _: () = redis::cmd("DEL")
        .arg(format!("v2:budget:hard_block:{TEST_WORKSPACE}"))
        .query_async(conn)
        .await
        .unwrap();

    // Virtual key record (JSON) — simulates a valid key lookup
    let vk_json = serde_json::json!({
        "token": TEST_VK,
        "key_name": "bench-key",
        "team_id": "team_bench",
        "user_id": "user_bench",
        "max_budget": 1000.0,
        "spend": 42.50,
        "models": ["gpt-4o", "claude-sonnet-4-20250514"],
    });
    let _: () = conn
        .set(
            format!("v2:vk:{TEST_VK}"),
            serde_json::to_string(&vk_json).unwrap(),
        )
        .await
        .unwrap();

    // Budget key for the "blocked" test case
    let _: () = conn
        .set(
            format!("v2:budget:hard_block:{TEST_WORKSPACE}_blocked"),
            "1",
        )
        .await
        .unwrap();
}

/// Clean up test keys after benchmarks.
async fn cleanup_keys(conn: &mut redis::aio::ConnectionManager) {
    let _: () = redis::cmd("DEL")
        .arg(format!("v2:vk:{TEST_VK}"))
        .arg(format!("v2:budget:hard_block:{TEST_WORKSPACE}_blocked"))
        .query_async(conn)
        .await
        .unwrap_or(());
}

// ── Case 1: Budget gate via Valkey GET ──────────────────────────────────────

/// Benchmarks a single Valkey GET for the budget hard-block check.
/// This is the dominant I/O cost on the hot path.
///
/// Expected: ~0.2-0.5ms on localhost Docker, ~1-2ms cross-AZ.
fn bench_budget_gate_valkey(c: &mut Criterion) {
    let runtime = rt();
    let mut conn = runtime.block_on(connect());
    runtime.block_on(seed_keys(&mut conn));

    let mut group = c.benchmark_group("e2e_budget_gate");
    group.measurement_time(Duration::from_secs(10));

    // Budget check — key ABSENT (pass path, most common)
    group.bench_function("budget_pass_get", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            async move {
                let result: Option<String> = redis::cmd("GET")
                    .arg(format!("v2:budget:hard_block:{TEST_WORKSPACE}"))
                    .query_async(&mut c)
                    .await
                    .unwrap();
                assert!(result.is_none()); // Absent = pass
                black_box(result);
            }
        });
    });

    // Budget check — key PRESENT (block path)
    group.bench_function("budget_blocked_get", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            async move {
                let result: Option<String> = redis::cmd("GET")
                    .arg(format!("v2:budget:hard_block:{TEST_WORKSPACE}_blocked"))
                    .query_async(&mut c)
                    .await
                    .unwrap();
                assert!(result.is_some()); // Present = blocked
                black_box(result);
            }
        });
    });

    group.finish();

    // Don't cleanup yet — other groups need the keys
}

// ── Case 2: Virtual key lookup via Valkey GET ───────────────────────────────

/// Benchmarks the virtual key lookup (GET + JSON parse).
/// This runs on every authenticated request.
fn bench_vk_lookup_valkey(c: &mut Criterion) {
    let runtime = rt();
    let conn = runtime.block_on(connect());

    let mut group = c.benchmark_group("e2e_vk_lookup");
    group.measurement_time(Duration::from_secs(10));

    // VK found — GET + JSON deserialize
    group.bench_function("vk_found_parse", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            async move {
                let raw: Option<String> = redis::cmd("GET")
                    .arg(format!("v2:vk:{TEST_VK}"))
                    .query_async(&mut c)
                    .await
                    .unwrap();
                let parsed: serde_json::Value =
                    serde_json::from_str(raw.as_ref().unwrap()).unwrap();
                black_box(parsed);
            }
        });
    });

    // VK not found — GET returns nil (reject path)
    group.bench_function("vk_not_found", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            async move {
                let raw: Option<String> = redis::cmd("GET")
                    .arg("v2:vk:sk-nonexistent-key-12345")
                    .query_async(&mut c)
                    .await
                    .unwrap();
                assert!(raw.is_none());
                black_box(raw);
            }
        });
    });

    group.finish();
}

// ── Case 3: Trace PUBLISH (fire-and-forget) ─────────────────────────────────

/// Benchmarks the trace publish step — Valkey PUBLISH is fire-and-forget
/// on the hot path (subscriber count returned but not awaited).
fn bench_trace_publish(c: &mut Criterion) {
    let runtime = rt();
    let conn = runtime.block_on(connect());

    let mut group = c.benchmark_group("e2e_trace_publish");
    group.measurement_time(Duration::from_secs(10));

    let trace_payload = serde_json::json!({
        "trace_id": "tr_bench001",
        "session_id": "sess_bench001",
        "workspace_id": TEST_WORKSPACE,
        "model": "gpt-4o",
        "provider": "openai",
        "raw_input_tokens": 500,
        "output_tokens": 250,
        "raw_cost_usd": 0.0125,
        "actual_cost_usd": 0.0100,
        "enforcement_action": "PASS",
    });
    let payload_str = serde_json::to_string(&trace_payload).unwrap();

    group.bench_function("publish_trace_event", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            let p = payload_str.clone();
            async move {
                let subs: i64 = redis::cmd("PUBLISH")
                    .arg(format!("intutic:traces:{TEST_WORKSPACE}"))
                    .arg(p)
                    .query_async(&mut c)
                    .await
                    .unwrap();
                black_box(subs);
            }
        });
    });

    group.finish();
}

// ── Case 4: Full chain with I/O ─────────────────────────────────────────────

/// The critical E2E benchmark: simulates the COMPLETE hot path including
/// Valkey I/O. This is what the "<5ms P95" claim must hold against.
///
/// Sequence:
///   1. GET v2:budget:hard_block:{ws}    — budget gate (~0.3ms)
///   2. GET v2:vk:{key} + JSON parse     — key lookup (~0.5ms)
///   3. DLP scan (CPU)                    — regex scan (~0.003ms)
///   4. PUBLISH trace event              — fire-and-forget (~0.2ms)
///   Total expected: ~1-2ms P50, ~2-3ms P95, well under 5ms.
fn bench_full_chain_e2e(c: &mut Criterion) {
    let runtime = rt();
    let mut conn = runtime.block_on(connect());
    // Re-seed to be safe
    runtime.block_on(seed_keys(&mut conn));

    let mut group = c.benchmark_group("e2e_full_chain");
    group.measurement_time(Duration::from_secs(15));

    let clean_body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Implement binary search in Rust."},
        ],
    })
    .to_string();

    let trace_payload = serde_json::to_string(&serde_json::json!({
        "trace_id": "tr_e2e",
        "session_id": "sess_e2e",
        "workspace_id": TEST_WORKSPACE,
        "model": "gpt-4o",
        "enforcement_action": "PASS",
    }))
    .unwrap();

    // Full hot-path: budget gate → VK lookup → DLP scan → trace publish
    group.bench_function("pass_clean_1kb", |b| {
        b.to_async(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        )
        .iter(|| {
            let mut c = conn.clone();
            let body = clean_body.clone();
            let trace = trace_payload.clone();
            async move {
                // Gate 1: Budget hard-block check
                let blocked: Option<String> = redis::cmd("GET")
                    .arg(format!("v2:budget:hard_block:{TEST_WORKSPACE}"))
                    .query_async(&mut c)
                    .await
                    .unwrap();
                assert!(blocked.is_none());

                // Gate 2: Virtual key lookup + parse
                let vk_raw: Option<String> = redis::cmd("GET")
                    .arg(format!("v2:vk:{TEST_VK}"))
                    .query_async(&mut c)
                    .await
                    .unwrap();
                let _vk: serde_json::Value =
                    serde_json::from_str(vk_raw.as_ref().unwrap()).unwrap();

                // Gate 3: DLP scan (CPU — no I/O)
                let findings = intutic_proxy::dlp::scan(black_box(&body));
                assert!(findings.is_empty());

                // Gate 4: Hostname filter (CPU — no I/O)
                let is_ai = intutic_proxy::hostname_filter::is_ai_provider_host("api.openai.com");
                assert!(is_ai);

                // Post: Trace publish (fire-and-forget)
                let _: i64 = redis::cmd("PUBLISH")
                    .arg(format!("intutic:traces:{TEST_WORKSPACE}"))
                    .arg(trace)
                    .query_async(&mut c)
                    .await
                    .unwrap();

                black_box(());
            }
        });
    });

    group.finish();

    // Cleanup after all benchmarks
    runtime.block_on(cleanup_keys(&mut conn));
}

// ── Group and main ──────────────────────────────────────────────────────────

criterion_group!(
    benches,
    bench_budget_gate_valkey,
    bench_vk_lookup_valkey,
    bench_trace_publish,
    bench_full_chain_e2e,
);
criterion_main!(benches);
