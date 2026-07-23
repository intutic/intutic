//! SnipCompactor — zero-LLM heuristic context compression.
//!
//! Phase 2 compression layer. Ported algorithms from Headroom (masks.py,
//! json_handler.py) via snip_json.rs and snip_code.rs.
//! See LLD §7 and HLD §3.20.

use crate::config::SnipCompactorConfig;
use crate::snip_code::{compact_code_cached, detect_language, CodeLanguage};
use crate::snip_json::{compact_json, is_json, JsonCompactConfig};

/// Content type detected for a given tool output chunk.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContentType {
    Json,
    Code(CodeLanguage),
    Text,
}

/// Telemetry emitted by `compact()` for each compression event.
/// Callers can log or record this as OpenTelemetry span attributes.
#[derive(Debug, Clone)]
pub struct SnipTelemetry {
    /// Detected content type: "json" | "rust" | "python" | "typescript" | "javascript" | "go" | "java" | "text"
    pub input_type: &'static str,
    /// Compression strategy used: "json_aware" | "code_syn" | "code_wasm" | "code_regex" | "text_rules" | "passthrough"
    pub strategy: &'static str,
    /// Input byte count
    pub input_bytes: usize,
    /// Output byte count
    pub output_bytes: usize,
    /// Compression ratio in [0.0, 1.0] — 0.0 means no compression
    pub compression_ratio: f64,
}

/// Classify a text blob as JSON, code, or plain text.
pub fn detect_content_type(text: &str) -> ContentType {
    if is_json(text) {
        return ContentType::Json;
    }
    let lang = detect_language(text);
    if lang != CodeLanguage::Unknown {
        return ContentType::Code(lang);
    }
    ContentType::Text
}

/// Apply SnipCompactor rules to tool output text.
/// Returns compressed text and the compression ratio.
///
/// Dispatch order:
///   1. JSON-aware compressor (if JSON detected)
///   2. Code skeleton extractor (if a supported language is detected)
///   3. Text-level rules: whitespace, import dedup, repetition collapse,
///      stack trace dedup, hard truncation
pub fn compact(text: &str, config: &SnipCompactorConfig) -> (String, f64) {
    if !config.enabled {
        return (text.to_string(), 0.0);
    }

    // ── Pre-pass 1: JSON-aware compression ──────────────────────────────────
    if is_json(text) {
        let json_cfg = JsonCompactConfig::from(config);
        let (compressed, _ratio) = compact_json(text, &json_cfg);
        // Always apply hard truncation even on JSON output
        let truncated = apply_hard_truncation(&compressed, config);
        let final_ratio = if !text.is_empty() {
            1.0 - (truncated.len() as f64 / text.len() as f64)
        } else {
            0.0
        };
        let ratio = final_ratio.max(0.0);
        tracing::info!(
            snip.input_type = "json",
            snip.strategy = "json_aware",
            snip.input_bytes = text.len(),
            snip.output_bytes = truncated.len(),
            snip.compression_ratio = ratio,
            "snip.compacted"
        );
        return (truncated, ratio);
    }

    // ── Pre-pass 2: Code skeleton extraction ────────────────────────────────
    if config.code_skeleton_enabled {
        let line_count = text.lines().count();
        if line_count >= config.code_skeleton_min_lines {
            let lang = detect_language(text);
            if lang != CodeLanguage::Unknown {
                let (skeleton, _) =
                    compact_code_cached(text, config.code_skeleton_incremental_cache);
                if !skeleton.is_empty() && skeleton.len() < text.len() {
                    let truncated = apply_hard_truncation(&skeleton, config);
                    let ratio = if !text.is_empty() {
                        1.0 - (truncated.len() as f64 / text.len() as f64)
                    } else {
                        0.0
                    };
                    if ratio > 0.05 {
                        let (input_type, strategy) = lang_telemetry(lang);
                        tracing::info!(
                            snip.input_type = input_type,
                            snip.strategy = strategy,
                            snip.input_bytes = text.len(),
                            snip.output_bytes = truncated.len(),
                            snip.compression_ratio = ratio,
                            "snip.compacted"
                        );
                        return (truncated, ratio);
                    }
                }
            }
        }
    }

    // ── Pass 3: Text-level rules ─────────────────────────────────────────────
    let mut result = text.to_string();

    // Rule 1: Whitespace normalization
    if config.whitespace_normalize {
        result = normalize_whitespace(&result);
    }

    // Rule 2: Import deduplication
    if config.import_dedup {
        result = dedup_imports(&result);
    }

    // Rule 3: Repetition collapse
    result = collapse_repetitions(&result, config.collapse_repetitions_above);

    // Rule 4: Stack trace dedup
    if config.stack_trace_dedup {
        result = dedup_stack_traces(&result);
    }

    // Rule 5: Hard truncation
    result = apply_hard_truncation(&result, config);

    let original_len = text.len() as f64;
    let compressed_len = result.len() as f64;
    let ratio = if original_len > 0.0 {
        1.0 - (compressed_len / original_len)
    } else {
        0.0
    }
    .max(0.0);

    tracing::info!(
        snip.input_type = "text",
        snip.strategy = "text_rules",
        snip.input_bytes = text.len(),
        snip.output_bytes = result.len(),
        snip.compression_ratio = ratio,
        "snip.compacted"
    );

    (result, ratio)
}

/// Map a CodeLanguage to (input_type, strategy) telemetry strings.
/// Strategy reflects which parsing layer was used (detected at LanguageCache init time).
fn lang_telemetry(lang: CodeLanguage) -> (&'static str, &'static str) {
    // Strategy is always "code_syn" for Rust (syn AST), and "code_wasm"/"code_regex"
    // for others depending on grammar availability. Since we don't thread the actual
    // strategy back from compact_code, we use the conservative label.
    match lang {
        CodeLanguage::Rust => ("rust", "code_syn"),
        CodeLanguage::Python => ("python", "code_wasm_or_regex"),
        CodeLanguage::TypeScript => ("typescript", "code_wasm_or_regex"),
        CodeLanguage::JavaScript => ("javascript", "code_wasm_or_regex"),
        CodeLanguage::Go => ("go", "code_wasm_or_regex"),
        CodeLanguage::Java => ("java", "code_wasm_or_regex"),
        CodeLanguage::Unknown => ("unknown", "passthrough"),
    }
}

/// Hard-truncate `text` at `max_tool_output_tokens` (estimated as 4 chars/token).
fn apply_hard_truncation(text: &str, config: &SnipCompactorConfig) -> String {
    let estimated_tokens = text.len() / 4;
    if estimated_tokens > config.max_tool_output_tokens {
        let max_chars = config.max_tool_output_tokens * 4;
        let remaining_tokens = estimated_tokens - config.max_tool_output_tokens;
        format!(
            "{}\n[truncated: ~{} more tokens]",
            &text[..max_chars.min(text.len())],
            remaining_tokens
        )
    } else {
        text.to_string()
    }
}

/// Collapse consecutive blank lines into a single blank line
fn normalize_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prev_blank = false;
    for line in text.lines() {
        let is_blank = line.trim().is_empty();
        if is_blank && prev_blank {
            continue;
        }
        result.push_str(line);
        result.push('\n');
        prev_blank = is_blank;
    }
    result
}

/// Remove duplicate import/require statements
fn dedup_imports(text: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut result = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim();
        let is_import = trimmed.starts_with("import ")
            || trimmed.starts_with("from ")
            || trimmed.starts_with("const ") && trimmed.contains("require(")
            || trimmed.starts_with("use ");
        if is_import {
            if seen.contains(trimmed) {
                continue;
            }
            seen.insert(trimmed.to_string());
        }
        result.push_str(line);
        result.push('\n');
    }
    result
}

/// Collapse N+ identical consecutive lines into a summary
fn collapse_repetitions(text: &str, threshold: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    while i < lines.len() {
        let current = lines[i];
        let mut count = 1;
        while i + count < lines.len() && lines[i + count] == current {
            count += 1;
        }
        if count > threshold {
            result.push_str(current);
            result.push('\n');
            result.push_str(&format!("[... {} more identical lines]\n", count - 1));
            i += count;
        } else {
            for j in 0..count {
                result.push_str(lines[i + j]);
                result.push('\n');
            }
            i += count;
        }
    }
    result
}

/// Keep first and last stack frame, collapse middle
fn dedup_stack_traces(text: &str) -> String {
    // Simple heuristic: detect "at " lines in sequence
    let lines: Vec<&str> = text.lines().collect();
    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.starts_with("at ") {
            // Found start of stack trace
            let start = i;
            while i < lines.len() && lines[i].trim().starts_with("at ") {
                i += 1;
            }
            let end = i;
            let trace_len = end - start;
            if trace_len > 4 {
                // Keep first 2 + last 1, collapse middle
                result.push_str(lines[start]);
                result.push('\n');
                result.push_str(lines[start + 1]);
                result.push('\n');
                result.push_str(&format!("    [... {} frames omitted]\n", trace_len - 3));
                result.push_str(lines[end - 1]);
                result.push('\n');
            } else {
                for line in lines.iter().take(end).skip(start) {
                    result.push_str(line);
                    result.push('\n');
                }
            }
        } else {
            result.push_str(lines[i]);
            result.push('\n');
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SnipCompactorConfig;

    #[test]
    fn test_whitespace_normalization() {
        let input = "line1\n\n\n\nline2\n";
        let result = normalize_whitespace(input);
        assert_eq!(result, "line1\n\nline2\n");
    }

    #[test]
    fn test_import_dedup() {
        let input = "import foo from 'bar';\nimport baz from 'qux';\nimport foo from 'bar';\n";
        let result = dedup_imports(input);
        assert_eq!(result.matches("import foo").count(), 1);
    }

    #[test]
    fn test_repetition_collapse() {
        let input = "ok\nok\nok\nok\nok\nok\n";
        let result = collapse_repetitions(input, 3);
        assert!(result.contains("[... 5 more identical lines]"));
    }

    #[test]
    fn test_compact_returns_ratio() {
        let input = "line\n".repeat(100);
        let config = SnipCompactorConfig::default();
        let (_, ratio) = compact(&input, &config);
        // Repetition collapse should give us a positive ratio
        assert!(ratio > 0.0);
    }
}
