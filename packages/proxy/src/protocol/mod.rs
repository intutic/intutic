//! Protocol adapters — translate between harness wire formats and internal canonical format.

pub mod anthropic;
pub mod decisions;
pub mod gemini;
pub mod openai;
pub mod systemone;
pub mod tool_use_parser;

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

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
    /// System One decision API (/v1/systemone): TypeSafe, Fastino, and
    /// self-hosted Kev, Laya or LiteLLM servers. Customer decision traffic.
    SystemOne,
    /// OpenAI Decisions API (/v1/decisions). Customer decision traffic.
    OpenAIDecisions,
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
    } else if path == "/v1/systemone" {
        Protocol::SystemOne
    } else if path == "/v1/decisions" {
        Protocol::OpenAIDecisions
    } else {
        Protocol::Unknown
    }
}

impl Protocol {
    /// The decision format a request on this protocol speaks, or `None` for
    /// an LLM protocol.
    pub fn decision_format(&self) -> Option<DecisionFormat> {
        match self {
            Protocol::SystemOne => Some(DecisionFormat::SystemOne),
            Protocol::OpenAIDecisions => Some(DecisionFormat::Decisions),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Decision traffic: the normalised shape both decision formats parse to
// ---------------------------------------------------------------------------

/// The two decision-model wire formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionFormat {
    /// `POST /v1/systemone`.
    SystemOne,
    /// `POST /v1/decisions`.
    Decisions,
}

impl DecisionFormat {
    /// The name the decision-traffic log records.
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionFormat::SystemOne => "systemone",
            DecisionFormat::Decisions => "decisions",
        }
    }

    /// The request path the format is served on.
    pub fn path(self) -> &'static str {
        match self {
            DecisionFormat::SystemOne => "/v1/systemone",
            DecisionFormat::Decisions => "/v1/decisions",
        }
    }

    /// Reads a request body into the normalised shape.
    pub fn parse_request(self, body: &Value) -> Result<DecisionRequest, String> {
        match self {
            DecisionFormat::SystemOne => systemone::parse_request(body),
            DecisionFormat::Decisions => decisions::parse_request(body),
        }
    }

    /// Reads a response body into the normalised shape. Fields it cannot read
    /// are left out; it never fails, because the body is forwarded unchanged
    /// whatever it holds.
    pub fn parse_response(self, body: &Value) -> DecisionResponse {
        match self {
            DecisionFormat::SystemOne => systemone::parse_response(body),
            DecisionFormat::Decisions => decisions::parse_response(body),
        }
    }

    /// The JSON pointer to the field holding the state (`state` or `input`).
    pub fn state_field(self) -> &'static str {
        match self {
            DecisionFormat::SystemOne => "state",
            DecisionFormat::Decisions => "input",
        }
    }
}

/// A question's type, normalised across the two formats: System One's
/// `noul` and OpenAI's `predicate` are both `yes_no`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    YesNo,
    Choice,
    Score,
    /// An image region (System One only). It carries no probability.
    Box,
}

/// One question a decision request asks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DecisionQuestion {
    pub name: String,
    #[serde(rename = "type")]
    pub qtype: QuestionType,
    /// The options of a choice, or the level labels of a score.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

/// A decision request, normalised.
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionRequest {
    pub model: String,
    /// The state as it is sent: the string itself, or the serialised JSON of
    /// a structured state (System One JSON, OpenAI content parts).
    pub state: String,
    pub questions: Vec<DecisionQuestion>,
}

/// One question's answer, normalised.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Answer {
    /// The probability of yes, for a yes/no question.
    YesProbability(f64),
    /// A probability per option (choice) or per level label (score).
    Distribution(BTreeMap<String, f64>),
    /// No probability: the model refused, the answer is a box, or the field
    /// could not be read.
    Unanswered,
}

impl Answer {
    /// The probability of the answer the model leans to: `max(p, 1 − p)` for
    /// yes/no, the largest option otherwise; `None` with no probability.
    pub fn top_probability(&self) -> Option<f64> {
        match self {
            Answer::YesProbability(p) => Some(p.max(1.0 - p)),
            Answer::Distribution(d) => d.values().copied().reduce(f64::max),
            Answer::Unanswered => None,
        }
    }
}

/// A decision response, normalised.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DecisionResponse {
    /// The model version the upstream reports.
    pub model_version: Option<String>,
    /// One entry per answered question, by name.
    pub answers: BTreeMap<String, Answer>,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// A probability in `[0, 1]`, or `None`.
pub(crate) fn probability(v: Option<&Value>) -> Option<f64> {
    let p = v?.as_f64()?;
    (p.is_finite() && (0.0..=1.0).contains(&p)).then_some(p)
}

/// The state's bytes as they are sent: a string as is, anything else as its
/// serialised JSON.
pub(crate) fn state_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A JSON scalar as the option name it stands for: a string as is, a boolean
/// or number as its JSON text.
pub(crate) fn option_name(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(_) | Value::Number(_) => Some(v.to_string()),
        _ => None,
    }
}

/// A token count from the first of `keys` under `usage`.
pub(crate) fn usage_count(body: &Value, keys: &[&str]) -> u32 {
    let usage = body.get("usage");
    keys.iter()
        .find_map(|k| usage.and_then(|u| u.get(*k)).and_then(Value::as_u64))
        .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_both_decision_routes_and_nothing_else_as_decision_traffic() {
        assert_eq!(detect("/v1/systemone"), Protocol::SystemOne);
        assert_eq!(detect("/v1/decisions"), Protocol::OpenAIDecisions);
        assert_eq!(
            detect("/v1/systemone").decision_format(),
            Some(DecisionFormat::SystemOne)
        );
        assert_eq!(
            detect("/v1/decisions").decision_format(),
            Some(DecisionFormat::Decisions)
        );
        for p in [
            "/v1/messages",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1/decisions/x",
            "/v1/systemone/",
        ] {
            assert_eq!(detect(p).decision_format(), None, "{p}");
        }
    }

    #[test]
    fn top_probability_reads_the_leaning_answer() {
        assert_eq!(Answer::YesProbability(0.2).top_probability(), Some(0.8));
        assert_eq!(Answer::YesProbability(0.62).top_probability(), Some(0.62));
        let d: BTreeMap<String, f64> = [("a".to_string(), 0.3), ("b".to_string(), 0.6)].into();
        assert_eq!(Answer::Distribution(d).top_probability(), Some(0.6));
        assert_eq!(Answer::Unanswered.top_probability(), None);
    }
}
