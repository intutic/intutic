//! A custom rule that reaches no verdict refuses the request with
//! `Verdict::Unavailable`, naming the rule and the cause. Every rule failure
//! used to allow.
//!
//! There is no fail mode to test it under: the registry takes none. The proxy's
//! `intutic_settings.policy.fail_closed` is for control-plane outages, which an
//! agent cannot cause; a rule's timeout it can cause by padding its input.
//!
//! One rule per way of reaching no verdict — the deadline, the instruction
//! budget, a trap, and a result that is not a verdict — each run through the
//! registry from the local rules directory.

use intutic_proxy::store::{ControlPlaneCache, NullControlPlaneCache};
use intutic_proxy::wasm::context::{RequestContext, Verdict};
use intutic_proxy::wasm::registry::PluginRegistry;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

/// Loops forever while spending little fuel (a megabyte filled per
/// instruction), so the deadline stops it, not the budget.
const SLOW_LOOP: &str = r#"(module
     (memory (export "memory") 17)
     (func (export "allocate") (param i32) (result i32) i32.const 0)
     (func (export "evaluate") (param i32 i32) (result i32)
       (loop $l
         (memory.fill (i32.const 65536) (i32.const 7) (i32.const 1048576))
         (br $l))
       i32.const 1))"#;

/// Loops forever on one instruction per iteration: the 1,000,000-instruction
/// budget stops it in about a millisecond, and in under 100 ms on a loaded
/// machine — deterministically first, ten times inside the 1 s deadline.
const SPIN: &str = r#"(module
     (memory (export "memory") 1)
     (func (export "allocate") (param i32) (result i32) i32.const 8)
     (func (export "evaluate") (param i32 i32) (result i32)
       (loop $l (br $l))
       i32.const 1))"#;

/// Traps at once.
const TRAP: &str = r#"(module
     (memory (export "memory") 1)
     (func (export "allocate") (param i32) (result i32) i32.const 8)
     (func (export "evaluate") (param i32 i32) (result i32) unreachable))"#;

/// A rule returning `code`.
fn returning(code: i32) -> String {
    format!(
        r#"(module
             (memory (export "memory") 1)
             (func (export "allocate") (param i32) (result i32) i32.const 8)
             (func (export "evaluate") (param i32 i32) (result i32) i32.const {code}))"#
    )
}

/// A Rego build whose entrypoint is an object with no `decision`: the
/// conformance policy, whose result is one entry per host builtin.
const CONFORMANCE: &[u8] = include_bytes!("fixtures/rego/conformance.wasm");

fn rule_dir(tag: &str, rules: &[(&str, Vec<u8>)]) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-fail-mode-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, bytes) in rules {
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    dir
}

fn wat(source: &str) -> Vec<u8> {
    wat::parse_str(source).expect("fixture WAT compiles")
}

fn ctx() -> RequestContext {
    let mut ctx: RequestContext = serde_json::from_value(json!({
        "session_id": "ses_1",
        "workspace_id": "ws_1",
        "virtual_key_prefix": "vk_1",
        "model": "claude-sonnet-4",
        "tools": [],
        "tool_calls": [],
        "estimated_input_tokens": 10,
        "budget_remaining_usd": 1.0,
        "risk_tier": "Low",
        "dlp_findings": [],
        "tool_sequence": []
    }))
    .unwrap();
    ctx.turn_tool_calls = serde_json::from_value(json!([
        { "id": "call_1", "name": "Bash", "arguments": { "command": "ls" } }
    ]))
    .unwrap();
    ctx
}

async fn evaluate(registry: &PluginRegistry) -> Verdict {
    let cp: Arc<dyn ControlPlaneCache> = Arc::new(NullControlPlaneCache);
    registry.evaluate(&cp, &ctx()).await
}

/// Refused, naming the rule and `cause`.
async fn assert_refused(tag: &str, rule: Vec<u8>, cause: &str) {
    let dir = rule_dir(tag, &[("10_rule.wasm", rule)]);
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();

    let verdict = evaluate(&registry).await;
    match verdict {
        Verdict::Unavailable { reason, policy_id } => {
            assert_eq!(policy_id.as_deref(), Some("local:10_rule.wasm"));
            assert!(
                reason.contains("local:10_rule.wasm") && reason.contains(&format!("({cause})")),
                "{tag}: {reason}"
            );
        }
        other => panic!("{tag}: must refuse, got {other:?}"),
    }
    assert_eq!(registry.plugin_count().await, 1, "{tag}: the rule loaded");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_rule_past_its_deadline_is_refused() {
    assert_refused("deadline", wat(SLOW_LOOP), "deadline").await;
}

#[tokio::test]
async fn a_rule_out_of_budget_is_refused() {
    assert_refused("budget", wat(SPIN), "budget").await;
}

#[tokio::test]
async fn a_rule_that_traps_is_refused() {
    assert_refused("trap", wat(TRAP), "error").await;
}

#[tokio::test]
async fn a_native_result_that_is_not_a_verdict_is_refused() {
    assert_refused("code", wat(&returning(7)), "result").await;
}

#[tokio::test]
async fn a_rego_result_that_is_not_a_decision_is_refused() {
    assert_refused("rego", CONFORMANCE.to_vec(), "result").await;
}

/// A block from another rule is the more useful refusal, and wins; the
/// failure still outranks a reask, which a retry could otherwise clear.
#[tokio::test]
async fn a_block_outranks_a_failure_and_a_failure_outranks_a_reask() {
    let dir = rule_dir(
        "rank",
        &[
            ("10_trap.wasm", wat(TRAP)),
            ("20_block.wasm", wat(&returning(1))),
        ],
    );
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    match evaluate(&registry).await {
        Verdict::Kill { policy_id, .. } => {
            assert_eq!(policy_id.as_deref(), Some("local:20_block.wasm"))
        }
        other => panic!("expected the block, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);

    let dir = rule_dir(
        "rank-reask",
        &[
            ("10_reask.wasm", wat(&returning(3))),
            ("20_trap.wasm", wat(TRAP)),
        ],
    );
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    assert!(
        matches!(evaluate(&registry).await, Verdict::Unavailable { .. }),
        "a reask must not let an unjudged call through on retry"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
