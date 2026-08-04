//! Cost prediction gate — evaluates whether a request should be gated
//! based on estimated cost exceeding a workspace threshold.
//!
//! Runs BEFORE forwarding the request to the LLM provider.
//! If the estimated cost exceeds the threshold, returns a cost estimate
//! response instead of forwarding to the LLM.

use serde::Serialize;
use std::sync::Arc;

use crate::store::ControlPlaneCache;
use crate::token::counter;

/// Cost prediction gate.
///
/// It holds a `ControlPlaneCache` rather than its own connection because the
/// keys it reads (`tok:predict:gate:*`, `tok:baseline:*`) belong to the control
/// plane.
///
/// # The claim that used to be here
///
/// This said "standalone that resolves to the null cache and the gate is
/// inert". That was false, and the falsehood is worth keeping visible.
/// `NullControlPlaneCache` returns `None` for the threshold, and `None` was
/// collapsed to `0.0` — a zero-dollar ceiling, which every request exceeds. The
/// gate was inert standalone only because the *call site* is skipped when
/// `CONTROL_PLANE_URL` is unset. Wherever that variable is set — including the
/// shipped Kubernetes deployment — the null cache was just as fatal as a
/// missing key, and no request ever reached a model.
///
/// An absent threshold now means the gate is off, which is what "unconfigured"
/// has to mean for a control nothing configures.
pub struct CostPredictionGate {
    control_plane: Arc<dyn ControlPlaneCache>,
}

/// Result of cost estimation.
#[derive(Debug, Serialize)]
pub struct CostEstimate {
    pub input_tokens: u32,
    pub estimated_output_tokens: u32,
    pub estimated_reasoning_tokens: u32,
    pub estimated_cost_usd: f64,
    pub confidence: &'static str,
    /// `None` when the workspace has no gate configured — which is every
    /// workspace, since no product surface writes `tok:predict:gate:*`. Kept as
    /// an `Option` rather than a sentinel so "unconfigured" cannot be confused
    /// with "a ceiling of zero".
    pub threshold_usd: Option<f64>,
    pub exceeds_threshold: bool,
}

/// Historical baseline statistics, derived from the stored counters.
#[derive(Debug)]
struct BaselineStats {
    avg: f64,
    p50: f64,
    #[allow(dead_code)]
    p95: f64,
    reasoning_avg: f64,
    sample_count: u64,
}

impl CostPredictionGate {
    pub fn new(control_plane: Arc<dyn ControlPlaneCache>) -> Self {
        Self { control_plane }
    }

    /// Predict estimated cost and tokens.
    pub async fn predict(
        &self,
        workspace_id: &str,
        model: &str,
        input_messages: &serde_json::Value,
    ) -> Option<CostEstimate> {
        // 1. Count input tokens
        let input_tokens = counter::count_message_tokens(input_messages, model).ok()?;

        // 2. Get workspace gate threshold, if one is configured at all.
        //
        // NOT `.unwrap_or(0.0)`. Nothing in production writes this key, so it is
        // absent everywhere, and reading absent as a $0 ceiling made
        // `estimated_cost > threshold` true for every request forever.
        let threshold = self.control_plane.predict_gate_threshold(workspace_id).await;

        // 3. Look up historical baseline
        let bucket = counter::get_input_bucket(input_tokens);
        let baseline = self.get_baseline(workspace_id, model, bucket).await;

        // 4. Estimate output tokens
        let (estimated_output, estimated_reasoning, confidence) = match &baseline {
            Some(b) if b.sample_count >= 10 => (b.p50 as u32, b.reasoning_avg as u32, "high"),
            Some(b) if b.sample_count >= 3 => (b.avg as u32, b.reasoning_avg as u32, "medium"),
            _ => {
                let multiplier = default_output_multiplier(model);
                ((input_tokens as f64 * multiplier) as u32, 0u32, "low")
            }
        };

        // 5. Calculate estimated cost
        let pricing = get_model_pricing(model);
        let estimated_cost = (input_tokens as f64 * pricing.0)
            + (estimated_output as f64 * pricing.1)
            + (estimated_reasoning as f64 * pricing.2);

        // A threshold of zero or less is treated as "off" too. It cannot be a
        // policy anyone acts on — it denies a one-token request and reports the
        // ceiling as `$0.0000`, which reads as a bug rather than a budget — and
        // it is the one value that made this failure silent.
        let exceeds_threshold = matches!(threshold, Some(t) if t > 0.0 && estimated_cost > t);

        Some(CostEstimate {
            input_tokens,
            estimated_output_tokens: estimated_output,
            estimated_reasoning_tokens: estimated_reasoning,
            estimated_cost_usd: estimated_cost,
            confidence,
            threshold_usd: threshold,
            exceeds_threshold,
        })
    }

    /// Evaluate whether the request should be gated on cost.
    ///
    /// Returns `Some(estimate)` if cost exceeds the workspace threshold.
    /// Returns `None` to proceed normally (cost is within budget or gate disabled).
    pub async fn evaluate(
        &self,
        _session_id: &str,
        workspace_id: &str,
        model: &str,
        input_messages: &serde_json::Value,
    ) -> Option<CostEstimate> {
        let est = self.predict(workspace_id, model, input_messages).await?;
        if est.exceeds_threshold {
            Some(est)
        } else {
            None
        }
    }

    /// Render the gate verdict in the wire format the client actually asked for.
    ///
    /// This always emitted an OpenAI `chat.completion` envelope with
    /// `choices[]`, including on Anthropic `/v1/messages` — so Claude Code, the
    /// primary client, received a structurally invalid response rather than
    /// merely an unexpected one. The passing integration test asserted
    /// `body.choices[0]` on a `/v1/messages` call, so it pinned the wrong shape.
    ///
    /// `construct_mock_response` already builds a correct synthetic body for all
    /// four protocols and is used by the semantic cache for exactly this
    /// purpose. Reused rather than re-derived: a second hand-written envelope is
    /// how the two drift apart.
    pub fn format_gate_response(
        estimate: &CostEstimate,
        model: &str,
        protocol: &crate::protocol::Protocol,
    ) -> Vec<u8> {
        let threshold = estimate.threshold_usd.unwrap_or_default();
        let text = format!(
            "### 💰 Cost Prediction Gate\n\n\
            This request is estimated to cost **${:.4}**, which exceeds your \
            workspace threshold of **${:.4}**.\n\n\
            | Metric | Value |\n|--------|-------|\n\
            | Input tokens | {} |\n\
            | Est. output tokens | {} |\n\
            | Est. reasoning tokens | {} |\n\
            | Est. cost | ${:.4} |\n\
            | Threshold | ${:.4} |\n\
            | Confidence | {} |\n\
            | Model | {} |",
            estimate.estimated_cost_usd,
            threshold,
            estimate.input_tokens,
            estimate.estimated_output_tokens,
            estimate.estimated_reasoning_tokens,
            estimate.estimated_cost_usd,
            threshold,
            estimate.confidence,
            model,
        );

        // The remediation line that used to close this message told the user to
        // "add `--force` to your message or adjust the threshold in Settings →
        // Billing". Neither exists: the only `--force` parser in the crate
        // bypasses the *quality* gate (`quality/mod.rs`), and no UI or API
        // writes `tok:predict:gate:*`. Advice pointing at two surfaces that are
        // not there is worse than no advice — it sends the reader looking.
        let cached = crate::store::CachedResponse {
            prompt: String::new(),
            response: text,
            model: model.to_string(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_at: String::new(),
        };
        let body = crate::plugins::semantic_cache::construct_mock_response(protocol, &cached, model);
        serde_json::to_vec(&body).unwrap_or_default()
    }

    async fn get_baseline(
        &self,
        workspace_id: &str,
        model: &str,
        bucket: &str,
    ) -> Option<BaselineStats> {
        let raw = self
            .control_plane
            .token_baseline(workspace_id, model, bucket)
            .await?;
        if raw.count == 0 {
            return None;
        }
        let avg = raw.sum / raw.count as f64;
        Some(BaselineStats {
            avg,
            p50: avg,       // Approximate — exact p50 requires sorted data
            p95: avg * 1.5, // Approximate
            reasoning_avg: raw.reasoning_sum / raw.count as f64,
            sample_count: raw.count,
        })
    }
}

/// Default output multiplier when no baseline exists.
fn default_output_multiplier(model: &str) -> f64 {
    if model.contains("claude") {
        0.8
    } else if model.contains("gpt-4") {
        0.6
    } else if model.contains("o1") || model.contains("o3") || model.contains("o4") {
        2.0
    } else if model.contains("gemini") {
        0.7
    } else {
        0.5
    }
}

/// Returns (input_price_per_token, output_price_per_token, reasoning_price_per_token).
fn get_model_pricing(model: &str) -> (f64, f64, f64) {
    // Prices per token (approximate, from public pricing pages)
    if model.contains("claude-4-opus") {
        (0.000015, 0.000075, 0.000075)
    } else if model.contains("claude-4-sonnet") || model.contains("claude-4") {
        (0.000003, 0.000015, 0.000015)
    } else if model.contains("claude-4-haiku") {
        (0.0000008, 0.000004, 0.000004)
    } else if model.contains("gpt-4o") {
        (0.0000025, 0.00001, 0.00001)
    } else if model.contains("o1") || model.contains("o3") {
        (0.000015, 0.00006, 0.00006)
    } else if model.contains("gemini-2.5-pro") {
        (0.00000125, 0.00001, 0.00001)
    } else {
        // Default fallback pricing
        (0.000003, 0.000015, 0.000015)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::memory::NullControlPlaneCache;

    fn msgs() -> serde_json::Value {
        serde_json::json!([{ "role": "user", "content": "refactor the parser" }])
    }

    /// No configured threshold must mean **no gate**.
    ///
    /// This is the defect, and it was a live production break rather than a
    /// latent one. `predict_gate_threshold` returns `None` when
    /// `tok:predict:gate:{ws}` is absent — and nothing in production writes that
    /// key, so it is absent everywhere. `.unwrap_or(0.0)` turned "unconfigured"
    /// into "a ceiling of zero dollars", and `estimated_cost > 0.0` is true for
    /// every request: `get_model_pricing` returns a non-zero fallback for every
    /// model, and `count_message_tokens` adds an unconditional `+3` priming, so
    /// the cost is never zero even for an empty message list.
    ///
    /// `evaluate()` therefore returned `Some` unconditionally, and the call site
    /// at `proxy.rs:2364-2379` hard-returns HTTP 200 with a synthetic assistant
    /// message *before* the forward step. On the shipped Kubernetes deployment —
    /// which sets `CONTROL_PLANE_URL` and `VALKEY_URL` — no model call ever
    /// happened.
    #[tokio::test]
    async fn an_unconfigured_threshold_does_not_gate() {
        let gate = CostPredictionGate::new(Arc::new(NullControlPlaneCache));
        let verdict = gate
            .evaluate("ses_1", "ws_1", "claude-4-sonnet", &msgs())
            .await;
        assert!(
            verdict.is_none(),
            "an absent threshold must mean the gate is off, not a $0 ceiling: {:?}",
            verdict.map(|e| e.estimated_cost_usd),
        );
    }

    /// An explicit zero is still off.
    ///
    /// A zero-dollar ceiling is not a policy anyone can act on — it denies
    /// everything including a one-token request, and the response tells the user
    /// their threshold is `$0.0000`, which reads as a bug rather than a budget.
    /// Treating it as "off" removes the only value that made this failure
    /// silent.
    #[tokio::test]
    async fn an_explicit_zero_threshold_does_not_gate() {
        let gate = CostPredictionGate::new(Arc::new(FixedThreshold(Some(0.0))));
        assert!(gate
            .evaluate("ses_1", "ws_1", "claude-4-sonnet", &msgs())
            .await
            .is_none());
    }

    /// And a real threshold must still fire, or the fix is a deletion.
    #[tokio::test]
    async fn a_configured_threshold_still_gates_when_exceeded() {
        let gate = CostPredictionGate::new(Arc::new(FixedThreshold(Some(0.000001))));
        let hit = gate
            .evaluate("ses_1", "ws_1", "claude-4-opus", &msgs())
            .await
            .expect("a request over a configured ceiling must gate");
        assert!(hit.exceeds_threshold);
        assert!(hit.estimated_cost_usd > 0.000001);
    }

    #[tokio::test]
    async fn a_generous_threshold_lets_the_request_through() {
        let gate = CostPredictionGate::new(Arc::new(FixedThreshold(Some(1_000.0))));
        assert!(gate
            .evaluate("ses_1", "ws_1", "claude-4-sonnet", &msgs())
            .await
            .is_none());
    }

    /// The gate body must match the route the client called.
    ///
    /// It always emitted an OpenAI `chat.completion` envelope, including on
    /// Anthropic `/v1/messages` — so Claude Code, the primary client, got a
    /// structurally invalid response. The integration test that covered this
    /// asserted `body.choices[0]` on a `/v1/messages` call, pinning the bug.
    #[tokio::test]
    async fn the_gate_body_matches_the_inbound_protocol() {
        use crate::protocol::Protocol;
        let gate = CostPredictionGate::new(Arc::new(FixedThreshold(Some(0.000001))));
        let est = gate
            .evaluate("ses_1", "ws_1", "claude-4-opus", &msgs())
            .await
            .expect("configured and exceeded");

        let anthropic: serde_json::Value = serde_json::from_slice(
            &CostPredictionGate::format_gate_response(&est, "claude-4-opus", &Protocol::Anthropic),
        )
        .expect("valid json");
        assert_eq!(anthropic["type"], "message", "got: {anthropic}");
        assert!(anthropic["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Cost Prediction Gate"));
        assert!(
            anthropic.get("choices").is_none(),
            "an Anthropic client must not receive an OpenAI envelope: {anthropic}"
        );

        let openai: serde_json::Value = serde_json::from_slice(
            &CostPredictionGate::format_gate_response(
                &est,
                "gpt-4o",
                &Protocol::OpenAIChatCompletions,
            ),
        )
        .expect("valid json");
        assert!(openai["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Cost Prediction Gate"));
    }

    /// The remediation advice must not point at surfaces that do not exist.
    ///
    /// The message told the user to "add `--force`" — the only `--force` parser
    /// in the crate bypasses the *quality* gate — and to "adjust the threshold
    /// in Settings → Billing", which no UI or API writes. Advice aimed at two
    /// things that are not there sends the reader looking.
    #[tokio::test]
    async fn the_gate_message_promises_no_escape_hatch_that_does_not_exist() {
        use crate::protocol::Protocol;
        let gate = CostPredictionGate::new(Arc::new(FixedThreshold(Some(0.000001))));
        let est = gate
            .evaluate("ses_1", "ws_1", "claude-4-opus", &msgs())
            .await
            .expect("configured and exceeded");
        let body = String::from_utf8_lossy(&CostPredictionGate::format_gate_response(
            &est,
            "claude-4-opus",
            &Protocol::Anthropic,
        ))
        .to_string();
        assert!(!body.contains("--force"), "no such parser on this path");
        assert!(!body.contains("Settings"), "no such surface writes the threshold");
    }

    /// A stand-in whose only interesting answer is the threshold.
    ///
    /// Everything else mirrors `NullControlPlaneCache`. Spelled out rather than
    /// wrapped, because the point of the test is what happens when one method
    /// returns `None` — delegating through another object would put a second
    /// thing between the test and the behaviour under test.
    struct FixedThreshold(Option<f64>);

    #[async_trait::async_trait]
    impl ControlPlaneCache for FixedThreshold {
        async fn predict_gate_threshold(&self, _w: &str) -> Option<f64> {
            self.0
        }
        async fn token_baseline(
            &self,
            _w: &str,
            _m: &str,
            _b: &str,
        ) -> Option<crate::store::TokenBaseline> {
            None
        }
        async fn bandit_keywords(&self, _w: &str) -> Option<serde_json::Value> {
            None
        }
        async fn active_sop_tier(&self, _w: &str) -> Option<String> {
            None
        }
        async fn feature_flags(&self, _w: &str) -> Option<crate::store::FeatureFlags> {
            None
        }
        async fn auth_context(&self, _t: &str) -> crate::store::ControlPlaneAuth {
            crate::store::ControlPlaneAuth::Unmanaged
        }
        async fn daily_budget(&self, _w: &str) -> Option<(f64, Option<f64>)> {
            None
        }
        async fn hard_block(&self, _w: &str) -> crate::store::HardCapStatus {
            crate::store::HardCapStatus::Clear
        }
        async fn loop_status(&self, _l: &str) -> Option<String> {
            None
        }
        async fn active_loop_run(&self, _w: &str, _m: Option<&str>) -> Option<String> {
            None
        }
        async fn auto_judge_active(&self, _s: crate::store::JudgeScope, _id: &str) -> bool {
            false
        }
        async fn break_glass_valid(&self, _t: &str) -> bool {
            false
        }
        async fn transition_baseline(&self, _w: &str) -> Option<String> {
            None
        }
        async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
            Ok(None)
        }
        async fn wasm_binary(&self, _sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn drain_notifications(&self, _s: crate::store::NotifyScope, _id: &str) -> Vec<String> {
            Vec::new()
        }
    }
}
