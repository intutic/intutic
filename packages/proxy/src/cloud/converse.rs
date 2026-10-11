//! Anthropic Messages ⇄ Bedrock Converse.
//!
//! Converse is Bedrock's one API for every model it hosts, and its content
//! model is close to Anthropic's: typed blocks, `toolUse` / `toolResult` with
//! ids, a separate `system`, cache points. The mapping:
//!
//! | Anthropic | Converse |
//! |---|---|
//! | `system` (string or text blocks) | `system: [{text}]` |
//! | `text` | `{text}` |
//! | `image` (base64) | `{image: {format, source: {bytes}}}` |
//! | `document` (base64 PDF) | `{document: {format: "pdf", name, source: {bytes}}}` |
//! | `tool_use` | `{toolUse: {toolUseId, name, input}}` |
//! | `tool_result` | `{toolResult: {toolUseId, content, status}}` |
//! | `thinking` / `redacted_thinking` | `{reasoningContent: {reasoningText \| redactedContent}}` |
//! | `cache_control` on a block | a `{cachePoint: {type: "default"}}` after it |
//! | `max_tokens`, `temperature`, `top_p`, `stop_sequences` | `inferenceConfig` |
//! | `tools`, `tool_choice` | `toolConfig` |
//!
//! Converse has no URL image source and no `top_k`; a URL image is refused
//! (400) rather than silently dropped, `top_k` goes to
//! `additionalModelRequestFields` where models that take it read it.
//! `tool_choice: none` keeps the tools (Converse requires `toolConfig`
//! whenever the history holds tool blocks) and leaves the choice to the model.
//!
//! Usage: Converse's `inputTokens` already excludes cache reads and writes
//! (Bedrock prompt-caching guide), the same convention as Anthropic's
//! `input_tokens`, so the buckets map one to one.
//!
//! Source: <https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html>,
//! `ConverseStream`, `ContentBlock`, `ToolResultBlock`, `ToolSpecification`,
//! `ToolChoice`.

use serde_json::{json, Map, Value};

use super::sse::event;

/// Translate an Anthropic Messages body into a Converse body. `Err` is a
/// client-facing reason for a request Converse cannot express.
pub fn request(body: &Value) -> Result<Value, String> {
    let mut out = Map::new();

    let mut system = Vec::new();
    match body.get("system") {
        Some(Value::String(s)) if !s.is_empty() => system.push(json!({"text": s})),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    system.push(json!({"text": t}));
                    push_cache_point(&mut system, b);
                }
            }
        }
        _ => {}
    }
    if !system.is_empty() {
        out.insert("system".into(), Value::Array(system));
    }

    // Converse wants strictly alternating roles; Anthropic merges consecutive
    // same-role turns itself, so merging here sends what Anthropic would see.
    let mut messages: Vec<Value> = Vec::new();
    for m in body
        .get("messages")
        .and_then(|m| m.as_array())
        .ok_or("messages is required")?
    {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = content_blocks(m.get("content"))?;
        if content.is_empty() {
            continue;
        }
        match messages.last_mut() {
            Some(last) if last["role"] == role => {
                if let Some(arr) = last["content"].as_array_mut() {
                    arr.extend(content);
                }
            }
            _ => messages.push(json!({"role": role, "content": content})),
        }
    }
    out.insert("messages".into(), Value::Array(messages));

    let mut inference = Map::new();
    for (from, to) in [
        ("max_tokens", "maxTokens"),
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("stop_sequences", "stopSequences"),
    ] {
        if let Some(v) = body.get(from).filter(|v| !v.is_null()) {
            inference.insert(to.into(), v.clone());
        }
    }
    if !inference.is_empty() {
        out.insert("inferenceConfig".into(), Value::Object(inference));
    }
    if let Some(k) = body.get("top_k").filter(|v| !v.is_null()) {
        out.insert("additionalModelRequestFields".into(), json!({"top_k": k}));
    }

    if let Some(tools) = body
        .get("tools")
        .and_then(|t| t.as_array())
        .filter(|t| !t.is_empty())
    {
        let mut specs = Vec::new();
        for t in tools {
            let name = t
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or("every tool needs a name")?;
            let Some(schema) = t.get("input_schema") else {
                return Err(format!(
                    "tool '{name}' is a server tool; Bedrock Converse takes client tools with an input_schema only"
                ));
            };
            let mut spec = json!({"name": name, "inputSchema": {"json": schema}});
            if let Some(d) = t.get("description").and_then(|d| d.as_str()) {
                spec["description"] = json!(d);
            }
            specs.push(json!({"toolSpec": spec}));
            push_cache_point(&mut specs, t);
        }
        let mut config = json!({"tools": specs});
        match body
            .get("tool_choice")
            .and_then(|c| c.get("type"))
            .and_then(|t| t.as_str())
        {
            Some("any") => config["toolChoice"] = json!({"any": {}}),
            Some("tool") => {
                let name = body["tool_choice"]
                    .get("name")
                    .and_then(|n| n.as_str())
                    .ok_or("tool_choice of type tool needs a name")?;
                config["toolChoice"] = json!({"tool": {"name": name}});
            }
            Some("auto") => config["toolChoice"] = json!({"auto": {}}),
            _ => {}
        }
        out.insert("toolConfig".into(), config);
    }
    Ok(Value::Object(out))
}

fn push_cache_point(list: &mut Vec<Value>, source: &Value) {
    if source.get("cache_control").is_some_and(|c| !c.is_null()) {
        list.push(json!({"cachePoint": {"type": "default"}}));
    }
}

fn content_blocks(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    match content {
        Some(Value::String(s)) if !s.is_empty() => out.push(json!({"text": s})),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if let Some(mapped) = content_block(b)? {
                    out.push(mapped);
                    push_cache_point(&mut out, b);
                }
            }
        }
        _ => {}
    }
    Ok(out)
}

fn content_block(b: &Value) -> Result<Option<Value>, String> {
    let s = |k: &str| b.get(k).and_then(|v| v.as_str()).unwrap_or("");
    Ok(Some(match s("type") {
        "text" => {
            if s("text").is_empty() {
                return Ok(None);
            }
            json!({"text": s("text")})
        }
        "image" => json!({"image": media(b, "image")?}),
        "document" => {
            let mut d = media(b, "document")?;
            d["name"] = json!(b
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("document"));
            json!({"document": d})
        }
        "tool_use" => json!({"toolUse": {
            "toolUseId": s("id"),
            "name": s("name"),
            "input": b.get("input").cloned().unwrap_or_else(|| json!({})),
        }}),
        "tool_result" => {
            let content = match b.get("content") {
                Some(Value::String(t)) => vec![json!({"text": t})],
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|p| match p.get("type").and_then(|t| t.as_str()) {
                        Some("text") => Some(Ok(
                            json!({"text": p.get("text").cloned().unwrap_or(json!(""))}),
                        )),
                        Some("image") => Some(media(p, "image").map(|m| json!({"image": m}))),
                        _ => None,
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => Vec::new(),
            };
            let content = if content.is_empty() {
                vec![json!({"text": ""})]
            } else {
                content
            };
            let mut r = json!({"toolUseId": s("tool_use_id"), "content": content});
            if b.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                r["status"] = json!("error");
            }
            json!({"toolResult": r})
        }
        "thinking" => {
            let mut text = json!({"text": s("thinking")});
            if !s("signature").is_empty() {
                text["signature"] = json!(s("signature"));
            }
            json!({"reasoningContent": {"reasoningText": text}})
        }
        "redacted_thinking" => json!({"reasoningContent": {"redactedContent": s("data")}}),
        // Anthropic-only server-side blocks have no Converse counterpart.
        _ => return Ok(None),
    }))
}

/// `{format, source: {bytes}}` from an Anthropic base64 source.
fn media(b: &Value, kind: &str) -> Result<Value, String> {
    let src = b
        .get("source")
        .ok_or_else(|| format!("{kind} block has no source"))?;
    if src.get("type").and_then(|t| t.as_str()) != Some("base64") {
        return Err(format!(
            "Bedrock Converse takes {kind}s as base64 data; URL and file sources are not supported"
        ));
    }
    let media_type = src.get("media_type").and_then(|m| m.as_str()).unwrap_or("");
    let format = media_type.rsplit('/').next().unwrap_or("");
    let format = if format == "jpg" { "jpeg" } else { format };
    Ok(
        json!({"format": format, "source": {"bytes": src.get("data").cloned().unwrap_or(json!(""))}}),
    )
}

fn stop_reason(r: &str) -> &str {
    match r {
        "guardrail_intervened" | "content_filtered" => "refusal",
        // end_turn, tool_use, max_tokens, stop_sequence and
        // model_context_window_exceeded are Anthropic's names too.
        other => other,
    }
}

fn usage(u: Option<&Value>) -> Value {
    let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|v| v.as_u64());
    let mut out = json!({
        "input_tokens": n("inputTokens").unwrap_or(0),
        "output_tokens": n("outputTokens").unwrap_or(0),
    });
    if let Some(r) = n("cacheReadInputTokens") {
        out["cache_read_input_tokens"] = json!(r);
    }
    if let Some(w) = n("cacheWriteInputTokens") {
        out["cache_creation_input_tokens"] = json!(w);
    }
    out
}

fn message_id() -> String {
    format!("msg_bdrk_{}", uuid::Uuid::new_v4().simple())
}

/// A Converse response as an Anthropic Messages response.
pub fn response(v: &Value, model: &str) -> Value {
    let mut content = Vec::new();
    for b in v
        .pointer("/output/message/content")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
            content.push(json!({"type": "text", "text": t}));
        } else if let Some(tu) = b.get("toolUse") {
            content.push(json!({
                "type": "tool_use",
                "id": tu.get("toolUseId").cloned().unwrap_or(json!("")),
                "name": tu.get("name").cloned().unwrap_or(json!("")),
                "input": tu.get("input").cloned().unwrap_or(json!({})),
            }));
        } else if let Some(rc) = b.get("reasoningContent") {
            if let Some(rt) = rc.get("reasoningText") {
                content.push(json!({
                    "type": "thinking",
                    "thinking": rt.get("text").cloned().unwrap_or(json!("")),
                    "signature": rt.get("signature").cloned().unwrap_or(json!("")),
                }));
            } else if let Some(r) = rc.get("redactedContent") {
                content.push(json!({"type": "redacted_thinking", "data": r}));
            }
        }
    }
    json!({
        "id": message_id(),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason(v.get("stopReason").and_then(|s| s.as_str()).unwrap_or("end_turn")),
        "stop_sequence": null,
        "usage": usage(v.get("usage")),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Text,
    Thinking,
    ToolUse,
}

/// ConverseStream events → Anthropic SSE events.
///
/// Converse reports the stop reason (`messageStop`) and the usage
/// (`metadata`) as two events, in that order; Anthropic carries both on one
/// `message_delta`. The stop reason is held until `metadata` arrives — or the
/// stream ends without one — and then `message_delta` + `message_stop` close
/// the message.
pub struct StreamTranslator {
    model: String,
    started: bool,
    open: std::collections::BTreeMap<u64, Block>,
    stop_reason: Option<String>,
    closed: bool,
}

impl StreamTranslator {
    pub fn new(model: &str) -> Self {
        StreamTranslator {
            model: model.to_string(),
            started: false,
            open: Default::default(),
            stop_reason: None,
            closed: false,
        }
    }

    fn ensure_started(&mut self, out: &mut String) {
        if !self.started {
            self.started = true;
            out.push_str(&event(
                "message_start",
                &json!({"type": "message_start", "message": {
                    "id": message_id(), "type": "message", "role": "assistant",
                    "model": self.model, "content": [], "stop_reason": null,
                    "stop_sequence": null,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                }}),
            ));
        }
    }

    fn open_block(&mut self, index: u64, kind: Block, start: Value, out: &mut String) {
        if self.open.contains_key(&index) {
            return;
        }
        self.open.insert(index, kind);
        out.push_str(&event(
            "content_block_start",
            &json!({"type": "content_block_start", "index": index, "content_block": start}),
        ));
    }

    fn delta(index: u64, delta: Value) -> String {
        event(
            "content_block_delta",
            &json!({"type": "content_block_delta", "index": index, "delta": delta}),
        )
    }

    /// One decoded ConverseStream event.
    pub fn on_event(&mut self, kind: &str, p: &Value) -> String {
        let mut out = String::new();
        if self.closed {
            return out;
        }
        let index = p
            .get("contentBlockIndex")
            .and_then(|i| i.as_u64())
            .unwrap_or(0);
        match kind {
            "messageStart" => self.ensure_started(&mut out),
            "contentBlockStart" => {
                self.ensure_started(&mut out);
                if let Some(tu) = p.pointer("/start/toolUse") {
                    let start = json!({
                        "type": "tool_use",
                        "id": tu.get("toolUseId").cloned().unwrap_or(json!("")),
                        "name": tu.get("name").cloned().unwrap_or(json!("")),
                        "input": {},
                    });
                    self.open_block(index, Block::ToolUse, start, &mut out);
                }
            }
            "contentBlockDelta" => {
                self.ensure_started(&mut out);
                let d = p.get("delta").cloned().unwrap_or(Value::Null);
                if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                    self.open_block(
                        index,
                        Block::Text,
                        json!({"type": "text", "text": ""}),
                        &mut out,
                    );
                    out.push_str(&Self::delta(
                        index,
                        json!({"type": "text_delta", "text": t}),
                    ));
                } else if let Some(input) = d.pointer("/toolUse/input").and_then(|i| i.as_str()) {
                    self.open_block(
                        index,
                        Block::ToolUse,
                        json!({"type": "tool_use", "id": "", "name": "", "input": {}}),
                        &mut out,
                    );
                    out.push_str(&Self::delta(
                        index,
                        json!({"type": "input_json_delta", "partial_json": input}),
                    ));
                } else if let Some(rc) = d.get("reasoningContent") {
                    self.open_block(
                        index,
                        Block::Thinking,
                        json!({"type": "thinking", "thinking": "", "signature": ""}),
                        &mut out,
                    );
                    if let Some(t) = rc.get("text").and_then(|t| t.as_str()) {
                        out.push_str(&Self::delta(
                            index,
                            json!({"type": "thinking_delta", "thinking": t}),
                        ));
                    }
                    if let Some(sig) = rc.get("signature").and_then(|t| t.as_str()) {
                        out.push_str(&Self::delta(
                            index,
                            json!({"type": "signature_delta", "signature": sig}),
                        ));
                    }
                }
            }
            "contentBlockStop" if self.open.remove(&index).is_some() => {
                out.push_str(&event(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            }
            "messageStop" => {
                self.stop_reason = Some(
                    stop_reason(
                        p.get("stopReason")
                            .and_then(|s| s.as_str())
                            .unwrap_or("end_turn"),
                    )
                    .to_string(),
                );
            }
            "metadata" => {
                out.push_str(&self.close(Some(usage(p.get("usage")))));
            }
            _ => {}
        }
        out
    }

    /// Close the message: any block still open, then `message_delta` and
    /// `message_stop`.
    fn close(&mut self, usage: Option<Value>) -> String {
        let mut out = String::new();
        if self.closed {
            return out;
        }
        self.ensure_started(&mut out);
        for index in std::mem::take(&mut self.open).into_keys() {
            out.push_str(&event(
                "content_block_stop",
                &json!({"type": "content_block_stop", "index": index}),
            ));
        }
        let mut delta = json!({"type": "message_delta", "delta": {
            "stop_reason": self.stop_reason.clone().unwrap_or_else(|| "end_turn".into()),
            "stop_sequence": null,
        }});
        if let Some(u) = usage {
            delta["usage"] = u;
        }
        out.push_str(&event("message_delta", &delta));
        out.push_str(&event("message_stop", &json!({"type": "message_stop"})));
        self.closed = true;
        out
    }

    /// The upstream ended. A stream that delivered a stop reason but no
    /// usage is closed without usage; one that never stopped is left open,
    /// so the client sees a truncated message rather than a fabricated end.
    pub fn finish(&mut self) -> String {
        if self.stop_reason.is_some() {
            self.close(None)
        } else {
            String::new()
        }
    }

    pub fn closed(&self) -> bool {
        self.closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_conversation_translates_block_for_block() {
        let anthropic = json!({
            "model": "bedrock/meta.llama3-1-70b-instruct-v1:0",
            "max_tokens": 512,
            "temperature": 0.2,
            "stop_sequences": ["END"],
            "system": [{"type": "text", "text": "Be terse.", "cache_control": {"type": "ephemeral"}}],
            "tools": [{"name": "get_weather", "description": "Weather", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}}],
            "tool_choice": {"type": "auto"},
            "messages": [
                {"role": "user", "content": "Weather in Paris?"},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Checking."},
                    {"type": "tool_use", "id": "tooluse_1", "name": "get_weather", "input": {"city": "Paris"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "tooluse_1", "content": "18C", "is_error": false}
                ]},
                {"role": "user", "content": [{"type": "text", "text": "Thanks"}]}
            ]
        });
        let converse = request(&anthropic).unwrap();
        assert_eq!(
            converse,
            json!({
                "system": [{"text": "Be terse."}, {"cachePoint": {"type": "default"}}],
                "messages": [
                    {"role": "user", "content": [{"text": "Weather in Paris?"}]},
                    {"role": "assistant", "content": [
                        {"text": "Checking."},
                        {"toolUse": {"toolUseId": "tooluse_1", "name": "get_weather", "input": {"city": "Paris"}}}
                    ]},
                    {"role": "user", "content": [
                        {"toolResult": {"toolUseId": "tooluse_1", "content": [{"text": "18C"}]}},
                        {"text": "Thanks"}
                    ]}
                ],
                "inferenceConfig": {"maxTokens": 512, "temperature": 0.2, "stopSequences": ["END"]},
                "toolConfig": {
                    "tools": [{"toolSpec": {"name": "get_weather", "description": "Weather", "inputSchema": {"json": {"type": "object", "properties": {"city": {"type": "string"}}}}}}],
                    "toolChoice": {"auto": {}}
                }
            })
        );
    }

    #[test]
    fn images_errors_and_forced_tools() {
        let body = json!({
            "max_tokens": 10,
            "tools": [{"name": "t", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "tool", "name": "t"},
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}},
                {"type": "tool_result", "tool_use_id": "x", "is_error": true, "content": [{"type": "text", "text": "boom"}]}
            ]}]
        });
        let c = request(&body).unwrap();
        assert_eq!(
            c["messages"][0]["content"][0],
            json!({"image": {"format": "jpeg", "source": {"bytes": "AAAA"}}})
        );
        assert_eq!(
            c["messages"][0]["content"][1]["toolResult"]["status"],
            "error"
        );
        assert_eq!(
            c["toolConfig"]["toolChoice"],
            json!({"tool": {"name": "t"}})
        );

        let url_image = json!({"max_tokens": 1, "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}}
        ]}]});
        assert!(request(&url_image).unwrap_err().contains("base64"));
        let server_tool = json!({"max_tokens": 1, "tools": [{"type": "web_search_20250305", "name": "web_search"}], "messages": [{"role": "user", "content": "hi"}]});
        assert!(request(&server_tool).unwrap_err().contains("server tool"));
    }

    #[test]
    fn a_converse_response_becomes_an_anthropic_message() {
        let converse = json!({
            "output": {"message": {"role": "assistant", "content": [
                {"text": "Let me check."},
                {"toolUse": {"toolUseId": "tooluse_9", "name": "get_weather", "input": {"city": "Oslo"}}}
            ]}},
            "stopReason": "tool_use",
            "usage": {"inputTokens": 120, "outputTokens": 30, "totalTokens": 170, "cacheReadInputTokens": 20},
            "metrics": {"latencyMs": 400}
        });
        let m = response(&converse, "bedrock/meta.llama3-1-70b-instruct-v1:0");
        assert_eq!(m["type"], "message");
        assert_eq!(m["stop_reason"], "tool_use");
        assert_eq!(
            m["content"][1],
            json!({"type": "tool_use", "id": "tooluse_9", "name": "get_weather", "input": {"city": "Oslo"}})
        );
        assert_eq!(
            m["usage"],
            json!({"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 20})
        );
        let usage = crate::usage::TokenUsage::from_anthropic(&m);
        assert_eq!(usage.total_input(), 140);
        assert_eq!(usage.output, Some(30));
        assert!(m["id"].as_str().unwrap().starts_with("msg_bdrk_"));
        let filtered = response(
            &json!({"stopReason": "guardrail_intervened", "output": {"message": {"content": []}}}),
            "m",
        );
        assert_eq!(filtered["stop_reason"], "refusal");
    }

    fn events(sse: &str) -> Vec<(String, Value)> {
        sse.split("\n\n")
            .filter(|e| !e.is_empty())
            .map(|e| {
                let mut lines = e.lines();
                let name = lines
                    .next()
                    .unwrap()
                    .strip_prefix("event: ")
                    .unwrap()
                    .to_string();
                let data = lines.next().unwrap().strip_prefix("data: ").unwrap();
                (name, serde_json::from_str(data).unwrap())
            })
            .collect()
    }

    #[test]
    fn a_streamed_tool_call_becomes_anthropic_events_with_usage_on_message_delta() {
        let mut t = StreamTranslator::new("bedrock/amazon.nova-pro-v1:0");
        let mut sse = String::new();
        for (kind, payload) in [
            ("messageStart", json!({"role": "assistant"})),
            (
                "contentBlockDelta",
                json!({"contentBlockIndex": 0, "delta": {"text": "Sure"}}),
            ),
            ("contentBlockStop", json!({"contentBlockIndex": 0})),
            (
                "contentBlockStart",
                json!({"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "tu_1", "name": "lookup"}}}),
            ),
            (
                "contentBlockDelta",
                json!({"contentBlockIndex": 1, "delta": {"toolUse": {"input": "{\"q\":"}}}),
            ),
            (
                "contentBlockDelta",
                json!({"contentBlockIndex": 1, "delta": {"toolUse": {"input": "\"x\"}"}}}),
            ),
            ("contentBlockStop", json!({"contentBlockIndex": 1})),
            ("messageStop", json!({"stopReason": "tool_use"})),
            (
                "metadata",
                json!({"usage": {"inputTokens": 50, "outputTokens": 12, "totalTokens": 62}, "metrics": {"latencyMs": 10}}),
            ),
        ] {
            sse.push_str(&t.on_event(kind, &payload));
        }
        sse.push_str(&t.finish());
        let ev = events(&sse);
        let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(
            ev[2].1["delta"],
            json!({"type": "text_delta", "text": "Sure"})
        );
        assert_eq!(
            ev[4].1["content_block"],
            json!({"type": "tool_use", "id": "tu_1", "name": "lookup", "input": {}})
        );
        assert_eq!(ev[6].1["delta"]["partial_json"], "\"x\"}");
        assert_eq!(ev[8].1["delta"]["stop_reason"], "tool_use");
        assert_eq!(
            ev[8].1["usage"],
            json!({"input_tokens": 50, "output_tokens": 12})
        );
        // The proxy's own streamed-text and usage readers see this stream.
        assert!(
            crate::protocol::tool_use_parser::parse_sse_chunk(&format!("data: {}", ev[4].1))
                .is_some()
        );
        assert!(t.closed());
    }

    #[test]
    fn a_stream_that_never_stops_is_not_given_a_fabricated_end() {
        let mut t = StreamTranslator::new("m");
        let _ = t.on_event("messageStart", &json!({}));
        let _ = t.on_event(
            "contentBlockDelta",
            &json!({"contentBlockIndex": 0, "delta": {"text": "par"}}),
        );
        assert_eq!(t.finish(), "");
        let mut t = StreamTranslator::new("m");
        let _ = t.on_event("messageStop", &json!({"stopReason": "max_tokens"}));
        let tail = events(&t.finish());
        assert_eq!(tail.last().unwrap().0, "message_stop");
        assert_eq!(tail[tail.len() - 2].1["delta"]["stop_reason"], "max_tokens");
    }
}
