//! Slash command interceptor — detects `/intutic` prefix commands
//! and routes them to the control plane.
//!
//! Commands are processed by the control plane and the response is
//! returned as a fake LLM response so the harness displays it naturally.

use tracing::{debug, warn};

use super::format_as_llm_response;

/// Handle a `/intutic` slash command.
///
/// Parses the command and arguments, calls the control plane API,
/// and returns the response formatted as a fake LLM response.
///
/// Returns `None` if the command couldn't be processed (fail-open:
/// the message will be forwarded to the LLM as-is).
pub async fn handle(
    http_client: &reqwest::Client,
    control_plane_url: &str,
    session_id: &str,
    workspace_id: &str,
    message: &str,
    protocol: &crate::protocol::Protocol,
    api_key: &str,
) -> Option<Vec<u8>> {
    let parts: Vec<&str> = message.split_whitespace().collect();
    let command = parts.get(1).copied().unwrap_or("help");
    let args: Vec<String> = parts
        .get(2..)
        .unwrap_or(&[])
        .iter()
        .map(|s| s.to_string())
        .collect();

    debug!(command, args = ?args, "Processing slash command");

    // Call control plane slash command API
    let response = match http_client
        .post(format!("{}/api/v1/slash-command", control_plane_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "sessionId": session_id,
            "workspaceId": workspace_id,
            "command": command,
            "args": args,
            "messageContext": if command == "review" || command == "verify" || command == "check" || command == "judge" {
                Some(message.to_string())
            } else {
                None
            },
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "Failed to reach control plane for slash command");
            let error_text = format!(
                "### ⚠️ Intutic Unavailable\n\n\
                Could not reach the Intutic control plane to process `/{}`.\n\
                The command was not forwarded to the LLM.\n\n\
                *Try again in a moment, or check if the control plane is running.*",
                command
            );
            return Some(format_as_llm_response(&error_text, protocol));
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        warn!(%status, command, "Slash command API returned error");
        let error_text = format!(
            "### ⚠️ Command Failed\n\n\
            `/intutic {}` returned status {}.\n\
            Run `/intutic help` for available commands.",
            command, status
        );
        return Some(format_as_llm_response(&error_text, protocol));
    }

    let body: serde_json::Value = response.json().await.ok()?;
    let response_text = body
        .get("responseText")
        .and_then(|t| t.as_str())
        .unwrap_or("No response from command.");

    Some(format_as_llm_response(response_text, protocol))
}
