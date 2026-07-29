//! Response post-processor — appends governance notifications to LLM responses.
//!
//! This module hooks into the proxy's SSE stream pipeline. After the LLM
//! response is fully streamed, it checks Valkey for pending governance
//! notifications (both session-level and workspace-level) and appends a
//! formatted block to the response.
//!
//! Design principle: NEVER modifies LLM response content. Only APPENDS
//! after the response is complete.

pub mod formatter;
pub mod formatters;
pub mod notification_client;

use crate::postprocessor::formatter::GovernanceFormatter;
use crate::postprocessor::notification_client::NotificationClient;
use tracing::{debug, warn};

/// Response post-processor that appends governance notifications.
pub struct ResponsePostProcessor {
    notification_client: NotificationClient,
    formatter: Box<dyn GovernanceFormatter + Send + Sync>,
    protocol: Protocol,
}

/// Supported LLM provider protocols.
#[derive(Debug, Clone)]
pub enum Protocol {
    OpenAI,
    Anthropic,
    Gemini,
}

impl ResponsePostProcessor {
    /// Create a new post-processor for the given harness type.
    ///
    /// Selects the appropriate formatter (markdown vs plaintext) based
    /// on which AI coding harness is making the request.
    pub fn new(
        control_plane: std::sync::Arc<dyn crate::store::ControlPlaneCache>,
        harness_type: &str,
        protocol: Protocol,
    ) -> anyhow::Result<Self> {
        let notification_client = NotificationClient::new(control_plane);
        let formatter: Box<dyn GovernanceFormatter + Send + Sync> = match harness_type {
            "cursor" | "claude_code" | "windsurf" | "antigravity" | "openhands" | "cline"
            | "roo_code" => Box::new(formatters::markdown::MarkdownFormatter),
            _ => Box::new(formatters::plaintext::PlaintextFormatter),
        };
        Ok(Self {
            notification_client,
            formatter,
            protocol,
        })
    }

    /// Check for pending notifications and return formatted governance block.
    ///
    /// Drains the session queue (`gov:notify:{sessionId}`), this node's graph
    /// queue (`gov:notify:graph:{workspaceId}:{graphId}:{nodeId}`) and the workspace queue
    /// (`gov:notify:workspace:{workspaceId}`), merges them, and returns the
    /// top-priority notifications.
    ///
    /// `graph_key` is `"{workspaceId}:{graphId}:{nodeId}"`, or `None` when the request is not
    /// part of a multi-agent graph. Each node has its own graph queue because
    /// broadcast fans out at publish time — a single shared queue would let the
    /// first sibling to poll consume everyone else's copy.
    ///
    /// Returns `None` if no notifications are pending.
    /// Called after the LLM SSE stream finishes (after `data: [DONE]`).
    pub async fn process(
        &self,
        session_id: &str,
        workspace_id: &str,
        graph_key: Option<&str>,
    ) -> Option<Vec<u8>> {
        // 1a. Atomically drain session-level notifications from Valkey
        let mut notifications = match self
            .notification_client
            .drain_notifications(session_id)
            .await
        {
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, session_id, "Failed to drain session governance notifications");
                Vec::new()
            }
        };

        // 1b. Drain this node's graph queue — findings a sibling broadcast.
        // Skipped entirely for a graph of one, which is every single-agent
        // request.
        if let Some(key) = graph_key {
            match self.notification_client.drain_graph_notifications(key).await {
                Ok(graph_notifs) => notifications.extend(graph_notifs),
                Err(e) => {
                    warn!(error = %e, graph_key = key, "Failed to drain graph governance notifications");
                }
            }
        }

        // 1c. Atomically drain workspace-level notifications from Valkey
        match self
            .notification_client
            .drain_workspace_notifications(workspace_id)
            .await
        {
            Ok(ws_notifs) => notifications.extend(ws_notifs),
            Err(e) => {
                warn!(error = %e, workspace_id, "Failed to drain workspace governance notifications");
            }
        };

        if notifications.is_empty() {
            debug!(
                session_id,
                workspace_id, "No pending governance notifications"
            );
            return None;
        }

        debug!(
            session_id,
            workspace_id,
            count = notifications.len(),
            "Appending governance notifications"
        );

        // 2. Sort by priority (CRITICAL first)
        let mut sorted = notifications;
        sorted.sort_by_key(|n| match n.priority.as_str() {
            "CRITICAL" => 0,
            "HIGH" => 1,
            "MEDIUM" => 2,
            "INFO" => 3,
            _ => 4,
        });

        // 3. Limit to max 5 notifications per response
        sorted.truncate(5);

        // 4. Format as governance block
        let block = self.formatter.format(&sorted);

        // 5. Wrap in SSE event format
        let sse_payload = self.wrap_as_sse_content(&block);

        Some(sse_payload)
    }

    /// Wraps formatted text as SSE content delta events.
    fn wrap_as_sse_content(&self, text: &str) -> Vec<u8> {
        match self.protocol {
            Protocol::OpenAI | Protocol::Gemini => {
                let chunk = serde_json::json!({
                    "id": "intutic-gov",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": { "content": text },
                        "finish_reason": serde_json::Value::Null
                    }]
                });
                format!("data: {}\n\n", chunk).into_bytes()
            }
            Protocol::Anthropic => {
                let event = serde_json::json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "text_delta",
                        "text": text
                    }
                });
                format!("event: content_block_delta\ndata: {}\n\n", event).into_bytes()
            }
        }
    }
}
