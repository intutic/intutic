//! Request pre-processor — slash command interception and prompt quality gate.
//!
//! This module hooks into the proxy's request pipeline BEFORE forwarding
//! to the LLM provider. It can short-circuit the request by returning
//! a response directly.
//!
//! LLD #49: Inline Prompt Quality & Slash Commands

pub mod quality_gate;
pub mod slash_interceptor;

use tracing::{debug, warn};

/// Request pre-processor that checks for slash commands and quality gate.
pub struct RequestPreProcessor {
    control_plane_url: String,
    http_client: reqwest::Client,
}

impl RequestPreProcessor {
    pub fn new(control_plane_url: &str) -> Self {
        Self {
            control_plane_url: control_plane_url.to_string(),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("Failed to create HTTP client"),
        }
    }

    /// Process an incoming request before forwarding to LLM.
    ///
    /// Returns:
    /// - `Some(response_bytes)` if the request was intercepted
    /// - `None` if the request should proceed to the LLM normally
    pub async fn process(
        &self,
        session_id: &str,
        workspace_id: &str,
        messages: &serde_json::Value,
        model: &str,
        protocol: &crate::protocol::Protocol,
        api_key: &str,
    ) -> Option<Vec<u8>> {
        let last_message = get_last_user_message(messages)?;

        // 1. Check for /intutic or @intutic slash commands
        let intutic_pos = last_message
            .find("/intutic")
            .or_else(|| last_message.find("@intutic"));
        if let Some(pos) = intutic_pos {
            let command_line = last_message[pos..].trim();
            let parts: Vec<&str> = command_line.split_whitespace().collect();
            let cmd_0 = parts.first().copied().unwrap_or("");
            let cmd_1 = parts.get(1).copied().unwrap_or("help");
            let is_predict = cmd_0.contains("predict") || cmd_1.contains("predict");
            let is_judge_with_args = cmd_1 == "judge" && parts.len() > 2;
            if !is_judge_with_args && !is_predict {
                debug!(session_id, command = %command_line, "Intercepted slash command");
                return slash_interceptor::handle(
                    &self.http_client,
                    &self.control_plane_url,
                    session_id,
                    workspace_id,
                    command_line,
                    protocol,
                    api_key,
                )
                .await;
            }
        }

        // 2. Check for --force bypass
        if last_message.contains("--force") {
            debug!(session_id, "Quality gate bypassed via --force");
            return None;
        }

        // 3. Check quality gate (calls control plane for scoring)
        match quality_gate::check(
            &self.http_client,
            &self.control_plane_url,
            session_id,
            workspace_id,
            &last_message,
            model,
            protocol,
            api_key,
        )
        .await
        {
            Ok(Some(gate_response)) => {
                debug!(session_id, "Prompt gated by quality check");
                Some(gate_response)
            }
            Ok(None) => None, // Quality OK, proceed
            Err(e) => {
                warn!(error = %e, session_id, "Quality gate failed, proceeding");
                None // Fail-open
            }
        }
    }
}

fn get_last_user_message(messages: &serde_json::Value) -> Option<String> {
    let last_msg = messages
        .as_array()?
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))?;

    let content = last_msg.get("content")?;
    match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(arr) => {
            let mut text = String::new();
            for item in arr {
                if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

/// Format text as a fake LLM response in OpenAI chat completion format.
///
/// Used by both slash commands and quality gate to return responses
/// without making an actual LLM call.
pub fn format_as_llm_response(text: &str, protocol: &crate::protocol::Protocol) -> Vec<u8> {
    let response = match protocol {
        crate::protocol::Protocol::Anthropic => {
            serde_json::json!({
                "id": "msg_intutic_cmd",
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "text",
                    "text": text,
                }],
                "model": "intutic",
                "stop_reason": "end_turn",
                "stop_sequence": null,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0
                }
            })
        }
        _ => {
            serde_json::json!({
                "id": "intutic-cmd",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": text,
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0
                }
            })
        }
    };

    serde_json::to_vec(&response).unwrap_or_default()
}
