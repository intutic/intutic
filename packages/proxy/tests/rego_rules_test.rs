//! Rego rules through the registry: loaded from both rule sources, on by
//! default, and their verdicts attributed and ordered like every other rule's.
//! The kill switch has its own test binary (`rego_kill_switch_test.rs`): it is
//! an environment variable, and tests in one binary share a process.

use intutic_proxy::store::{ControlPlaneCache, NullControlPlaneCache};
use intutic_proxy::wasm::context::{RequestContext, RiskLevel, Verdict};
use intutic_proxy::wasm::registry::PluginRegistry;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

const SHELL: &[u8] = include_bytes!("fixtures/rego/examples/block_destructive_shell.wasm");
const DEPLOY: &[u8] = include_bytes!("fixtures/rego/examples/hold_prod_deploys.wasm");
const UNSUPPORTED: &[u8] = include_bytes!("fixtures/rego/unsupported_builtin.wasm");

fn temp_rule_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("intutic-rego-{tag}-{nanos}"));
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

fn null_control_plane() -> Arc<dyn ControlPlaneCache> {
    Arc::new(NullControlPlaneCache)
}

#[tokio::test]
async fn a_rego_rule_in_the_local_directory_is_enforced_by_default() {
    let dir = temp_rule_dir("local");
    std::fs::write(dir.join("10_shell.wasm"), SHELL).unwrap();
    std::fs::write(dir.join("20_deploy.wasm"), DEPLOY).unwrap();
    std::fs::write(dir.join("30_unsupported.wasm"), UNSUPPORTED).unwrap();
    let registry = PluginRegistry::new(dir.to_str()).await.unwrap();
    let cp = null_control_plane();

    match registry.evaluate(&cp, &ctx("ws", "rm -rf /")).await {
        Verdict::Kill { reason, policy_id } => {
            assert_eq!(policy_id.as_deref(), Some("local:10_shell.wasm"));
            assert_eq!(reason, "destructive shell command blocked: rm -rf /");
        }
        other => panic!("expected a block, got {other:?}"),
    }
    match registry
        .evaluate(&cp, &ctx("ws", "terraform apply -var env=prod"))
        .await
    {
        Verdict::Hold {
            policy_id,
            risk_tier,
            ..
        } => {
            assert_eq!(policy_id.as_deref(), Some("local:20_deploy.wasm"));
            assert_eq!(risk_tier, Some(RiskLevel::High));
        }
        other => panic!("expected a hold, got {other:?}"),
    }
    assert_eq!(
        registry.evaluate(&cp, &ctx("ws", "cargo test")).await,
        Verdict::Bypass
    );
    // The policy needing `crypto.md5` was refused at load, not counted.
    assert_eq!(registry.plugin_count().await, 2);

    let _ = std::fs::remove_dir_all(&dir);
}

/// The control plane publishes a rule as a descriptor list and the module by
/// its SHA-256, the same two keys for a Rego rule as for a native one.
struct CloudRules {
    descriptors: String,
    binaries: Vec<(String, Vec<u8>)>,
}

impl CloudRules {
    fn new(rules: &[(&str, &[u8], &str)]) -> Self {
        let mut descriptors = Vec::new();
        let mut binaries = Vec::new();
        for (i, (rule_id, bytes, mode)) in rules.iter().enumerate() {
            let sha = hex::encode(Sha256::digest(bytes));
            descriptors.push(json!({
                "ruleId": rule_id, "name": rule_id, "sha256": sha,
                "priority": 10 + i, "mode": mode
            }));
            binaries.push((sha, bytes.to_vec()));
        }
        Self {
            descriptors: serde_json::to_string(&descriptors).unwrap(),
            binaries,
        }
    }
}

#[async_trait::async_trait]
impl ControlPlaneCache for CloudRules {
    async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
        Ok(Some(self.descriptors.clone()))
    }
    async fn wasm_binary(&self, sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self
            .binaries
            .iter()
            .find(|(s, _)| s == sha)
            .map(|(_, b)| b.clone()))
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

#[tokio::test]
async fn a_rego_rule_from_the_control_plane_enforces_and_shadows_like_a_native_one() {
    let empty = temp_rule_dir("cloud");
    let registry = PluginRegistry::new(empty.to_str()).await.unwrap();
    let cp: Arc<dyn ControlPlaneCache> = Arc::new(CloudRules::new(&[
        ("wasm_shell", SHELL, "ENFORCE"),
        ("wasm_deploy", DEPLOY, "SHADOW"),
        ("wasm_unsupported", UNSUPPORTED, "ENFORCE"),
    ]));

    let (verdict, shadow) = registry
        .evaluate_with_shadow(&cp, &ctx("ws_cloud", "rm -rf ~"))
        .await;
    match verdict {
        Verdict::Kill { policy_id, .. } => assert_eq!(policy_id.as_deref(), Some("wasm_shell")),
        other => panic!("expected a block, got {other:?}"),
    }
    // The shadowed rule sorts after the blocking one (priority 11 to 10), and
    // a block ends the evaluation before it.
    assert!(shadow.is_empty(), "{shadow:?}");

    let (verdict, shadow) = registry
        .evaluate_with_shadow(&cp, &ctx("ws_cloud", "helm upgrade api ./chart -n prod"))
        .await;
    assert_eq!(verdict, Verdict::Bypass, "a shadowed hold changes nothing");
    assert_eq!(shadow.len(), 1);
    assert_eq!(shadow[0].rule_id, "wasm_deploy");
    assert!(shadow[0].would_act);
    assert!(shadow[0].verdict.contains("Hold"), "{}", shadow[0].verdict);

    // The rule needing a builtin the host lacks was refused, not loaded.
    assert_eq!(registry.plugin_count().await, 2);
    let _ = std::fs::remove_dir_all(&empty);
}
