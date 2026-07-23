//! Plaintext formatter for governance notification blocks.
//!
//! Used by harnesses that don't render markdown well:
//! Aider, Codex, n8n, Continue, Goose.

use crate::postprocessor::formatter::GovernanceFormatter;
use crate::postprocessor::notification_client::GovernanceNotification;

/// Formats governance notifications as plain text.
pub struct PlaintextFormatter;

impl GovernanceFormatter for PlaintextFormatter {
    fn format(&self, notifications: &[GovernanceNotification]) -> String {
        let mut output = String::with_capacity(512);
        output.push_str("\n\n--- Intutic Governance ---\n\n");

        for notification in notifications {
            let priority_tag = match notification.priority.as_str() {
                "CRITICAL" => "[CRITICAL]",
                "HIGH" => "[HIGH]",
                "MEDIUM" => "[MEDIUM]",
                "INFO" => "[INFO]",
                _ => "[NOTICE]",
            };

            let category_label = match notification.category.as_str() {
                "anomaly" => "Anomaly",
                "budget" => "Budget",
                "ssl_violation" => "SOP Violation",
                "decision" => "Decision",
                "incident" => "Incident",
                "corrective" => "Corrective",
                "system" => "System",
                _ => "Notice",
            };

            output.push_str(&format!(
                "{} {}: {}\n{}\n",
                priority_tag, category_label, notification.title, notification.body
            ));

            if let Some(url) = &notification.action_url {
                output.push_str(&format!("  -> {}\n", url));
            }
            output.push('\n');
        }

        output.push_str("--- End Governance ---\n");
        output
    }
}
