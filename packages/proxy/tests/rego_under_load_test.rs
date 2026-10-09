//! A legitimate Rego rule on the largest input reaches its verdict on a busy
//! machine.
//!
//! A rule that reaches no verdict refuses the call, so the deadline must not be
//! what stops a rule that is within its fuel. This loads every core several
//! times over — about what a 4-vCPU CI runner sees running every package's
//! tests at once — and evaluates the destructive-shell example, through the
//! request path's limits, on the largest input the builder produces.
//!
//! Its own test binary, so the load it makes slows no other test.

use intutic_proxy::wasm::context::{RequestContext, Verdict};
use intutic_proxy::wasm::opa;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SHELL: &[u8] = include_bytes!("fixtures/rego/examples/block_destructive_shell.wasm");

fn ctx(command: &str) -> RequestContext {
    let mut ctx: RequestContext = serde_json::from_value(json!({
        "session_id": "ses_1", "workspace_id": "ws_1", "virtual_key_prefix": "vk_1",
        "model": "m", "tools": [], "tool_calls": [], "estimated_input_tokens": 1,
        "budget_remaining_usd": 1.0, "risk_tier": "Low", "dlp_findings": [],
        "tool_sequence": []
    }))
    .unwrap();
    ctx.turn_tool_calls = serde_json::from_value(json!([
        { "id": "call_1", "name": "Bash", "arguments": { "command": command } }
    ]))
    .unwrap();
    ctx
}

#[test]
fn the_largest_legitimate_input_reaches_its_verdict_under_cpu_contention() {
    let engine = intutic_proxy::wasm::limits::engine().unwrap();
    let module = wasmtime::Module::new(&engine, SHELL).unwrap();
    let rule = opa::load(&engine, &module, SHELL).unwrap().unwrap();
    // Chained commands just under the input cap, the destructive one last, so
    // only an evaluation that reads all of it blocks.
    let unit = "cd /workspace/app && npm test; ";
    let command = format!(
        "{}rm -rf /",
        unit.repeat((opa::MAX_INPUT_BYTES - 1024) / unit.len())
    );
    let c = ctx(&command);
    let input = opa::policy_input(&c, c.turn_tool_calls.first());
    assert!(input.len() > opa::MAX_INPUT_BYTES - 1024);

    let stop = Arc::new(AtomicBool::new(false));
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    let burners: Vec<_> = (0..cores * 4)
        .map(|_| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut x = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
                }
            })
        })
        .collect();

    let mut refused = Vec::new();
    for i in 0..50 {
        let (verdict, failure) = opa::evaluate(&engine, &module, &rule, &c);
        if let Some(f) = failure {
            refused.push(format!("evaluation {i}: {}", f.reason));
        } else {
            assert!(
                matches!(verdict, Verdict::Kill { .. }),
                "evaluation {i}: {verdict:?}"
            );
        }
    }
    stop.store(true, Ordering::Relaxed);
    for b in burners {
        b.join().unwrap();
    }
    assert!(refused.is_empty(), "refused under load: {refused:?}");
}
