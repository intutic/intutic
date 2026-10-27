//! Slash command interceptor — detects `/intutic` prefix commands
//! and routes them to the control plane.
//!
//! Commands are processed by the control plane and the answer text is
//! returned for the proxy to frame as an LLM response, so the harness
//! displays it naturally.

#[cfg(feature = "control-plane")]
use tracing::{debug, warn};

/// A build without the `control-plane` feature has no control plane to answer
/// the command: it is not processed, so the message goes on to the LLM as-is.
#[cfg(not(feature = "control-plane"))]
pub async fn handle(
    _http_client: &reqwest::Client,
    _control_plane_url: &str,
    _session_id: &str,
    _workspace_id: &str,
    _message: &str,
    _virtual_key: &crate::credential::VirtualKey,
) -> Option<String> {
    None
}

/// Handle a `/intutic` slash command.
///
/// Parses the command and arguments, calls the control plane API,
/// and returns the answer text.
///
/// Returns `None` if the command couldn't be processed (fail-open:
/// the message will be forwarded to the LLM as-is).
#[cfg(feature = "control-plane")]
pub async fn handle(
    http_client: &reqwest::Client,
    control_plane_url: &str,
    session_id: &str,
    workspace_id: &str,
    message: &str,
    virtual_key: &crate::credential::VirtualKey,
) -> Option<String> {
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
    let response = match virtual_key
        .authorize(http_client.post(format!("{}/api/v1/slash-command", control_plane_url)))
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
            return Some(error_text);
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
        return Some(error_text);
    }

    let body: serde_json::Value = response.json().await.ok()?;
    let response_text = body
        .get("responseText")
        .and_then(|t| t.as_str())
        .unwrap_or("No response from command.");

    Some(response_text.to_string())
}
