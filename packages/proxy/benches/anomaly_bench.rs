//! Criterion benchmarks for the 22-detector anomaly chain.
//!
//! Run:
//!   cargo bench --bench anomaly_bench
//!   cargo bench --bench anomaly_bench -- --output-format bencher 2>&1 | tee docs/benchmarks/anomaly_v1_baseline.txt
//!
//! # Why this exists
//!
//! It did not, and its absence was load-bearing. `benches/` held policy,
//! policy_e2e, snip and wasm — every hot-path component *except* this one — while
//! the public documentation described the anomaly chain as a "sub-millisecond
//! fast path". That claim has now been removed from the docs, and this benchmark
//! is what would have to exist before anything like it goes back.
//!
//! The first run of the sibling `policy_bench` found `dlp::scan` costing ~150
//! ns/byte, which put a 32 KB request body over the entire advertised latency
//! budget in one gate. A benchmark nobody runs is not coverage; treat every
//! number here as provisional until it has been run on more than one machine.
//!
//! # What it measures, and what it does not
//!
//! In-process time for `DetectorRegistry::evaluate_all` over a `RequestContext`
//! that is already populated. It is **not** end-to-end added latency: the fields
//! the detectors read — `denied_tools`, `plan_steps`, `scope_paths`,
//! `transition_baseline`, the graph aggregates — are resolved on the request path
//! *before* this runs, and that resolution is I/O this benchmark deliberately
//! excludes. The detectors are pure functions of the struct by design; this
//! measures exactly that purity and nothing about the cost of filling it in.
//!
//! # Sequence length, and what 60 means
//!
//! Several detectors are linear or worse in `tool_sequence`: the cycle detectors
//! walk it, `ForbiddenSuccession` and `MissingPredecessor` scan it once per rule,
//! and `LandmarkCycleDetector` projects it into an anchor frequency table.
//!
//! In production the sequence is a rolling window capped at `TOOL_SEQUENCE_CAP`,
//! which is **60** (`proxy.rs`). So 60 is the number that describes real traffic
//! and the only one to quote; 128 and 512 are headroom probes, included because
//! the cap is a constant somebody could raise, and "is that cheap?" should be
//! answerable from a measurement rather than an assumption. If the curve were
//! superlinear, raising the cap would not be the small change it looks like.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use intutic_proxy::plugins::anomaly::DetectorRegistry;
use intutic_proxy::wasm::context::{NodeIdentity, RequestContext, RiskLevel};

// ── Fixtures ────────────────────────────────────────────────────────────────

/// A context with nothing declared and nothing wrong — the shape the
/// overwhelming majority of production requests have.
///
/// Every declaration field is empty on purpose. Empty means "nothing to check"
/// throughout this codebase, never "deny everything unlisted", so this is also
/// the fastest legitimate path and the right baseline to compare against.
fn clean_ctx(sequence: Vec<String>) -> RequestContext {
    RequestContext {
        session_id: "ses_bench".into(),
        workspace_id: "ws_bench".into(),
        virtual_key_prefix: "sk-bench".into(),
        model: "gpt-4o".into(),
        tools: Vec::new(),
        tool_calls: Vec::new(),
        estimated_input_tokens: 1200,
        budget_remaining_usd: 50.0,
        risk_tier: RiskLevel::Low,
        dlp_findings: Vec::new(),
        tool_sequence: sequence,
        transition_baseline: None,
        denied_tools: Vec::new(),
        plan_steps: Vec::new(),
        scope_paths: Vec::new(),
        review_before: Vec::new(),
        requires_before: Vec::new(),
        forbid_after: Vec::new(),
        changes: Vec::new(),
        new_tool_calls: Vec::new(),
        injection_findings: Vec::new(),
        tool_contract_changed: false,
        harness: "claude-code".into(),
        allowed_harnesses: Vec::new(),
        workflow_spend_usd: None,
        workflow_budget_usd: None,
        node: NodeIdentity::default(),
    }
}

/// A realistic, varied tool sequence of `n` steps that trips nothing.
///
/// Deliberately not `["Read"; n]` — that is a spin loop, which short-circuits
/// `ConsecutiveRepeatDetector` at its threshold and would measure the *early
/// return* rather than the full chain. A benchmark of the fast exit is the
/// classic way to publish a number that describes nothing.
fn varied_sequence(n: usize) -> Vec<String> {
    const PALETTE: &[&str] = &[
        "Read", "Grep", "Edit", "Write", "Bash", "WebFetch", "Glob", "Task",
    ];
    (0..n).map(|i| PALETTE[i % PALETTE.len()].to_string()).collect()
}

/// A context with every declaration populated, as a workspace running real SOPs
/// would have. This is the *slow* legitimate path: the declaration-driven
/// detectors do real work instead of returning immediately on an empty list.
fn declared_ctx(sequence: Vec<String>) -> RequestContext {
    let mut ctx = clean_ctx(sequence);
    ctx.denied_tools = vec!["curl".into(), "wget".into(), "nc".into()];
    ctx.plan_steps = vec![
        "read the failing test".into(),
        "locate the defect".into(),
        "apply the fix".into(),
        "run the suite".into(),
    ];
    ctx.scope_paths = vec!["src/".into(), "tests/".into()];
    ctx.review_before = vec!["action:deploy".into(), "action:publish".into()];
    // Declared ordering rules, so the succession detectors take the declared
    // branch here rather than their built-in tables — which is what a workspace
    // that configured its SOPs actually pays.
    ctx.requires_before = vec![("action:run_tests".into(), "action:deploy".into())];
    ctx.forbid_after = vec![("action:secret_read".into(), "action:http_post".into())];
    ctx.allowed_harnesses = vec!["claude-code".into(), "cursor".into()];
    ctx.transition_baseline = Some(
        [
            ("Read Edit".to_string(), 0.42_f64),
            ("Edit Write".to_string(), 0.31),
            ("Write Bash".to_string(), 0.55),
            ("Bash Read".to_string(), 0.28),
        ]
        .into_iter()
        .collect(),
    );
    ctx.node = NodeIdentity {
        node_id: "node_bench".into(),
        agent_role: "implementer".into(),
        graph_id: "graph_bench".into(),
        parent_session_id: "ses_parent".into(),
        depth: 2,
        graph_spend_usd: Some(1.25),
        graph_budget_usd: Some(10.0),
        parent_alive: Some(true),
        graph_node_count: Some(6),
    };
    ctx
}

// ── Benchmarks ──────────────────────────────────────────────────────────────

/// The full chain against sequence length. The axis that decides whether the
/// rolling-window bound is a free parameter or a load-bearing one.
fn bench_chain_by_sequence_length(c: &mut Criterion) {
    let registry = DetectorRegistry::with_defaults();
    let mut group = c.benchmark_group("anomaly_chain_clean");

    for n in [0usize, 8, 32, 60, 128, 512] {
        let ctx = clean_ctx(varied_sequence(n));
        group.bench_with_input(BenchmarkId::new("clean", n), &ctx, |b, ctx| {
            b.iter(|| black_box(registry.evaluate_all(black_box(ctx))));
        });
    }
    group.finish();
}

/// The same lengths with every declaration populated — the cost a workspace
/// that actually configured its SOPs pays, which is the one that matters.
fn bench_chain_with_declarations(c: &mut Criterion) {
    let registry = DetectorRegistry::with_defaults();
    let mut group = c.benchmark_group("anomaly_chain_declared");

    for n in [8usize, 32, 60, 128, 512] {
        let ctx = declared_ctx(varied_sequence(n));
        group.bench_with_input(BenchmarkId::new("declared", n), &ctx, |b, ctx| {
            b.iter(|| black_box(registry.evaluate_all(black_box(ctx))));
        });
    }
    group.finish();
}

/// Sequences that actually trip detectors.
///
/// A chain measured only on clean input is measured on its cheapest path. These
/// are the cases where findings are constructed, `format!` runs, and the result
/// vector is sorted.
fn bench_chain_firing(c: &mut Criterion) {
    let registry = DetectorRegistry::with_defaults();
    let mut group = c.benchmark_group("anomaly_chain_firing");

    // Spin loop: ConsecutiveRepeat plus ToolDiversityCollapse.
    let spin = clean_ctx(vec!["Bash".to_string(); 64]);
    group.bench_function("spin_loop_64", |b| {
        b.iter(|| black_box(registry.evaluate_all(black_box(&spin))));
    });

    // Alternation: PingPongCycle.
    let pingpong = clean_ctx(
        (0..64)
            .map(|i| if i % 2 == 0 { "Read" } else { "Write" }.to_string())
            .collect(),
    );
    group.bench_function("ping_pong_64", |b| {
        b.iter(|| black_box(registry.evaluate_all(black_box(&pingpong))));
    });

    // Several detectors at once, with declarations in play — the worst realistic
    // case, and the one an incident actually looks like.
    let mut multi = declared_ctx(vec!["curl".to_string(); 64]);
    multi.injection_findings = vec!["override-instructions".into(), "role-reassignment".into()];
    multi.tool_contract_changed = true;
    multi.budget_remaining_usd = 0.0;
    group.bench_function("many_findings_64", |b| {
        b.iter(|| black_box(registry.evaluate_all(black_box(&multi))));
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_chain_by_sequence_length,
    bench_chain_with_declarations,
    bench_chain_firing
);
criterion_main!(benches);
