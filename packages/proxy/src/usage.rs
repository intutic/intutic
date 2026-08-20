//! Provider token-usage parsing, normalized to disjoint billing buckets.
//!
//! TD-347: every provider's usage block was read for a plain input/output
//! total and nothing else, so the two prompt-cache buckets Anthropic, OpenAI
//! and Gemini all report today — tokens read from a warm prompt cache, and
//! (Anthropic only) tokens written into one — were silently dropped. That
//! made cost accounting and the routing bandit's reward function cache-blind:
//! a cache-heavy Anthropic tenant was never billed for reads, and a
//! cache-heavy OpenAI/Gemini tenant never got credit for savings, because the
//! bytes that would have said so were never parsed out of the response body
//! in the first place.
//!
//! This module is the single place that reads a provider's native usage JSON
//! into a normalized shape. Everything downstream — `pricing::estimate_cost_cached`,
//! the trace, the reward engine's cost term — consumes [`TokenUsage`], never
//! the raw provider JSON, so there is exactly one place that has to know each
//! provider's field names.

use serde_json::Value;

/// Provider-reported token usage, normalized to disjoint billing buckets.
///
/// The three input buckets are mutually exclusive by construction — a token
/// is either billed at full input rate, or read from cache, or written to
/// cache, never counted in more than one bucket — which is what makes
/// `total_input()` a safe plain sum rather than a double-count.
///
/// `None` (not `Some(0)`) means the provider did not report this bucket at
/// all — distinct from "reported and zero" (no cache activity this call).
/// Losing that distinction would make "this provider doesn't support
/// caching" indistinguishable from "this call didn't hit the cache", which
/// matters to a pricing fallback that has to decide whether to apply a
/// cache-tier rate at all.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenUsage {
    /// Input tokens billed at the full input rate (excludes both cache buckets).
    pub uncached_input: Option<u32>,
    /// Input tokens read from the provider's prompt cache.
    pub cache_read_input: Option<u32>,
    /// Input tokens written into the provider's prompt cache (Anthropic only today).
    pub cache_write_input: Option<u32>,
    pub output: Option<u32>,
}

impl TokenUsage {
    /// Saturating sum of the three input buckets, for callers that only want
    /// a plain input total (e.g. the cache-blind "what would this have cost
    /// un-optimized" side of the reward engine's ratio).
    ///
    /// Missing buckets contribute 0, matching how `Option<u32>` fields already
    /// read as "not reported" rather than "reported as some unknown value" —
    /// a total is well-defined even when only one of the three buckets is
    /// present.
    pub fn total_input(&self) -> u32 {
        self.uncached_input
            .unwrap_or(0)
            .saturating_add(self.cache_read_input.unwrap_or(0))
            .saturating_add(self.cache_write_input.unwrap_or(0))
    }

    /// Parse an Anthropic Messages API `usage` object (top-level `v["usage"]`
    /// or a `message_start`/`message_delta` event's `usage` field — callers
    /// pass whichever object is in hand).
    ///
    /// Anthropic's `input_tokens` EXCLUDES both cache buckets — it is already
    /// the uncached count — so this reads it verbatim with no subtraction,
    /// unlike OpenAI/the Responses API below.
    pub fn from_anthropic(v: &Value) -> Self {
        let usage = v.get("usage").unwrap_or(v);
        let read_u32 = |key: &str| usage.get(key).and_then(|x| x.as_u64()).map(|x| x as u32);
        TokenUsage {
            uncached_input: read_u32("input_tokens"),
            cache_read_input: read_u32("cache_read_input_tokens"),
            cache_write_input: read_u32("cache_creation_input_tokens"),
            output: read_u32("output_tokens"),
        }
    }

    /// Parse an OpenAI Chat Completions `usage` object.
    ///
    /// OpenAI's `prompt_tokens` INCLUDES cached tokens, so the cached count
    /// has to be subtracted out to get the uncached bucket — saturating, in
    /// case a malformed upstream payload reports `cached_tokens > prompt_tokens`.
    /// OpenAI does not report a cache-write bucket (no equivalent of
    /// Anthropic's `cache_creation_input_tokens`), so that field is always
    /// `None` here.
    pub fn from_openai_chat(v: &Value) -> Self {
        let usage = v.get("usage").unwrap_or(v);
        let prompt_tokens = usage.get("prompt_tokens").and_then(|x| x.as_u64()).map(|x| x as u32);
        let cached_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|x| x.as_u64())
            .map(|x| x as u32);
        let uncached_input = match (prompt_tokens, cached_tokens) {
            (Some(p), Some(c)) => Some(p.saturating_sub(c)),
            (Some(p), None) => Some(p),
            (None, _) => None,
        };
        TokenUsage {
            uncached_input,
            cache_read_input: cached_tokens,
            cache_write_input: None,
            output: usage.get("completion_tokens").and_then(|x| x.as_u64()).map(|x| x as u32),
        }
    }

    /// Parse an OpenAI Responses API `usage` object — same shape as chat
    /// completions, nested under different field names
    /// (`input_tokens`/`input_tokens_details.cached_tokens`).
    pub fn from_responses(v: &Value) -> Self {
        let usage = v.get("usage").unwrap_or(v);
        let input_tokens = usage.get("input_tokens").and_then(|x| x.as_u64()).map(|x| x as u32);
        let cached_tokens = usage
            .get("input_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|x| x.as_u64())
            .map(|x| x as u32);
        let uncached_input = match (input_tokens, cached_tokens) {
            (Some(p), Some(c)) => Some(p.saturating_sub(c)),
            (Some(p), None) => Some(p),
            (None, _) => None,
        };
        TokenUsage {
            uncached_input,
            cache_read_input: cached_tokens,
            cache_write_input: None,
            output: usage.get("output_tokens").and_then(|x| x.as_u64()).map(|x| x as u32),
        }
    }

    /// Parse a Gemini `usageMetadata` object (or the response envelope that
    /// carries one under `usageMetadata`).
    ///
    /// Gemini reports `promptTokenCount` inclusive of cached tokens, like
    /// OpenAI — `cachedContentTokenCount` is subtracted out, saturating.
    /// Gemini does not report a cache-write bucket.
    pub fn from_gemini_metadata(v: &Value) -> Self {
        let usage = v.get("usageMetadata").unwrap_or(v);
        let prompt_tokens = usage.get("promptTokenCount").and_then(|x| x.as_u64()).map(|x| x as u32);
        let cached_tokens = usage
            .get("cachedContentTokenCount")
            .and_then(|x| x.as_u64())
            .map(|x| x as u32);
        let uncached_input = match (prompt_tokens, cached_tokens) {
            (Some(p), Some(c)) => Some(p.saturating_sub(c)),
            (Some(p), None) => Some(p),
            (None, _) => None,
        };
        TokenUsage {
            uncached_input,
            cache_read_input: cached_tokens,
            cache_write_input: None,
            output: usage.get("candidatesTokenCount").and_then(|x| x.as_u64()).map(|x| x as u32),
        }
    }

    /// Overlay `other`'s present fields onto `self`, leaving fields `other`
    /// does not report untouched.
    ///
    /// Streaming accumulation needs this rather than a plain overwrite: an
    /// Anthropic `message_start` event carries the input+cache buckets, and
    /// the later `message_delta` event carries only `output_tokens` — parsing
    /// `message_delta` alone through `from_anthropic` would read `None` for
    /// every field `message_start` already established, and merging by plain
    /// assignment would erase them.
    pub fn merge_from(&mut self, other: TokenUsage) {
        if other.uncached_input.is_some() {
            self.uncached_input = other.uncached_input;
        }
        if other.cache_read_input.is_some() {
            self.cache_read_input = other.cache_read_input;
        }
        if other.cache_write_input.is_some() {
            self.cache_write_input = other.cache_write_input;
        }
        if other.output.is_some() {
            self.output = other.output;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anthropic_reads_cache_fields_verbatim() {
        let v = json!({
            "usage": {
                "input_tokens": 25,
                "cache_read_input_tokens": 1800,
                "cache_creation_input_tokens": 400,
                "output_tokens": 130
            }
        });
        let u = TokenUsage::from_anthropic(&v);
        assert_eq!(u.uncached_input, Some(25));
        assert_eq!(u.cache_read_input, Some(1800));
        assert_eq!(u.cache_write_input, Some(400));
        assert_eq!(u.output, Some(130));
        assert_eq!(u.total_input(), 25 + 1800 + 400);
    }

    #[test]
    fn anthropic_all_fields_absent_stays_none() {
        let v = json!({});
        let u = TokenUsage::from_anthropic(&v);
        assert_eq!(u, TokenUsage::default());
        assert_eq!(u.uncached_input, None);
        assert_eq!(u.cache_read_input, None);
        assert_eq!(u.cache_write_input, None);
        assert_eq!(u.output, None);
        assert_eq!(u.total_input(), 0);
    }

    #[test]
    fn anthropic_accepts_a_bare_usage_object() {
        // message_start/message_delta events hand in the `usage` object
        // itself, not a wrapper with a `usage` key.
        let v = json!({
            "input_tokens": 10,
            "output_tokens": 5
        });
        let u = TokenUsage::from_anthropic(&v);
        assert_eq!(u.uncached_input, Some(10));
        assert_eq!(u.output, Some(5));
    }

    #[test]
    fn openai_chat_subtracts_cached_from_prompt_tokens() {
        let v = json!({
            "usage": {
                "prompt_tokens": 2000,
                "prompt_tokens_details": { "cached_tokens": 1536 },
                "completion_tokens": 300
            }
        });
        let u = TokenUsage::from_openai_chat(&v);
        assert_eq!(u.uncached_input, Some(2000 - 1536));
        assert_eq!(u.cache_read_input, Some(1536));
        assert_eq!(u.cache_write_input, None);
        assert_eq!(u.output, Some(300));
    }

    #[test]
    fn openai_chat_saturates_when_cached_exceeds_prompt() {
        // Malformed upstream payload — must not panic or wrap.
        let v = json!({
            "usage": {
                "prompt_tokens": 100,
                "prompt_tokens_details": { "cached_tokens": 500 },
                "completion_tokens": 10
            }
        });
        let u = TokenUsage::from_openai_chat(&v);
        assert_eq!(u.uncached_input, Some(0));
        assert_eq!(u.cache_read_input, Some(500));
    }

    #[test]
    fn openai_chat_all_fields_absent_stays_none() {
        let v = json!({});
        let u = TokenUsage::from_openai_chat(&v);
        assert_eq!(u, TokenUsage::default());
    }

    #[test]
    fn openai_chat_no_cache_details_present() {
        // A provider/model that doesn't report caching at all: prompt_tokens
        // present, no `prompt_tokens_details` block whatsoever.
        let v = json!({
            "usage": { "prompt_tokens": 50, "completion_tokens": 20 }
        });
        let u = TokenUsage::from_openai_chat(&v);
        assert_eq!(u.uncached_input, Some(50));
        assert_eq!(u.cache_read_input, None);
    }

    #[test]
    fn responses_subtracts_cached_from_input_tokens() {
        let v = json!({
            "usage": {
                "input_tokens": 1200,
                "input_tokens_details": { "cached_tokens": 1000 },
                "output_tokens": 88
            }
        });
        let u = TokenUsage::from_responses(&v);
        assert_eq!(u.uncached_input, Some(200));
        assert_eq!(u.cache_read_input, Some(1000));
        assert_eq!(u.cache_write_input, None);
        assert_eq!(u.output, Some(88));
    }

    #[test]
    fn responses_all_fields_absent_stays_none() {
        let v = json!({});
        let u = TokenUsage::from_responses(&v);
        assert_eq!(u, TokenUsage::default());
    }

    #[test]
    fn gemini_subtracts_cached_content_from_prompt_count() {
        let v = json!({
            "usageMetadata": {
                "promptTokenCount": 5000,
                "cachedContentTokenCount": 4000,
                "candidatesTokenCount": 250
            }
        });
        let u = TokenUsage::from_gemini_metadata(&v);
        assert_eq!(u.uncached_input, Some(1000));
        assert_eq!(u.cache_read_input, Some(4000));
        assert_eq!(u.cache_write_input, None);
        assert_eq!(u.output, Some(250));
    }

    #[test]
    fn gemini_all_fields_absent_stays_none() {
        let v = json!({});
        let u = TokenUsage::from_gemini_metadata(&v);
        assert_eq!(u, TokenUsage::default());
    }

    #[test]
    fn gemini_accepts_a_bare_usage_metadata_object() {
        let v = json!({ "promptTokenCount": 30, "candidatesTokenCount": 12 });
        let u = TokenUsage::from_gemini_metadata(&v);
        assert_eq!(u.uncached_input, Some(30));
        assert_eq!(u.output, Some(12));
    }

    #[test]
    fn merge_from_overlays_only_present_fields() {
        // message_start: input + cache buckets, no output yet.
        let mut acc = TokenUsage::from_anthropic(&json!({
            "input_tokens": 25,
            "cache_read_input_tokens": 1800,
            "cache_creation_input_tokens": 400
        }));
        assert_eq!(acc.output, None);

        // message_delta: output only — must not erase the cache buckets
        // message_start already established.
        let delta = TokenUsage::from_anthropic(&json!({ "output_tokens": 130 }));
        acc.merge_from(delta);

        assert_eq!(acc.uncached_input, Some(25));
        assert_eq!(acc.cache_read_input, Some(1800));
        assert_eq!(acc.cache_write_input, Some(400));
        assert_eq!(acc.output, Some(130));
    }

    #[test]
    fn merge_from_overwrites_when_new_value_present() {
        let mut acc = TokenUsage {
            uncached_input: Some(10),
            ..Default::default()
        };
        acc.merge_from(TokenUsage {
            uncached_input: Some(99),
            ..Default::default()
        });
        assert_eq!(acc.uncached_input, Some(99));
    }

    #[test]
    fn total_input_sums_all_three_buckets_saturating() {
        let u = TokenUsage {
            uncached_input: Some(u32::MAX - 1),
            cache_read_input: Some(10),
            cache_write_input: Some(10),
            output: None,
        };
        assert_eq!(u.total_input(), u32::MAX);
    }

    #[test]
    fn total_input_is_zero_when_everything_absent() {
        assert_eq!(TokenUsage::default().total_input(), 0);
    }
}
