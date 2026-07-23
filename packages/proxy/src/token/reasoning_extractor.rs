//! Reasoning token extractor — parses thinking/reasoning content from
//! LLM responses across providers.
//!
//! Supported formats:
//! - **Claude (Anthropic)**: `thinking` content blocks with `type: "thinking"`
//! - **OpenAI o1/o3/o4-mini**: `reasoning_content` field in message
//! - **Google Gemini**: `thought: true` parts in candidates

use tiktoken_rs::CoreBPE;
use tracing::debug;

/// Extracts reasoning token count from a completed LLM response.
///
/// Returns `None` if the model doesn't emit reasoning tokens or
/// if no reasoning content was found in the response.
pub fn extract_reasoning_tokens(
    response_json: &serde_json::Value,
    protocol: &str,
    tokenizer: &CoreBPE,
) -> Option<u32> {
    match protocol {
        "anthropic" => extract_claude_thinking(response_json, tokenizer),
        "openai" => extract_openai_reasoning(response_json, tokenizer),
        "gemini" => extract_gemini_thought(response_json, tokenizer),
        _ => None,
    }
}

/// Extract thinking tokens from Claude's response format.
///
/// Claude returns thinking blocks in the content array:
/// ```json
/// {
///   "content": [
///     { "type": "thinking", "thinking": "Let me analyze..." },
///     { "type": "text", "text": "Here's my answer..." }
///   ]
/// }
/// ```
fn extract_claude_thinking(response: &serde_json::Value, tokenizer: &CoreBPE) -> Option<u32> {
    let content = response.get("content")?.as_array()?;
    let mut total = 0u32;

    for block in content {
        if block.get("type")?.as_str()? == "thinking" {
            if let Some(thinking_text) = block.get("thinking").and_then(|t| t.as_str()) {
                total += tokenizer.encode_ordinary(thinking_text).len() as u32;
            }
        }
    }

    if total > 0 {
        debug!(tokens = total, "Extracted Claude thinking tokens");
        Some(total)
    } else {
        None
    }
}

/// Extract reasoning tokens from OpenAI o1/o3 response format.
///
/// OpenAI reasoning models return:
/// ```json
/// {
///   "choices": [{
///     "message": {
///       "reasoning_content": "Step 1: ...",
///       "content": "The answer is..."
///     }
///   }]
/// }
/// ```
fn extract_openai_reasoning(response: &serde_json::Value, tokenizer: &CoreBPE) -> Option<u32> {
    let reasoning = response
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("reasoning_content")?
        .as_str()?;

    let tokens = tokenizer.encode_ordinary(reasoning).len() as u32;
    if tokens > 0 {
        debug!(tokens, "Extracted OpenAI reasoning tokens");
        Some(tokens)
    } else {
        None
    }
}

/// Extract thought tokens from Gemini response format.
///
/// Gemini returns thought parts in candidates:
/// ```json
/// {
///   "candidates": [{
///     "content": {
///       "parts": [
///         { "thought": true, "text": "Let me think..." },
///         { "text": "Here's the answer..." }
///       ]
///     }
///   }]
/// }
/// ```
fn extract_gemini_thought(response: &serde_json::Value, tokenizer: &CoreBPE) -> Option<u32> {
    let parts = response
        .get("candidates")?
        .get(0)?
        .get("content")?
        .get("parts")?
        .as_array()?;

    let mut total = 0u32;
    for part in parts {
        if part
            .get("thought")
            .and_then(|t| t.as_bool())
            .unwrap_or(false)
        {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                total += tokenizer.encode_ordinary(text).len() as u32;
            }
        }
    }

    if total > 0 {
        debug!(tokens = total, "Extracted Gemini thought tokens");
        Some(total)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get_test_tokenizer() -> CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn test_claude_thinking_extraction() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "content": [
                { "type": "thinking", "thinking": "Let me analyze the problem step by step." },
                { "type": "text", "text": "The answer is 42." }
            ]
        });

        let result = extract_reasoning_tokens(&response, "anthropic", &tokenizer);
        assert!(result.is_some());
        assert!(result.unwrap() > 0);
    }

    #[test]
    fn test_openai_reasoning_extraction() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "choices": [{
                "message": {
                    "reasoning_content": "Step 1: Consider the input. Step 2: Calculate.",
                    "content": "The answer is 42."
                }
            }]
        });

        let result = extract_reasoning_tokens(&response, "openai", &tokenizer);
        assert!(result.is_some());
        assert!(result.unwrap() > 0);
    }

    #[test]
    fn test_no_reasoning_returns_none() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "choices": [{
                "message": { "content": "Just a normal response." }
            }]
        });

        let result = extract_reasoning_tokens(&response, "openai", &tokenizer);
        assert!(result.is_none());
    }

    #[test]
    fn test_gemini_thought_extraction() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "thought": true, "text": "I need to think about this carefully." },
                        { "text": "Here is the answer." }
                    ]
                }
            }]
        });

        let result = extract_reasoning_tokens(&response, "gemini", &tokenizer);
        assert!(result.is_some());
        assert!(result.unwrap() > 0);
    }
}
