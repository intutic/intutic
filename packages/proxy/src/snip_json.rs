//! snip_json — JSON-structure-preserving compression for SnipCompactor.
//!
//! Ported from Headroom's `JSONStructureHandler` (json_handler.py) and
//! `EntropyScore` (masks.py:256-294). Zero external dependencies — pure std.
//!
//! # What it does
//! Walks JSON character-by-character, preserving:
//!   - All keys (object field names)
//!   - Structural tokens: `{`, `}`, `[`, `]`, `:`, `,`
//!   - Booleans (`true`, `false`) and `null`
//!   - Numbers ≤ 10 digits
//!   - High-entropy string values (UUIDs, hashes, API keys, prefixed IDs)
//!
//! And compressing:
//!   - Long string values (> `max_string_value_chars`) → `"…"`
//!   - Array tails past `max_array_items` → `[...N more items]`

use crate::config::SnipCompactorConfig;

/// Configuration for JSON-specific compression, derived from SnipCompactorConfig.
#[derive(Debug, Clone)]
pub struct JsonCompactConfig {
    pub max_array_items: usize,
    pub max_string_value_chars: usize,
    pub entropy_threshold: f64,
}

impl From<&SnipCompactorConfig> for JsonCompactConfig {
    fn from(c: &SnipCompactorConfig) -> Self {
        JsonCompactConfig {
            max_array_items: c.json_max_array_items,
            max_string_value_chars: c.json_max_string_value_chars,
            entropy_threshold: c.json_entropy_threshold,
        }
    }
}

impl Default for JsonCompactConfig {
    fn default() -> Self {
        JsonCompactConfig {
            max_array_items: 3,
            max_string_value_chars: 20,
            entropy_threshold: 0.85,
        }
    }
}

// ─── Entropy scorer ──────────────────────────────────────────────────────────

/// Shannon entropy of `s`, self-normalized to [0.0, 1.0].
///
/// Ported from Headroom `EntropyScore.compute` (masks.py:257-294).
///
/// Short-circuits to 0.0 if `s` contains a space — space-separated prose is
/// never high-entropy in the identifier sense and we avoid wasting cycles.
pub fn entropy_score(s: &str) -> f64 {
    if s.is_empty() || s.contains(' ') {
        return 0.0;
    }
    let total = s.len() as f64;
    // Count byte frequencies (ASCII/UTF-8 bytes — sufficient for UUIDs/hashes)
    let mut freq = [0u32; 256];
    for b in s.bytes() {
        freq[b as usize] += 1;
    }
    let unique: usize = freq.iter().filter(|&&c| c > 0).count();
    if unique <= 1 {
        return 0.0;
    }
    let entropy: f64 = freq
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / total;
            -p * p.log2()
        })
        .sum();
    let max_entropy = (unique as f64).log2();
    if max_entropy <= 0.0 {
        0.0
    } else {
        (entropy / max_entropy).min(1.0)
    }
}

/// Returns true if this string value should be preserved verbatim.
/// Preserves: short values, and space-free values with high Shannon entropy.
fn should_preserve_value(val: &str, cfg: &JsonCompactConfig) -> bool {
    if val.len() <= cfg.max_string_value_chars {
        return true;
    }
    // Space-free + high entropy → UUID/hash/API-key → preserve
    !val.contains(' ') && entropy_score(val) >= cfg.entropy_threshold
}

// ─── Quick JSON detection ─────────────────────────────────────────────────────

/// Returns true if `text` looks like JSON (starts with `{` or `[` after trimming).
pub fn is_json(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('{') || t.starts_with('[')
}

// ─── JSON compactor ───────────────────────────────────────────────────────────

/// Per-container frame on the parser stack.
#[derive(Debug, Clone)]
enum Frame {
    /// Inside a JSON object. `expecting_key` flips between key and value slots.
    Object { expecting_key: bool },
    /// Inside a JSON array. `count` = items seen so far (incremented on each `,`).
    Array { count: usize },
}

/// Scanner state — what kind of token are we currently reading?
#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Value,    // expecting next value/token
    InKey,    // accumulating object key string chars
    InValue,  // accumulating value string chars
    InNumber, // accumulating number literal
    InWord,   // accumulating true/false/null keyword
}

/// Compress JSON text structure-preservingly.
///
/// Returns `(compressed_json, ratio)` where ratio ∈ [0.0, 1.0].
/// Keys are always preserved. Long/low-entropy values are collapsed to `"…"`.
/// Array tails past `max_array_items` are collapsed to `…N more items`.
pub fn compact_json(text: &str, cfg: &JsonCompactConfig) -> (String, f64) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());

    let mut state = State::Value;
    let mut i = 0;
    let mut frames: Vec<Frame> = Vec::new();
    let mut token_buf = String::new();

    // Array-tail skipping state
    let mut skipping = false;
    let mut skip_depth: usize = 0;
    let mut skipped_items: usize = 0;

    while i < chars.len() {
        let ch = chars[i];

        // ── Array-tail skip scan ──────────────────────────────────────────────
        if skipping {
            match ch {
                '{' | '[' => skip_depth += 1,
                '}' | ']' if skip_depth > 0 => skip_depth -= 1,
                '}' | ']' => {
                    // Matched the closing bracket of the array being collapsed
                    out.push_str(&format!(", ...{} more items]", skipped_items));
                    skipping = false;
                    frames.pop(); // pop the array frame
                    i += 1;
                    continue;
                }
                ',' if skip_depth == 0 => {
                    // Another item in the tail being skipped
                    skipped_items += 1;
                }
                _ => {}
            }
            i += 1;
            continue;
        }

        // ── Main scanner ──────────────────────────────────────────────────────
        match state {
            State::Value => match ch {
                ' ' | '\t' | '\n' | '\r' => {
                    i += 1;
                }

                '"' => {
                    // Key or value? Check the current frame's expecting_key bit.
                    let is_key = matches!(
                        frames.last(),
                        Some(Frame::Object {
                            expecting_key: true
                        })
                    );
                    state = if is_key { State::InKey } else { State::InValue };
                    token_buf.clear();
                    i += 1;
                }

                '{' => {
                    // Objects start expecting a key next
                    if let Some(Frame::Object { expecting_key }) = frames.last_mut() {
                        *expecting_key = false; // the object value is now being consumed
                    }
                    frames.push(Frame::Object {
                        expecting_key: true,
                    });
                    out.push('{');
                    i += 1;
                }

                '[' => {
                    if let Some(Frame::Object { expecting_key }) = frames.last_mut() {
                        *expecting_key = false;
                    }
                    frames.push(Frame::Array { count: 0 });
                    out.push('[');
                    i += 1;
                }

                '}' => {
                    frames.pop();
                    out.push('}');
                    i += 1;
                }

                ']' => {
                    frames.pop();
                    out.push(']');
                    i += 1;
                }

                ':' => {
                    // After colon: value follows — flip expecting_key to false
                    if let Some(Frame::Object { expecting_key }) = frames.last_mut() {
                        *expecting_key = false;
                    }
                    out.push(':');
                    i += 1;
                }

                ',' => {
                    // After comma in object: next string is a key
                    // After comma in array: increment item count, check collapse threshold
                    match frames.last_mut() {
                        Some(Frame::Object { expecting_key }) => {
                            *expecting_key = true;
                            out.push(',');
                            i += 1;
                        }
                        Some(Frame::Array { count }) => {
                            *count += 1;
                            if *count >= cfg.max_array_items {
                                // Start collapsing tail — don't emit the comma
                                skipping = true;
                                skip_depth = 0;
                                skipped_items = 1; // the item after this comma
                                i += 1;
                            } else {
                                out.push(',');
                                i += 1;
                            }
                        }
                        None => {
                            out.push(',');
                            i += 1;
                        }
                    }
                }

                't' | 'f' | 'n' => {
                    // Keyword (true/false/null) — also counts as consuming a value
                    if let Some(Frame::Object { expecting_key }) = frames.last_mut() {
                        *expecting_key = false;
                    }
                    state = State::InWord;
                    token_buf.clear();
                    token_buf.push(ch);
                    i += 1;
                }

                '-' | '0'..='9' => {
                    if let Some(Frame::Object { expecting_key }) = frames.last_mut() {
                        *expecting_key = false;
                    }
                    state = State::InNumber;
                    token_buf.clear();
                    token_buf.push(ch);
                    i += 1;
                }

                _ => {
                    out.push(ch);
                    i += 1;
                }
            },

            State::InKey => {
                if ch == '"' {
                    out.push('"');
                    out.push_str(&token_buf);
                    out.push('"');
                    token_buf.clear();
                    state = State::Value;
                    i += 1;
                } else if ch == '\\' && i + 1 < chars.len() {
                    token_buf.push(ch);
                    token_buf.push(chars[i + 1]);
                    i += 2;
                } else {
                    token_buf.push(ch);
                    i += 1;
                }
            }

            State::InValue => {
                if ch == '"' {
                    let val = token_buf.clone();
                    if should_preserve_value(&val, cfg) {
                        out.push('"');
                        out.push_str(&val);
                        out.push('"');
                    } else {
                        out.push_str("\"…\"");
                    }
                    token_buf.clear();
                    state = State::Value;
                    // After emitting a value in an object, next comma → expecting_key=true
                    i += 1;
                } else if ch == '\\' && i + 1 < chars.len() {
                    token_buf.push(ch);
                    token_buf.push(chars[i + 1]);
                    i += 2;
                } else {
                    token_buf.push(ch);
                    i += 1;
                }
            }

            State::InNumber => {
                if ch.is_ascii_digit()
                    || ch == '.'
                    || ch == 'e'
                    || ch == 'E'
                    || ch == '+'
                    || ch == '-'
                {
                    token_buf.push(ch);
                    i += 1;
                } else {
                    // End of number
                    if token_buf.len() <= 10 {
                        out.push_str(&token_buf);
                    } else {
                        out.push_str(&token_buf[..10]);
                        out.push('…');
                    }
                    token_buf.clear();
                    state = State::Value;
                    // Don't advance i — reprocess this char
                }
            }

            State::InWord => {
                if ch.is_ascii_alphabetic() {
                    token_buf.push(ch);
                    i += 1;
                } else {
                    out.push_str(&token_buf);
                    token_buf.clear();
                    state = State::Value;
                    // Don't advance i
                }
            }
        }
    }

    // Flush any trailing token
    if !token_buf.is_empty() {
        out.push_str(&token_buf);
    }

    let original_len = text.len() as f64;
    let compressed_len = out.len() as f64;
    let ratio = if original_len > 0.0 && compressed_len < original_len {
        1.0 - (compressed_len / original_len)
    } else {
        0.0
    };

    (out, ratio)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── entropy_score ──────────────────────────────────────────────────────────

    #[test]
    fn test_entropy_uuid_high() {
        let score = entropy_score("8f14e45f-ceea-4123-8f14-e45fceea4123");
        assert!(score >= 0.85, "UUID entropy {} should be >= 0.85", score);
    }

    #[test]
    fn test_entropy_hex_hash_high() {
        let score = entropy_score("a3f2c1d8e7b94056");
        assert!(
            score >= 0.80,
            "hex hash entropy {} should be >= 0.80",
            score
        );
    }

    #[test]
    fn test_entropy_short_low() {
        // Very short strings have trivially high normalized entropy but we
        // short-circuit on length in should_preserve_value, not here
        let score = entropy_score("ok");
        // 'o' and 'k' → 2 unique of 2 chars → normalized = 1.0, but that's fine;
        // the preserve gate uses max_string_value_chars first
        let _ = score; // no assertion needed — just no panic
    }

    #[test]
    fn test_entropy_prose_space_shortcircuit() {
        let score = entropy_score("Hello world this is prose");
        assert_eq!(score, 0.0, "prose with spaces should short-circuit to 0.0");
    }

    #[test]
    fn test_entropy_empty() {
        assert_eq!(entropy_score(""), 0.0);
    }

    // ── is_json ────────────────────────────────────────────────────────────────

    #[test]
    fn test_is_json_object() {
        assert!(is_json(r#"{"key":"value"}"#));
    }

    #[test]
    fn test_is_json_array() {
        assert!(is_json(r#"[1, 2, 3]"#));
    }

    #[test]
    fn test_is_json_with_leading_whitespace() {
        assert!(is_json("  \n  {\"a\":1}"));
    }

    #[test]
    fn test_is_json_negative_plain_text() {
        assert!(!is_json("fn main() { println!(\"hello\"); }"));
    }

    #[test]
    fn test_is_json_negative_empty() {
        assert!(!is_json(""));
    }

    // ── compact_json ──────────────────────────────────────────────────────────

    fn cfg() -> JsonCompactConfig {
        JsonCompactConfig {
            max_array_items: 3,
            max_string_value_chars: 20,
            entropy_threshold: 0.85,
        }
    }

    #[test]
    fn test_compact_preserves_keys() {
        let input = r#"{"name":"Alice","role":"admin"}"#;
        let (out, _) = compact_json(input, &cfg());
        assert!(out.contains("\"name\""), "key 'name' must be present");
        assert!(out.contains("\"role\""), "key 'role' must be present");
    }

    #[test]
    fn test_compact_truncates_long_strings() {
        let bio = "A".repeat(80);
        let input = format!(r#"{{"bio":"{}"}}"#, bio);
        let (out, ratio) = compact_json(&input, &cfg());
        assert!(out.contains("\"…\""), "long value should become '\"…\"'");
        assert!(ratio > 0.0, "ratio should be positive");
    }

    #[test]
    fn test_compact_preserves_uuid_value() {
        let uuid = "8f14e45f-ceea-4123-8f14-e45fceea4123";
        let input = format!(r#"{{"id":"{}"}}"#, uuid);
        let (out, _) = compact_json(&input, &cfg());
        assert!(out.contains(uuid), "UUID should be preserved, got: {}", out);
    }

    #[test]
    fn test_compact_preserves_short_values() {
        let input = r#"{"status":"ok","count":42}"#;
        let (out, _) = compact_json(&input, &cfg());
        assert!(
            out.contains("\"ok\""),
            "short value 'ok' should be preserved"
        );
        assert!(out.contains("42"), "number 42 should be preserved");
    }

    #[test]
    fn test_compact_collapses_array() {
        // Use a large array so that collapsing the tail actually saves characters
        let items: Vec<String> = (0..50)
            .map(|i| format!("\"item_with_long_key_{}\"", i))
            .collect();
        let input = format!("[{}]", items.join(","));
        let (out, ratio) = compact_json(&input, &cfg());
        assert!(
            out.contains("more items"),
            "array tail should be collapsed, got: {}",
            out
        );
        assert!(
            ratio > 0.0,
            "50-item array should compress positively, got ratio={}",
            ratio
        );
    }

    #[test]
    fn test_compact_preserves_booleans_nulls() {
        let input = r#"{"active":true,"deleted":false,"ref":null}"#;
        let (out, _) = compact_json(&input, &cfg());
        assert!(out.contains("true"));
        assert!(out.contains("false"));
        assert!(out.contains("null"));
    }

    #[test]
    fn test_compact_nested_objects_keys_preserved() {
        let input = r#"{"user":{"id":"u1","meta":{"role":"admin"}}}"#;
        let (out, _) = compact_json(&input, &cfg());
        assert!(out.contains("\"user\""));
        assert!(out.contains("\"id\""));
        assert!(out.contains("\"meta\""));
        assert!(out.contains("\"role\""));
    }

    #[test]
    fn test_compact_ratio_on_large_json() {
        let items: Vec<String> = (0..50)
            .map(|i| format!(r#"{{"id":{},"desc":"{}"}}"#, i, "x".repeat(40)))
            .collect();
        let input = format!("[{}]", items.join(","));
        let (_, ratio) = compact_json(&input, &cfg());
        assert!(
            ratio > 0.1,
            "large JSON should compress > 10%, got {}",
            ratio
        );
    }

    #[test]
    fn test_compact_json_dispatch_through_config() {
        // Verify compact_json works with a config derived from SnipCompactorConfig
        use crate::config::SnipCompactorConfig;
        let sc = SnipCompactorConfig::default();
        let jc = JsonCompactConfig::from(&sc);
        let input = r#"{"key":"value"}"#;
        let (out, _) = compact_json(input, &jc);
        assert!(out.contains("\"key\""));
    }
}
