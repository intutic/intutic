//! PCAS Gate Plugin — HLD §3.3
//!
//! Checks tool calls in the [`RequestContext`] against a cached
//! permission set resolved by the Policy & Compliance Adjudication
//! Service (PCAS).
//!
//! # Phase 1 design
//!
//! In Phase 1, permissions are stored as a simple in-memory
//! `HashMap<String, ToolPermission>` keyed by tool name. The proxy
//! populates this map from the workspace's PCAS policy document at
//! session start (or from Valkey cache).
//!
//! Phase 2 replaces this with a live gRPC/REST call to the PCAS
//! microservice with circuit-breaker semantics.
//!
//! # Verdict semantics
//!
//! | Permission state | Verdict |
//! |------------------|---------|
//! | All tool calls → `Allowed` | `Bypass` |
//! | Any tool call → `Denied` | `Kill` |
//! | Any tool call → `Unknown` (and none denied) | `Hijack` — hold for human review |
//! | No tool calls in request | `Bypass` |
//!
//! When multiple tool calls appear in a single request, the most
//! restrictive permission wins (Denied > Unknown > Allowed).

use std::collections::HashMap;

use crate::plugins::IntuticPlugin;
use crate::wasm::context::{RequestContext, Verdict};

/// Permission state for a single tool in the workspace policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPermission {
    /// Tool is explicitly allowed by workspace policy.
    Allowed,
    /// Tool is explicitly denied by workspace policy.
    Denied,
    /// Tool is not in the policy — requires human adjudication.
    Unknown,
}

/// PCAS gate plugin — enforces per-tool permissions from the workspace
/// policy cache.
///
/// See HLD §3.3 for the full PCAS integration design.
pub struct PcasGatePlugin {
    /// Cached permission set, keyed by tool name.
    ///
    /// In Phase 2 this is replaced by a live PCAS client with
    /// circuit-breaker fallback to this cache.
    permissions: HashMap<String, ToolPermission>,
}

impl PcasGatePlugin {
    /// Create a new PCAS gate plugin with a pre-populated permission map.
    ///
    /// # Arguments
    ///
    /// * `permissions` — Map of tool name → [`ToolPermission`]. Tools
    ///   not present in the map are treated as [`ToolPermission::Unknown`].
    pub fn new(permissions: HashMap<String, ToolPermission>) -> Self {
        Self { permissions }
    }

    /// Create a PCAS gate plugin with an empty permission set.
    ///
    /// Every tool call will be treated as [`ToolPermission::Unknown`],
    /// resulting in a [`Verdict::Hijack`] for human review. Useful for
    /// bootstrapping new workspaces before their first policy sync.
    pub fn with_empty_permissions() -> Self {
        Self {
            permissions: HashMap::new(),
        }
    }

    /// Resolve the permission for a tool name.
    ///
    /// Returns [`ToolPermission::Unknown`] if the tool is not in the
    /// cached permission set.
    fn resolve(&self, tool_name: &str) -> &ToolPermission {
        self.permissions
            .get(tool_name)
            .unwrap_or(&ToolPermission::Unknown)
    }
}

impl IntuticPlugin for PcasGatePlugin {
    fn name(&self) -> &str {
        "pcas-gate"
    }

    /// Priority 20 — runs after budget and DLP gates. Permission
    /// resolution is slightly more expensive (hash lookups over all
    /// tool calls) and benefits from early Kill on budget/DLP.
    fn priority(&self) -> u8 {
        20
    }

    /// Evaluate tool calls against the cached permission set.
    ///
    /// # Algorithm
    ///
    /// 1. If no tool calls → `Bypass`.
    /// 2. Resolve each tool call against the permission map.
    /// 3. If *any* tool is `Denied` → `Kill` (list all denied tools).
    /// 4. If *any* tool is `Unknown` → `Hijack` (hold for human review).
    /// 5. Otherwise → `Bypass`.
    fn evaluate(&self, ctx: &RequestContext) -> Verdict {
        if ctx.tool_calls.is_empty() {
            return Verdict::Bypass;
        }

        let mut denied: Vec<&str> = Vec::new();
        let mut unknown: Vec<&str> = Vec::new();

        for tc in &ctx.tool_calls {
            match self.resolve(&tc.name) {
                ToolPermission::Denied => denied.push(&tc.name),
                ToolPermission::Unknown => unknown.push(&tc.name),
                ToolPermission::Allowed => {} // no-op
            }
        }

        if !denied.is_empty() {
            return Verdict::Kill {
                reason: format!(
                    "PCAS policy violation — denied tool(s): [{}]",
                    denied.join(", ")
                ),
                policy_id: Some("pcas-denied".into()),
            };
        }

        if !unknown.is_empty() {
            return Verdict::Hijack {
                reason: format!(
                    "PCAS policy — unknown tool(s) require human review: [{}]",
                    unknown.join(", ")
                ),
                confidence: 0.0, // no confidence when permission is unresolved
            };
        }

        Verdict::Bypass
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::{RequestContext, RiskLevel, ToolCall};

    fn base_ctx() -> RequestContext {
        RequestContext {
            session_id: "sess-pcas".into(),
            workspace_id: "ws-1".into(),
            virtual_key_prefix: "vk-test".into(),
            model: "gpt-4o".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 500,
            budget_remaining_usd: 10.0,
            risk_tier: RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: vec![],
        }
    }

    fn tool_call(name: &str) -> ToolCall {
        ToolCall {
            id: format!("tc-{}", name),
            name: name.into(),
            arguments: serde_json::json!({}),
        }
    }

    #[test]
    fn bypass_when_no_tool_calls() {
        let plugin = PcasGatePlugin::with_empty_permissions();
        assert_eq!(plugin.evaluate(&base_ctx()), Verdict::Bypass);
    }

    #[test]
    fn bypass_when_all_tools_allowed() {
        let mut perms = HashMap::new();
        perms.insert("read_file".into(), ToolPermission::Allowed);
        perms.insert("list_dir".into(), ToolPermission::Allowed);
        let plugin = PcasGatePlugin::new(perms);

        let mut ctx = base_ctx();
        ctx.tool_calls = vec![tool_call("read_file"), tool_call("list_dir")];
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }

    #[test]
    fn kill_when_tool_denied() {
        let mut perms = HashMap::new();
        perms.insert("read_file".into(), ToolPermission::Allowed);
        perms.insert("exec_shell".into(), ToolPermission::Denied);
        let plugin = PcasGatePlugin::new(perms);

        let mut ctx = base_ctx();
        ctx.tool_calls = vec![tool_call("read_file"), tool_call("exec_shell")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Kill { .. }));
        if let Verdict::Kill { reason, policy_id } = verdict {
            assert!(reason.contains("exec_shell"));
            assert_eq!(policy_id, Some("pcas-denied".into()));
        }
    }

    #[test]
    fn hijack_when_tool_unknown() {
        let mut perms = HashMap::new();
        perms.insert("read_file".into(), ToolPermission::Allowed);
        let plugin = PcasGatePlugin::new(perms);

        let mut ctx = base_ctx();
        ctx.tool_calls = vec![tool_call("read_file"), tool_call("new_fancy_tool")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Hijack { .. }));
        if let Verdict::Hijack { reason, .. } = verdict {
            assert!(reason.contains("new_fancy_tool"));
        }
    }

    #[test]
    fn denied_takes_precedence_over_unknown() {
        let mut perms = HashMap::new();
        perms.insert("exec_shell".into(), ToolPermission::Denied);
        // "mystery_tool" is not in the map → Unknown
        let plugin = PcasGatePlugin::new(perms);

        let mut ctx = base_ctx();
        ctx.tool_calls = vec![tool_call("exec_shell"), tool_call("mystery_tool")];
        let verdict = plugin.evaluate(&ctx);
        // Denied wins over Unknown
        assert!(matches!(verdict, Verdict::Kill { .. }));
    }

    #[test]
    fn empty_permissions_hijacks_all_tools() {
        let plugin = PcasGatePlugin::with_empty_permissions();
        let mut ctx = base_ctx();
        ctx.tool_calls = vec![tool_call("any_tool")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Hijack { .. }));
    }
}
