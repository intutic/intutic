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
    /// Per-1k rate for input tokens read from the provider's prompt cache.
    ///
    /// `Option` + `#[serde(default)]`, not a plain `f64`: this struct derives
    /// `Deserialize` over the entire 1300+-line bundle file, and most bundle
    /// entries have no cache tier at all — a non-optional field would break
    /// every existing entry that doesn't report one. `None` means "this model
    /// reports no cache-read rate", not "cache reads are free".
    #[serde(default)]
    pub cache_read_cost_per_1k: Option<f64>,
    /// Per-1k rate for input tokens written into the provider's prompt cache
    /// (Anthropic only today — see [`crate::usage::TokenUsage::cache_write_input`]).
    /// Same optionality reasoning as `cache_read_cost_per_1k`.
    #[serde(default)]
    pub cache_write_cost_per_1k: Option<f64>,
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

/// Estimate cost in USD from a cache-aware [`TokenUsage`] (TD-347).
///
/// Billing: `uncached_input` at `input_cost_per_1k`; `cache_read_input` at
/// `cache_read_cost_per_1k`, falling back to `input_cost_per_1k` when the
/// model has no cache-read rate; `cache_write_input` at
/// `cache_write_cost_per_1k`, same fallback; `output` at `output_cost_per_1k`.
///
/// The fallback direction is deliberate: a model with no published cache
/// discount is billed for cache activity at the FULL input rate rather than
/// zero — this must fail toward over-charging, the safe direction for a
/// budget gate, not under-charging.
///
/// The family-prefix fallback and the unknown-model conservative estimate
/// (both reached only via [`lookup_price`]'s own resolution order) never
/// carry a cache tier — `family_fallbacks` and
/// `unknown_model_conservative_estimate` entries in the bundle have no cache
/// fields, so `price.cache_*_cost_per_1k` is `None` for them and every cache
/// bucket falls back to the full input rate automatically. An unknown or
/// family-matched model gets NO cache discount, full stop.
pub fn estimate_cost_cached(model: &str, usage: &crate::usage::TokenUsage) -> f64 {
    let price = lookup_price(model);
    let input_rate = price.input_cost_per_1k;
    let cache_read_rate = price.cache_read_cost_per_1k.unwrap_or(input_rate);
    let cache_write_rate = price.cache_write_cost_per_1k.unwrap_or(input_rate);

    let uncached_cost = (usage.uncached_input.unwrap_or(0) as f64 / 1000.0) * input_rate;
    let cache_read_cost = (usage.cache_read_input.unwrap_or(0) as f64 / 1000.0) * cache_read_rate;
    let cache_write_cost = (usage.cache_write_input.unwrap_or(0) as f64 / 1000.0) * cache_write_rate;
    let output_cost = (usage.output.unwrap_or(0) as f64 / 1000.0) * price.output_cost_per_1k;

    uncached_cost + cache_read_cost + cache_write_cost + output_cost
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

    /// The regression guard TD-347 exists to protect: with both cache
    /// buckets at zero, `estimate_cost_cached` must equal the plain
    /// cache-blind `estimate_cost` — for an exact-match model, a
    /// family-fallback model, and the unknown-model conservative estimate. A
    /// future refactor that breaks this equivalence has broken the "no cache
    /// activity" case, which is supposed to be indistinguishable from
    /// today's behavior.
    #[test]
    fn cached_cost_matches_blind_cost_when_cache_buckets_are_zero() {
        use crate::usage::TokenUsage;

        let cases: &[(&str, u32, u32)] = &[
            // Exact match, has real cache rates in the bundle.
            ("claude-3-5-sonnet-20241022", 1000, 500),
            // Exact match, no cache rate at all.
            ("gpt-4o-mini", 2000, 1000),
            // Family-fallback path.
            ("claude-opus-99", 1500, 200),
            // Unknown-model conservative-estimate path.
            ("unknown-vendor-model-v9", 800, 300),
        ];

        for &(model, input, output) in cases {
            let blind = estimate_cost(model, input, output);
            let usage = TokenUsage {
                uncached_input: Some(input),
                cache_read_input: Some(0),
                cache_write_input: Some(0),
                output: Some(output),
            };
            let cached = estimate_cost_cached(model, &usage);
            assert!(
                (blind - cached).abs() < 1e-9,
                "model={model}: blind={blind} cached={cached} did not match with zero cache buckets"
            );
        }
    }

    /// A model with no published cache-read/write rate must still charge for
    /// cache activity — at the full input rate, not for free. This is the
    /// "fail toward over-charging" fallback direction the budget gate relies on.
    #[test]
    fn cache_activity_falls_back_to_full_input_rate_when_model_has_no_cache_tier() {
        use crate::usage::TokenUsage;

        // A version string with no exact-match entry, resolving through the
        // `family_fallbacks` path — those entries are hand-curated in the
        // bundle generator and never carry a cache tier, unlike an exact
        // model match, whose upstream-derived cache rate can appear or
        // disappear on a bundle regeneration. This keeps the test's premise
        // ("this model has no cache tier") true regardless of what upstream
        // happens to publish at regeneration time.
        let cached = estimate_cost_cached("claude-opus-not-a-real-version", &TokenUsage {
            uncached_input: Some(0),
            cache_read_input: Some(1000),
            cache_write_input: Some(0),
            output: Some(0),
        });
        let full_rate_equivalent = estimate_cost("claude-opus-not-a-real-version", 1000, 0);
        assert!(
            (cached - full_rate_equivalent).abs() < 1e-9,
            "cache read with no cache rate should cost the same as a full-rate input token: \
             cached={cached} full_rate={full_rate_equivalent}"
        );
    }

    /// Family fallback and unknown-model paths get no cache discount at all —
    /// cache-read/write tokens on those paths must cost exactly what an
    /// equal number of plain input tokens would.
    #[test]
    fn family_fallback_and_unknown_model_get_no_cache_discount() {
        use crate::usage::TokenUsage;

        for model in ["claude-opus-99", "unknown-vendor-model-v9"] {
            let usage = TokenUsage {
                uncached_input: Some(0),
                cache_read_input: Some(500),
                cache_write_input: Some(500),
                output: Some(0),
            };
            let cached = estimate_cost_cached(model, &usage);
            let blind_equivalent = estimate_cost(model, 1000, 0);
            assert!(
                (cached - blind_equivalent).abs() < 1e-9,
                "model={model}: cache buckets should price identically to plain input on the \
                 fallback paths — cached={cached} blind_equivalent={blind_equivalent}"
            );
        }
    }
}
