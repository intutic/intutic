//! Per-tool-call token breakdown — estimates token count for each
//! individual tool call in an LLM response.
//!
//! Walks the response JSON to find `tool_calls[]` and counts tokens
//! in each tool call's function name and arguments.

use anyhow::Result;
use serde::Serialize;
use tiktoken_rs::CoreBPE;
use tracing::debug;

/// Token breakdown for a single tool call.
#[derive(Debug, Clone, Serialize)]
pub struct ToolCallBreakdown {
    pub tool_name: String,
    pub argument_tokens: u32,
    pub name_tokens: u32,
    pub total_tokens: u32,
}

/// Parse per-tool-call token breakdown from a raw LLM response.
///
/// Supports OpenAI chat completion format with `tool_calls[]` array.
pub fn parse_tool_call_tokens(
    response_json: &serde_json::Value,
    tokenizer: &CoreBPE,
) -> Result<Vec<ToolCallBreakdown>> {
    let mut breakdowns = Vec::new();

    // OpenAI / compatible format
    let tool_calls = response_json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("tool_calls"))
        .and_then(|tc| tc.as_array());

    if let Some(calls) = tool_calls {
        for tc in calls {
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("unknown");

            let args_str = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("");

            let name_tokens = tokenizer.encode_ordinary(name).len() as u32;
            let argument_tokens = tokenizer.encode_ordinary(args_str).len() as u32;

            breakdowns.push(ToolCallBreakdown {
                tool_name: name.to_string(),
                argument_tokens,
                name_tokens,
                total_tokens: name_tokens + argument_tokens,
            });
        }
    }

    // Anthropic format — tool_use content blocks
    if breakdowns.is_empty() {
        if let Some(content) = response_json.get("content").and_then(|c| c.as_array()) {
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown");
                    let input = block
                        .get("input")
                        .map(|i| i.to_string())
                        .unwrap_or_default();

                    let name_tokens = tokenizer.encode_ordinary(name).len() as u32;
                    let argument_tokens = tokenizer.encode_ordinary(&input).len() as u32;

                    breakdowns.push(ToolCallBreakdown {
                        tool_name: name.to_string(),
                        argument_tokens,
                        name_tokens,
                        total_tokens: name_tokens + argument_tokens,
                    });
                }
            }
        }
    }

    debug!(count = breakdowns.len(), "Parsed tool call token breakdown");
    Ok(breakdowns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get_test_tokenizer() -> CoreBPE {
        tiktoken_rs::cl100k_base().unwrap()
    }

    #[test]
    fn test_openai_tool_calls() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\": \"/src/main.rs\"}"
                        }
                    }]
                }
            }]
        });

        let result = parse_tool_call_tokens(&response, &tokenizer).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].tool_name, "read_file");
        assert!(result[0].argument_tokens > 0);
        assert!(result[0].total_tokens > 0);
    }

    #[test]
    fn test_anthropic_tool_use() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "content": [
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "write_file",
                    "input": { "path": "/src/lib.rs", "content": "fn main() {}" }
                }
            ]
        });

        let result = parse_tool_call_tokens(&response, &tokenizer).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].tool_name, "write_file");
    }

    #[test]
    fn test_no_tool_calls() {
        let tokenizer = get_test_tokenizer();
        let response = json!({
            "choices": [{
                "message": { "content": "Just text, no tools." }
            }]
        });

        let result = parse_tool_call_tokens(&response, &tokenizer).unwrap();
        assert!(result.is_empty());
    }
}
