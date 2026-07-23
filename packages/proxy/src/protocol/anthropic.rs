//! Anthropic Messages API adapter — passthrough.
//!
//! Claude Code sends requests to POST /v1/messages with ANTHROPIC_BASE_URL override.
//! This is the primary protocol — handled natively as passthrough.

/// Anthropic Messages API is handled natively as passthrough.
/// This module exists as a structural placeholder for any custom pre/post processing.
pub struct AnthropicAdapter;

impl AnthropicAdapter {
    /// No-op — Anthropic format is supported natively by the proxy
    pub fn new() -> Self {
        Self
    }
}

impl Default for AnthropicAdapter {
    fn default() -> Self {
        Self::new()
    }
}
