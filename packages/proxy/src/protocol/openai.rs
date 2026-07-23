//! OpenAI ↔ Anthropic protocol adapter.
//!
//! Handles native Rust translation of incoming OpenAI chat completion and
//! responses API payloads to canonical Anthropic formats and back.
//! Includes support for multimodal content translation, structured outputs,
//! tool use mapping, streamingSSE, and thinking block stripping.
//!
//! LLD #26 §4.4 — Rust-Native Protocol Normalization (LLM-Bridge Pattern)

use serde_json::{json, Value};

pub struct OpenAIAdapter;

impl OpenAIAdapter {
    /// Translates an OpenAI Chat Completion request (or Responses request) to Anthropic Messages format.
    pub fn translate_request_to_anthropic(openai_req: &Value, is_responses_api: bool) -> Value {
        let mut anthropic_req = json!({});

        // 1. Resolve model name
        if let Some(model) = openai_req.get("model").and_then(|v| v.as_str()) {
            anthropic_req["model"] = json!(model);
        }

        // 2. Extract messages (or inputs)
        let messages_key = if is_responses_api {
            "input"
        } else {
            "messages"
        };
        let empty_vec = vec![];
        let raw_messages = openai_req
            .get(messages_key)
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_vec);

        let mut system_prompts = Vec::new();
        let mut anthropic_messages = Vec::new();

        for msg in raw_messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");

            // Responses API developer role maps to system prompt
            if role == "system" || (is_responses_api && role == "developer") {
                if let Some(content) = msg.get("content") {
                    if let Some(txt) = content.as_str() {
                        system_prompts.push(txt.to_string());
                    } else if let Some(arr) = content.as_array() {
                        for part in arr {
                            if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(txt) = part.get("text").and_then(|v| v.as_str()) {
                                    system_prompts.push(txt.to_string());
                                }
                            }
                        }
                    }
                }
                continue;
            }

            let mut mapped_msg = json!({});
            let mut content_blocks = Vec::new();

            // Handle content mapping
            if let Some(content) = msg.get("content") {
                if let Some(txt) = content.as_str() {
                    if !txt.is_empty() {
                        content_blocks.push(json!({
                            "type": "text",
                            "text": txt
                        }));
                    }
                } else if let Some(arr) = content.as_array() {
                    for part in arr {
                        let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if part_type == "text" {
                            if let Some(txt) = part.get("text").and_then(|v| v.as_str()) {
                                content_blocks.push(json!({
                                    "type": "text",
                                    "text": txt
                                }));
                            }
                        } else if part_type == "image_url" {
                            if let Some(url) = part
                                .get("image_url")
                                .and_then(|img| img.get("url"))
                                .and_then(|u| u.as_str())
                            {
                                if url.starts_with("data:") {
                                    // Parse data URL: data:image/png;base64,iVBOR...
                                    let comma_idx = url.find(',').unwrap_or(0);
                                    let meta = &url[..comma_idx];
                                    let data = &url[(comma_idx + 1)..];
                                    let media_type = meta
                                        .strip_prefix("data:")
                                        .and_then(|s| s.split(';').next())
                                        .unwrap_or("image/jpeg");
                                    content_blocks.push(json!({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": media_type,
                                            "data": data
                                        }
                                    }));
                                }
                            }
                        } else if part_type == "input_audio" {
                            if let Some(audio_data) = part
                                .get("input_audio")
                                .and_then(|a| a.get("data"))
                                .and_then(|d| d.as_str())
                            {
                                let format = part
                                    .get("input_audio")
                                    .and_then(|a| a.get("format"))
                                    .and_then(|f| f.as_str())
                                    .unwrap_or("wav");
                                let media_type = format!("audio/{}", format);
                                content_blocks.push(json!({
                                    "type": "document",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": audio_data
                                    }
                                }));
                            }
                        }
                    }
                }
            }

            // Map role
            let mut anthropic_role = if role == "assistant" {
                "assistant"
            } else {
                "user"
            };

            // Tool execution output (role = tool / function_call_output)
            if role == "tool" || (is_responses_api && role == "function_call_output") {
                anthropic_role = "user";
                let tool_use_id = msg
                    .get("tool_call_id")
                    .or_else(|| msg.get("tool_use_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                let tool_result_content = msg
                    .get("content")
                    .map(|v| {
                        if v.is_string() {
                            v.as_str().unwrap().to_string()
                        } else {
                            v.to_string()
                        }
                    })
                    .unwrap_or_default();

                content_blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": tool_result_content
                }));
            }

            // Assistant tool calls mapping
            if role == "assistant" {
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tool_calls {
                        if let (Some(id), Some(name)) = (
                            tc.get("id").and_then(|v| v.as_str()),
                            tc.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|n| n.as_str()),
                        ) {
                            let args_str = tc
                                .get("function")
                                .and_then(|f| f.get("arguments"))
                                .and_then(|a| a.as_str())
                                .unwrap_or("{}");
                            let args_json: Value =
                                serde_json::from_str(args_str).unwrap_or_default();
                            content_blocks.push(json!({
                                "type": "tool_use",
                                "id": id,
                                "name": name,
                                "input": args_json
                            }));
                        }
                    }
                }
            }

            mapped_msg["role"] = json!(anthropic_role);
            if content_blocks.len() == 1 && content_blocks[0]["type"] == "text" {
                mapped_msg["content"] = content_blocks[0]["text"].clone();
            } else {
                mapped_msg["content"] = json!(content_blocks);
            }
            anthropic_messages.push(mapped_msg);
        }

        anthropic_req["messages"] = json!(anthropic_messages);

        if !system_prompts.is_empty() {
            anthropic_req["system"] = json!(system_prompts.join("\n"));
        }

        // 3. Translate tools / functions
        let mut anthropic_tools = Vec::new();
        if let Some(tools) = openai_req.get("tools").and_then(|v| v.as_array()) {
            for t in tools {
                if t.get("type").and_then(|v| v.as_str()) == Some("function") {
                    if let Some(func) = t.get("function") {
                        if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                            let mapped_tool = json!({
                                "name": name,
                                "description": func.get("description").unwrap_or(&json!("")),
                                "input_schema": func.get("parameters").unwrap_or(&json!({
                                    "type": "object",
                                    "properties": {}
                                }))
                            });
                            anthropic_tools.push(mapped_tool);
                        }
                    }
                }
            }
        }

        // 4. Translate response_format to implicit structured output tool
        let mut force_json_tool = false;
        let mut json_tool_name = "json_output".to_string();
        if let Some(fmt) = openai_req.get("response_format") {
            let fmt_type = fmt.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if fmt_type == "json_schema" {
                if let Some(js) = fmt.get("json_schema") {
                    let name = js
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("json_output");
                    json_tool_name = name.to_string();
                    if let Some(schema) = js.get("schema") {
                        anthropic_tools.push(json!({
                            "name": name,
                            "description": "Output structured JSON matching the schema.",
                            "input_schema": schema
                        }));
                        force_json_tool = true;
                    }
                }
            } else if fmt_type == "json_object" {
                // Freeform JSON output request
                anthropic_tools.push(json!({
                    "name": "json_output",
                    "description": "Output structured JSON data.",
                    "input_schema": {
                        "type": "object"
                    }
                }));
                force_json_tool = true;
            }
        }

        if !anthropic_tools.is_empty() {
            anthropic_req["tools"] = json!(anthropic_tools);
        }

        if force_json_tool {
            anthropic_req["tool_choice"] = json!({
                "type": "tool",
                "name": json_tool_name
            });
        }

        // 5. Transfer hyper-parameters
        if let Some(temp) = openai_req.get("temperature") {
            anthropic_req["temperature"] = temp.clone();
        }
        if let Some(max_tokens) = openai_req
            .get("max_tokens")
            .or_else(|| openai_req.get("max_completion_tokens"))
        {
            anthropic_req["max_tokens"] = max_tokens.clone();
        } else {
            anthropic_req["max_tokens"] = json!(4096);
        }
        if let Some(stream) = openai_req.get("stream") {
            anthropic_req["stream"] = stream.clone();
        }

        anthropic_req
    }

    /// Translates an Anthropic Messages response back to OpenAI Chat Completion (or Responses) format.
    pub fn translate_response_to_openai(
        anthropic_resp: &Value,
        requested_model: &str,
        is_responses_api: bool,
    ) -> Value {
        let mut openai_resp = json!({});

        // Set ID and Object type
        let id = anthropic_resp
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("chatcmpl-unknown");
        openai_resp["id"] = json!(id);

        let object_type = if is_responses_api {
            "response"
        } else {
            "chat.completion"
        };
        openai_resp["object"] = json!(object_type);
        openai_resp["created"] = json!(chrono::Utc::now().timestamp());
        openai_resp["model"] = json!(requested_model);

        let mut choices = Vec::new();
        let mut tool_calls = Vec::new();
        let mut text_content = String::new();

        let empty_vec = vec![];
        let content_blocks = anthropic_resp
            .get("content")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty_vec);

        for block in content_blocks {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if block_type == "text" {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    text_content.push_str(text);
                }
            } else if block_type == "tool_use" {
                if let (Some(id), Some(name)) = (
                    block.get("id").and_then(|v| v.as_str()),
                    block.get("name").and_then(|v| v.as_str()),
                ) {
                    let default_input = json!({});
                    let input = block.get("input").unwrap_or(&default_input);
                    tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": serde_json::to_string(input).unwrap_or_default()
                        }
                    }));
                }
            }
            // Note: thinking and redacted_thinking content blocks are filtered out (Thinking Block Stripping)
        }

        let mut finish_reason = "stop";
        if !tool_calls.is_empty() {
            finish_reason = "tool_calls";
        }

        let mut message = json!({
            "role": "assistant"
        });

        // If implicit JSON output tool was forced, extract its argument directly as content
        if tool_calls.len() == 1
            && (tool_calls[0]["function"]["name"] == "json_output"
                || tool_calls[0]["function"]["name"] == "json_schema")
        {
            let args_str = tool_calls[0]["function"]["arguments"]
                .as_str()
                .unwrap_or("");
            message["content"] = json!(args_str);
        } else {
            message["content"] = json!(text_content);
            if !tool_calls.is_empty() {
                message["tool_calls"] = json!(tool_calls);
            }
        }

        let choice = json!({
            "index": 0,
            "message": message,
            "finish_reason": finish_reason
        });
        choices.push(choice);
        openai_resp["choices"] = json!(choices);

        // Map token counts
        let mut usage = json!({
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0
        });

        if let Some(u) = anthropic_resp.get("usage") {
            let input_tokens = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            let output_tokens = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            usage["prompt_tokens"] = json!(input_tokens);
            usage["completion_tokens"] = json!(output_tokens);
            usage["total_tokens"] = json!(input_tokens + output_tokens);
        }

        openai_resp["usage"] = usage;
        openai_resp
    }

    /// Translate a streaming SSE delta event from Anthropic format to OpenAI format.
    pub fn translate_stream_event(
        event_type: &str,
        data: &Value,
        _is_responses_api: bool,
    ) -> Option<Value> {
        match event_type {
            "content_block_start" => {
                let block = data.get("content_block");
                let block_type = block
                    .and_then(|b| b.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if block_type == "tool_use" {
                    let tc_id = block
                        .and_then(|b| b.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let name = block
                        .and_then(|b| b.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let index = data.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    return Some(json!({
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": [{
                                    "index": index,
                                    "id": tc_id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": ""
                                    }
                                }]
                            }
                        }]
                    }));
                }
            }
            "content_block_delta" => {
                let delta = data.get("delta");
                let delta_type = delta
                    .and_then(|d| d.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                let index = data.get("index").and_then(|v| v.as_u64()).unwrap_or(0);

                if delta_type == "text_delta" {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        return Some(json!({
                            "choices": [{
                                "index": 0,
                                "delta": {
                                    "content": text
                                }
                            }]
                        }));
                    }
                } else if delta_type == "input_json_delta" {
                    if let Some(partial_json) = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|t| t.as_str())
                    {
                        return Some(json!({
                            "choices": [{
                                "index": 0,
                                "delta": {
                                    "tool_calls": [{
                                        "index": index,
                                        "function": {
                                            "arguments": partial_json
                                        }
                                    }]
                                }
                            }]
                        }));
                    }
                }
            }
            "message_delta" => {
                if let Some(stop_reason) = data
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|s| s.as_str())
                {
                    let finish_reason = match stop_reason {
                        "end_turn" => "stop",
                        "tool_use" => "tool_calls",
                        "max_tokens" => "length",
                        _ => "stop",
                    };
                    return Some(json!({
                        "choices": [{
                            "index": 0,
                            "finish_reason": finish_reason,
                            "delta": {}
                        }]
                    }));
                }
            }
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_translate_stream_event_text() {
        let data = json!({
            "index": 0,
            "delta": {
                "type": "text_delta",
                "text": "hello"
            }
        });
        let res = OpenAIAdapter::translate_stream_event("content_block_delta", &data, false);
        assert!(res.is_some());
        let val = res.unwrap();
        assert_eq!(val["choices"][0]["delta"]["content"], "hello");
    }

    #[test]
    fn test_translate_stream_event_message_delta() {
        let data = json!({
            "delta": {
                "stop_reason": "end_turn"
            }
        });
        let res = OpenAIAdapter::translate_stream_event("message_delta", &data, false);
        assert!(res.is_some());
        let val = res.unwrap();
        assert_eq!(val["choices"][0]["finish_reason"], "stop");
    }
}
