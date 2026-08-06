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
        let intutic_pos = find_slash_command(&last_message);
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

        // 3. Prompt quality gate — DISABLED.
        //
        // quality_gate::check posts to POST /api/v1/prompt-quality/score, whose
        // control-plane service was deleted in the non-circuit-breaker strip.
        // The gate fails open, so nothing was ever blocked — but every proxied
        // request paid a control-plane round trip (5s-timeout client) to collect
        // a 404. `/fix` is the surviving prompt-quality surface.
        //
        // Kept behind a flag rather than deleted so restoring the endpoint is a
        // one-line change; quality_gate.rs stays compiled and tested.
        if std::env::var("INTUTIC_PROMPT_QUALITY_GATE").as_deref() == Ok("true") {
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
                    return Some(gate_response);
                }
                Ok(None) => return None, // Quality OK, proceed
                Err(e) => {
                    warn!(error = %e, session_id, "Quality gate failed, proceeding");
                    return None; // Fail-open
                }
            }
        }

        None
    }
}

/// Locate a `/intutic` or `@intutic` command, if the message actually contains one.
///
/// This used to be `last_message.find("/intutic")` — a bare substring search over
/// the whole message. That matches inside ordinary prose and, worse, inside
/// paths. Our own Artifact Registry is
/// `us-central1-docker.pkg.dev/intutic/intutic/...`, so *any* prompt naming a
/// container image was intercepted and answered with
/// "Command Failed: `/intutic` returned status 400" instead of reaching the
/// model. Observed twice while building a demo that deploys our own images. Any
/// customer whose registry, repo path, or docs URL contains `/intutic` hits it
/// too, and the `--force` bypass below cannot help — it is checked afterwards.
///
/// A slash command is a command because of where it sits, not merely because
/// the characters appear somewhere. Require the start of the message or the
/// start of a line, allowing leading whitespace, and require that what follows
/// is a boundary rather than more word characters — so `/intuticfoo` is not a
/// command either.
fn find_slash_command(message: &str) -> Option<usize> {
    for prefix in ["/intutic", "@intutic"] {
        let mut from = 0usize;
        while let Some(rel) = message[from..].find(prefix) {
            let pos = from + rel;

            // Everything before it on this line must be whitespace.
            let line_start = message[..pos].rfind('\n').map_or(0, |i| i + 1);
            let at_line_start = message[line_start..pos].trim().is_empty();

            // And it must not run straight into more word characters.
            let after = message[pos + prefix.len()..].chars().next();
            let boundary = after.is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '-');

            if at_line_start && boundary {
                return Some(pos);
            }
            from = pos + prefix.len();
        }
    }
    None
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

#[cfg(test)]
mod slash_command_tests {
    use super::find_slash_command;

    // The string that actually broke a live demo: our own Artifact Registry
    // path. Before the boundary check this was intercepted and the request
    // never reached the model.
    const AR_PATH: &str =
        "Deploy us-central1-docker.pkg.dev/intutic/intutic/sockshop/catalogue:0.3.5";

    #[test]
    fn a_registry_path_is_not_a_command() {
        assert_eq!(find_slash_command(AR_PATH), None);
    }

    #[test]
    fn prose_mentioning_the_path_is_not_a_command() {
        assert_eq!(
            find_slash_command("The image lives at docker.pkg.dev/intutic/intutic/proxy."),
            None
        );
    }

    #[test]
    fn a_docs_url_is_not_a_command() {
        assert_eq!(find_slash_command("see https://example.com/intutic/setup"), None);
    }

    #[test]
    fn a_command_at_the_start_is_found() {
        assert_eq!(find_slash_command("/intutic status"), Some(0));
        assert_eq!(find_slash_command("@intutic judge"), Some(0));
    }

    #[test]
    fn a_command_on_its_own_line_is_found() {
        let msg = "please review this\n/intutic status";
        assert_eq!(find_slash_command(msg), Some(msg.find("/intutic").unwrap()));
    }

    #[test]
    fn leading_whitespace_is_allowed() {
        let msg = "  \t/intutic help";
        assert_eq!(find_slash_command(msg), Some(msg.find("/intutic").unwrap()));
    }

    #[test]
    fn a_bare_command_with_no_args_is_found() {
        assert_eq!(find_slash_command("/intutic"), Some(0));
    }

    #[test]
    fn a_longer_word_is_not_a_command() {
        // `/intuticorn` is not `/intutic`.
        assert_eq!(find_slash_command("/intuticorn is a word"), None);
        assert_eq!(find_slash_command("/intutic-extra"), None);
    }

    #[test]
    fn a_real_command_later_in_the_message_still_wins_over_a_path_earlier() {
        let msg = "pull docker.pkg.dev/intutic/intutic/proxy\n/intutic status";
        let pos = find_slash_command(msg).expect("the line-start command should be found");
        assert_eq!(&msg[pos..pos + 15], "/intutic status");
    }
}
