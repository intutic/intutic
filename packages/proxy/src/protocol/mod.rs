//! Protocol adapters — translate between harness wire formats and internal canonical format.

pub mod anthropic;
pub mod gemini;
pub mod openai;
pub mod tool_use_parser;

/// Detected wire protocol
#[derive(Debug, Clone, PartialEq)]
pub enum Protocol {
    /// Anthropic Messages API (/v1/messages) — Claude Code
    Anthropic,
    /// OpenAI Chat Completions (/v1/chat/completions) — Cursor
    OpenAIChatCompletions,
    /// OpenAI Responses API (/v1/responses) — Codex CLI
    OpenAIResponses,
    /// Google Gemini v1beta (/v1beta/models/...) — Antigravity
    Gemini,
    /// Unknown protocol
    Unknown,
}

/// Detect protocol from request path
pub fn detect(path: &str) -> Protocol {
    if path.starts_with("/v1beta/") {
        Protocol::Gemini
    } else if path == "/v1/messages" {
        Protocol::Anthropic
    } else if path == "/v1/responses" {
        Protocol::OpenAIResponses
    } else if path == "/v1/chat/completions" {
        Protocol::OpenAIChatCompletions
    } else {
        Protocol::Unknown
    }
}
