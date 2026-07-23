//! Budget Gate Plugin — HLD §3.2
//!
//! Estimates the cost of a request based on the target model and
//! estimated input token count, then compares against the remaining
//! budget on the virtual key.
//!
//! # Cost model
//!
//! Phase 1 uses a static lookup table of cost-per-1K-input-tokens for
//! well-known models. Unknown models fall back to a conservative
//! "premium" rate to avoid accidental budget overruns.
//!
//! A **20% safety margin** is applied to all estimates to account for
//! output tokens and tool-call overhead that aren't yet known at
//! request time. This margin is configurable per-workspace in Phase 2.
//!
//! # Verdict semantics
//!
//! | Condition | Verdict |
//! |-----------|---------|
//! | Estimated cost ≤ remaining budget | `Bypass` |
//! | Estimated cost > remaining budget  | `Kill` with policy `"budget-exceeded"` |

use crate::plugins::IntuticPlugin;
use crate::pricing;
use crate::wasm::context::{RequestContext, Verdict};

/// Safety margin multiplier applied to all cost estimates.
///
/// 1.20 = 20% headroom for output tokens, tool-call overhead,
/// and provider billing rounding.
const SAFETY_MARGIN: f64 = 1.20;

/// Budget gate plugin — blocks requests that would exceed the
/// virtual key's remaining budget.
///
/// See HLD §3.2 for the full budget enforcement design.
pub struct BudgetGatePlugin;

impl BudgetGatePlugin {
    /// Create a new budget gate plugin instance.
    pub fn new() -> Self {
        Self
    }

    /// Returns cost-per-1K-input-tokens (USD) for a given model name.
    ///
    /// Delegates to the offline pricing bundle (WS-5OP) which provides exact model
    /// lookup, family-prefix fallback, and a conservative Opus-class estimate for
    /// unknowns. Prices are kept in sync monthly via build-offline-pricing-bundle.ts.
    fn cost_per_1k_tokens(model: &str) -> f64 {
        pricing::input_cost_per_1k(model)
    }
}

impl Default for BudgetGatePlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl IntuticPlugin for BudgetGatePlugin {
    fn name(&self) -> &str {
        "budget-gate"
    }

    /// Priority 10 — runs early because budget checks are cheap and
    /// can save expensive downstream work (DLP scanning, PCAS lookup).
    fn priority(&self) -> u8 {
        10
    }

    /// Estimate request cost and compare against remaining budget.
    ///
    /// # Algorithm
    ///
    /// 1. Look up cost-per-1K-tokens for `ctx.model`.
    /// 2. Compute `estimated_cost = (tokens / 1000) × rate × SAFETY_MARGIN`.
    /// 3. If `estimated_cost > budget_remaining_usd` → `Kill`.
    /// 4. Otherwise → `Bypass`.
    fn evaluate(&self, ctx: &RequestContext) -> Verdict {
        let rate = Self::cost_per_1k_tokens(&ctx.model);
        let estimated_cost = (ctx.estimated_input_tokens as f64 / 1000.0) * rate * SAFETY_MARGIN;

        if estimated_cost > ctx.budget_remaining_usd {
            Verdict::Kill {
                reason: format!(
                    "Estimated cost ${:.6} exceeds remaining budget ${:.6} \
                     (model={}, tokens={}, rate=${:.6}/1K, margin={}%)",
                    estimated_cost,
                    ctx.budget_remaining_usd,
                    ctx.model,
                    ctx.estimated_input_tokens,
                    rate,
                    ((SAFETY_MARGIN - 1.0) * 100.0) as u32,
                ),
                policy_id: Some("budget-exceeded".into()),
            }
        } else {
            Verdict::Bypass
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::{RequestContext, RiskLevel};

    fn base_ctx() -> RequestContext {
        RequestContext {
            session_id: "sess-budget".into(),
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
    fn bypass_when_within_budget() {
        let plugin = BudgetGatePlugin::new();
        let ctx = base_ctx(); // 1K tokens × $0.005/1K × 1.20 = $0.006
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }

    #[test]
    fn kill_when_over_budget() {
        let plugin = BudgetGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.budget_remaining_usd = 0.001; // way too low
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Kill { .. }));
    }

    #[test]
    fn unknown_model_uses_conservative_rate() {
        let plugin = BudgetGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.model = "some-unknown-model-v99".into();
        ctx.estimated_input_tokens = 100_000;
        ctx.budget_remaining_usd = 1.0;
        // 100K tokens × $0.030/1K × 1.20 = $3.60 > $1.0 → Kill
        let verdict = plugin.evaluate(&ctx);
        assert!(matches!(verdict, Verdict::Kill { .. }));
    }

    #[test]
    fn cheap_model_stays_within_budget() {
        let plugin = BudgetGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.model = "gemini-1.5-flash".into();
        ctx.estimated_input_tokens = 10_000;
        ctx.budget_remaining_usd = 0.01;
        // 10K tokens × $0.000075/1K × 1.20 = $0.0009 < $0.01 → Bypass
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }

    #[test]
    fn case_insensitive_model_matching() {
        let plugin = BudgetGatePlugin::new();
        let mut ctx = base_ctx();
        ctx.model = "GPT-4o".into();
        // Should still match the gpt-4o rate
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }
}
