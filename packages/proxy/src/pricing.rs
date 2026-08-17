//! Offline Model Pricing Module — WS-5OP Air-Gapped Support
//!
//! Loads model cost data from a compile-time bundled JSON file.
//! In air-gapped mode (`OFFLINE_MODE=true`) or when the LiteLLM pricing API
//! is unreachable, this module provides the single source of truth for token cost.
//!
//! ## Resolution order
//! 1. `OFFLINE_PRICING_PATH` env var → load from that filesystem path at startup.
//! 2. Compile-time bundle (`offline_bundle.json` via `include_str!`) — zero I/O, tamper-proof.
//!
//! ## Lookup order
//! 1. Exact model name match (lowercase) in the `models` table.
//! 2. Model-family prefix fallback: strip version suffix iteratively.
//!    e.g. `claude-opus-4-5` → `claude-opus-4` → `claude-opus` → `claude`
//! 3. Unknown model conservative estimate — logs WARN, never returns $0.
//!
//! LLD §31 WS-5OP (TD-130 graduation)

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::warn;

// ─── Compile-time bundle ──────────────────────────────────────────────

static BUNDLE_JSON: &str = include_str!("pricing/offline_bundle.json");

// ─── Data model ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct ModelPrice {
    pub input_cost_per_1k: f64,
    pub output_cost_per_1k: f64,
}

#[derive(Debug, Deserialize)]
struct OfflineBundle {
    models: HashMap<String, ModelPrice>,
    family_fallbacks: HashMap<String, ModelPrice>,
    unknown_model_conservative_estimate: ModelPrice,
}

// ─── Lazy-initialised global registry ────────────────────────────────

static REGISTRY: Lazy<OfflineBundle> = Lazy::new(|| {
    // 1. Try runtime override path first
    if let Ok(path) = std::env::var("OFFLINE_PRICING_PATH") {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(bundle) = serde_json::from_str::<OfflineBundle>(&data) {
                tracing::info!(path = %path, "offline pricing: loaded from OFFLINE_PRICING_PATH");
                return bundle;
            } else {
                warn!(path = %path, "offline pricing: OFFLINE_PRICING_PATH parse failed, falling back to compile-time bundle");
            }
        } else {
            warn!(path = %path, "offline pricing: OFFLINE_PRICING_PATH read failed, falling back to compile-time bundle");
        }
    }

    // 2. Compile-time bundle (zero I/O)
    serde_json::from_str::<OfflineBundle>(BUNDLE_JSON)
        .expect("compile-time offline_bundle.json is malformed — this is a build error")
});

// ─── Public API ───────────────────────────────────────────────────────

/// Estimate the cost in USD for an LLM request using the offline pricing bundle.
///
/// Resolution order: exact match → family prefix fallback → conservative estimate.
///
/// # Arguments
/// * `model` — model name (case-insensitive; e.g. `"claude-opus-4-5"`)
/// * `input_tokens` — number of input tokens
/// * `output_tokens` — number of output tokens
pub fn estimate_cost(model: &str, input_tokens: u32, output_tokens: u32) -> f64 {
    let price = lookup_price(model);
    let input_cost = (input_tokens as f64 / 1000.0) * price.input_cost_per_1k;
    let output_cost = (output_tokens as f64 / 1000.0) * price.output_cost_per_1k;
    input_cost + output_cost
}

/// Returns input cost per 1K tokens for use in budget gate pre-checks.
pub fn input_cost_per_1k(model: &str) -> f64 {
    lookup_price(model).input_cost_per_1k
}

/// Derive a model's pricing family, e.g. `"claude-opus-4-5"` → `Some("claude-opus")`.
///
/// Same prefix-stripping idea as the family fallback inside [`lookup_price`] —
/// strip trailing `-`-separated segments until a known `family_fallbacks` key
/// matches — but exposed standalone for callers that want "same family" as a
/// signal, not a price. The bandit's session-lock re-sample uses this to prefer
/// a same-family arm among near-tied candidates (see
/// `routing::bandit::route_model`), which is what makes that re-sample
/// KV-cache-preserving rather than picking a same-quality arm on a different
/// provider prefix.
///
/// Unlike `lookup_price`'s two-step (exact model match, then family fallback),
/// this checks the full model name against `family_fallbacks` too — a bare
/// family name like `"claude"` resolves to itself here, which `lookup_price`
/// never needs to do because step 1 (`models` table) already owns exact names.
///
/// Returns `None` when nothing matches (e.g. a first-party or custom model name
/// absent from the offline pricing bundle) — callers should treat that as "no
/// family signal", not an error.
pub fn model_family(model: &str) -> Option<String> {
    let m = model.to_lowercase();
    let reg = &*REGISTRY;
    let parts: Vec<&str> = m.split('-').collect();
    for len in (1..=parts.len()).rev() {
        let prefix = parts[..len].join("-");
        if reg.family_fallbacks.contains_key(&prefix) {
            return Some(prefix);
        }
    }
    None
}

// ─── Internal helpers ─────────────────────────────────────────────────

fn lookup_price(model: &str) -> ModelPrice {
    let m = model.to_lowercase();
    let reg = &*REGISTRY;

    // 1. Exact match
    if let Some(price) = reg.models.get(&m) {
        return price.clone();
    }

    // 2. Family prefix fallback — strip trailing segments iteratively
    // e.g. "claude-opus-4-5" → "claude-opus-4" → "claude-opus" → "claude"
    let parts: Vec<&str> = m.split('-').collect();
    for len in (1..parts.len()).rev() {
        let prefix = parts[..len].join("-");
        if let Some(price) = reg.family_fallbacks.get(&prefix) {
            tracing::debug!(
                model = %model,
                matched_prefix = %prefix,
                "offline pricing: family prefix fallback"
            );
            return price.clone();
        }
    }

    // 3. Conservative estimate — never return $0 to avoid underbilling
    warn!(
        model = %model,
        "offline pricing: unknown model, using conservative Opus-class estimate"
    );
    reg.unknown_model_conservative_estimate.clone()
}

// ─── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_claude_sonnet() {
        let cost = estimate_cost("claude-3-5-sonnet-20241022", 1000, 500);
        // (1000/1000)*0.003 + (500/1000)*0.015 = 0.003 + 0.0075 = 0.0105
        assert!((cost - 0.0105).abs() < 1e-9, "cost={cost}");
    }

    #[test]
    fn exact_match_gpt4o_mini() {
        let cost = estimate_cost("gpt-4o-mini", 2000, 1000);
        // (2000/1000)*0.00015 + (1000/1000)*0.0006 = 0.0003 + 0.0006 = 0.0009
        assert!((cost - 0.0009).abs() < 1e-9, "cost={cost}");
    }

    #[test]
    fn family_fallback_claude_opus_new_version() {
        // "claude-opus-4-5" is in the bundle; "claude-opus-99" should fall back to family
        let cost = estimate_cost("claude-opus-99", 1000, 0);
        // Should match "claude-opus" family: 0.015/1k
        assert!((cost - 0.015).abs() < 1e-9, "cost={cost}");
    }

    #[test]
    fn conservative_estimate_unknown_model() {
        let cost = estimate_cost("unknown-vendor-model-v9", 1000, 0);
        // Conservative Opus-class: 0.015/1k
        assert!((cost - 0.015).abs() < 1e-9, "cost={cost}");
        // Must not be zero
        assert!(cost > 0.0);
    }

    #[test]
    fn case_insensitive() {
        let lower = estimate_cost("gpt-4o", 1000, 1000);
        let upper = estimate_cost("GPT-4O", 1000, 1000);
        assert!((lower - upper).abs() < 1e-9);
    }

    #[test]
    fn gemini_flash_lookup() {
        let cost = estimate_cost("gemini-1.5-flash-latest", 10_000, 5_000);
        // (10000/1000)*0.000075 + (5000/1000)*0.0003 = 0.00075 + 0.0015 = 0.00225
        assert!((cost - 0.00225).abs() < 1e-9, "cost={cost}");
    }

    #[test]
    fn model_family_strips_version_suffix() {
        // claude-opus-4-5 -> claude-opus-4 (not a family key) -> claude-opus (is)
        assert_eq!(model_family("claude-opus-4-5"), Some("claude-opus".to_string()));
        assert_eq!(
            model_family("claude-sonnet-4-5-20250929"),
            Some("claude-sonnet".to_string())
        );
    }

    #[test]
    fn model_family_matches_exact_family_name() {
        // A bare family name resolves to itself — unlike `lookup_price`'s
        // fallback loop, which never needs this case (step 1 already owns
        // exact model names).
        assert_eq!(model_family("claude"), Some("claude".to_string()));
        assert_eq!(model_family("gpt-4o"), Some("gpt-4o".to_string()));
    }

    #[test]
    fn model_family_is_case_insensitive() {
        assert_eq!(
            model_family("CLAUDE-OPUS-4-5"),
            Some("claude-opus".to_string())
        );
    }

    #[test]
    fn model_family_none_for_unknown_vendor() {
        assert_eq!(model_family("totally-unknown-vendor-model-v9"), None);
    }

    #[test]
    fn model_family_distinguishes_cross_provider_prefixes() {
        // Regression guard for the tie-break's whole premise: two different
        // providers must never collapse to the same family string.
        assert_ne!(model_family("gpt-4o-mini"), model_family("claude-opus-4-5"));
    }
}
