//! Token counter — tiktoken-rs wrapper for counting tokens across models.
//!
//! Provides a unified interface for counting tokens regardless of the
//! LLM provider or model. Uses tiktoken-rs which implements OpenAI's
//! tokenizer (cl100k_base for GPT-4, o200k_base for newer models).
//!
//! For Claude and Gemini, we use cl100k_base as an approximation.
//! The error margin is typically <5% which is acceptable for cost estimation.

use anyhow::Result;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tiktoken_rs::CoreBPE;
use tracing::debug;

/// Reuse tokenizer instances across calls (they are expensive to load).
static TOKENIZER_CACHE: Lazy<Mutex<HashMap<String, Arc<CoreBPE>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Get the appropriate tokenizer for a model.
///
/// Returns cl100k_base for most models (GPT-4, Claude, Gemini).
/// Returns o200k_base for GPT-4o and newer OpenAI models.
pub fn get_tokenizer(model: &str) -> Result<Arc<CoreBPE>> {
    let encoding_name = if model.contains("gpt-4o") || model.contains("o1") || model.contains("o3")
    {
        "o200k_base"
    } else {
        "cl100k_base"
    };

    let mut cache = TOKENIZER_CACHE
        .lock()
        .map_err(|e| anyhow::anyhow!("Tokenizer cache lock poisoned: {}", e))?;

    if let Some(bpe) = cache.get(encoding_name) {
        return Ok(Arc::clone(bpe));
    }

    let bpe = match encoding_name {
        "o200k_base" => tiktoken_rs::o200k_base(),
        _ => tiktoken_rs::cl100k_base(),
    }
    .map_err(|e| anyhow::anyhow!("Failed to load tokenizer {}: {}", encoding_name, e))?;

    let arc_bpe = Arc::new(bpe);
    cache.insert(encoding_name.to_string(), Arc::clone(&arc_bpe));
    Ok(arc_bpe)
}

/// Count tokens in a text string using the model-appropriate tokenizer.
pub fn count_tokens(text: &str, model: &str) -> Result<u32> {
    let bpe = get_tokenizer(model)?;
    let tokens = bpe.encode_ordinary(text);
    Ok(tokens.len() as u32)
}

/// Count tokens in a JSON messages array (OpenAI chat format).
///
/// Concatenates all message contents and counts the total.
/// Adds per-message overhead (4 tokens per message for role/metadata).
pub fn count_message_tokens(messages: &serde_json::Value, model: &str) -> Result<u32> {
    let bpe = get_tokenizer(model)?;
    let mut total: u32 = 0;
    let per_message_overhead: u32 = 4; // role, name, content delimiters

    if let Some(arr) = messages.as_array() {
        for msg in arr {
            total += per_message_overhead;

            // Count content tokens
            if let Some(content) = msg.get("content") {
                match content {
                    serde_json::Value::String(s) => {
                        total += bpe.encode_ordinary(s).len() as u32;
                    }
                    serde_json::Value::Array(parts) => {
                        // Multi-part content (images + text)
                        for part in parts {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                total += bpe.encode_ordinary(text).len() as u32;
                            }
                        }
                    }
                    _ => {}
                }
            }

            // Count role tokens
            if let Some(role) = msg.get("role").and_then(|r| r.as_str()) {
                total += bpe.encode_ordinary(role).len() as u32;
            }

            // Count tool call argument tokens
            if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
                for tc in tool_calls {
                    if let Some(args) = tc
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                    {
                        total += bpe.encode_ordinary(args).len() as u32;
                    }
                    if let Some(name) = tc
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                    {
                        total += bpe.encode_ordinary(name).len() as u32;
                    }
                }
            }
        }
    }

    // Add 3 tokens for priming (every conversation has this overhead)
    total += 3;

    debug!(model, total, "Counted message tokens");
    Ok(total)
}

/// Classify input tokens into a bucket for baseline lookups.
pub fn get_input_bucket(input_tokens: u32) -> &'static str {
    match input_tokens {
        0..=999 => "0-1k",
        1000..=4999 => "1k-5k",
        5000..=19999 => "5k-20k",
        20000..=49999 => "20k-50k",
        _ => "50k+",
    }
}
