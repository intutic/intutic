//! `INTUTIC_DISABLE_REGO_RULES=1` refuses Rego rules at load.
//!
//! Alone in its own test binary because the switch is a process-wide
//! environment variable, and tests in one binary run in parallel.

use intutic_proxy::store::{ControlPlaneCache, NullControlPlaneCache};
use intutic_proxy::wasm::context::{RequestContext, Verdict};
use intutic_proxy::wasm::registry::PluginRegistry;
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn the_kill_switch_refuses_rego_rules() {
    let dir = std::env::temp_dir().join(format!("intutic-rego-off-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("10_shell.wasm"),
        include_bytes!("fixtures/rego/examples/block_destructive_shell.wasm"),
    )
    .unwrap();
    let mut ctx: RequestContext = serde_json::from_value(json!({
        "session_id": "s", "workspace_id": "w", "virtual_key_prefix": "vk", "model": "m",
        "tools": [], "tool_calls": [], "estimated_input_tokens": 1,
        "budget_remaining_usd": 1.0, "risk_tier": "Low", "dlp_findings": [], "tool_sequence": []
    }))
    .unwrap();
    ctx.turn_tool_calls = serde_json::from_value(json!([
        { "id": "c", "name": "Bash", "arguments": { "command": "rm -rf /" } }
    ]))
    .unwrap();
    let cp: Arc<dyn ControlPlaneCache> = Arc::new(NullControlPlaneCache);

    std::env::set_var("INTUTIC_DISABLE_REGO_RULES", "1");
    let off = PluginRegistry::new(dir.to_str()).await.unwrap();
    assert_eq!(off.evaluate(&cp, &ctx).await, Verdict::Bypass);
    assert_eq!(off.plugin_count().await, 0, "refused at load");

    std::env::remove_var("INTUTIC_DISABLE_REGO_RULES");
    let on = PluginRegistry::new(dir.to_str()).await.unwrap();
    assert!(matches!(on.evaluate(&cp, &ctx).await, Verdict::Kill { .. }));

    let _ = std::fs::remove_dir_all(&dir);
}
