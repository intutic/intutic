//! Anthropic Messages ⇄ Gemini `generateContent` (Vertex AI).
//!
//! | Anthropic | Gemini |
//! |---|---|
//! | `system` | `systemInstruction.parts[].text` |
//! | role `assistant` | role `model` |
//! | `text` | `{text}` |
//! | `image` / `document` (base64) | `{inlineData: {mimeType, data}}` |
//! | `tool_use` | `{functionCall: {name, args}}` |
//! | `tool_result` | `{functionResponse: {name, response: {output \| error}}}` |
//! | `thinking` (with signature) | `{text, thought: true, thoughtSignature}` |
//! | `tools[].input_schema` | `functionDeclarations[].parametersJsonSchema` |
//! | `tool_choice` auto / any / tool / none | `functionCallingConfig.mode` AUTO / ANY (+ `allowedFunctionNames`) / NONE |
//! | `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` | `generationConfig` |
//! | `thinking.budget_tokens` | `generationConfig.thinkingConfig` |
//!
//! **Thought signatures.** Gemini 3 answers 400 when a function call in the
//! history comes back without the `thoughtSignature` it was issued with. An
//! Anthropic client keeps nothing but the `tool_use` id, so the signature
//! rides inside that id (`toolu_vtx_<12 hex>s<base64url signature>`) and is
//! restored onto the `functionCall` part when the history returns. A call
//! with no recoverable signature — history from another model — gets the
//! documented `skip_thought_signature_validator` value on the first call of
//! its turn, the only part Gemini validates for parallel calls.
//! <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures>
//!
//! **Usage.** `promptTokenCount` includes `cachedContentTokenCount`, and
//! thinking tokens are reported apart from `candidatesTokenCount` though
//! billed, so: input = prompt − cached (+ tool-use prompt), cache read =
//! cached, output = candidates + thoughts.
//! <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/GenerateContentResponse>

use base64::Engine;
use serde_json::{json, Map, Value};

use super::sse::event;

const ID_PREFIX: &str = "toolu_vtx_";
const SKIP_SIGNATURE: &str = "skip_thought_signature_validator";

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// A `tool_use` id for a Gemini function call, carrying its signature.
fn tool_use_id(signature: Option<&str>) -> String {
    let nonce = &uuid::Uuid::new_v4().simple().to_string()[..12];
    match signature.filter(|s| !s.is_empty()) {
        Some(sig) => format!("{ID_PREFIX}{nonce}s{}", b64().encode(sig)),
        None => format!("{ID_PREFIX}{nonce}"),
    }
}

/// The signature carried in a `tool_use` id this module minted.
fn signature_of(id: &str) -> Option<String> {
    let rest = id.strip_prefix(ID_PREFIX)?;
    let encoded = rest.get(12..)?.strip_prefix('s')?;
    String::from_utf8(b64().decode(encoded).ok()?).ok()
}

/// Gemini 3 and later validate thought signatures on function calls.
fn validates_signatures(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    let Some(rest) = m.strip_prefix("gemini-") else {
        return false;
    };
    rest.split(['.', '-'])
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 3)
}

/// An Anthropic Messages body as a `generateContent` body.
pub fn request(body: &Value, model: &str) -> Result<Value, String> {
    let mut out = Map::new();

    let system_text = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if !system_text.is_empty() {
        out.insert(
            "systemInstruction".into(),
            json!({"parts": [{"text": system_text}]}),
        );
    }

    let messages = body
        .get("messages")
        .and_then(|m| m.as_array())
        .ok_or("messages is required")?;
    // tool_use id → function name, for the functionResponse that answers it.
    let mut names = std::collections::HashMap::new();
    for m in messages {
        for b in m
            .get("content")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                if let (Some(id), Some(name)) = (
                    b.get("id").and_then(|v| v.as_str()),
                    b.get("name").and_then(|v| v.as_str()),
                ) {
                    names.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    let validates = validates_signatures(model);
    let mut contents: Vec<Value> = Vec::new();
    for m in messages {
        let role = match m.get("role").and_then(|r| r.as_str()) {
            Some("assistant") => "model",
            _ => "user",
        };
        let mut parts = parts_of(m.get("content"), &names)?;
        if parts.is_empty() {
            continue;
        }
        if role == "model" && validates {
            if let Some(first_call) = parts.iter_mut().find(|p| p.get("functionCall").is_some()) {
                if first_call.get("thoughtSignature").is_none() {
                    first_call["thoughtSignature"] = json!(SKIP_SIGNATURE);
                }
            }
        }
        match contents.last_mut() {
            Some(last) if last["role"] == role => {
                if let Some(arr) = last["parts"].as_array_mut() {
                    arr.append(&mut parts);
                }
            }
            _ => contents.push(json!({"role": role, "parts": parts})),
        }
    }
    out.insert("contents".into(), Value::Array(contents));

    let mut generation = Map::new();
    for (from, to) in [
        ("max_tokens", "maxOutputTokens"),
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("top_k", "topK"),
        ("stop_sequences", "stopSequences"),
    ] {
        if let Some(v) = body.get(from).filter(|v| !v.is_null()) {
            generation.insert(to.into(), v.clone());
        }
    }
    match body
        .get("thinking")
        .and_then(|t| t.get("type"))
        .and_then(|t| t.as_str())
    {
        Some("enabled") => {
            let mut cfg = json!({"includeThoughts": true});
            if let Some(b) = body["thinking"].get("budget_tokens") {
                cfg["thinkingBudget"] = b.clone();
            }
            generation.insert("thinkingConfig".into(), cfg);
        }
        Some("adaptive") => {
            generation.insert("thinkingConfig".into(), json!({"includeThoughts": true}));
        }
        _ => {}
    }
    if !generation.is_empty() {
        out.insert("generationConfig".into(), Value::Object(generation));
    }

    if let Some(tools) = body
        .get("tools")
        .and_then(|t| t.as_array())
        .filter(|t| !t.is_empty())
    {
        let mut decls = Vec::new();
        for t in tools {
            let name = t
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or("every tool needs a name")?;
            let Some(schema) = t.get("input_schema") else {
                return Err(format!(
                    "tool '{name}' is a server tool; Gemini takes client tools with an input_schema only"
                ));
            };
            let mut d = json!({"name": name, "parametersJsonSchema": schema});
            if let Some(desc) = t.get("description").and_then(|d| d.as_str()) {
                d["description"] = json!(desc);
            }
            decls.push(d);
        }
        out.insert("tools".into(), json!([{"functionDeclarations": decls}]));
        let choice = body.get("tool_choice");
        let mode = match choice.and_then(|c| c.get("type")).and_then(|t| t.as_str()) {
            Some("any") => Some(json!({"mode": "ANY"})),
            Some("tool") => {
                let name = choice
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
                    .ok_or("tool_choice of type tool needs a name")?;
                Some(json!({"mode": "ANY", "allowedFunctionNames": [name]}))
            }
            Some("none") => Some(json!({"mode": "NONE"})),
            Some("auto") => Some(json!({"mode": "AUTO"})),
            _ => None,
        };
        if let Some(m) = mode {
            out.insert("toolConfig".into(), json!({"functionCallingConfig": m}));
        }
    }
    Ok(Value::Object(out))
}

fn parts_of(
    content: Option<&Value>,
    names: &std::collections::HashMap<String, String>,
) -> Result<Vec<Value>, String> {
    let mut parts = Vec::new();
    let blocks = match content {
        Some(Value::String(s)) => {
            if !s.is_empty() {
                parts.push(json!({"text": s}));
            }
            return Ok(parts);
        }
        Some(Value::Array(b)) => b,
        _ => return Ok(parts),
    };
    for b in blocks {
        let s = |k: &str| b.get(k).and_then(|v| v.as_str()).unwrap_or("");
        match s("type") {
            "text" if !s("text").is_empty() => parts.push(json!({"text": s("text")})),
            "image" | "document" => parts.push(inline_data(b)?),
            "tool_use" => {
                let mut p = json!({"functionCall": {
                    "name": s("name"),
                    "args": b.get("input").cloned().unwrap_or_else(|| json!({})),
                }});
                if let Some(sig) = signature_of(s("id")) {
                    p["thoughtSignature"] = json!(sig);
                }
                parts.push(p);
            }
            "tool_result" => {
                let id = s("tool_use_id");
                let name = names.get(id).ok_or_else(|| {
                    format!("tool_result {id} answers no tool_use in the conversation")
                })?;
                let text = match b.get("content") {
                    Some(Value::String(t)) => t.clone(),
                    Some(Value::Array(items)) => items
                        .iter()
                        .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                let key = if b.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                    "error"
                } else {
                    "output"
                };
                parts.push(json!({"functionResponse": {"name": name, "response": {key: text}}}));
            }
            "thinking" if !s("signature").is_empty() => parts.push(json!({
                "text": s("thinking"),
                "thought": true,
                "thoughtSignature": s("signature"),
            })),
            // Unsigned or redacted thinking cannot be replayed to Gemini, and
            // server-side Anthropic blocks have no counterpart.
            _ => {}
        }
    }
    Ok(parts)
}

fn inline_data(b: &Value) -> Result<Value, String> {
    let src = b.get("source").ok_or("media block has no source")?;
    if src.get("type").and_then(|t| t.as_str()) != Some("base64") {
        return Err("Gemini on Vertex AI takes images and documents as base64 data here; URL and file sources are not supported".into());
    }
    Ok(json!({"inlineData": {
        "mimeType": src.get("media_type").cloned().unwrap_or(json!("application/octet-stream")),
        "data": src.get("data").cloned().unwrap_or(json!("")),
    }}))
}

fn stop_reason(finish: &str, tool_use: bool) -> &'static str {
    match finish {
        "MAX_TOKENS" => "max_tokens",
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" => {
            "refusal"
        }
        _ if tool_use => "tool_use",
        _ => "end_turn",
    }
}

/// Anthropic usage from Gemini `usageMetadata`.
pub fn usage(meta: Option<&Value>) -> Value {
    let n = |k: &str| {
        meta.and_then(|m| m.get(k))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let cached = n("cachedContentTokenCount");
    let mut u = json!({
        "input_tokens": n("promptTokenCount").saturating_sub(cached) + n("toolUsePromptTokenCount"),
        "output_tokens": n("candidatesTokenCount") + n("thoughtsTokenCount"),
    });
    if meta
        .and_then(|m| m.get("cachedContentTokenCount"))
        .is_some()
    {
        u["cache_read_input_tokens"] = json!(cached);
    }
    u
}

fn message_id() -> String {
    format!("msg_vtx_{}", uuid::Uuid::new_v4().simple())
}

/// A `generateContent` response as an Anthropic Messages response.
pub fn response(v: &Value, model: &str) -> Value {
    let candidate = v.pointer("/candidates/0");
    let mut content = Vec::new();
    let mut tool_use = false;
    for p in candidate
        .and_then(|c| c.pointer("/content/parts"))
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
    {
        let sig = p.get("thoughtSignature").and_then(|s| s.as_str());
        if let Some(fc) = p.get("functionCall") {
            tool_use = true;
            content.push(json!({
                "type": "tool_use",
                "id": tool_use_id(sig),
                "name": fc.get("name").cloned().unwrap_or(json!("")),
                "input": fc.get("args").cloned().unwrap_or(json!({})),
            }));
        } else if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
            if p.get("thought").and_then(|t| t.as_bool()) == Some(true) {
                content.push(
                    json!({"type": "thinking", "thinking": t, "signature": sig.unwrap_or("")}),
                );
            } else if !t.is_empty() {
                content.push(json!({"type": "text", "text": t}));
            }
        }
    }
    let finish = candidate
        .and_then(|c| c.get("finishReason"))
        .and_then(|f| f.as_str())
        .unwrap_or(if v.pointer("/promptFeedback/blockReason").is_some() {
            "SAFETY"
        } else {
            "STOP"
        });
    json!({
        "id": message_id(),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason(finish, tool_use),
        "stop_sequence": null,
        "usage": usage(v.get("usageMetadata")),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Open {
    Text,
    Thinking,
}

/// `streamGenerateContent?alt=sse` chunks → Anthropic SSE events. Each chunk
/// is a whole `GenerateContentResponse` holding the next parts; a function
/// call always arrives in one piece, so it becomes a complete `tool_use`
/// block at once.
pub struct StreamTranslator {
    model: String,
    started: bool,
    open: Option<(u64, Open)>,
    next_index: u64,
    tool_use: bool,
    finish: Option<String>,
    usage: Option<Value>,
    failed: bool,
    closed: bool,
}

impl StreamTranslator {
    pub fn new(model: &str) -> Self {
        StreamTranslator {
            model: model.to_string(),
            started: false,
            open: None,
            next_index: 0,
            tool_use: false,
            finish: None,
            usage: None,
            failed: false,
            closed: false,
        }
    }

    fn start(&mut self, out: &mut String) {
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

    fn close_open(&mut self, out: &mut String) {
        if let Some((index, _)) = self.open.take() {
            out.push_str(&event(
                "content_block_stop",
                &json!({"type": "content_block_stop", "index": index}),
            ));
        }
    }

    fn ensure_open(&mut self, kind: Open, out: &mut String) -> u64 {
        if let Some((index, k)) = self.open {
            if k == kind {
                return index;
            }
        }
        self.close_open(out);
        let index = self.next_index;
        self.next_index += 1;
        let block = match kind {
            Open::Text => json!({"type": "text", "text": ""}),
            Open::Thinking => json!({"type": "thinking", "thinking": "", "signature": ""}),
        };
        out.push_str(&event(
            "content_block_start",
            &json!({"type": "content_block_start", "index": index, "content_block": block}),
        ));
        self.open = Some((index, kind));
        index
    }

    fn delta(index: u64, d: Value) -> String {
        event(
            "content_block_delta",
            &json!({"type": "content_block_delta", "index": index, "delta": d}),
        )
    }

    /// One `data:` payload.
    pub fn on_chunk(&mut self, v: &Value) -> String {
        let mut out = String::new();
        if self.failed || self.closed {
            return out;
        }
        if let Some(err) = v.get("error") {
            let (_, kind) = super::errors::google_mapping(
                err.get("status").and_then(|s| s.as_str()).unwrap_or(""),
                err.get("code").and_then(|c| c.as_u64()).unwrap_or(500) as u16,
            );
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
            self.failed = true;
            out.push_str(&super::errors::sse_error(
                kind,
                &format!("Vertex AI: {msg}"),
            ));
            return out;
        }
        self.start(&mut out);
        let candidate = v.pointer("/candidates/0");
        for p in candidate
            .and_then(|c| c.pointer("/content/parts"))
            .and_then(|p| p.as_array())
            .into_iter()
            .flatten()
        {
            let sig = p.get("thoughtSignature").and_then(|s| s.as_str());
            if let Some(fc) = p.get("functionCall") {
                self.close_open(&mut out);
                self.tool_use = true;
                let index = self.next_index;
                self.next_index += 1;
                out.push_str(&event(
                    "content_block_start",
                    &json!({"type": "content_block_start", "index": index, "content_block": {
                        "type": "tool_use", "id": tool_use_id(sig),
                        "name": fc.get("name").cloned().unwrap_or(json!("")), "input": {},
                    }}),
                ));
                let args = fc.get("args").cloned().unwrap_or(json!({}));
                out.push_str(&Self::delta(
                    index,
                    json!({"type": "input_json_delta", "partial_json": args.to_string()}),
                ));
                out.push_str(&event(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            } else if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                let thought = p.get("thought").and_then(|t| t.as_bool()) == Some(true);
                if thought {
                    let index = self.ensure_open(Open::Thinking, &mut out);
                    if !t.is_empty() {
                        out.push_str(&Self::delta(
                            index,
                            json!({"type": "thinking_delta", "thinking": t}),
                        ));
                    }
                    if let Some(sig) = sig {
                        out.push_str(&Self::delta(
                            index,
                            json!({"type": "signature_delta", "signature": sig}),
                        ));
                    }
                } else if !t.is_empty() {
                    let index = self.ensure_open(Open::Text, &mut out);
                    out.push_str(&Self::delta(
                        index,
                        json!({"type": "text_delta", "text": t}),
                    ));
                } else if let (Some(sig), Some((index, Open::Thinking))) = (sig, self.open) {
                    // A signature can arrive alone, on an empty part.
                    out.push_str(&Self::delta(
                        index,
                        json!({"type": "signature_delta", "signature": sig}),
                    ));
                }
            }
        }
        if let Some(f) = candidate
            .and_then(|c| c.get("finishReason"))
            .and_then(|f| f.as_str())
        {
            self.finish = Some(f.to_string());
        }
        if let Some(u) = v.get("usageMetadata") {
            self.usage = Some(u.clone());
        }
        out
    }

    /// The upstream ended: close the message if Gemini said it finished.
    pub fn finish(&mut self) -> String {
        let mut out = String::new();
        if self.failed || self.closed || self.finish.is_none() {
            return out;
        }
        self.start(&mut out);
        self.close_open(&mut out);
        let reason = stop_reason(self.finish.as_deref().unwrap_or("STOP"), self.tool_use);
        out.push_str(&event(
            "message_delta",
            &json!({"type": "message_delta",
                "delta": {"stop_reason": reason, "stop_sequence": null},
                "usage": usage(self.usage.as_ref())}),
        ));
        out.push_str(&event("message_stop", &json!({"type": "message_stop"})));
        self.closed = true;
        out
    }

    pub fn failed(&self) -> bool {
        self.failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_conversation_translates_to_contents_and_function_declarations() {
        let first = response(
            &json!({"candidates": [{"content": {"role": "model", "parts": [
                {"functionCall": {"name": "get_weather", "args": {"city": "Rome"}}, "thoughtSignature": "c2lnLTE="}
            ]}, "finishReason": "STOP"}]}),
            "gemini-3-pro",
        );
        let id = first["content"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(first["stop_reason"], "tool_use");
        assert!(id.starts_with("toolu_vtx_"));

        let anthropic = json!({
            "max_tokens": 256,
            "temperature": 0.5,
            "system": "Be brief.",
            "tools": [{"name": "get_weather", "description": "Weather", "input_schema": {"type": "object", "additionalProperties": false}}],
            "tool_choice": {"type": "tool", "name": "get_weather"},
            "messages": [
                {"role": "user", "content": "Weather in Rome?"},
                {"role": "assistant", "content": [first["content"][0].clone()]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": [{"type": "text", "text": "21C"}]}]}
            ]
        });
        let g = request(&anthropic, "gemini-3-pro").unwrap();
        assert_eq!(
            g["systemInstruction"],
            json!({"parts": [{"text": "Be brief."}]})
        );
        assert_eq!(
            g["contents"],
            json!([
                {"role": "user", "parts": [{"text": "Weather in Rome?"}]},
                {"role": "model", "parts": [{"functionCall": {"name": "get_weather", "args": {"city": "Rome"}}, "thoughtSignature": "c2lnLTE="}]},
                {"role": "user", "parts": [{"functionResponse": {"name": "get_weather", "response": {"output": "21C"}}}]}
            ])
        );
        assert_eq!(
            g["tools"],
            json!([{"functionDeclarations": [{"name": "get_weather", "description": "Weather", "parametersJsonSchema": {"type": "object", "additionalProperties": false}}]}])
        );
        assert_eq!(
            g["toolConfig"],
            json!({"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["get_weather"]}})
        );
        assert_eq!(
            g["generationConfig"],
            json!({"maxOutputTokens": 256, "temperature": 0.5})
        );
    }

    #[test]
    fn history_from_another_model_gets_the_documented_skip_value_on_gemini_3_only() {
        let body = json!({"max_tokens": 1, "messages": [
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_01abc", "name": "a", "input": {}},
                {"type": "tool_use", "id": "toolu_01def", "name": "b", "input": {}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01abc", "content": "x", "is_error": true},
                {"type": "tool_result", "tool_use_id": "toolu_01def", "content": "y"}
            ]}
        ]});
        let g3 = request(&body, "gemini-3.5-flash").unwrap();
        assert_eq!(
            g3["contents"][0]["parts"][0]["thoughtSignature"],
            SKIP_SIGNATURE
        );
        assert!(g3["contents"][0]["parts"][1]
            .get("thoughtSignature")
            .is_none());
        assert_eq!(
            g3["contents"][1]["parts"][0]["functionResponse"]["response"],
            json!({"error": "x"})
        );
        let g25 = request(&body, "gemini-2.5-pro").unwrap();
        assert!(g25["contents"][0]["parts"][0]
            .get("thoughtSignature")
            .is_none());
        assert!(request(&json!({"max_tokens": 1, "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "nope", "content": "x"}]}]}), "gemini-2.5-pro").is_err());
    }

    #[test]
    fn the_signature_survives_the_tool_use_id_round_trip() {
        let sig = "CiQB0e2Kb/+==/longopaque";
        let id = tool_use_id(Some(sig));
        assert!(
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "{id}"
        );
        assert_eq!(signature_of(&id).as_deref(), Some(sig));
        assert_eq!(signature_of(&tool_use_id(None)), None);
        assert_eq!(signature_of("toolu_01XYZ"), None);
    }

    #[test]
    fn usage_separates_cache_reads_and_bills_thoughts_as_output() {
        let u = usage(Some(&json!({
            "promptTokenCount": 1000, "cachedContentTokenCount": 600,
            "candidatesTokenCount": 50, "thoughtsTokenCount": 200, "totalTokenCount": 1250
        })));
        assert_eq!(
            u,
            json!({"input_tokens": 400, "output_tokens": 250, "cache_read_input_tokens": 600})
        );
        let parsed = crate::usage::TokenUsage::from_anthropic(&json!({"usage": u}));
        assert_eq!(parsed.total_input(), 1000);
        assert_eq!(
            usage(Some(
                &json!({"promptTokenCount": 7, "candidatesTokenCount": 3})
            )),
            json!({"input_tokens": 7, "output_tokens": 3})
        );
    }

    #[test]
    fn a_blocked_prompt_is_a_refusal() {
        let m = response(
            &json!({"promptFeedback": {"blockReason": "SAFETY"}, "usageMetadata": {"promptTokenCount": 5}}),
            "gemini-2.5-pro",
        );
        assert_eq!(m["stop_reason"], "refusal");
        assert_eq!(m["content"], json!([]));
    }

    #[test]
    fn a_stream_of_thoughts_text_and_a_call_becomes_ordered_anthropic_blocks() {
        let mut t = StreamTranslator::new("vertex/gemini-3-pro");
        let mut sse = String::new();
        for chunk in [
            json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "Planning", "thought": true}]}}]}),
            json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "", "thoughtSignature": "sig-A"}]}}]}),
            json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "Calling "}]}}]}),
            json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "now."}]}}]}),
            json!({"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": "lookup", "args": {"q": 1}}}]}, "finishReason": "STOP"}],
                   "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "thoughtsTokenCount": 2}}),
        ] {
            sse.push_str(&t.on_chunk(&chunk));
        }
        sse.push_str(&t.finish());
        let events: Vec<Value> = sse
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(|d| serde_json::from_str(d).unwrap())
            .collect();
        let kinds: Vec<String> = events
            .iter()
            .map(|e| {
                let ty = e["type"].as_str().unwrap();
                match ty {
                    "content_block_start" => {
                        format!("start:{}", e["content_block"]["type"].as_str().unwrap())
                    }
                    "content_block_delta" => {
                        format!("delta:{}", e["delta"]["type"].as_str().unwrap())
                    }
                    other => other.to_string(),
                }
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "message_start",
                "start:thinking",
                "delta:thinking_delta",
                "delta:signature_delta",
                "content_block_stop",
                "start:text",
                "delta:text_delta",
                "delta:text_delta",
                "content_block_stop",
                "start:tool_use",
                "delta:input_json_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        let delta = events
            .iter()
            .find(|e| e["type"] == "message_delta")
            .unwrap();
        assert_eq!(delta["delta"]["stop_reason"], "tool_use");
        assert_eq!(
            delta["usage"],
            json!({"input_tokens": 10, "output_tokens": 7})
        );
        // Indices are dense and distinct per block.
        let starts: Vec<u64> = events
            .iter()
            .filter(|e| e["type"] == "content_block_start")
            .map(|e| e["index"].as_u64().unwrap())
            .collect();
        assert_eq!(starts, vec![0, 1, 2]);
    }

    #[test]
    fn an_error_chunk_ends_the_stream_with_a_mapped_error_event() {
        let mut t = StreamTranslator::new("m");
        let out = t.on_chunk(
            &json!({"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}}),
        );
        assert!(out.starts_with("event: error\n"));
        assert!(out.contains("rate_limit_error"));
        assert!(t.failed());
        assert_eq!(t.finish(), "");
    }
}
