//! Governance notification queue reader.
//!
//! Drains `gov:notify:{sessionId}` and `gov:notify:workspace:{workspaceId}`.
//! Both queues are written by the control plane (corrective-prompt service and
//! crons) and only read here, so this holds a `ControlPlaneCache` rather than
//! its own connection — the atomic LRANGE+DEL lives in the Valkey impl.
//!
//! Standalone the cache is the null one and both drains return empty. That is
//! not a degradation: nothing in open core writes these queues, so here this is
//! a consumer with no producer.

use anyhow::Result;
use serde::Deserialize;
use std::sync::Arc;
use tracing::debug;

use crate::store::{ControlPlaneCache, NotifyScope};

/// Reader for governance notifications.
pub struct NotificationClient {
    control_plane: Arc<dyn ControlPlaneCache>,
}

/// A governance notification queued for inline delivery.
#[derive(Debug, Clone, Deserialize)]
pub struct GovernanceNotification {
    pub notification_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub priority: String,
    pub category: String,
    pub title: String,
    pub body: String,
    pub action_url: Option<String>,
    pub created_at: String,
}

impl NotificationClient {
    pub fn new(control_plane: Arc<dyn ControlPlaneCache>) -> Self {
        Self { control_plane }
    }

    fn parse(raw: Vec<String>) -> Vec<GovernanceNotification> {
        raw.iter()
            .filter_map(|s| match serde_json::from_str(s) {
                Ok(n) => Some(n),
                Err(e) => {
                    debug!(error = %e, "Failed to parse notification JSON");
                    None
                }
            })
            .collect()
    }

    /// Drain all pending notifications for a session.
    pub async fn drain_notifications(
        &self,
        session_id: &str,
    ) -> Result<Vec<GovernanceNotification>> {
        let raw = self
            .control_plane
            .drain_notifications(NotifyScope::Session, session_id)
            .await;
        let notifications = Self::parse(raw);
        debug!(
            session_id,
            count = notifications.len(),
            "Drained governance notifications"
        );
        Ok(notifications)
    }

    /// Drain this node's graph queue.
    ///
    /// `key` is `"{graphId}:{nodeId}"`. Each node reads its own queue: the
    /// producer fans a finding out to one queue per registered sibling, so
    /// nobody can consume another's copy.
    pub async fn drain_graph_notifications(
        &self,
        key: &str,
    ) -> Result<Vec<GovernanceNotification>> {
        let raw = self
            .control_plane
            .drain_notifications(NotifyScope::Graph, key)
            .await;
        let notifications = Self::parse(raw);
        debug!(
            graph_key = key,
            count = notifications.len(),
            "Drained graph governance notifications"
        );
        Ok(notifications)
    }

    /// Drain all pending workspace-level notifications.
    ///
    /// Queued by control-plane crons (e.g. context gap suggestions) and
    /// delivered to whichever session drains them first.
    pub async fn drain_workspace_notifications(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<GovernanceNotification>> {
        let raw = self
            .control_plane
            .drain_notifications(NotifyScope::Workspace, workspace_id)
            .await;
        let notifications = Self::parse(raw);
        debug!(
            workspace_id,
            count = notifications.len(),
            "Drained workspace governance notifications"
        );
        Ok(notifications)
    }
}
