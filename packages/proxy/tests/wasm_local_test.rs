//! Integration tests for local WASM rule ingestion (`~/.intutic/wasm/`).
//!
//! All self-contained. The registry-level tests used to require a reachable
//! Valkey — `PluginRegistry` construction and evaluation took a live
//! connection — and skipped without one. After the storage port they take a
//! `ControlPlaneCache`, so `NullControlPlaneCache` covers them: local rules are
//! precisely the half that does not come from a control plane.

use intutic_proxy::wasm::context::{RequestContext, RiskLevel, Verdict};
use intutic_proxy::wasm::local_loader::{load_local_modules, scan_signatures};
use intutic_proxy::store::{ControlPlaneCache, NullControlPlaneCache};
use intutic_proxy::wasm::registry::PluginRegistry;
use std::path::PathBuf;
use std::sync::Arc;

/// Minimal rule implementing the guest ABI: exports `memory`, `allocate`,
/// and `evaluate(offset, len) -> i32` returning a fixed verdict code.
fn rule_wasm(verdict: i32) -> Vec<u8> {
    let wat = format!(
        r#"(module
             (memory (export "memory") 1)
             (func (export "allocate") (param i32) (result i32) (i32.const 8))
             (func (export "evaluate") (param i32 i32) (result i32) (i32.const {verdict})))"#
    );
    wat::parse_str(&wat).expect("fixture WAT must compile")
}

fn temp_rule_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-wasm-local-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn test_ctx(workspace_id: &str) -> RequestContext {
    RequestContext {
        session_id: "test-session".to_string(),
        workspace_id: workspace_id.to_string(),
        virtual_key_prefix: "vk_test".to_string(),
        model: "claude-3-5-sonnet".to_string(),
        tools: vec![],
        tool_calls: vec![],
        estimated_input_tokens: 100,
        budget_remaining_usd: 10.0,
        risk_tier: RiskLevel::Low,
        dlp_findings: vec![],
        tool_sequence: vec![],
        denied_tools: vec![],
        node: Default::default(),
    }
}

fn test_engine() -> wasmtime::Engine {
    let mut config = wasmtime::Config::new();
    config.consume_fuel(true);
    wasmtime::Engine::new(&config).unwrap()
}

// ─── Loader-level (no Valkey needed) ─────────────────────────────────

#[test]
fn loads_valid_rules_with_priority_naming() {
    let dir = temp_rule_dir("load");
    std::fs::write(dir.join("10_first.wasm"), rule_wasm(0)).unwrap();
    std::fs::write(dir.join("plain.wasm"), rule_wasm(0)).unwrap();

    let engine = test_engine();
    let sigs = scan_signatures(&dir).unwrap();
    let modules = load_local_modules(&engine, &sigs, &[]);
    assert_eq!(modules.len(), 2);

    let first = modules
        .iter()
        .find(|m| m.rule_id == "local:10_first.wasm")
        .unwrap();
    assert_eq!(first.priority, 10);
    assert_eq!(first.name, "first");
    assert!(!first.sha256.is_empty());

    let plain = modules
        .iter()
        .find(|m| m.rule_id == "local:plain.wasm")
        .unwrap();
    assert_eq!(plain.priority, 100);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn corrupt_file_fails_open_and_retains_previous_good_module() {
    let dir = temp_rule_dir("corrupt");
    let engine = test_engine();

    // First load: a valid rule.
    std::fs::write(dir.join("20_rule.wasm"), rule_wasm(1)).unwrap();
    let sigs = scan_signatures(&dir).unwrap();
    let first_load = load_local_modules(&engine, &sigs, &[]);
    assert_eq!(first_load.len(), 1);
    let good_sha = first_load[0].sha256.clone();

    // Overwrite with garbage (simulates a mid-copy or corrupt file).
    std::fs::write(dir.join("20_rule.wasm"), b"not wasm at all").unwrap();
    let sigs = scan_signatures(&dir).unwrap();
    let second_load = load_local_modules(&engine, &sigs, &first_load);
    assert_eq!(
        second_load.len(),
        1,
        "previous good module must be retained on load failure"
    );
    assert_eq!(second_load[0].sha256, good_sha);

    // A corrupt file with no previous good version is skipped entirely.
    let fresh_load = load_local_modules(&engine, &sigs, &[]);
    assert!(fresh_load.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

// ─── Registry-level (needs Valkey) ───────────────────────────────────

/// Local rules come from disk, never from a control plane — so the null cache
/// is the correct backing here, not a stand-in for a missing one.
fn control_plane() -> Arc<dyn ControlPlaneCache> {
    Arc::new(NullControlPlaneCache)
}

#[tokio::test]
async fn registry_hot_picks_up_local_rules_and_attributes_kills() {
    let valkey = control_plane();
    let dir = temp_rule_dir("registry");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let ctx = test_ctx("test-ws-local-rules");

    // Empty dir → no rules → Bypass.
    assert_eq!(registry.evaluate(&valkey, &ctx).await, Verdict::Bypass);

    // Drop in an allow rule → still Bypass, but the module is loaded.
    std::fs::write(dir.join("50_allow.wasm"), rule_wasm(0)).unwrap();
    registry.force_local_rescan().await;
    assert_eq!(registry.evaluate(&valkey, &ctx).await, Verdict::Bypass);
    assert_eq!(registry.plugin_count().await, 1);

    // Drop in a kill rule → Kill, attributed to the local rule id.
    std::fs::write(dir.join("10_kill.wasm"), rule_wasm(1)).unwrap();
    registry.force_local_rescan().await;
    match registry.evaluate(&valkey, &ctx).await {
        Verdict::Kill { policy_id, .. } => {
            assert_eq!(policy_id.as_deref(), Some("local:10_kill.wasm"));
        }
        other => panic!("expected Kill from local rule, got {:?}", other),
    }

    // Corrupting the kill rule keeps the previous good version enforcing.
    std::fs::write(dir.join("10_kill.wasm"), b"garbage").unwrap();
    registry.force_local_rescan().await;
    assert!(matches!(
        registry.evaluate(&valkey, &ctx).await,
        Verdict::Kill { .. }
    ));

    // Removing the rule files disables them on the next rescan.
    std::fs::remove_file(dir.join("10_kill.wasm")).unwrap();
    std::fs::remove_file(dir.join("50_allow.wasm")).unwrap();
    registry.force_local_rescan().await;
    assert_eq!(registry.evaluate(&valkey, &ctx).await, Verdict::Bypass);

    let _ = std::fs::remove_dir_all(&dir);
}