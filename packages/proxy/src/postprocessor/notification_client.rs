//! Valkey notification queue client.
//!
//! Reads and atomically drains governance notifications from a per-session
//! Valkey list using MULTI/EXEC (LRANGE + DEL).

use anyhow::Result;
use redis::AsyncCommands;
use serde::Deserialize;
use tracing::debug;

/// Client for reading governance notifications from Valkey.
pub struct NotificationClient {
    client: redis::Client,
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
    /// Create a new notification client connected to Valkey.
    pub fn new(valkey_url: &str) -> Result<Self> {
        let client = redis::Client::open(valkey_url)?;
        Ok(Self { client })
    }

    /// Atomically drain all pending notifications for a session.
    ///
    /// Uses a Redis pipeline with MULTI/EXEC to read the list and delete
    /// it in a single atomic operation. This prevents duplicate delivery
    /// if the proxy crashes after reading but before deleting.
    pub async fn drain_notifications(
        &self,
        session_id: &str,
    ) -> Result<Vec<GovernanceNotification>> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let key = format!("gov:notify:{}", session_id);

        // Check if key exists first (fast path — most requests have no notifications)
        let len: usize = conn.llen(&key).await.unwrap_or(0);
        if len == 0 {
            return Ok(Vec::new());
        }

        // Atomic read + delete via pipeline
        let mut pipe = redis::pipe();
        pipe.atomic()
            .cmd("LRANGE")
            .arg(&key)
            .arg(0i64)
            .arg(-1i64)
            .cmd("DEL")
            .arg(&key);

        let (raw_items, _deleted): (Vec<String>, i64) = pipe.query_async(&mut conn).await?;

        let notifications: Vec<GovernanceNotification> = raw_items
            .iter()
            .filter_map(|s| match serde_json::from_str(s) {
                Ok(n) => Some(n),
                Err(e) => {
                    debug!(error = %e, "Failed to parse notification JSON");
                    None
                }
            })
            .collect();

        debug!(
            session_id,
            count = notifications.len(),
            "Drained governance notifications from Valkey"
        );

        Ok(notifications)
    }

    /// Atomically drain all pending workspace-level notifications.
    ///
    /// Workspace notifications are queued by cron jobs (e.g. context gap
    /// suggestions) and delivered to whichever session drains them first.
    /// Uses the same atomic MULTI/EXEC pattern as `drain_notifications()`.
    pub async fn drain_workspace_notifications(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<GovernanceNotification>> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let key = format!("gov:notify:workspace:{}", workspace_id);

        // Fast path — most requests have no workspace-level notifications
        let len: usize = conn.llen(&key).await.unwrap_or(0);
        if len == 0 {
            return Ok(Vec::new());
        }

        // Atomic read + delete via pipeline
        let mut pipe = redis::pipe();
        pipe.atomic()
            .cmd("LRANGE")
            .arg(&key)
            .arg(0i64)
            .arg(-1i64)
            .cmd("DEL")
            .arg(&key);

        let (raw_items, _deleted): (Vec<String>, i64) = pipe.query_async(&mut conn).await?;

        let notifications: Vec<GovernanceNotification> = raw_items
            .iter()
            .filter_map(|s| match serde_json::from_str(s) {
                Ok(n) => Some(n),
                Err(e) => {
                    debug!(error = %e, "Failed to parse workspace notification JSON");
                    None
                }
            })
            .collect();

        debug!(
            workspace_id,
            count = notifications.len(),
            "Drained workspace governance notifications from Valkey"
        );

        Ok(notifications)
    }
}
