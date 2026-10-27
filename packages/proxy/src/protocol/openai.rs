//! OpenAI ↔ Anthropic protocol adapter.
//!
//! Handles native Rust translation of incoming OpenAI chat completion and
//! responses API payloads to canonical Anthropic formats and back.
//! Includes support for multimodal content translation, structured outputs,
//! tool use mapping, streamingSSE, and thinking block stripping.

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

        // 2. Extract messages. A Responses body is a different shape — its
        // system prompt in `instructions`, `input` a string or a list of typed
        // items — and is read by `responses_input_to_anthropic`.
        let empty_vec = vec![];
        let raw_messages = if is_responses_api {
            &empty_vec
        } else {
            openai_req
                .get("messages")
                .and_then(|v| v.as_array())
                .unwrap_or(&empty_vec)
        };

        let (mut system_prompts, mut anthropic_messages) = if is_responses_api {
            responses_input_to_anthropic(openai_req)
        } else {
            (Vec::new(), Vec::new())
        };

        for msg in raw_messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");

            if role == "system" {
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

            // A tool-role message's `content` IS the tool result, and the branch
            // below turns it into a `tool_result` block. Letting the generic
            // handler run for it too emitted the same payload twice — once as a
            // leading `text` block, then again as the result.
            //
            // Anthropic rejects that outright: the message after a `tool_use`
            // must lead with its `tool_result`, so a text block in front breaks
            // the pairing and the whole request 400s with "tool_use ids were
            // found without tool_result blocks immediately after". Every
            // OpenAI-shaped agent doing multi-turn tool use against a Claude
            // model hit this — LangGraph, LangChain, the OpenAI SDK, Cursor —
            // because the failure needs a *second* turn to appear and a
            // single-turn smoke test looks fine.
            let is_tool_output = role == "tool";

            // Handle content mapping
            if let Some(content) = msg.get("content").filter(|_| !is_tool_output) {
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

            // Tool execution output (role = tool)
            if is_tool_output {
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

        // 3. Translate tools / functions. Chat Completions nests a function
        // tool's fields under `function`; Responses puts them on the tool
        // itself (`{"type":"function","name",...}`).
        let mut anthropic_tools = Vec::new();
        if let Some(tools) = openai_req.get("tools").and_then(|v| v.as_array()) {
            for t in tools {
                if t.get("type").and_then(|v| v.as_str()) == Some("function") {
                    if let Some(func) = t.get("function").or(is_responses_api.then_some(t)) {
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
            .or_else(|| openai_req.get("max_output_tokens"))
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
        if is_responses_api {
            return anthropic_response_to_responses(anthropic_resp, requested_model);
        }
        let mut openai_resp = json!({});

        // Set ID and Object type
        let id = anthropic_resp
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("chatcmpl-unknown");
        openai_resp["id"] = json!(id);

        openai_resp["object"] = json!("chat.completion");
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

    /// Translate a streaming SSE delta event from Anthropic format to OpenAI
    /// **chat completions** format.
    ///
    /// # `_is_responses_api` is accepted and ignored, and that is a known gap
    ///
    /// The parameter is underscore-prefixed on purpose so nobody reads this as
    /// handling the Responses API. It does not. Every arm below emits
    /// `choices[].delta`, which is chat completions, so a Codex CLI client on
    /// `/v1/responses` whose request was routed **cross-provider** receives
    /// chunks it cannot parse. That is pre-existing and larger than a
    /// parameter: closing it means a Responses counterpart for every event this
    /// function translates, plus item/content indices that Anthropic's wire
    /// format does not carry, which is a translation layer rather than a branch.
    ///
    /// It is deliberately **not** guessed at here. The same-provider Responses
    /// path — the one Codex CLI actually takes when it is routed to an OpenAI
    /// model, and the overwhelmingly common case — is handled properly in
    /// `proxy.rs` via `DeltaShape::ResponsesOutputText`, and
    /// `commands::responses_message_events` is the shape any future
    /// cross-provider translation should be built out of.
    ///
    /// Callers that must synthesise a Responses event should therefore not go
    /// through here: see `proxy::holdback_flush_bytes`, whose cross-provider
    /// branch has the same limitation for the same reason.
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

/// A Responses request's `instructions` and `input` as Anthropic `system`
/// prompts and `messages`.
///
/// `input` is a string (one user message) or a list of items, each with a
/// `type`: `message` (the default when absent: a role and content parts
/// `input_text` / `output_text` / `input_image`), `function_call` (the
/// model's tool call, an assistant `tool_use` block) and
/// `function_call_output` (its result, a user `tool_result` block), both
/// keyed by `call_id`. Items with no Messages equivalent — `reasoning`, which
/// is dropped like Anthropic thinking blocks, and built-in tool calls — are
/// skipped.
///
/// Consecutive items of one role become one message, so the assistant's
/// `function_call`s for a turn are one message of `tool_use` blocks and their
/// outputs the next one, which Anthropic requires: a `tool_use` must be
/// answered by a `tool_result` in the message right after it.
fn responses_input_to_anthropic(req: &Value) -> (Vec<String>, Vec<Value>) {
    let mut system = Vec::new();
    if let Some(instructions) = req
        .get("instructions")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        system.push(instructions.to_string());
    }

    let mut turns: Vec<(&'static str, Vec<Value>)> = Vec::new();
    let mut push = |role: &'static str, blocks: Vec<Value>| {
        if blocks.is_empty() {
            return;
        }
        match turns.last_mut() {
            Some((last, content)) if *last == role => content.extend(blocks),
            _ => turns.push((role, blocks)),
        }
    };

    match req.get("input") {
        Some(Value::String(text)) if !text.is_empty() => {
            push("user", vec![json!({"type": "text", "text": text})]);
        }
        Some(Value::Array(items)) => {
            for item in items {
                match item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("message")
                {
                    "message" => {
                        let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        let blocks = responses_content_blocks(item.get("content"));
                        if role == "system" || role == "developer" {
                            system.extend(
                                blocks
                                    .iter()
                                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                    .map(str::to_string),
                            );
                        } else if role == "assistant" {
                            push("assistant", blocks);
                        } else {
                            push("user", blocks);
                        }
                    }
                    "function_call" => {
                        let id = item.get("call_id").or_else(|| item.get("id"));
                        let name = item.get("name").and_then(|v| v.as_str());
                        if let (Some(id), Some(name)) = (id.and_then(|v| v.as_str()), name) {
                            let input: Value = item
                                .get("arguments")
                                .and_then(|a| a.as_str())
                                .and_then(|a| serde_json::from_str(a).ok())
                                .unwrap_or_else(|| json!({}));
                            push(
                                "assistant",
                                vec![json!({
                                    "type": "tool_use",
                                    "id": id,
                                    "name": name,
                                    "input": input
                                })],
                            );
                        }
                    }
                    "function_call_output" => {
                        let id = item
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let content = match item.get("output") {
                            Some(Value::String(s)) => json!(s),
                            Some(parts @ Value::Array(_)) => {
                                json!(responses_content_blocks(Some(parts)))
                            }
                            Some(other) => json!(other.to_string()),
                            None => json!(""),
                        };
                        push(
                            "user",
                            vec![json!({
                                "type": "tool_result",
                                "tool_use_id": id,
                                "content": content
                            })],
                        );
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    let messages = turns
        .into_iter()
        .map(|(role, blocks)| {
            let content = if blocks.len() == 1 && blocks[0]["type"] == "text" {
                blocks[0]["text"].clone()
            } else {
                json!(blocks)
            };
            json!({"role": role, "content": content})
        })
        .collect();
    (system, messages)
}

/// A Responses message's `content` (a string or a list of parts) as
/// Anthropic content blocks: `input_text` / `output_text` (and `text`) as
/// text, `input_image` as an image from its data or https URL. Other parts
/// (files, refusals, uploaded-file ids) have no block here and are skipped.
fn responses_content_blocks(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(text)) if !text.is_empty() => {
            vec![json!({"type": "text", "text": text})]
        }
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(|v| v.as_str())? {
                "input_text" | "output_text" | "text" => {
                    let text = part.get("text").and_then(|v| v.as_str())?;
                    (!text.is_empty()).then(|| json!({"type": "text", "text": text}))
                }
                "input_image" => {
                    let url = part.get("image_url").and_then(|v| v.as_str())?;
                    image_block(url)
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// An Anthropic image block for an image URL: a `data:` URL as base64, an
/// http(s) URL as a URL source.
fn image_block(url: &str) -> Option<Value> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let media_type = meta.split(';').next().filter(|m| !m.is_empty());
        return Some(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type.unwrap_or("image/jpeg"),
                "data": data
            }
        }));
    }
    (url.starts_with("https://") || url.starts_with("http://"))
        .then(|| json!({"type": "image", "source": {"type": "url", "url": url}}))
}

/// An Anthropic Messages response as a Responses API response: each text
/// block an assistant `message` item with an `output_text` part, each
/// `tool_use` block a `function_call` item whose `call_id` is the block's id
/// (what the client's `function_call_output` answers). `max_tokens` is
/// `status: "incomplete"`. As for Chat Completions, a single forced
/// structured-output tool call is returned as text.
fn anthropic_response_to_responses(anthropic_resp: &Value, requested_model: &str) -> Value {
    let id = anthropic_resp
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("resp_unknown");
    let empty = vec![];
    let blocks = anthropic_resp
        .get("content")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let message = |n: usize, text: &str| {
        json!({
            "type": "message",
            "id": format!("{id}_{n}"),
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}]
        })
    };
    let mut output = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    output.push(message(output.len(), text));
                }
            }
            Some("tool_use") => {
                if let (Some(call_id), Some(name)) = (
                    block.get("id").and_then(|v| v.as_str()),
                    block.get("name").and_then(|v| v.as_str()),
                ) {
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    output.push(json!({
                        "type": "function_call",
                        "id": format!("fc_{call_id}"),
                        "call_id": call_id,
                        "name": name,
                        "arguments": serde_json::to_string(&input).unwrap_or_default(),
                        "status": "completed"
                    }));
                }
            }
            // thinking and redacted_thinking blocks are stripped, as for Chat.
            _ => {}
        }
    }
    if let [only] = output.as_slice() {
        if only["type"] == "function_call"
            && (only["name"] == "json_output" || only["name"] == "json_schema")
        {
            let text = only["arguments"].as_str().unwrap_or("").to_string();
            output = vec![message(0, &text)];
        }
    }

    let usage = anthropic_resp.get("usage");
    let tokens = |k: &str| {
        usage
            .and_then(|u| u.get(k))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let cached = tokens("cache_read_input_tokens");
    let input = tokens("input_tokens") + cached + tokens("cache_creation_input_tokens");
    let output_tokens = tokens("output_tokens");

    let mut resp = json!({
        "id": id,
        "object": "response",
        "created_at": chrono::Utc::now().timestamp(),
        "model": requested_model,
        "status": "completed",
        "output": output,
        "usage": {
            "input_tokens": input,
            "input_tokens_details": {"cached_tokens": cached},
            "output_tokens": output_tokens,
            "total_tokens": input + output_tokens
        }
    });
    if anthropic_resp.get("stop_reason").and_then(|v| v.as_str()) == Some("max_tokens") {
        resp["status"] = json!("incomplete");
        resp["incomplete_details"] = json!({"reason": "max_output_tokens"});
    }
    resp
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

#[cfg(test)]
mod tool_result_pairing_tests {
    use super::*;
    use serde_json::json;

    /// A tool result must be the ONLY block in the message after a tool_use.
    ///
    /// The generic content handler used to emit a `text` block for every
    /// message, tool-role ones included — so a tool result arrived as
    /// `[text, tool_result]` with the payload duplicated and the result no
    /// longer leading. Anthropic rejects that with "tool_use ids were found
    /// without tool_result blocks immediately after", and the whole request
    /// 400s.
    ///
    /// It needed a *second* turn to show up: a one-shot call with tools works
    /// fine, and only a real agent loop — LangGraph, the OpenAI SDK, Cursor —
    /// ever sends a tool result back. That is why this shipped.
    #[test]
    fn a_tool_result_is_the_only_block_in_its_message() {
        let req = json!({
            "model": "claude-haiku-4-5",
            "messages": [
                {"role": "user", "content": "read it"},
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": {"name": "read", "arguments": "{\"path\":\"a.py\"}"}
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "42 lines"}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, false);
        let msgs = out["messages"].as_array().expect("messages");

        let blocks = msgs[2]["content"]
            .as_array()
            .expect("tool result is a block list");
        assert_eq!(
            blocks.len(),
            1,
            "the tool result message must carry exactly one block, got {blocks:?}"
        );
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[0]["tool_use_id"], "call_1");
        assert_eq!(blocks[0]["content"], "42 lines");
    }

    /// And the pairing itself: tool_use in one message, its result immediately
    /// next, with matching ids.
    #[test]
    fn every_tool_use_is_followed_immediately_by_its_result() {
        let req = json!({
            "model": "claude-haiku-4-5",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_a", "type": "function",
                    "function": {"name": "bash", "arguments": "{\"command\":\"npm test\"}"}
                }]},
                {"role": "tool", "tool_call_id": "call_a", "content": "PASS"}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, false);
        let msgs = out["messages"].as_array().unwrap();

        let uses = msgs[0]["content"].as_array().unwrap();
        assert_eq!(uses[0]["type"], "tool_use");
        assert_eq!(uses[0]["id"], "call_a");

        let results = msgs[1]["content"].as_array().unwrap();
        assert_eq!(
            msgs[1]["role"], "user",
            "a tool result is a user-role message"
        );
        assert_eq!(results[0]["type"], "tool_result");
        assert_eq!(results[0]["tool_use_id"], "call_a");
    }

    /// An ordinary text message is untouched — the guard must not swallow
    /// content from every other role while fixing this one.
    #[test]
    fn ordinary_messages_keep_their_text() {
        let req = json!({
            "model": "claude-haiku-4-5",
            "messages": [{"role": "user", "content": "hello"}]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, false);
        assert_eq!(out["messages"][0]["content"], "hello");
    }

    /// The Responses-API spelling of the same thing: `function_call_output` is
    /// the item's `type`, and it answers by `call_id`.
    #[test]
    fn a_function_call_output_is_also_a_lone_tool_result() {
        let req = json!({
            "model": "claude-haiku-4-5",
            "input": [
                {"type": "function_call", "call_id": "fc_1", "name": "read", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "fc_1", "output": "done"}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, true);
        let blocks = out["messages"][1]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[0]["tool_use_id"], "fc_1");
        assert_eq!(blocks[0]["content"], "done");
    }
}

#[cfg(test)]
mod responses_translation_tests {
    use super::*;
    use serde_json::json;

    /// A Codex CLI turn after one tool call: the system prompt in
    /// `instructions`, typed `input` items with `input_text` / `output_text`
    /// parts, a `reasoning` item, a `function_call` and its
    /// `function_call_output`, and flat function tools.
    fn codex_request() -> Value {
        json!({
            "model": "claude-sonnet-4-5",
            "instructions": "You are Codex, a coding agent running in the Codex CLI.",
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>"}
                ]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "Run the tests and tell me what fails."}
                ]},
                {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAAAB"},
                {"type": "message", "role": "assistant", "id": "msg_1", "content": [
                    {"type": "output_text", "text": "I'll run the test suite.", "annotations": []}
                ]},
                {"type": "function_call", "id": "fc_1", "call_id": "call_abc", "name": "shell",
                 "arguments": "{\"command\":[\"bash\",\"-lc\",\"npm test\"],\"workdir\":\"/work/app\"}"},
                {"type": "function_call_output", "call_id": "call_abc",
                 "output": "{\"output\":\"1 failing: auth.spec.ts\",\"metadata\":{\"exit_code\":1}}"}
            ],
            "tools": [{
                "type": "function",
                "name": "shell",
                "description": "Runs a shell command and returns its output.",
                "strict": false,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "array", "items": {"type": "string"}},
                        "workdir": {"type": "string"}
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }],
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "reasoning": {"effort": "medium", "summary": "auto"},
            "store": false,
            "stream": true,
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": "0199c0de-0000-7000-8000-000000000000"
        })
    }

    #[test]
    fn a_codex_turn_translates_whole() {
        let out = OpenAIAdapter::translate_request_to_anthropic(&codex_request(), true);

        assert_eq!(
            out["system"],
            "You are Codex, a coding agent running in the Codex CLI."
        );
        assert_eq!(
            out["messages"],
            json!([
                {"role": "user", "content": [
                    {"type": "text", "text": "<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>"},
                    {"type": "text", "text": "Run the tests and tell me what fails."}
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "I'll run the test suite."},
                    {"type": "tool_use", "id": "call_abc", "name": "shell",
                     "input": {"command": ["bash", "-lc", "npm test"], "workdir": "/work/app"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_abc",
                     "content": "{\"output\":\"1 failing: auth.spec.ts\",\"metadata\":{\"exit_code\":1}}"}
                ]}
            ])
        );
        assert_eq!(
            out["tools"],
            json!([{
                "name": "shell",
                "description": "Runs a shell command and returns its output.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "array", "items": {"type": "string"}},
                        "workdir": {"type": "string"}
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }])
        );
        assert_eq!(out["stream"], true);
        assert_eq!(out["max_tokens"], 4096);
        // Responses-only fields have no Messages counterpart and are not sent.
        for key in [
            "input",
            "instructions",
            "reasoning",
            "store",
            "include",
            "tool_choice",
        ] {
            assert!(out.get(key).is_none(), "{key} leaked into {out}");
        }
    }

    #[test]
    fn a_string_input_is_one_user_message() {
        let req = json!({"model": "claude-sonnet-4-5", "input": "hello", "max_output_tokens": 256});
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, true);
        assert_eq!(
            out["messages"],
            json!([{"role": "user", "content": "hello"}])
        );
        assert_eq!(out["max_tokens"], 256);
        assert!(out.get("system").is_none());
    }

    #[test]
    fn developer_and_system_messages_join_the_instructions() {
        let req = json!({
            "model": "claude-sonnet-4-5",
            "instructions": "Be brief.",
            "input": [
                {"role": "developer", "content": [{"type": "input_text", "text": "Use metric units."}]},
                {"role": "system", "content": "Never guess."},
                {"role": "user", "content": "How far is it?"}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, true);
        assert_eq!(out["system"], "Be brief.\nUse metric units.\nNever guess.");
        assert_eq!(
            out["messages"],
            json!([{"role": "user", "content": "How far is it?"}])
        );
    }

    #[test]
    fn parallel_calls_and_their_outputs_pair_up() {
        let req = json!({
            "model": "claude-sonnet-4-5",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "read both"}]},
                {"type": "function_call", "call_id": "call_a", "name": "read", "arguments": "{\"path\":\"a\"}"},
                {"type": "function_call", "call_id": "call_b", "name": "read", "arguments": "{\"path\":\"b\"}"},
                {"type": "function_call_output", "call_id": "call_a", "output": "A"},
                {"type": "function_call_output", "call_id": "call_b",
                 "output": [{"type": "input_text", "text": "B"}]}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, true);
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "{msgs:?}");
        let uses: Vec<_> = msgs[1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| (b["type"].clone(), b["id"].clone()))
            .collect();
        assert_eq!(
            uses,
            vec![
                (json!("tool_use"), json!("call_a")),
                (json!("tool_use"), json!("call_b"))
            ]
        );
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(
            msgs[2]["content"],
            json!([
                {"type": "tool_result", "tool_use_id": "call_a", "content": "A"},
                {"type": "tool_result", "tool_use_id": "call_b",
                 "content": [{"type": "text", "text": "B"}]}
            ])
        );
    }

    #[test]
    fn input_images_become_image_blocks() {
        let req = json!({
            "model": "claude-sonnet-4-5",
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "what is this?"},
                {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="},
                {"type": "input_image", "image_url": "https://example.com/cat.jpg"}
            ]}]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, true);
        assert_eq!(
            out["messages"][0]["content"],
            json!([
                {"type": "text", "text": "what is this?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
                {"type": "image", "source": {"type": "url", "url": "https://example.com/cat.jpg"}}
            ])
        );
    }

    /// Chat Completions keeps its nested tool shape, and a flat tool there is
    /// not read as one.
    #[test]
    fn chat_tools_stay_nested() {
        let req = json!({
            "model": "claude-sonnet-4-5",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [
                {"type": "function", "function": {"name": "nested", "parameters": {"type": "object"}}},
                {"type": "function", "name": "flat", "parameters": {"type": "object"}}
            ]
        });
        let out = OpenAIAdapter::translate_request_to_anthropic(&req, false);
        let names: Vec<_> = out["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].clone())
            .collect();
        assert_eq!(names, vec![json!("nested")]);
    }

    #[test]
    fn a_messages_answer_is_a_responses_body() {
        let anthropic = json!({
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-4-5",
            "content": [
                {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                {"type": "text", "text": "The auth spec fails; checking it."},
                {"type": "tool_use", "id": "toolu_01", "name": "shell",
                 "input": {"command": ["bash", "-lc", "cat auth.spec.ts"]}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 100, "cache_read_input_tokens": 900, "output_tokens": 40}
        });
        let out =
            OpenAIAdapter::translate_response_to_openai(&anthropic, "claude-sonnet-4-5", true);
        assert_eq!(out["object"], "response");
        assert_eq!(out["status"], "completed");
        assert_eq!(out["model"], "claude-sonnet-4-5");
        assert!(out.get("choices").is_none(), "{out}");
        assert_eq!(
            out["output"],
            json!([
                {"type": "message", "id": "msg_01_0", "status": "completed", "role": "assistant",
                 "content": [{"type": "output_text", "text": "The auth spec fails; checking it.", "annotations": []}]},
                {"type": "function_call", "id": "fc_toolu_01", "call_id": "toolu_01", "name": "shell",
                 "arguments": "{\"command\":[\"bash\",\"-lc\",\"cat auth.spec.ts\"]}", "status": "completed"}
            ])
        );
        assert_eq!(
            out["usage"],
            json!({"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 900},
                   "output_tokens": 40, "total_tokens": 1040})
        );

        // The call the client runs comes back next turn by its `call_id`, and
        // pairs with the `tool_use` it was.
        let next = json!({
            "model": "claude-sonnet-4-5",
            "input": [
                out["output"][0].clone(),
                out["output"][1].clone(),
                {"type": "function_call_output", "call_id": "toolu_01", "output": "it('logs in')"}
            ]
        });
        let req = OpenAIAdapter::translate_request_to_anthropic(&next, true);
        assert_eq!(req["messages"][0]["content"][1]["id"], "toolu_01");
        assert_eq!(req["messages"][1]["content"][0]["tool_use_id"], "toolu_01");
    }

    #[test]
    fn a_max_tokens_stop_is_incomplete() {
        let anthropic = json!({
            "id": "msg_02",
            "content": [{"type": "text", "text": "partial"}],
            "stop_reason": "max_tokens",
            "usage": {"input_tokens": 5, "output_tokens": 16}
        });
        let out =
            OpenAIAdapter::translate_response_to_openai(&anthropic, "claude-sonnet-4-5", true);
        assert_eq!(out["status"], "incomplete");
        assert_eq!(out["incomplete_details"]["reason"], "max_output_tokens");
        assert_eq!(out["output"][0]["content"][0]["text"], "partial");
    }

    /// Chat Completions answers are unchanged.
    #[test]
    fn a_chat_answer_keeps_its_choices() {
        let anthropic = json!({
            "id": "msg_03",
            "content": [{"type": "text", "text": "hi"}],
            "usage": {"input_tokens": 1, "output_tokens": 1}
        });
        let out =
            OpenAIAdapter::translate_response_to_openai(&anthropic, "claude-sonnet-4-5", false);
        assert_eq!(out["object"], "chat.completion");
        assert_eq!(out["choices"][0]["message"]["content"], "hi");
    }
}
