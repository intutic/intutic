//! OpenAI Decisions API (`POST /v1/decisions`), as customer traffic.
//!
//! A request names a `model`, an `input` (a string, or user messages with
//! `input_text` / `input_image` parts) and `questions[]`, each `{name, type,
//! instructions, …}` with `type` one of `predicate` (yes/no), `choice`
//! (`choices: [{value, description}]`) or `score` (`levels: [{label,
//! description}]`, lowest first). OpenAI documents no `box` type.
//!
//! A response is `{model, answers[], usage}`, the answers in question order,
//! each naming its question: `{type: "predicate", name, probability}`,
//! `{type: "choice", name, choice, probabilities: [{value, probability}],
//! confidence}`, `{type: "score", name, score, probabilities: [{value, label,
//! probability}], confidence}`, or `{type: "refusal", name}` for a question
//! the model did not answer.
//!
//! Recorded shapes: `tests/fixtures/decision-traffic/decisions.json`.

use serde_json::Value;

use super::systemone::distribution;
use super::{
    option_name, probability, state_text, usage_count, Answer, DecisionQuestion, DecisionRequest,
    DecisionResponse, QuestionType,
};

fn question_type(t: &str) -> Option<QuestionType> {
    match t {
        "predicate" => Some(QuestionType::YesNo),
        "choice" => Some(QuestionType::Choice),
        "score" => Some(QuestionType::Score),
        _ => None,
    }
}

/// The name a question or answer goes by: `name`, or the older `id`.
fn name_of(v: &Value) -> Option<String> {
    v.get("name")
        .or_else(|| v.get("id"))
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

fn options(q: &Value, key: &str, field: &str) -> Option<Vec<String>> {
    q.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.get(field).and_then(option_name))
            .collect()
    })
}

pub fn parse_request(body: &Value) -> Result<DecisionRequest, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .ok_or("a Decisions request names no model")?;
    let input = body
        .get("input")
        .filter(|s| !s.is_null())
        .ok_or("a Decisions request has no input")?;
    let questions = body
        .get("questions")
        .and_then(Value::as_array)
        .filter(|q| !q.is_empty())
        .ok_or("a Decisions request has no questions array")?;
    let questions = questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let name = name_of(q).ok_or_else(|| format!("question {i} has no name"))?;
            let t = q.get("type").and_then(Value::as_str).unwrap_or_default();
            let qtype = question_type(t)
                .ok_or_else(|| format!("question {name} has an unknown type {t:?}"))?;
            let options = match qtype {
                QuestionType::Choice => options(q, "choices", "value"),
                QuestionType::Score => options(q, "levels", "label"),
                QuestionType::YesNo | QuestionType::Box => None,
            };
            Ok(DecisionQuestion {
                name,
                qtype,
                options,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(DecisionRequest {
        model: model.to_string(),
        state: state_text(input),
        questions,
    })
}

fn answer(a: &Value) -> Answer {
    match a.get("type").and_then(Value::as_str) {
        Some("predicate") => {
            probability(a.get("probability")).map_or(Answer::Unanswered, Answer::YesProbability)
        }
        Some("choice") | Some("score") => {
            distribution(a.get("probabilities")).map_or(Answer::Unanswered, Answer::Distribution)
        }
        _ => Answer::Unanswered,
    }
}

pub fn parse_response(body: &Value) -> DecisionResponse {
    let answers = body
        .get("answers")
        .and_then(Value::as_array)
        .map(|answers| {
            answers
                .iter()
                .filter_map(|a| name_of(a).map(|n| (n, answer(a))))
                .collect()
        })
        .unwrap_or_default();
    DecisionResponse {
        model_version: body
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        answers,
        input_tokens: usage_count(body, &["input_tokens", "prompt_tokens"]),
        output_tokens: usage_count(body, &["output_tokens", "completion_tokens"]),
    }
}
