//! Governance plugin system — native Rust implementations.
//!
//! Phase 1 uses native trait impls compiled directly into the proxy binary.
//! Phase 3 adds wasmtime WASM host for user-authored rules (TD-004).
//!
//! Each plugin receives a [`RequestContext`] and returns a [`Verdict`].
//! The [`evaluate_chain`] function runs plugins in priority order and
//! short-circuits on the first [`Verdict::Kill`].

pub mod budget_gate;
pub mod dlp_gate;
pub mod pcas_gate;
pub mod semantic_cache;
pub mod sequence_anomaly;
pub mod sop_prompt_injector;

use crate::wasm::context::{RequestContext, Verdict};

/// Plugin trait — identical interface for native Rust and future WASM plugins.
///
/// Every governance gate (budget, DLP, PCAS, …) implements this trait.
/// The proxy calls [`evaluate_chain`] with a sorted `Vec<Box<dyn IntuticPlugin>>`
/// on each inbound request.
///
/// # Contract
///
/// - [`name`](IntuticPlugin::name) must be a stable, kebab-case identifier
///   (e.g. `"budget-gate"`) used in telemetry spans and audit logs.
/// - [`priority`](IntuticPlugin::priority) determines execution order:
///   **lower values run first**. Security-critical gates (DLP) should use
///   single-digit priorities.
/// - [`evaluate`](IntuticPlugin::evaluate) must be **pure** — no I/O, no
///   mutations. Side-effects belong in the proxy pipeline, not in plugins.
pub trait IntuticPlugin: Send + Sync {
    /// Stable identifier for telemetry and audit logs.
    fn name(&self) -> &str;

    /// Execution priority — lower values run first.
    fn priority(&self) -> u8;

    /// Evaluate the request context and return a governance verdict.
    fn evaluate(&self, ctx: &RequestContext) -> Verdict;
}

/// Runs all plugins in priority order. Short-circuits on first [`Verdict::Kill`].
///
/// Returns the most restrictive verdict observed:
///
/// | Precedence | Verdict | Behaviour |
/// |------------|---------|-----------|
/// | 1 (highest)| `Kill`  | Immediately returned — no further plugins run |
/// | 2          | `Hijack`| Stored, but remaining plugins still run |
/// | 3          | `Enhance`| Stored only if nothing worse seen yet |
/// | 4 (lowest) | `Bypass`| Default — request proceeds unmodified |
///
/// **Important:** The caller is responsible for sorting `plugins` by
/// [`IntuticPlugin::priority`] before calling this function. The chain
/// itself iterates in the order given.
pub fn evaluate_chain(plugins: &[Box<dyn IntuticPlugin>], ctx: &RequestContext) -> Verdict {
    let mut worst_verdict = Verdict::Bypass;
    for plugin in plugins {
        let verdict = plugin.evaluate(ctx);
        match &verdict {
            Verdict::Kill { .. } => return verdict, // short-circuit
            Verdict::Hijack { .. } => worst_verdict = verdict,
            Verdict::Enhance { .. } if matches!(worst_verdict, Verdict::Bypass) => {
                worst_verdict = verdict;
            }
            _ => {}
        }
    }
    worst_verdict
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::{RequestContext, RiskLevel, Verdict};

    /// Minimal plugin for testing chain behaviour.
    struct StubPlugin {
        verdict: Verdict,
        priority: u8,
    }

    impl IntuticPlugin for StubPlugin {
        fn name(&self) -> &str {
            "stub"
        }
        fn priority(&self) -> u8 {
            self.priority
        }
        fn evaluate(&self, _ctx: &RequestContext) -> Verdict {
            self.verdict.clone()
        }
    }

    fn dummy_ctx() -> RequestContext {
        RequestContext {
            session_id: "sess-1".into(),
            workspace_id: "ws-1".into(),
            virtual_key_prefix: "vk-test".into(),
            model: "gpt-4o".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 1000,
            budget_remaining_usd: 10.0,
            risk_tier: RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: vec![],
        }
    }

    #[test]
    fn chain_returns_bypass_when_all_bypass() {
        let plugins: Vec<Box<dyn IntuticPlugin>> = vec![
            Box::new(StubPlugin {
                verdict: Verdict::Bypass,
                priority: 1,
            }),
            Box::new(StubPlugin {
                verdict: Verdict::Bypass,
                priority: 2,
            }),
        ];
        assert_eq!(evaluate_chain(&plugins, &dummy_ctx()), Verdict::Bypass);
    }

    #[test]
    fn chain_short_circuits_on_kill() {
        let plugins: Vec<Box<dyn IntuticPlugin>> = vec![
            Box::new(StubPlugin {
                verdict: Verdict::Kill {
                    reason: "blocked".into(),
                    policy_id: None,
                },
                priority: 1,
            }),
            Box::new(StubPlugin {
                verdict: Verdict::Bypass,
                priority: 2,
            }),
        ];
        let result = evaluate_chain(&plugins, &dummy_ctx());
        assert!(matches!(result, Verdict::Kill { .. }));
    }

    #[test]
    fn chain_keeps_hijack_over_enhance() {
        let plugins: Vec<Box<dyn IntuticPlugin>> = vec![
            Box::new(StubPlugin {
                verdict: Verdict::Hijack {
                    reason: "needs review".into(),
                    confidence: 0.6,
                },
                priority: 1,
            }),
            Box::new(StubPlugin {
                verdict: Verdict::Enhance {
                    context: "note".into(),
                },
                priority: 2,
            }),
        ];
        let result = evaluate_chain(&plugins, &dummy_ctx());
        assert!(matches!(result, Verdict::Hijack { .. }));
    }
}
