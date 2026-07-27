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
/// Every key it reads (`tok:predict:gate:*`, `tok:baseline:*`) is written by
/// the control plane and only read here, so it holds a `ControlPlaneCache`
/// rather than its own connection. Standalone that resolves to the null cache
/// and the gate is inert — which is correct, since nothing in open core
/// produces those baselines.
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
    pub threshold_usd: f64,
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

        // 2. Get workspace gate threshold
        let threshold = self
            .control_plane
            .predict_gate_threshold(workspace_id)
            .await
            .unwrap_or(0.0);

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

        let exceeds_threshold = estimated_cost > threshold;

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

    /// Format a cost estimate as a fake LLM response.
    pub fn format_gate_response(estimate: &CostEstimate, model: &str) -> Vec<u8> {
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
            | Model | {} |\n\n\
            *To proceed anyway, add `--force` to your message or adjust the \
            threshold in Settings → Billing.*",
            estimate.estimated_cost_usd,
            estimate.threshold_usd,
            estimate.input_tokens,
            estimate.estimated_output_tokens,
            estimate.estimated_reasoning_tokens,
            estimate.estimated_cost_usd,
            estimate.threshold_usd,
            estimate.confidence,
            model,
        );

        let response = serde_json::json!({
            "id": "intutic-cost-gate",
            "object": "chat.completion",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text,
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0
            }
        });

        serde_json::to_vec(&response).unwrap_or_default()
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
