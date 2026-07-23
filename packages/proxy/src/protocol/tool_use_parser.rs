//! Tool-use detection for streaming SSE responses.
//!
//! Scans individual SSE data lines for the *start* of a tool invocation.
//! Only detects the initial `content_block_start` / `tool_calls` delta —
//! full argument accumulation is tracked as TD-TOOLUSE-001 for Phase 5.
//!
//! # Supported providers
//!
//! | Provider  | Detection trigger |
//! |-----------|-------------------|
//! | Anthropic | `content_block_start` with `content_block.type == "tool_use"` |
//! | OpenAI    | `choices[].delta.tool_calls[].function.name` present |

use serde_json::Value;

// ─── Public types ────────────────────────────────────────────────────────────

/// Origin of a detected tool-use event.
#[derive(Debug, Clone)]
pub enum ToolUseSource {
    /// Anthropic streaming SSE — `content_block_start` event.
    Anthropic,
    /// OpenAI streaming SSE — `choices[].delta.tool_calls` event.
    OpenAI,
}

/// A tool invocation detected in a single streaming SSE chunk.
#[derive(Debug, Clone)]
pub struct ToolUseEvent {
    /// The tool name extracted from the streaming chunk.
    pub tool_name: String,
    /// Partial or complete JSON input present in this chunk (may be `"{}"`).
    pub tool_input_json: String,
    /// Which LLM provider emitted this event.
    pub source: ToolUseSource,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Parse a single SSE chunk string and return a [`ToolUseEvent`] if a tool
/// invocation start is detected.
///
/// The `chunk` argument is the raw text of one or more SSE lines as received
/// from the upstream LLM provider (e.g., `"data: {...}\n\ndata: {...}\n"`).
/// Lines that are not `data:` lines, or whose JSON does not contain a
/// tool-use marker, are silently skipped.
///
/// # Returns
///
/// `Some(ToolUseEvent)` on the **first** tool-use start found in the chunk,
/// `None` if no tool invocation is present.
pub fn parse_sse_chunk(chunk: &str) -> Option<ToolUseEvent> {
    for line in chunk.lines() {
        let line = line.trim();
        // Only process `data:` lines; skip comments, event:, id:, etc.
        let data = match line.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => continue,
        };
        // Skip the SSE keep-alive sentinel
        if data == "[DONE]" {
            continue;
        }

        let json: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(event) = try_parse_anthropic(&json) {
            return Some(event);
        }
        if let Some(event) = try_parse_openai(&json) {
            return Some(event);
        }
    }
    None
}

// ─── Provider-specific parsers ───────────────────────────────────────────────

/// Try to extract a tool-use start from an Anthropic SSE data object.
///
/// Anthropic fires a `content_block_start` event when a tool block begins:
///
/// ```json
/// {
///   "type": "content_block_start",
///   "index": 1,
///   "content_block": {
///     "type": "tool_use",
///     "id": "toolu_xxx",
///     "name": "bash",
///     "input": {}
///   }
/// }
/// ```
fn try_parse_anthropic(json: &Value) -> Option<ToolUseEvent> {
    // Must be a content_block_start event
    if json.get("type")?.as_str()? != "content_block_start" {
        return None;
    }
    let block = json.get("content_block")?;
    if block.get("type")?.as_str()? != "tool_use" {
        return None;
    }
    let tool_name = block.get("name")?.as_str()?.to_string();
    let tool_input_json = block
        .get("input")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());

    Some(ToolUseEvent {
        tool_name,
        tool_input_json,
        source: ToolUseSource::Anthropic,
    })
}

/// Try to extract a tool-use start from an OpenAI SSE data object.
///
/// OpenAI fires tool_calls deltas on the first chunk that names the function:
///
/// ```json
/// {
///   "choices": [{
///     "delta": {
///       "tool_calls": [{
///         "index": 0,
///         "function": { "name": "bash", "arguments": "" }
///       }]
///     }
///   }]
/// }
/// ```
///
/// We only return an event when `function.name` is non-empty (the name delta
/// arrives in the first chunk; subsequent chunks carry `arguments` fragments).
fn try_parse_openai(json: &Value) -> Option<ToolUseEvent> {
    let choices = json.get("choices")?.as_array()?;
    let delta = choices.first()?.get("delta")?;
    let tool_calls = delta.get("tool_calls")?.as_array()?;
    let first_call = tool_calls.first()?;
    let function = first_call.get("function")?;
    let name = function.get("name")?.as_str()?;
    if name.is_empty() {
        return None;
    }
    let tool_input_json = function
        .get("arguments")
        .map(|v| v.as_str().unwrap_or("").to_string())
        .unwrap_or_default();

    Some(ToolUseEvent {
        tool_name: name.to_string(),
        tool_input_json,
        source: ToolUseSource::OpenAI,
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const ANTHROPIC_TOOL_CHUNK: &str = r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"bash","input":{}}}

"#;

    const ANTHROPIC_TEXT_CHUNK: &str = r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#;

    const OPENAI_TOOL_CHUNK: &str = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":""}}]}}]}

"#;

    const OPENAI_ARGS_ONLY_CHUNK: &str = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"","arguments":"echo hi"}}]}}]}

"#;

    #[test]
    fn detects_anthropic_tool_use() {
        let event = parse_sse_chunk(ANTHROPIC_TOOL_CHUNK).expect("should detect tool use");
        assert_eq!(event.tool_name, "bash");
        assert!(matches!(event.source, ToolUseSource::Anthropic));
    }

    #[test]
    fn ignores_anthropic_text_block() {
        assert!(parse_sse_chunk(ANTHROPIC_TEXT_CHUNK).is_none());
    }

    #[test]
    fn detects_openai_tool_use() {
        let event = parse_sse_chunk(OPENAI_TOOL_CHUNK).expect("should detect tool use");
        assert_eq!(event.tool_name, "bash");
        assert!(matches!(event.source, ToolUseSource::OpenAI));
    }

    #[test]
    fn ignores_openai_args_only_chunk() {
        // Name is empty string — not the start event
        assert!(parse_sse_chunk(OPENAI_ARGS_ONLY_CHUNK).is_none());
    }

    #[test]
    fn handles_done_sentinel() {
        assert!(parse_sse_chunk("data: [DONE]\n").is_none());
    }

    #[test]
    fn handles_empty_chunk() {
        assert!(parse_sse_chunk("").is_none());
    }

    #[test]
    fn handles_non_data_lines() {
        assert!(parse_sse_chunk("event: ping\n: keep-alive\n").is_none());
    }
}
