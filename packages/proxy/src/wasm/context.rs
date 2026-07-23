//! RequestContext — the data structure passed to WASM plugins.

use serde::{Deserialize, Serialize};

/// Enforcement verdict returned by each WASM plugin.
/// Maps to shared-types EnforcementAction enum.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Verdict {
    /// Allow the request to proceed unmodified
    Bypass,
    /// Allow but inject additional context
    Enhance { context: String },
    /// Hold the request, render a decision card for human review
    Hijack { reason: String, confidence: f64 },
    /// Block the request immediately
    Kill {
        reason: String,
        policy_id: Option<String>,
    },
}

/// Risk level from PCAS permission resolution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

/// Tool schema definition (subset of OpenAI/Anthropic tool format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: Option<String>,
}

/// Tool call extracted from the request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// DLP finding from the bidirectional scanner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlpFinding {
    pub category: String,     // "secret", "pii", "credential"
    pub pattern_name: String, // "aws_key", "ssn", "github_token"
    pub action: String,       // "redact", "block"
    pub offset: usize,
    pub length: usize,
}

/// Context passed to WASM plugins on each request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestContext {
    pub session_id: String,
    pub workspace_id: String,
    pub virtual_key_prefix: String,
    pub model: String,
    pub tools: Vec<ToolSchema>,
    pub tool_calls: Vec<ToolCall>,
    pub estimated_input_tokens: u32,
    pub budget_remaining_usd: f64,
    pub risk_tier: RiskLevel,
    pub dlp_findings: Vec<DlpFinding>,
    pub tool_sequence: Vec<String>,
}

/// Context passed to WASM plugins on each response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseContext {
    pub session_id: String,
    pub workspace_id: String,
    pub model: String,
    pub output_tokens: u32,
    pub actual_cost_usd: f64,
    pub response_tool_calls: Vec<ToolCall>,
    pub dlp_findings: Vec<DlpFinding>,
}
