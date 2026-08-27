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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Protocol {
    OpenAI,
    Anthropic,
    Gemini,
    /// OpenAI Responses API — Codex CLI.
    ///
    /// Present so the wrapper can *decline*, not so it can emit. See
    /// `wrap_as_sse_content`.
    OpenAIResponses,
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
        // 0. Protocols this cannot write into, checked BEFORE the drain.
        //
        // Draining is destructive. Discovering at step 5 that there is no shape
        // to emit would consume the notifications and throw them away, so a
        // protocol that cannot carry a governance block has to bail out here.
        //
        // The Responses API is that protocol, for now. Its stream is a sequence
        // of output *items*, so an injected block is not a delta on an existing
        // one — it is a new item, and a new item needs the `output_index` after
        // the last one the model emitted, which this type never sees. Emitting
        // the `chat.completion.chunk` from the OpenAI arm instead would be
        // bytes Codex CLI cannot parse appended to a finished stream. Nothing
        // is lost relative to what shipped: this whole path was unreachable for
        // `/v1/responses` because its terminal event is `response.completed`
        // and the caller only ever recognised `[DONE]`. Closing that made the
        // path reachable, which is what makes the wrong shape a live risk and
        // this guard necessary rather than theoretical.
        if self.protocol == Protocol::OpenAIResponses {
            debug!(
                session_id,
                workspace_id,
                "Governance notifications are not delivered on the Responses API — left queued"
            );
            return None;
        }

        // Each drained notification is tagged with the queue it came from, so
        // a corrective card's delivery record can say which channel actually
        // carried it (`governance_card_labels.delivery_channel`).

        // 1a. Atomically drain session-level notifications from Valkey
        let mut notifications: Vec<(
            crate::postprocessor::notification_client::GovernanceNotification,
            &'static str,
        )> = match self
            .notification_client
            .drain_notifications(session_id)
            .await
        {
            Ok(n) => n.into_iter().map(|n| (n, "session")).collect(),
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
                Ok(graph_notifs) => {
                    notifications.extend(graph_notifs.into_iter().map(|n| (n, "graph")))
                }
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
            Ok(ws_notifs) => notifications.extend(ws_notifs.into_iter().map(|n| (n, "workspace"))),
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
        let mut tagged = notifications;
        tagged.sort_by_key(|(n, _)| match n.priority.as_str() {
            "CRITICAL" => 0,
            "HIGH" => 1,
            "MEDIUM" => 2,
            "INFO" => 3,
            _ => 4,
        });

        // 3. Limit to max 5 notifications per response
        tagged.truncate(5);

        // 3b. Report delivered corrective cards for the control plane's label
        // sweep. Only the survivors of the truncate above: a card drained but
        // dropped by the cap was destroyed without being shown, and its
        // dataset row honestly keeps a NULL delivered_at. Fire-and-forget —
        // failure must never cost the response its governance block.
        let delivered: Vec<String> = tagged
            .iter()
            .filter_map(|(n, channel)| {
                n.card_id.as_ref().map(|card_id| {
                    serde_json::json!({
                        "card_id": card_id,
                        "channel": channel,
                        "delivered_at_ms": chrono::Utc::now().timestamp_millis(),
                    })
                    .to_string()
                })
            })
            .collect();
        if !delivered.is_empty() {
            self.notification_client
                .record_card_deliveries(workspace_id, &delivered)
                .await;
        }

        let sorted: Vec<_> = tagged.into_iter().map(|(n, _)| n).collect();

        // 4. Format as governance block
        let block = self.formatter.format(&sorted);

        // 5. Wrap in SSE event format
        let sse_payload = self.wrap_as_sse_content(&block);

        Some(sse_payload)
    }

    /// Wraps formatted text as SSE content delta events.
    ///
    /// `Protocol::OpenAIResponses` never reaches here — `process` returns
    /// before the drain for it — so it deliberately has no arm of its own
    /// rather than a wrong one.
    fn wrap_as_sse_content(&self, text: &str) -> Vec<u8> {
        match self.protocol {
            Protocol::OpenAI | Protocol::Gemini | Protocol::OpenAIResponses => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ControlPlaneCache, NotifyScope};
    use std::sync::{Arc, Mutex};

    /// Serves canned notification payloads per scope and captures what
    /// `record_card_deliveries` was called with. Spelled out rather than
    /// wrapping `NullControlPlaneCache`, same reasoning as
    /// `token/prediction.rs`'s `FixedThreshold`.
    struct QueuedCards {
        session: Vec<String>,
        workspace: Vec<String>,
        recorded: Mutex<Vec<(String, Vec<String>)>>,
    }

    #[async_trait::async_trait]
    impl ControlPlaneCache for QueuedCards {
        async fn drain_notifications(&self, scope: NotifyScope, _id: &str) -> Vec<String> {
            match scope {
                NotifyScope::Session => self.session.clone(),
                NotifyScope::Workspace => self.workspace.clone(),
                NotifyScope::Graph => Vec::new(),
            }
        }
        async fn record_card_deliveries(&self, workspace_id: &str, payloads: &[String]) {
            self.recorded
                .lock()
                .unwrap()
                .push((workspace_id.to_string(), payloads.to_vec()));
        }
        async fn bandit_keywords(&self, _w: &str) -> Option<serde_json::Value> {
            None
        }
        async fn active_sop_tier(&self, _w: &str) -> Option<String> {
            None
        }
        async fn allowed_models(&self, _w: &str) -> Option<Vec<String>> {
            None
        }
        async fn feature_flags(&self, _w: &str) -> Option<crate::store::FeatureFlags> {
            None
        }
        async fn auth_context(&self, _t: &str) -> crate::store::ControlPlaneAuth {
            crate::store::ControlPlaneAuth::Unmanaged
        }
        async fn hard_block(&self, _w: &str) -> crate::store::HardCapStatus {
            crate::store::HardCapStatus::Clear
        }
        async fn daily_budget(&self, _w: &str) -> Option<(f64, Option<f64>)> {
            None
        }
        async fn loop_status(&self, _l: &str) -> Option<String> {
            None
        }
        async fn active_loop_run(&self, _w: &str, _m: Option<&str>) -> Option<String> {
            None
        }
        async fn auto_judge_active(&self, _s: crate::store::JudgeScope, _id: &str) -> bool {
            false
        }
        async fn break_glass_valid(&self, _t: &str) -> bool {
            false
        }
        async fn transition_baseline(&self, _w: &str) -> Option<String> {
            None
        }
        async fn wasm_plugins(&self, _w: &str) -> anyhow::Result<Option<String>> {
            Ok(None)
        }
        async fn wasm_binary(&self, _sha: &str) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn predict_gate_threshold(&self, _w: &str) -> Option<f64> {
            None
        }
        async fn token_baseline(
            &self,
            _w: &str,
            _m: &str,
            _b: &str,
        ) -> Option<crate::store::TokenBaseline> {
            None
        }
        async fn is_sandbox_attested(&self, _sid: &str) -> bool {
            false
        }
    }

    fn payload(card_id: Option<&str>, priority: &str) -> String {
        let mut v = serde_json::json!({
            "notification_id": "gn_test",
            "session_id": "ses_test",
            "workspace_id": "wk_test",
            "priority": priority,
            "category": "TOKEN_WASTE",
            "title": "t",
            "body": "b",
            "action_url": null,
            "created_at": "2026-01-01T00:00:00Z",
        });
        if let Some(id) = card_id {
            v["card_id"] = serde_json::json!(id);
        }
        v.to_string()
    }

    fn processor(cache: Arc<QueuedCards>, protocol: Protocol) -> ResponsePostProcessor {
        ResponsePostProcessor::new(cache, "claude_code", protocol).expect("processor")
    }

    #[tokio::test]
    async fn delivered_cards_are_reported_with_their_channel() {
        let cache = Arc::new(QueuedCards {
            session: vec![payload(Some("crd_a"), "HIGH"), payload(None, "CRITICAL")],
            workspace: vec![payload(Some("crd_b"), "INFO")],
            recorded: Mutex::new(Vec::new()),
        });
        let pp = processor(Arc::clone(&cache), Protocol::Anthropic);

        let out = pp.process("ses_test", "wk_test", None).await;
        assert!(out.is_some(), "notifications were pending");

        let recorded = cache.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1, "one batched report per response");
        let (ws, markers) = &recorded[0];
        assert_eq!(ws, "wk_test");
        // The payload without a card_id produces no marker — two, not three.
        assert_eq!(markers.len(), 2);

        let parsed: Vec<serde_json::Value> = markers
            .iter()
            .map(|m| serde_json::from_str(m).expect("marker is JSON"))
            .collect();
        let by_id = |id: &str| {
            parsed
                .iter()
                .find(|m| m["card_id"] == id)
                .unwrap_or_else(|| panic!("marker for {id}"))
        };
        assert_eq!(by_id("crd_a")["channel"], "session");
        assert_eq!(by_id("crd_b")["channel"], "workspace");
        assert!(by_id("crd_a")["delivered_at_ms"].is_i64());
    }

    #[tokio::test]
    async fn responses_api_neither_drains_nor_reports() {
        let cache = Arc::new(QueuedCards {
            session: vec![payload(Some("crd_a"), "HIGH")],
            workspace: Vec::new(),
            recorded: Mutex::new(Vec::new()),
        });
        let pp = processor(Arc::clone(&cache), Protocol::OpenAIResponses);

        let out = pp.process("ses_test", "wk_test", None).await;
        assert!(out.is_none(), "Responses API cannot carry a governance block");
        assert!(
            cache.recorded.lock().unwrap().is_empty(),
            "an undeliverable card must not be reported delivered — its row honestly keeps delivered_at NULL"
        );
    }

    #[tokio::test]
    async fn cards_dropped_by_the_truncate_cap_are_not_reported_delivered() {
        // Six CRITICAL card payloads; the block carries at most five.
        let session: Vec<String> = (0..6)
            .map(|i| payload(Some(&format!("crd_{i}")), "CRITICAL"))
            .collect();
        let cache = Arc::new(QueuedCards {
            session,
            workspace: Vec::new(),
            recorded: Mutex::new(Vec::new()),
        });
        let pp = processor(Arc::clone(&cache), Protocol::OpenAI);

        let out = pp.process("ses_test", "wk_test", None).await;
        assert!(out.is_some());

        let recorded = cache.recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0].1.len(),
            5,
            "only the five appended cards count as delivered"
        );
    }
}
