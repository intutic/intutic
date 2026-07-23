//! Criterion benchmarks for the proxy hot-path policy chain.
//!
//! Run:
//!   cargo bench --bench policy_bench
//!   cargo bench --bench policy_bench -- --output-format bencher 2>&1 | tee docs/benchmarks/policy_v1_baseline.txt
//!
//! Budget targets (from ADR-003):
//!   Proxy overhead (all gates):  < 5ms  P95
//!   Budget gate (in-memory):     < 1ms  P99
//!   DLP scan (6 regex):          < 1ms  P99 for 4 KB input
//!   Hostname filter:             < 50µs P99
//!   WASM plugin eval:            < 5ms  P99 (fuel-limited)

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use intutic_proxy::{
    config::SnipCompactorConfig,
    dlp,
    hostname_filter::is_ai_provider_host,
    metering::{check_budget, VirtualKeyRecord},
    snip,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// Typical LLM request body (~1 KB) — no secrets.
fn make_clean_request() -> String {
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful coding assistant."},
            {"role": "user", "content": "Write a Rust function that implements a binary search tree with insert, search, and delete operations. Include proper error handling and documentation comments."},
        ],
        "temperature": 0.7,
        "max_tokens": 4096,
    }).to_string()
}

/// Request body (~2 KB) containing embedded secrets for DLP detection.
fn make_dirty_request() -> String {
    serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "messages": [
            {"role": "system", "content": "You are a helpful coding assistant."},
            {"role": "user", "content": format!(
                "Here's my AWS config:\n\
                 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n\
                 GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh\n\
                 My SSN is 123-45-6789\n\
                 Auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U\n\
                 -----BEGIN RSA PRIVATE KEY-----\n\
                 MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n\
                 -----END RSA PRIVATE KEY-----\n\
                 Also my API key: sk-ant-api03-ABCDEFghijklmnop\n\
                 Please review this configuration."
            )},
        ],
        "temperature": 0.0,
    }).to_string()
}

/// A 4 KB request body — larger realistic prompt.
fn make_large_request() -> String {
    let mut content = String::with_capacity(4096);
    for i in 0..40 {
        content.push_str(&format!(
            "Line {i}: Implement a robust error handling mechanism for the distributed \
             system that gracefully handles network partitions, timeout failures, and \
             cascading service degradation scenarios.\n"
        ));
    }
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a senior distributed systems engineer."},
            {"role": "user", "content": content},
        ],
    })
    .to_string()
}

/// Simulated virtual key record for budget checks.
fn make_virtual_key(budget_remaining: f64) -> VirtualKeyRecord {
    VirtualKeyRecord {
        token: "sk-intutic-abc123".to_string(),
        key_name: Some("dev-key".to_string()),
        team_id: Some("team_01".to_string()),
        user_id: Some("user_01".to_string()),
        max_budget: Some(100.0),
        spend: 100.0 - budget_remaining,
        models: vec!["gpt-4o".to_string(), "claude-sonnet-4-20250514".to_string()],
        expires: None,
    }
}

// ── Case 1: Empty chain (Bypass) ─────────────────────────────────────────────

/// Benchmark the minimum overhead: parse JSON body, check if governance is
/// needed, and return Bypass. This measures the floor latency.
fn bench_bypass(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_bypass");
    let body = make_clean_request();

    group.bench_function("empty_chain", |b| {
        b.iter(|| {
            // Simulate: parse body, check hostname, decide bypass
            let _parsed: serde_json::Value = serde_json::from_str(black_box(&body)).unwrap();
            let is_ai = is_ai_provider_host(black_box("api.openai.com"));
            black_box(is_ai);
        });
    });
    group.finish();
}

// ── Case 2: Budget gate (in-memory) ──────────────────────────────────────────

/// Benchmark the budget gate: check if estimated cost fits within remaining
/// budget. This is the Valkey cache-hit path (in-memory simulation).
fn bench_budget_gate(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_budget_gate");

    let key = make_virtual_key(50.0);
    let estimated_cost = 0.05; // Typical GPT-4o request

    group.bench_function("budget_check_pass", |b| {
        b.iter(|| {
            let result = check_budget(black_box(&key), black_box(estimated_cost));
            let _ = black_box(result);
        });
    });

    // Budget nearly exhausted — should still pass
    let tight_key = make_virtual_key(0.06);
    group.bench_function("budget_check_tight", |b| {
        b.iter(|| {
            let result = check_budget(black_box(&tight_key), black_box(estimated_cost));
            let _ = black_box(result);
        });
    });

    group.finish();
}

// ── Case 3: DLP scan ─────────────────────────────────────────────────────────

fn bench_dlp_scan(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_dlp_scan");

    // Clean request — no findings (best case)
    let clean = make_clean_request();
    group.bench_with_input(
        BenchmarkId::new("clean_1kb", clean.len()),
        &clean,
        |b, body| {
            b.iter(|| {
                let findings = dlp::scan(black_box(body));
                black_box(findings);
            });
        },
    );

    // Dirty request — 6 findings (worst case)
    let dirty = make_dirty_request();
    group.bench_with_input(
        BenchmarkId::new("dirty_2kb_6findings", dirty.len()),
        &dirty,
        |b, body| {
            b.iter(|| {
                let findings = dlp::scan(black_box(body));
                black_box(findings);
            });
        },
    );

    // Large clean request — 4 KB, no findings
    let large = make_large_request();
    group.bench_with_input(
        BenchmarkId::new("clean_4kb", large.len()),
        &large,
        |b, body| {
            b.iter(|| {
                let findings = dlp::scan(black_box(body));
                black_box(findings);
            });
        },
    );

    // DLP scan + redact (dirty path)
    group.bench_with_input(
        BenchmarkId::new("scan_and_redact", dirty.len()),
        &dirty,
        |b, body| {
            b.iter(|| {
                let findings = dlp::scan(black_box(body));
                if !findings.is_empty() {
                    let redacted = dlp::redact(body, &findings);
                    black_box(redacted);
                }
            });
        },
    );

    group.finish();
}

// ── Case 4: Hostname filter ──────────────────────────────────────────────────

fn bench_hostname_filter(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_hostname_filter");

    let ai_hosts = [
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "api.mistral.ai",
        "api.cohere.com",
    ];

    let non_ai_hosts = [
        "www.google.com",
        "github.com",
        "cdn.jsdelivr.net",
        "registry.npmjs.org",
        "pypi.org",
    ];

    for host in ai_hosts {
        group.bench_function(format!("ai_hit_{}", host.replace('.', "_")), |b| {
            b.iter(|| is_ai_provider_host(black_box(host)));
        });
    }

    for host in non_ai_hosts {
        group.bench_function(format!("non_ai_{}", host.replace('.', "_")), |b| {
            b.iter(|| is_ai_provider_host(black_box(host)));
        });
    }

    group.finish();
}

// ── Case 5: Full chain (budget + DLP + hostname filter) ──────────────────────

/// The critical P95 benchmark: simulates the complete synchronous policy
/// chain that runs on every proxied request before forwarding to the LLM.
///
/// This does NOT include async I/O (Valkey, PCAS, upstream HTTP). It measures
/// the pure CPU overhead the proxy adds — the ADR-003 "<5ms P95" target.
fn bench_full_chain(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_full_chain");
    let key = make_virtual_key(50.0);
    let estimated_cost = 0.05;

    // Clean path (typical) — hostname + budget + DLP (no findings)
    let clean = make_clean_request();
    group.bench_function("clean_1kb_typical", |b| {
        b.iter(|| {
            // Gate 1: Hostname filter
            let is_ai = is_ai_provider_host(black_box("api.openai.com"));
            assert!(is_ai);

            // Gate 2: Budget gate (Valkey cache-hit simulated as in-memory)
            let _ = check_budget(black_box(&key), black_box(estimated_cost));

            // Gate 3: DLP scan
            let findings = dlp::scan(black_box(&clean));
            black_box(findings);
        });
    });

    // Dirty path (worst-case) — secrets detected, redact
    let dirty = make_dirty_request();
    group.bench_function("dirty_2kb_redact", |b| {
        b.iter(|| {
            let is_ai = is_ai_provider_host(black_box("api.anthropic.com"));
            assert!(is_ai);

            let _ = check_budget(black_box(&key), black_box(estimated_cost));

            let findings = dlp::scan(black_box(&dirty));
            if !findings.is_empty() {
                let redacted = dlp::redact(&dirty, &findings);
                black_box(redacted);
            }
        });
    });

    // Large clean path — 4 KB body
    let large = make_large_request();
    group.bench_function("clean_4kb_large", |b| {
        b.iter(|| {
            let is_ai = is_ai_provider_host(black_box("generativelanguage.googleapis.com"));
            assert!(is_ai);

            let _ = check_budget(black_box(&key), black_box(estimated_cost));

            let findings = dlp::scan(black_box(&large));
            black_box(findings);
        });
    });

    group.finish();
}

// ── Case 6: SnipCompactor in chain ───────────────────────────────────────────

/// SnipCompactor runs on response post-processing — not on the critical
/// pre-forward path. Benchmarked separately to ensure it doesn't dominate
/// end-to-end latency when enabled.
fn bench_snip_in_chain(c: &mut Criterion) {
    let mut group = c.benchmark_group("policy_snip_postprocess");
    let config = SnipCompactorConfig::default();

    let response_body = serde_json::json!({
        "choices": [{
            "message": {
                "content": format!(
                    "Here's the implementation:\n```rust\n{}\n```\n\nAnd the test:\n```python\n{}\n```",
                    (0..20).map(|i| format!("fn process_{i}(x: &str) -> String {{ x.to_uppercase() }}\n")).collect::<String>(),
                    (0..10).map(|i| format!("def test_{i}():\n    assert process_{i}('hello') == 'HELLO'\n")).collect::<String>(),
                )
            }
        }]
    }).to_string();

    group.bench_function("response_with_code", |b| {
        b.iter(|| {
            let compacted = snip::compact(black_box(&response_body), black_box(&config));
            black_box(compacted);
        });
    });

    group.finish();
}

// ── Group and main ───────────────────────────────────────────────────────────

criterion_group!(
    benches,
    bench_bypass,
    bench_budget_gate,
    bench_dlp_scan,
    bench_hostname_filter,
    bench_full_chain,
    bench_snip_in_chain,
);
criterion_main!(benches);
