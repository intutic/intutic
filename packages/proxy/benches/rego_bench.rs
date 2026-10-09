//! Rego rule cost at realistic coding-agent input sizes.
//!
//! Sizes are percentiles of 82,401 real tool calls (`tool` + `args` as JSON):
//! p50 366 B, p90 2 KB, p99 10 KB, p99.9 31 KB, and the 64 KB input cap. Each
//! case runs one example policy end to end — a fresh store and instance, the
//! input parse, the policy — exactly as the registry does per call.
//!
//! Prints the fuel each case uses before timing it, since fuel, not time, is
//! what the budget in `src/wasm/limits.rs` is checked against.
//!
//! Run: `cargo bench -p intutic-proxy --bench rego_bench`

use criterion::{criterion_group, criterion_main, Criterion};
use intutic_proxy::wasm::context::RequestContext;
use intutic_proxy::wasm::{limits, opa};
use serde_json::{json, Value};
use std::hint::black_box;
use wasmtime::Module;

const SHELL: &[u8] = include_bytes!("../tests/fixtures/rego/examples/block_destructive_shell.wasm");
const PATHS: &[u8] =
    include_bytes!("../tests/fixtures/rego/examples/deny_writes_outside_repo.wasm");

const SIZES: [(&str, usize); 5] = [
    ("p50", 366),
    ("p90", 2 * 1024),
    ("p99", 10 * 1024),
    ("p99.9", 31 * 1024),
    ("cap", 63 * 1024),
];

fn ctx(tool: &str, args: Value) -> RequestContext {
    let mut ctx: RequestContext = serde_json::from_value(json!({
        "session_id": "ses_bench", "workspace_id": "ws_bench", "virtual_key_prefix": "vk_bench",
        "model": "claude-sonnet-4", "tools": [], "tool_calls": [], "estimated_input_tokens": 4000,
        "budget_remaining_usd": 5.0, "risk_tier": "Medium", "dlp_findings": [],
        "tool_sequence": ["Read", "Grep", "Edit", "Bash", "Read", "Bash"]
    }))
    .expect("context");
    ctx.turn_tool_calls =
        serde_json::from_value(json!([{ "id": "c", "name": tool, "arguments": args }]))
            .expect("call");
    ctx
}

/// A shell command of about `n` bytes, shaped like an agent's chained commands.
fn command(n: usize) -> String {
    let unit = "cd /workspace/app && npm test -- --runInBand src/lib/parse.test.ts; ";
    unit.repeat(n / unit.len() + 1)[..n].to_string()
}

fn bench(c: &mut Criterion) {
    let engine = limits::engine().expect("engine");
    let mut group = c.benchmark_group("rego_eval");
    for (policy, bytes, tool) in [("shell", SHELL, "Bash"), ("paths", PATHS, "Write")] {
        let module = Module::new(&engine, bytes).expect("module");
        let rule = opa::load(&engine, &module, bytes)
            .expect("loads")
            .expect("is OPA");
        for (label, size) in SIZES {
            let args = if tool == "Bash" {
                json!({ "command": command(size) })
            } else {
                json!({ "file_path": "/workspace/app/src/main.rs", "content": command(size) })
            };
            let ctx = ctx(tool, args);
            let input = opa::policy_input(&ctx, ctx.turn_tool_calls.first());
            let (_, fuel) = opa::evaluate_input(&engine, &module, &rule, &input, limits::REGO)
                .expect("evaluates");
            eprintln!(
                "{policy:>6} {label:>6}: input {:>6} B, {fuel:>9} fuel ({:.0}/B)",
                input.len(),
                fuel as f64 / input.len() as f64
            );
            group.bench_function(format!("{policy}/{label}"), |b| {
                b.iter(|| {
                    black_box(opa::evaluate_input(
                        &engine,
                        &module,
                        &rule,
                        &input,
                        limits::REGO,
                    ))
                })
            });
        }
    }
    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
