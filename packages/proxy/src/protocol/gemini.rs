//! Gemini v1beta adapter — custom translation for Antigravity harness.
//!
//! Antigravity uses Google's Gemini API format, which differs from OpenAI/Anthropic:
//! - Endpoint: /v1beta/models/{model}:generateContent
//! - Tool calls: functionCall / functionResponse (not tool_use / function)
//! - System message: systemInstruction field (not system role)
//! - Safety settings: required safetySettings array
//!
//! See LLD §5.3 and TD-007.

use serde::{Deserialize, Serialize};

/// Gemini generateContent request format
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiRequest {
    pub contents: Vec<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<GeminiContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<GeminiTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_settings: Option<Vec<GeminiSafetySetting>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiContent {
    pub role: Option<String>,
    pub parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_call: Option<GeminiFunctionCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub function_response: Option<GeminiFunctionResponse>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeminiFunctionCall {
    pub name: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeminiFunctionResponse {
    pub name: String,
    pub response: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeminiTool {
    pub function_declarations: Vec<GeminiFunctionDeclaration>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiFunctionDeclaration {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSafetySetting {
    pub category: String,
    pub threshold: String,
}

/// Gemini adapter — translates Gemini v1beta ↔ internal canonical format
pub struct GeminiAdapter;

impl Default for GeminiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiAdapter {
    pub fn new() -> Self {
        Self
    }

    /// Translate a Gemini request to internal canonical format (Anthropic Messages JSON)
    pub fn to_canonical(&self, request: &GeminiRequest) -> anyhow::Result<serde_json::Value> {
        let mut canonical_request = serde_json::Map::new();

        // 1. System Prompt
        if let Some(ref system_instruction) = request.system_instruction {
            let mut system_text = String::new();
            for part in &system_instruction.parts {
                if let Some(ref text) = part.text {
                    if !system_text.is_empty() {
                        system_text.push(' ');
                    }
                    system_text.push_str(text);
                }
            }
            if !system_text.is_empty() {
                canonical_request
                    .insert("system".to_string(), serde_json::Value::String(system_text));
            }
        }

        // 2. Messages
        let mut messages = Vec::new();
        for content in &request.contents {
            let mut message_obj = serde_json::Map::new();
            let role = content.role.as_deref().unwrap_or("user");
            let canonical_role = match role {
                "model" | "assistant" => "assistant",
                _ => "user",
            };
            message_obj.insert(
                "role".to_string(),
                serde_json::Value::String(canonical_role.to_string()),
            );

            let mut content_parts = Vec::new();
            for part in &content.parts {
                if let Some(ref text) = part.text {
                    content_parts.push(serde_json::json!({
                        "type": "text",
                        "text": text
                    }));
                } else if let Some(ref func_call) = part.function_call {
                    content_parts.push(serde_json::json!({
                        "type": "tool_use",
                        "id": format!("call_{}", func_call.name),
                        "name": func_call.name,
                        "input": func_call.args
                    }));
                } else if let Some(ref func_resp) = part.function_response {
                    let text_resp = if func_resp.response.is_string() {
                        func_resp.response.as_str().unwrap().to_string()
                    } else {
                        func_resp.response.to_string()
                    };
                    content_parts.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": format!("call_{}", func_resp.name),
                        "content": [
                            {
                                "type": "text",
                                "text": text_resp
                            }
                        ]
                    }));
                }
            }
            message_obj.insert(
                "content".to_string(),
                serde_json::Value::Array(content_parts),
            );
            messages.push(serde_json::Value::Object(message_obj));
        }
        canonical_request.insert("messages".to_string(), serde_json::Value::Array(messages));

        // 3. Tools
        if let Some(ref tools_list) = request.tools {
            let mut canonical_tools = Vec::new();
            for tool in tools_list {
                for decl in &tool.function_declarations {
                    canonical_tools.push(serde_json::json!({
                        "name": decl.name,
                        "description": decl.description,
                        "input_schema": decl.parameters
                    }));
                }
            }
            if !canonical_tools.is_empty() {
                canonical_request.insert(
                    "tools".to_string(),
                    serde_json::Value::Array(canonical_tools),
                );
            }
        }

        // Add default max_tokens
        canonical_request.insert("max_tokens".to_string(), serde_json::json!(4096));

        Ok(serde_json::Value::Object(canonical_request))
    }

    /// Translate Anthropic response JSON back to Gemini generateContent response payload
    pub fn to_gemini_response(
        &self,
        canonical_response: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let response_obj = canonical_response
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Invalid canonical response: expected JSON object"))?;

        // Extract parts from content array
        let mut gemini_parts = Vec::new();
        if let Some(content_val) = response_obj.get("content") {
            if let Some(content_array) = content_val.as_array() {
                for block in content_array {
                    if let Some(block_obj) = block.as_object() {
                        let block_type = block_obj
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("text");
                        if block_type == "text" {
                            if let Some(text_val) = block_obj.get("text").and_then(|v| v.as_str()) {
                                gemini_parts.push(serde_json::json!({
                                    "text": text_val
                                }));
                            }
                        } else if block_type == "tool_use" {
                            let name = block_obj
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let input = block_obj
                                .get("input")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            gemini_parts.push(serde_json::json!({
                                "functionCall": {
                                    "name": name,
                                    "args": input
                                }
                            }));
                        }
                    }
                }
            } else if let Some(text_str) = content_val.as_str() {
                gemini_parts.push(serde_json::json!({
                    "text": text_str
                }));
            }
        }

        // Finish Reason
        let stop_reason = response_obj
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("end_turn");
        let finish_reason = match stop_reason {
            "end_turn" | "tool_use" => "STOP",
            "max_tokens" => "MAX_TOKENS",
            "safety" => "SAFETY",
            _ => "STOP",
        };

        // Usage metadata
        let mut usage_metadata = serde_json::json!({
            "promptTokenCount": 0,
            "candidatesTokenCount": 0,
            "totalTokenCount": 0
        });

        if let Some(usage_val) = response_obj.get("usage") {
            if let Some(usage_obj) = usage_val.as_object() {
                let input_tokens = usage_obj
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = usage_obj
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                usage_metadata = serde_json::json!({
                    "promptTokenCount": input_tokens,
                    "candidatesTokenCount": output_tokens,
                    "totalTokenCount": input_tokens + output_tokens
                });
            }
        }

        let gemini_response = serde_json::json!({
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": gemini_parts
                    },
                    "finishReason": finish_reason
                }
            ],
            "usageMetadata": usage_metadata
        });

        Ok(gemini_response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_canonical_text() {
        let adapter = GeminiAdapter::new();
        let request = GeminiRequest {
            contents: vec![GeminiContent {
                role: Some("user".to_string()),
                parts: vec![GeminiPart {
                    text: Some("Hello world".to_string()),
                    function_call: None,
                    function_response: None,
                }],
            }],
            system_instruction: Some(GeminiContent {
                role: None,
                parts: vec![GeminiPart {
                    text: Some("Be helpful".to_string()),
                    function_call: None,
                    function_response: None,
                }],
            }),
            tools: None,
            safety_settings: None,
        };

        let result = adapter.to_canonical(&request).unwrap();
        assert_eq!(result["system"], "Be helpful");
        assert_eq!(result["messages"][0]["role"], "user");
        assert_eq!(result["messages"][0]["content"][0]["text"], "Hello world");
    }

    #[test]
    fn test_to_canonical_tool_use() {
        let adapter = GeminiAdapter::new();
        let request = GeminiRequest {
            contents: vec![GeminiContent {
                role: Some("model".to_string()),
                parts: vec![GeminiPart {
                    text: None,
                    function_call: Some(GeminiFunctionCall {
                        name: "get_weather".to_string(),
                        args: serde_json::json!({ "location": "Boston" }),
                    }),
                    function_response: None,
                }],
            }],
            system_instruction: None,
            tools: Some(vec![GeminiTool {
                function_declarations: vec![GeminiFunctionDeclaration {
                    name: "get_weather".to_string(),
                    description: "Get weather details".to_string(),
                    parameters: serde_json::json!({ "type": "object" }),
                }],
            }]),
            safety_settings: None,
        };

        let result = adapter.to_canonical(&request).unwrap();
        assert_eq!(result["messages"][0]["role"], "assistant");
        assert_eq!(result["messages"][0]["content"][0]["type"], "tool_use");
        assert_eq!(result["messages"][0]["content"][0]["name"], "get_weather");
        assert_eq!(
            result["messages"][0]["content"][0]["input"]["location"],
            "Boston"
        );
        assert_eq!(result["tools"][0]["name"], "get_weather");
    }

    #[test]
    fn test_to_canonical_tool_result() {
        let adapter = GeminiAdapter::new();
        let request = GeminiRequest {
            contents: vec![GeminiContent {
                role: Some("user".to_string()),
                parts: vec![GeminiPart {
                    text: None,
                    function_call: None,
                    function_response: Some(GeminiFunctionResponse {
                        name: "get_weather".to_string(),
                        response: serde_json::json!({ "temperature": "72F" }),
                    }),
                }],
            }],
            system_instruction: None,
            tools: None,
            safety_settings: None,
        };

        let result = adapter.to_canonical(&request).unwrap();
        assert_eq!(result["messages"][0]["role"], "user");
        assert_eq!(result["messages"][0]["content"][0]["type"], "tool_result");
        assert_eq!(
            result["messages"][0]["content"][0]["tool_use_id"],
            "call_get_weather"
        );
        assert_eq!(
            result["messages"][0]["content"][0]["content"][0]["text"],
            "{\"temperature\":\"72F\"}"
        );
    }

    #[test]
    fn test_to_gemini_response() {
        let adapter = GeminiAdapter::new();
        let canonical_response = serde_json::json!({
            "id": "msg_123",
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "The weather is nice."
                },
                {
                    "type": "tool_use",
                    "id": "call_1",
                    "name": "get_weather",
                    "input": { "location": "Boston" }
                }
            ],
            "stop_reason": "tool_use",
            "usage": {
                "input_tokens": 15,
                "output_tokens": 25
            }
        });

        let result = adapter.to_gemini_response(&canonical_response).unwrap();
        let candidate = &result["candidates"][0];
        assert_eq!(candidate["finishReason"], "STOP");
        assert_eq!(candidate["content"]["role"], "model");
        assert_eq!(
            candidate["content"]["parts"][0]["text"],
            "The weather is nice."
        );
        assert_eq!(
            candidate["content"]["parts"][1]["functionCall"]["name"],
            "get_weather"
        );
        assert_eq!(
            candidate["content"]["parts"][1]["functionCall"]["args"]["location"],
            "Boston"
        );
        assert_eq!(result["usageMetadata"]["promptTokenCount"], 15);
        assert_eq!(result["usageMetadata"]["candidatesTokenCount"], 25);
        assert_eq!(result["usageMetadata"]["totalTokenCount"], 40);
    }
}
