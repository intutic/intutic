//! Governance block formatter trait.
//!
//! Defines the interface that all formatters must implement to render
//! governance notifications into text blocks appended to LLM responses.

use crate::postprocessor::notification_client::GovernanceNotification;

/// Trait for formatting governance notifications into a text block.
///
/// Implementations produce format-specific output (markdown, plaintext, etc.)
/// that is appended to the LLM response stream.
pub trait GovernanceFormatter {
    /// Format a list of notifications into a single text block.
    ///
    /// Notifications are pre-sorted by priority (CRITICAL first).
    /// The returned string is appended as-is to the response stream.
    fn format(&self, notifications: &[GovernanceNotification]) -> String;
}
