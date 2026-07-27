//! Contextual Bandit Router.
//!
//! Implements the Thompson Sampling arm selector, prompt classifier,
//! session-locked routing, and fallback behavior.
//!
//! LLD #26 §4.1 — Thompson Sampling Selector

use crate::store::{ControlPlaneCache, LocalStore};
use rand::prelude::*;
use rand_distr::Beta;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BanditArmState {
    pub alpha: f64,
    pub beta: f64,
    pub pulls: u32,
    #[serde(rename = "lastUpdated")]
    pub last_updated: String,
}

fn has_word(prompt_lower: &str, word: &str) -> bool {
    prompt_lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| w == word)
}

/// Heuristic Task Classifier.
/// Classifies the incoming prompt into a task type.
pub fn classify_task(prompt: &str) -> &'static str {
    let lower = prompt.to_lowercase();

    let has_any_test = has_word(&lower, "test")
        || has_word(&lower, "spec")
        || has_word(&lower, "assert")
        || has_word(&lower, "vitest")
        || has_word(&lower, "jest")
        || has_word(&lower, "unittest");

    let has_any_deploy = has_word(&lower, "deploy")
        || has_word(&lower, "release")
        || has_word(&lower, "kubernetes")
        || has_word(&lower, "docker")
        || has_word(&lower, "gke")
        || has_word(&lower, "pipeline")
        || lower.contains("ci/cd");

    let has_any_review = has_word(&lower, "review")
        || has_word(&lower, "audit")
        || has_word(&lower, "lint")
        || has_word(&lower, "eslint")
        || has_word(&lower, "pr");

    let has_any_fix = has_word(&lower, "fix")
        || has_word(&lower, "bug")
        || has_word(&lower, "issue")
        || has_word(&lower, "error")
        || has_word(&lower, "crash")
        || has_word(&lower, "debug");

    if has_any_test {
        "testing"
    } else if has_any_deploy {
        "deployment"
    } else if has_any_review {
        "review"
    } else if has_any_fix {
        "debugging"
    } else {
        "coding"
    }
}

/// Heuristic Task Classifier with dynamic custom keywords.
pub fn classify_task_dynamic(
    prompt: &str,
    custom_keywords: Option<&serde_json::Value>,
) -> &'static str {
    let lower = prompt.to_lowercase();

    if let Some(keywords) = custom_keywords {
        let check_category = |category: &str, defaults: &[&str]| -> bool {
            if let Some(arr) = keywords.get(category).and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(word) = item.as_str() {
                        let word_lower = word.to_lowercase();
                        let is_purely_alphanumeric =
                            word_lower.chars().all(|c| c.is_alphanumeric());
                        if is_purely_alphanumeric {
                            if has_word(&lower, &word_lower) {
                                return true;
                            }
                        } else {
                            if lower.contains(&word_lower) {
                                return true;
                            }
                        }
                    }
                }
                false
            } else {
                defaults.iter().any(|&w| {
                    if w == "ci/cd" {
                        lower.contains("ci/cd")
                    } else {
                        has_word(&lower, w)
                    }
                })
            }
        };

        if check_category(
            "testing",
            &["test", "spec", "assert", "vitest", "jest", "unittest"],
        ) {
            return "testing";
        }
        if check_category(
            "deployment",
            &[
                "deploy",
                "release",
                "kubernetes",
                "docker",
                "gke",
                "pipeline",
                "ci/cd",
            ],
        ) {
            return "deployment";
        }
        if check_category("review", &["review", "audit", "lint", "eslint", "pr"]) {
            return "review";
        }
        if check_category(
            "debugging",
            &["fix", "bug", "issue", "error", "crash", "debug"],
        ) {
            return "debugging";
        }
        return "coding";
    }

    classify_task(prompt)
}

/// Enforces the minimum floor of 1.0 on alpha/beta and samples from Beta distribution.
pub fn sample_beta(alpha: f64, beta: f64) -> f64 {
    let a = alpha.max(1.0);
    let b = beta.max(1.0);
    match Beta::new(a, b) {
        Ok(dist) => {
            let mut rng = rand::thread_rng();
            rng.sample(dist)
        }
        Err(_) => 0.5, // Fallback if sampling fails (mathematically impossible with a, b >= 1.0)
    }
}

/// Resolves model routing via Contextual Bandit or Session Lock.
///
/// `candidate_models` comes from `intutic_settings.routing.candidate_models`;
/// requests for models outside the pool bypass the bandit entirely.
pub async fn route_model(
    store: &Arc<dyn LocalStore>,
    control_plane: &Arc<dyn ControlPlaneCache>,
    workspace_id: &str,
    session_id: &str,
    requested_model: &str,
    prompt: &str,
    candidate_models: &[String],
) -> anyhow::Result<(String, String, String)> {
    // Keyword overrides are control-plane state; standalone this is `None` and
    // the classifier falls back to its built-in vocabulary.
    let keywords_json = control_plane.bandit_keywords(workspace_id).await;
    let task_type = classify_task_dynamic(prompt, keywords_json.as_ref());

    let session = store.session_routing(session_id).await.unwrap_or_default();

    // Resolve SOP tier: session pin, else workspace default, else TIER_1.
    let resolved_sop_tier = match session.sop_tier {
        Some(t) => t,
        None => control_plane
            .active_sop_tier(workspace_id)
            .await
            .unwrap_or_else(|| "TIER_1".to_string()),
    };

    // 0. Bypass bandit routing if the requested model is not in the candidate pool
    if !candidate_models.iter().any(|m| m == requested_model) {
        tracing::debug!(requested_model = %requested_model, "Requested model not in candidate pool — bypassing bandit");
        return Ok((
            requested_model.to_string(),
            resolved_sop_tier,
            task_type.to_string(),
        ));
    }

    // 1. Session-Locked Model Routing
    if let Some(locked_model) = session.locked_model {
        tracing::debug!(session_id = %session_id, locked_model = %locked_model, "Session lock hit");
        return Ok((locked_model, resolved_sop_tier, task_type.to_string()));
    }

    // 2. Load arms
    let raw_arms = store.load_arms(workspace_id).await.unwrap_or_default();

    let mut arms = Vec::new();
    let mut total_pulls = 0;

    for model in candidate_models {
        let arm_key = format!("arm:{}:{}:{}", model, resolved_sop_tier, task_type);

        match raw_arms.get(&arm_key) {
            Some(state) => {
                total_pulls += state.pulls;
                arms.push((model.to_string(), state.clone()));
            }
            None => {
                // Seed default arm on cache miss
                let default_state = BanditArmState {
                    alpha: 1.0,
                    beta: 1.0,
                    pulls: 0,
                    last_updated: chrono::Utc::now().to_rfc3339(),
                };
                let _ = store
                    .seed_arm(workspace_id, &arm_key, &default_state)
                    .await;
                arms.push((model.to_string(), default_state));
            }
        }
    }

    // 3. Fallback check: if cumulative pulls < 20, bypass selection and use requested model
    if total_pulls < 20 {
        tracing::debug!(workspace_id = %workspace_id, total_pulls = %total_pulls, "Total pulls < 20 — using requested model");
        let selected_model = requested_model.to_string();
        let _ = store
            .set_session_locked_model(session_id, &selected_model)
            .await;
        return Ok((selected_model, resolved_sop_tier, task_type.to_string()));
    }

    // 4. Sample arms using Thompson Sampling
    let mut best_model = requested_model.to_string();
    let mut max_sample = -1.0;

    for (model, state) in arms {
        let sample = sample_beta(state.alpha, state.beta);
        if sample > max_sample {
            max_sample = sample;
            best_model = model;
        }
    }

    // Lock selected model for the session
    let _ = store
        .set_session_locked_model(session_id, &best_model)
        .await;

    Ok((best_model, resolved_sop_tier, task_type.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_classify_task() {
        assert_eq!(classify_task("write a vitest spec for me"), "testing");
        assert_eq!(classify_task("deploy to kubernetes on gke"), "deployment");
        assert_eq!(
            classify_task("review this pull request and eslint rules"),
            "review"
        );
        assert_eq!(classify_task("fix the crash and debug error"), "debugging");
        assert_eq!(
            classify_task("write a function to add two numbers"),
            "coding"
        );
    }

    #[test]
    fn test_classify_task_dynamic() {
        // Test 1: No custom keywords (None) fallback to default
        assert_eq!(
            classify_task_dynamic("write a vitest spec", None),
            "testing"
        );

        // Test 2: Custom keywords provided, overrides default
        // Let's redefine testing keywords to only look for "vitest"
        let custom_json = json!({
            "testing": ["vitest"],
            "deployment": ["prod-push"],
            "review": ["codecheck"],
            "debugging": ["segfault"]
        });

        // "test" (default testing trigger) should fall back to coding now because of custom keywords
        assert_eq!(
            classify_task_dynamic("run a test", Some(&custom_json)),
            "coding"
        );

        // "vitest" should still match testing
        assert_eq!(
            classify_task_dynamic("run a vitest script", Some(&custom_json)),
            "testing"
        );

        // "prod-push" matches deployment
        assert_eq!(
            classify_task_dynamic("prod-push to sandbox", Some(&custom_json)),
            "deployment"
        );

        // Word boundaries match
        assert_eq!(
            classify_task_dynamic("segfault occurred", Some(&custom_json)),
            "debugging"
        );
        assert_eq!(
            classify_task_dynamic("notasegfault", Some(&custom_json)),
            "coding"
        );
    }

    #[test]
    fn test_sample_beta_bounds() {
        // Enforces floor of 1.0 and samples between 0.0 and 1.0
        let val = sample_beta(0.5, 0.5);
        assert!((0.0..=1.0).contains(&val));
        let val2 = sample_beta(-5.0, -10.0);
        assert!((0.0..=1.0).contains(&val2));
    }

    #[test]
    fn test_thompson_sampling_higher_alpha() {
        // Run a simulation to verify that higher alpha arm gets selected more often than higher beta
        let mut selections_high_alpha = 0;
        let mut selections_high_beta = 0;

        for _ in 0..1000 {
            let sample_a = sample_beta(10.0, 1.0); // high alpha (high expected utility)
            let sample_b = sample_beta(1.0, 10.0); // high beta (low expected utility)
            if sample_a > sample_b {
                selections_high_alpha += 1;
            } else {
                selections_high_beta += 1;
            }
        }

        assert!(selections_high_alpha > selections_high_beta);
        assert!(selections_high_alpha > 900); // Should be very high probability
    }
}
