//! Quality gate — calls the control plane for prompt quality scoring
//! and optionally blocks low-quality prompts.
//!
//! The gate is fail-open: if scoring fails, the request proceeds normally.

use anyhow::Result;
use tracing::{debug, warn};

use super::format_as_llm_response;

/// Check prompt quality and optionally gate the request.
///
/// Returns:
/// - `Ok(Some(response))` if the prompt was gated (score below threshold)
/// - `Ok(None)` if quality is acceptable (proceed to LLM)
/// - `Err(_)` on infrastructure failure (caller should proceed)
pub async fn check(
    http_client: &reqwest::Client,
    control_plane_url: &str,
    session_id: &str,
    workspace_id: &str,
    prompt_text: &str,
    model: &str,
    protocol: &crate::protocol::Protocol,
    api_key: &str,
) -> Result<Option<Vec<u8>>> {
    let response = http_client
        .post(format!("{}/api/v1/prompt-quality/score", control_plane_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "promptText": prompt_text,
            "model": model,
            "inputTokens": 0,
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        warn!(
            status = %response.status(),
            "Quality scoring API returned error"
        );
        return Ok(None); // Fail-open
    }

    let result: serde_json::Value = response.json().await?;

    // Only gate if shouldGate is true
    let should_gate = result
        .get("shouldGate")
        .and_then(|g| g.as_bool())
        .unwrap_or(false);

    if !should_gate {
        debug!(session_id, "Prompt quality OK, proceeding");
        return Ok(None);
    }

    // Build gated response
    let grade = result.get("grade").and_then(|g| g.as_str()).unwrap_or("?");
    let score = result.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);

    let suggestions: Vec<String> = result
        .get("suggestions")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let context_gaps: Vec<String> = result
        .get("contextGaps")
        .and_then(|g| g.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.get("description")
                        .and_then(|d| d.as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();

    let cost_pred = result.get("costPrediction");
    let mut cost_gate_fired = false;
    let mut pred_text = String::new();

    if let Some(pred) = cost_pred {
        let cost = pred
            .get("predictedCostUsd")
            .and_then(|c| c.as_f64())
            .unwrap_or(0.0);
        let tokens = pred
            .get("predictedTotalTokens")
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        let confidence = pred
            .get("confidence")
            .and_then(|c| c.as_str())
            .unwrap_or("UNKNOWN");
        cost_gate_fired = pred
            .get("costGateFired")
            .and_then(|t| t.as_bool())
            .unwrap_or(false);

        if cost_gate_fired {
            pred_text = format!(
                "### ⚠️ High Cost Warning\n\n\
                This prompt is predicted to exceed your workspace threshold:\n\
                - **Predicted Cost**: ${:.4} USD\n\
                - **Predicted Total Tokens**: {}\n\
                - **Confidence**: {}\n\n",
                cost, tokens, confidence
            );
        } else {
            pred_text = format!(
                "\n**Estimated Cost Impact:**\n\
                - Predicted Cost: ${:.4} USD (Total Tokens: {}, Confidence: {})\n",
                cost, tokens, confidence
            );
        }
    }

    let mut response_text = if cost_gate_fired {
        format!("{}**Suggestions to reduce tokens:**\n", pred_text)
    } else {
        format!(
            "### 🔍 Prompt Quality: Grade {} ({:.0}%)\n\n\
            Your prompt could be improved before sending to {}. \
            This saves tokens and produces better results.\n\n\
            **Suggestions:**\n",
            grade,
            score * 100.0,
            model
        )
    };

    for (i, suggestion) in suggestions.iter().enumerate() {
        response_text.push_str(&format!("{}. {}\n", i + 1, suggestion));
    }

    if !context_gaps.is_empty() {
        response_text.push_str("\n**Missing Context:**\n");
        for gap in &context_gaps {
            response_text.push_str(&format!("- {}\n", gap));
        }
    }

    if !cost_gate_fired && !pred_text.is_empty() {
        response_text.push_str(&pred_text);
    }

    response_text.push_str(
        "\n*Revise your prompt and try again. To bypass, \
        add `--force` to your message or run `/intutic config quality-gate off`.*",
    );

    Ok(Some(format_as_llm_response(&response_text, protocol)))
}
