//! Markdown formatter for governance notification blocks.
//!
//! Used by harnesses that render markdown natively:
//! Claude Code, Cursor, Windsurf, Antigravity, OpenHands, Cline, Roo Code.

use crate::postprocessor::formatter::GovernanceFormatter;
use crate::postprocessor::notification_client::GovernanceNotification;

/// Formats governance notifications as a markdown block with icons.
pub struct MarkdownFormatter;

impl GovernanceFormatter for MarkdownFormatter {
    fn format(&self, notifications: &[GovernanceNotification]) -> String {
        let mut output = String::with_capacity(1024);
        output.push_str("\n\n---\n");
        output.push_str("<!-- intutic:governance -->\n");
        output.push_str("### 🛡️ Intutic Governance\n\n");

        for notification in notifications {
            let icon = match notification.priority.as_str() {
                "CRITICAL" => "🔴",
                "HIGH" => "🟠",
                "MEDIUM" => "🟡",
                "INFO" => "🔵",
                _ => "⚪",
            };

            let category_label = match notification.category.as_str() {
                "anomaly" => "Anomaly Detected",
                "budget" => "Budget Alert",
                "ssl_violation" => "SOP Violation",
                "decision" => "Decision Pending",
                "incident" => "Incident Created",
                "corrective" => "Corrective Action",
                "system" => "System",
                _ => "Notice",
            };

            output.push_str(&format!(
                "{} **{}** — {}\n{}\n\n",
                icon, category_label, notification.title, notification.body
            ));

            if let Some(url) = &notification.action_url {
                output.push_str(&format!("[View in Dashboard]({})\n\n", url));
            }
        }

        output.push_str("<!-- /intutic:governance -->\n");
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_notification(priority: &str, category: &str, title: &str) -> GovernanceNotification {
        GovernanceNotification {
            notification_id: "ntf_test".to_string(),
            session_id: "ses_test".to_string(),
            workspace_id: "wk_test".to_string(),
            priority: priority.to_string(),
            category: category.to_string(),
            title: title.to_string(),
            body: "Test body text".to_string(),
            action_url: Some("/test".to_string()),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_single_notification_format() {
        let fmt = MarkdownFormatter;
        let notifications = vec![make_notification("CRITICAL", "anomaly", "Loop detected")];
        let result = fmt.format(&notifications);

        assert!(result.contains("🛡️ Intutic Governance"));
        assert!(result.contains("🔴"));
        assert!(result.contains("**Anomaly Detected**"));
        assert!(result.contains("Loop detected"));
        assert!(result.contains("[View in Dashboard](/test)"));
        assert!(result.contains("<!-- intutic:governance -->"));
    }

    #[test]
    fn test_multiple_notifications_format() {
        let fmt = MarkdownFormatter;
        let notifications = vec![
            make_notification("CRITICAL", "incident", "Security breach"),
            make_notification("MEDIUM", "budget", "80% consumed"),
        ];
        let result = fmt.format(&notifications);

        assert!(result.contains("🔴"));
        assert!(result.contains("🟡"));
        assert!(result.contains("Incident Created"));
        assert!(result.contains("Budget Alert"));
    }

    #[test]
    fn test_empty_notifications() {
        let fmt = MarkdownFormatter;
        let result = fmt.format(&[]);

        assert!(result.contains("🛡️ Intutic Governance"));
        // Should have header but no notification entries
        assert!(!result.contains("🔴"));
    }
}
