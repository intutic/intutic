//! A control-plane rule binary is loaded only when its bytes hash to the
//! SHA-256 its descriptor names.
//!
//! The registry fetches a rule's module from Valkey by that hash, and the key
//! alone proves nothing about the bytes stored under it: whoever can write the
//! key could swap a blocking rule for one that allows everything. These tests
//! put a different, valid module under a rule's hash, which is that attack, and
//! check that it is refused, reported once, and that a rule already enforcing
//! keeps enforcing.
//!
//! A version that cannot load (a missing binary, or one importing what the host
//! does not provide) is refused and reported the same way, so a rule that never
//! loaded does not leave the workspace ungoverned without an incident.

use intutic_proxy::store::{ControlPlaneCache, RuleRefusalWire};
use intutic_proxy::wasm::context::{RequestContext, Verdict};
use intutic_proxy::wasm::registry::PluginRegistry;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Blocks `rm -rf`.
const SHELL: &[u8] = include_bytes!("fixtures/rego/examples/block_destructive_shell.wasm");
/// A valid module that blocks nothing a shell command does.
const DEPLOY: &[u8] = include_bytes!("fixtures/rego/examples/hold_prod_deploys.wasm");

/// The registry re-reads a workspace's rules once this much time has passed.
const RESYNC: std::time::Duration = std::time::Duration::from_millis(5_100);

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn empty_rule_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-integrity-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn ctx(workspace_id: &str, command: &str) -> RequestContext {
    let mut ctx: RequestContext = serde_json::from_value(json!({
        "session_id": "ses_1",
        "workspace_id": workspace_id,
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
        { "id": "call_1", "name": "Bash", "arguments": { "command": command } }
    ]))
    .unwrap();
    ctx
}

/// The two Valkey keys a rule is published under, writable mid-test, and the
/// anomalies the registry raises.
#[derive(Default)]
struct CloudRules {
    descriptors: Mutex<String>,
    binaries: Mutex<Vec<(String, Vec<u8>)>>,
    anomalies: Mutex<Vec<String>>,
    refusals: Mutex<Vec<RuleRefusalWire>>,
}

impl CloudRules {
    /// Publishes `rule_id` under `descriptor_sha`, with `bytes` stored at that
    /// hash whether or not they match it.
    fn publish(&self, rule_id: &str, descriptor_sha: &str, bytes: &[u8]) {
        *self.descriptors.lock().unwrap() = json!([{
            "ruleId": rule_id, "name": rule_id, "sha256": descriptor_sha,
            "priority": 10, "mode": "ENFORCE"
        }])
        .to_string();
        self.binaries
            .lock()
            .unwrap()
            .push((descriptor_sha.to_string(), bytes.to_vec()));
    }

    fn anomalies(&self) -> Vec<String> {
        self.anomalies.lock().unwrap().clone()
    }

    fn refusals(&self) -> Vec<RuleRefusalWire> {
        self.refusals.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ControlPlaneCache for CloudRules {
    async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
        Ok(Some(self.descriptors.lock().unwrap().clone()))
    }
    async fn wasm_binary(&self, sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self
            .binaries
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(s, _)| s == sha)
            .map(|(_, b)| b.clone()))
    }
    async fn publish_rule_refusal(&self, _w: &str, description: &str, rule: &RuleRefusalWire) {
        self.anomalies.lock().unwrap().push(description.to_string());
        self.refusals.lock().unwrap().push(rule.clone());
    }
    async fn policy_version(&self, _w: &str) -> Option<u64> {
        None
    }
    async fn predict_gate_threshold(&self, _w: &str) -> Option<f64> {
        None
    }
    async fn token_baseline(
        &self,
        _w: &str,
        _m: &str,
        _b: &str,
    ) -> Option<intutic_proxy::store::TokenBaseline> {
        None
    }
    async fn bandit_keywords(&self, _w: &str) -> Option<serde_json::Value> {
        None
    }
    async fn active_sop_tier(&self, _w: &str) -> Option<String> {
        None
    }
    async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
        None
    }
    async fn feature_flags(&self, _w: &str) -> Option<intutic_proxy::store::FeatureFlags> {
        None
    }
    async fn auth_context(&self, _t: &str) -> intutic_proxy::store::ControlPlaneAuth {
        intutic_proxy::store::ControlPlaneAuth::Unmanaged
    }
    async fn daily_budget(&self, _w: &str) -> Option<(f64, Option<f64>)> {
        None
    }
    async fn hard_block(&self, _w: &str) -> intutic_proxy::store::HardCapStatus {
        intutic_proxy::store::HardCapStatus::Clear
    }
    async fn loop_status(&self, _l: &str) -> Option<String> {
        None
    }
    async fn active_loop_run(&self, _w: &str, _m: Option<&str>) -> Option<String> {
        None
    }
    async fn auto_judge_active(&self, _s: intutic_proxy::store::JudgeScope, _id: &str) -> bool {
        false
    }
    async fn break_glass_grant(
        &self,
        _t: &str,
        _w: &str,
    ) -> Option<intutic_proxy::store::BreakGlassGrant> {
        None
    }
    async fn transition_baseline(&self, _w: &str) -> Option<String> {
        None
    }
    async fn drain_notifications(
        &self,
        _s: intutic_proxy::store::NotifyScope,
        _id: &str,
    ) -> Vec<String> {
        Vec::new()
    }
    async fn is_sandbox_attested(&self, _sid: &str) -> bool {
        false
    }
}

fn is_kill(verdict: &Verdict) -> bool {
    matches!(verdict, Verdict::Kill { .. })
}

#[tokio::test]
async fn a_binary_matching_its_descriptor_loads() {
    let dir = empty_rule_dir("match");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    rules.publish("wasm_shell", &sha(SHELL), SHELL);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();

    assert!(is_kill(
        &registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await
    ));
    assert_eq!(registry.plugin_count().await, 1);
    assert!(rules.anomalies().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The hash matches case-insensitively: it is hex, and a descriptor written
/// in upper case names the same bytes.
#[tokio::test]
async fn an_upper_case_descriptor_hash_names_the_same_binary() {
    let dir = empty_rule_dir("upper");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    rules.publish("wasm_shell", &sha(SHELL).to_uppercase(), SHELL);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();

    assert!(is_kill(
        &registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await
    ));
    assert!(rules.anomalies().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_swapped_binary_is_refused_and_reported() {
    let dir = empty_rule_dir("swap");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    // The blocking rule's descriptor, with a different valid module under its hash.
    rules.publish("wasm_shell", &sha(SHELL), DEPLOY);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();

    assert_eq!(
        registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await,
        Verdict::Bypass,
        "nothing verified is loaded, so nothing enforces"
    );
    assert_eq!(registry.plugin_count().await, 0);
    let anomalies = rules.anomalies();
    assert_eq!(anomalies.len(), 1, "{anomalies:?}");
    assert!(anomalies[0].contains("wasm_shell"), "{}", anomalies[0]);
    assert!(anomalies[0].contains(&sha(SHELL)), "{}", anomalies[0]);
    assert!(anomalies[0].contains(&sha(DEPLOY)), "{}", anomalies[0]);
    // The version and the reason, which the control plane files the incident
    // under — the key the MCP proxy's report of the same refusal shares.
    assert_eq!(
        rules.refusals(),
        vec![RuleRefusalWire {
            rule_id: "wasm_shell".into(),
            name: "wasm_shell".into(),
            sha256: sha(SHELL),
            refusal: "hash_mismatch",
            actual_sha256: Some(sha(DEPLOY)),
            previous_in_force: false,
        }]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_tampered_update_keeps_the_verified_version_and_is_reported_once() {
    let dir = empty_rule_dir("keep");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    rules.publish("wasm_shell", &sha(SHELL), SHELL);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();
    assert!(is_kill(
        &registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await
    ));

    // An update names a new version, and what sits under its hash is not it.
    rules.publish("wasm_shell", &sha(b"wasm_shell v2"), DEPLOY);
    for _ in 0..2 {
        tokio::time::sleep(RESYNC).await;
        assert!(
            is_kill(&registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await),
            "the verified version must keep enforcing"
        );
        assert_eq!(registry.plugin_count().await, 1);
    }
    assert_eq!(
        rules.anomalies().len(),
        1,
        "one incident per tampered binary, not one per resync"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Hashes correctly, compiles, and imports a host function the proxy does not
/// provide (`env.seed`, what AssemblyScript emits for `Math.random()`): it
/// cannot load.
fn unloadable() -> Vec<u8> {
    wat::parse_str(
        r#"(module
             (import "env" "seed" (func (result f64)))
             (memory (export "memory") 1)
             (func (export "allocate") (param i32) (result i32) i32.const 8)
             (func (export "evaluate") (param i32 i32) (result i32) i32.const 1))"#,
    )
    .unwrap()
}

/// A rule whose first version cannot load enforces nothing, which the
/// dashboard cannot show — it lists the rule either way — so the incident has
/// to say it.
#[tokio::test]
async fn a_rule_whose_first_version_cannot_load_is_reported_once() {
    let dir = empty_rule_dir("first");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    let bytes = unloadable();
    rules.publish("wasm_seed", &sha(&bytes), &bytes);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();

    assert_eq!(
        registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await,
        Verdict::Bypass
    );
    assert_eq!(registry.plugin_count().await, 0);
    tokio::time::sleep(RESYNC).await;
    registry.evaluate(&cp, &ctx("ws", "ls")).await;

    let anomalies = rules.anomalies();
    assert_eq!(anomalies.len(), 1, "once, not per resync: {anomalies:?}");
    assert!(anomalies[0].contains("wasm_seed"), "{}", anomalies[0]);
    assert!(anomalies[0].contains("env.seed"), "{}", anomalies[0]);
    assert!(
        anomalies[0].contains("enforces nothing"),
        "{}",
        anomalies[0]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_update_that_cannot_load_keeps_the_loaded_version_and_is_reported() {
    let dir = empty_rule_dir("unloadable-update");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    rules.publish("wasm_shell", &sha(SHELL), SHELL);
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();
    assert!(is_kill(
        &registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await
    ));

    let bytes = unloadable();
    rules.publish("wasm_shell", &sha(&bytes), &bytes);
    tokio::time::sleep(RESYNC).await;
    assert!(
        is_kill(&registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await),
        "the loaded version keeps enforcing"
    );
    let anomalies = rules.anomalies();
    assert_eq!(anomalies.len(), 1, "{anomalies:?}");
    assert!(anomalies[0].contains("stays in force"), "{}", anomalies[0]);
    let refusals = rules.refusals();
    assert_eq!(
        (refusals[0].refusal, refusals[0].previous_in_force),
        ("unloadable", true)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A descriptor naming a binary that is not there: refused and reported like
/// one that cannot load. The control plane writes binaries before descriptors,
/// so this is not a window every upload passes through.
#[tokio::test]
async fn a_rule_whose_binary_is_missing_is_reported() {
    let dir = empty_rule_dir("missing");
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let rules = Arc::new(CloudRules::default());
    rules.publish("wasm_shell", &sha(SHELL), SHELL);
    rules.binaries.lock().unwrap().clear();
    let cp: Arc<dyn ControlPlaneCache> = rules.clone();

    assert_eq!(
        registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await,
        Verdict::Bypass
    );
    let anomalies = rules.anomalies();
    assert_eq!(anomalies.len(), 1, "{anomalies:?}");
    assert!(anomalies[0].contains("missing"), "{}", anomalies[0]);
    let refusals = rules.refusals();
    assert_eq!(refusals[0].refusal, "missing");
    assert_eq!(refusals[0].actual_sha256, None);
    let _ = std::fs::remove_dir_all(&dir);
}
