//! Contextual Bandit Router.
//!
//! Implements the Thompson Sampling arm selector, prompt classifier,
//! session-locked routing, and fallback behavior.
//!
//! LLD #26 §4.1 — Thompson Sampling Selector

use crate::pricing;
use crate::store::{ControlPlaneCache, LocalStore};
use rand::prelude::*;
use rand_distr::Beta;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Deterministic tie-break window for [`select_arm`]'s same-family preference.
///
/// Thompson samples land in `[0, 1]`; two arms with real, meaningfully
/// different reward histories almost never land this close together, but
/// float noise and near-identical priors (e.g. two freshly-seeded arms) do.
/// `0.02` was chosen to catch that "practically indistinguishable" band
/// without swallowing a genuine quality gap — an arm that's actually 2+
/// percentage points better in expectation still wins outright.
const FAMILY_PREFERENCE_EPSILON: f64 = 0.02;

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

/// Thompson-samples one draw per candidate arm and returns the model with the
/// highest sample — falling back to `requested_model` if `arms` is empty.
///
/// `prefer_family`, when given, is a **deterministic tie-break only**: it is
/// consulted only among arms whose sample lands within
/// [`FAMILY_PREFERENCE_EPSILON`] of the best sample seen. A same-family
/// candidate inside that window wins over a marginally-higher cross-family
/// one; a cross-family arm that is *clearly* better (outside the epsilon)
/// always wins regardless of family. This never overrides real signal — it
/// only picks a direction among arms Thompson sampling itself couldn't tell
/// apart, in favor of the choice that also keeps the session's KV-cache
/// prefix warm (see the session-lock doc comment in `route_model`).
fn select_arm(
    arms: Vec<(String, BanditArmState)>,
    requested_model: &str,
    prefer_family: Option<&str>,
) -> String {
    let sampled: Vec<(String, f64)> = arms
        .into_iter()
        .map(|(model, state)| (model, sample_beta(state.alpha, state.beta)))
        .collect();

    pick_with_family_preference(sampled, prefer_family)
        .unwrap_or_else(|| requested_model.to_string())
}

/// The deterministic half of [`select_arm`]: given already-sampled
/// `(model, value)` pairs, pick the winner. Split out from the sampling step
/// so the tie-break logic can be unit-tested without depending on
/// [`sample_beta`]'s randomness — every input here is a fixed float.
///
/// Returns `None` only when `sampled` is empty.
fn pick_with_family_preference(
    sampled: Vec<(String, f64)>,
    prefer_family: Option<&str>,
) -> Option<String> {
    let max_sample = sampled
        .iter()
        .map(|(_, s)| *s)
        .fold(None, |acc: Option<f64>, s| Some(acc.map_or(s, |m| m.max(s))))?;

    if let Some(family) = prefer_family {
        // Among same-family arms inside the window, still prefer the
        // higher-sampled one — the tie-break picks a direction among noise,
        // it does not pick arbitrarily within that direction.
        let same_family_in_window = sampled
            .iter()
            .filter(|(model, sample)| {
                max_sample - sample <= FAMILY_PREFERENCE_EPSILON
                    && pricing::model_family(model).as_deref() == Some(family)
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        if let Some((model, _)) = same_family_in_window {
            return Some(model.clone());
        }
    }

    sampled
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(model, _)| model)
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
    //
    // KV-cache preservation, not just anti-flapping.
    //
    // This lock was built to stop the bandit re-sampling on every turn of a
    // session — the original complaint was arms flip-flopping mid-conversation,
    // and pinning the pick for the session's life fixes exactly that. It has a
    // second effect that was never the design goal but is just as real: the
    // same pin is also what keeps the provider-side KV-cache prefix warm.
    // Every model switch forces the provider to recompute the prompt prefix
    // from scratch, discarding whatever cache discount prior turns in the
    // session had built up. A bandit that resampled per request would defeat
    // prompt caching almost entirely on multi-turn sessions — this lock is why
    // it mostly doesn't.
    //
    // "Mostly", not "entirely": the lock only protects the *model* choice.
    // SOP content is still prepended at `system[0]` on every request
    // (`sops::inject_into_body`), which can shift the cached prefix even with
    // the model held constant — see the hazard note there and TD-348.
    if let Some(locked_model) = session.locked_model {
        tracing::debug!(session_id = %session_id, locked_model = %locked_model, "Session lock hit");
        return Ok((locked_model, resolved_sop_tier, task_type.to_string()));
    }

    // No lock is active — either this session has never been routed, or a
    // lock was just released (e.g. the unservable-model path in `proxy.rs`
    // clears it after a failed request). Either way we're about to
    // Thompson-sample fresh; `last_model` (set alongside every lock and left
    // in place when the lock clears) is the only memory of what the session
    // was just running on, so it feeds the same-family tie-break below.
    let prefer_family: Option<String> = session
        .last_model
        .as_deref()
        .and_then(pricing::model_family);

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

    // 4. Sample arms using Thompson Sampling, tie-broken toward `prefer_family`
    let best_model = select_arm(arms, requested_model, prefer_family.as_deref());

    // Lock selected model for the session
    let _ = store
        .set_session_locked_model(session_id, &best_model)
        .await;

    Ok((best_model, resolved_sop_tier, task_type.to_string()))
}

/// Whether an upstream error says the MODEL was unservable, as opposed to the
/// request being malformed.
///
/// The distinction decides fault. The error branch in `proxy.rs` treats 4xx as
/// "the caller's fault" and only penalises arms on 5xx — which is right for a
/// request the caller wrote, and exactly wrong for a model the ROUTER chose.
/// When the bandit rewrites `claude-x` to a candidate the provider has
/// decommissioned, the caller did nothing; the router did. Without this
/// distinction that 404 passed through raw, the arm was never penalised, the
/// session lock kept the pick, and — because a fresh session re-samples from
/// unchanged priors — new sessions repeated it indefinitely.
///
/// The shape is a conjunction: a 400/404 whose body BOTH names the model AND
/// carries a not-found/does-not-exist marker. Either alone is too loose — a
/// 404 for a mistyped URL path never mentions a model, and plenty of 400s say
/// "model" while complaining about temperature.
///
/// Matches the three providers the proxy routes across:
/// - Anthropic: `{"type":"error","error":{"type":"not_found_error","message":"model: ..."}}`
/// - OpenAI: `The model \`gpt-x\` does not exist or you do not have access to it.`
/// - Gemini: `models/gemini-x is not found for API version v1beta`
pub fn is_unservable_model_error(status: u16, body: &str) -> bool {
    if status != 400 && status != 404 {
        return false;
    }
    let b = body.to_ascii_lowercase();
    if !b.contains("model") {
        return false;
    }
    [
        "not_found",
        "not found",
        "does not exist",
        "unknown model",
        "no such model",
        "invalid model",
        "decommissioned",
        "has been deprecated",
        "unsupported model",
    ]
    .iter()
    .any(|m| b.contains(m))
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

    #[test]
    fn unservable_shape_matches_the_three_providers() {
        // Anthropic
        assert!(is_unservable_model_error(
            404,
            r#"{"type":"error","error":{"type":"not_found_error","message":"model: claude-ancient"}}"#
        ));
        // OpenAI
        assert!(is_unservable_model_error(
            404,
            "The model `gpt-nonexistent` does not exist or you do not have access to it."
        ));
        // Gemini
        assert!(is_unservable_model_error(
            400,
            "models/gemini-nope is not found for API version v1beta"
        ));
    }

    #[test]
    fn unservable_shape_refuses_lookalikes() {
        // A mistyped URL path: 404 with no model mention.
        assert!(!is_unservable_model_error(404, "Not Found"));
        // A real validation error that happens to say "model".
        assert!(!is_unservable_model_error(
            400,
            "model parameter accepted; temperature must be between 0 and 1"
        ));
        // A 5xx is an outage, owned by the existing path.
        assert!(!is_unservable_model_error(
            500,
            "model claude-x not found (internal replication lag)"
        ));
        // A rate limit names the model and is not about servability.
        assert!(!is_unservable_model_error(429, "rate limit for model gpt-4o"));
    }

    // ── Same-family tie-break (`pick_with_family_preference`) ─────────────
    //
    // Deterministic: these drive the tie-break directly with fixed sample
    // values rather than going through `sample_beta`, so there is no
    // randomness to flake on.

    #[test]
    fn family_preference_wins_within_epsilon() {
        // gpt-4o-mini samples marginally higher, but the gap (0.005) is well
        // inside FAMILY_PREFERENCE_EPSILON (0.02) — the same-family arm wins.
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.900),
            ("gpt-4o-mini".to_string(), 0.905),
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("claude-opus-4-5"));
    }

    #[test]
    fn cross_family_wins_when_clearly_better() {
        // gpt-4o-mini is 0.4 ahead — far outside epsilon. The family
        // preference is a tie-break, not a filter, so it must not override
        // an arm that is genuinely better.
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.500),
            ("gpt-4o-mini".to_string(), 0.900),
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn no_preference_highest_sample_wins() {
        // `prefer_family: None` must reproduce the pre-existing (additive)
        // behavior: pure argmax, no family involved.
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.500),
            ("gpt-4o-mini".to_string(), 0.900),
            ("claude-sonnet-4-5".to_string(), 0.700),
        ];
        let winner = pick_with_family_preference(sampled, None);
        assert_eq!(winner.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn preference_ignored_when_no_arm_matches_the_family() {
        // prefer_family names a family with no candidate arm at all — falls
        // straight through to argmax rather than erroring or picking nothing.
        let sampled = vec![
            ("gpt-4o-mini".to_string(), 0.900),
            ("gemini-1.5-flash".to_string(), 0.895),
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn preference_wins_just_inside_epsilon() {
        // Gap (0.019) just under FAMILY_PREFERENCE_EPSILON (0.02) — same-family
        // arm wins. (Exact float equality at the boundary isn't asserted here:
        // f64 subtraction of decimal literals like 0.900 - 0.880 doesn't land
        // on exactly 0.02, so a "gap == epsilon" test would be testing binary
        // floating-point rounding, not this function's logic.)
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.881),
            ("gpt-4o-mini".to_string(), 0.900), // gap = 0.019 < epsilon
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("claude-opus-4-5"));
    }

    #[test]
    fn preference_loses_just_outside_epsilon() {
        // Gap (0.021) just over FAMILY_PREFERENCE_EPSILON (0.02) — cross-family
        // arm wins despite the preference.
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.879),
            ("gpt-4o-mini".to_string(), 0.900), // gap = 0.021 > epsilon
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn preference_among_multiple_same_family_candidates_picks_the_higher_one() {
        // Two same-family arms both within epsilon of the best: the
        // tie-break must not just grab the first family match, it should
        // still prefer the higher-sampled one within that family.
        let sampled = vec![
            ("claude-opus-4-5".to_string(), 0.885),
            ("claude-opus-4-1".to_string(), 0.895),
            ("gpt-4o-mini".to_string(), 0.900),
        ];
        let winner = pick_with_family_preference(sampled, Some("claude-opus"));
        assert_eq!(winner.as_deref(), Some("claude-opus-4-1"));
    }

    #[test]
    fn pick_with_family_preference_empty_arms_returns_none() {
        assert_eq!(pick_with_family_preference(vec![], Some("claude-opus")), None);
        assert_eq!(pick_with_family_preference(vec![], None), None);
    }

    #[test]
    fn select_arm_falls_back_to_requested_model_when_no_arms() {
        // End-to-end smoke test of `select_arm` itself (not just the
        // deterministic helper): an empty arm list is a should-not-happen
        // case, and it must degrade to the historical requested-model
        // fallback rather than panicking.
        let winner = select_arm(vec![], "claude-sonnet-4-5", Some("claude-opus"));
        assert_eq!(winner, "claude-sonnet-4-5");
    }
}
