//! DLP Gate Plugin — HLD §3.1
//!
//! Evaluates Data Loss Prevention findings attached to the
//! [`RequestContext`] by the upstream DLP scanner.
//!
//! This plugin runs at **priority 5** — the lowest (most urgent) of
//! all Phase 1 plugins — because security-sensitive content must be
//! caught before any budget or permission checks occur.
//!
//! # Verdict semantics
//!
//! | DLP action found | Verdict |
//! |------------------|---------|
//! | Any finding with `action = "block"` | `Kill` — request rejected |
//! | Any finding with `action = "redact"` (and none blocking) | `Enhance` — inject redaction notice |
//! | No findings | `Bypass` — request proceeds unmodified |
//!
//! # Design note
//!
//! The actual DLP scanning (regex + ML pattern matching) happens in the
//! [`crate::dlp`] module *before* the plugin chain runs. This plugin
//! only reads the pre-computed findings and makes a governance decision.
//! Keeping detection and enforcement separate follows HLD §3.1's
//! principle of "scan once, enforce everywhere."

use crate::plugins::IntuticPlugin;
use crate::wasm::context::{RequestContext, Verdict};

/// DLP gate plugin — enforces Data Loss Prevention policy based on
/// findings from the bidirectional DLP scanner.
///
/// See HLD §3.1 for the full DLP enforcement architecture.
pub struct DlpGatePlugin;

impl DlpGatePlugin {
    /// Create a new DLP gate plugin instance.
    pub fn new() -> Self {
        Self
    }
}

impl Default for DlpGatePlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl IntuticPlugin for DlpGatePlugin {
    fn name(&self) -> &str {
        "dlp-gate"
    }

    /// Priority 5 — security-critical, runs before all other plugins.
    fn priority(&self) -> u8 {
        5
    }

    /// Evaluate DLP findings and return the appropriate verdict.
    ///
    /// Scans `ctx.dlp_findings` in order. A single `"block"` finding
    /// is enough to `Kill` the entire request. If no blocking findings
    /// exist but redaction findings are present, the plugin returns
    /// `Enhance` with a human-readable redaction summary.
    fn evaluate(&self, ctx: &RequestContext) -> Verdict {
        if ctx.dlp_findings.is_empty() {
            return Verdict::Bypass;
        }

        // Check for any blocking findings first (hard stop)
        let blocked: Vec<&str> = ctx
            .dlp_findings
            .iter()
            .filter(|f| f.action == "block")
            .map(|f| f.pattern_name.as_str())
            .collect();

        if !blocked.is_empty() {
            return Verdict::Kill {
                reason: format!(
                    "DLP policy violation — blocked patterns detected: [{}]",
                    blocked.join(", ")
                ),
                policy_id: Some("dlp-block".into()),
            };
        }

        // Check for redaction findings (soft enforcement)
        let redacted: Vec<&str> = ctx
            .dlp_findings
            .iter()
            .filter(|f| f.action == "redact")
            .map(|f| f.pattern_name.as_str())
            .collect();

        if !redacted.is_empty() {
            return Verdict::Enhance {
                context: format!(
                    "[DLP] {} pattern(s) redacted before forwarding: [{}]. \
                     Original content has been masked per workspace DLP policy.",
                    redacted.len(),
                    redacted.join(", ")
                ),
            };
        }

        // Findings exist but none are block or redact — pass through
        Verdict::Bypass
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::{DlpFinding, RequestContext, RiskLevel};

    fn base_ctx() -> RequestContext {
        RequestContext {
            session_id: "sess-dlp".into(),
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

    fn finding(pattern: &str, action: &str) -> DlpFinding {
        DlpFinding {
            category: "secret".into(),
            pattern_name: pattern.into(),
            action: action.into(),
            offset: 0,
            length: 10,
        }
    }

    #[test]
    fn bypass_when_no_findings() {
        let plugin = DlpGatePlugin::new();
        assert_eq!(plugin.evaluate(&base_ctx()), Verdict::Bypass);
    }

    #[test]
    fn kill_on_block_finding() {
        let plugin = DlpGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![finding("aws_key", "block")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Kill { .. }));
        if let Verdict::Kill { reason, policy_id } = verdict {
            assert!(reason.contains("aws_key"));
            assert_eq!(policy_id, Some("dlp-block".into()));
        }
    }

    #[test]
    fn enhance_on_redact_finding() {
        let plugin = DlpGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![finding("ssn", "redact")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Enhance { .. }));
        if let Verdict::Enhance { context } = verdict {
            assert!(context.contains("ssn"));
            assert!(context.contains("1 pattern(s) redacted"));
        }
    }

    #[test]
    fn block_takes_precedence_over_redact() {
        let plugin = DlpGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![finding("ssn", "redact"), finding("github_token", "block")];
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Kill { .. }));
    }

    #[test]
    fn multiple_redactions_listed() {
        let plugin = DlpGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![
            finding("ssn", "redact"),
            finding("email", "redact"),
            finding("phone", "redact"),
        ];
        let verdict = plugin.evaluate(&ctx);
        if let Verdict::Enhance { context } = verdict {
            assert!(context.contains("3 pattern(s) redacted"));
            assert!(context.contains("ssn"));
            assert!(context.contains("email"));
            assert!(context.contains("phone"));
        } else {
            panic!("Expected Enhance verdict");
        }
    }

    #[test]
    fn unknown_action_is_bypass() {
        let plugin = DlpGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![finding("something", "warn")];
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }
}
