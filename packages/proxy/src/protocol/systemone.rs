//! System One decision API (`POST /v1/systemone`), as customer traffic.
//!
//! Spoken by TypeSafe (Jev), Fastino, and self-hosted Kev, Laya and LiteLLM
//! servers. A request names a `model`, a `state` (a string or JSON), and
//! `questions`, an object from question name to `{type, instructions, …}`
//! with `type` one of `noul` (yes/no), `choice`, `score` or `box`. A choice
//! lists its options as the keys of `criteria` (or an `options` array).
//!
//! A response carries `answers`, an object from question name to an answer of
//! the same type: `{type: "noul", noul: p}`, or `{type: "choice", choice,
//! confidence, probabilities: {option: p}}`; a score's `probabilities` are by
//! level. `model` and `version` name what answered.
//!
//! Recorded shapes: `tests/fixtures/decision-traffic/systemone.json`.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{
    option_name, probability, state_text, usage_count, Answer, DecisionQuestion, DecisionRequest,
    DecisionResponse, QuestionType,
};

fn question_type(t: &str) -> Option<QuestionType> {
    match t {
        "noul" => Some(QuestionType::YesNo),
        "choice" => Some(QuestionType::Choice),
        "score" => Some(QuestionType::Score),
        "box" => Some(QuestionType::Box),
        _ => None,
    }
}

/// A choice's or score's options: the keys of `criteria`, else the entries
/// of an `options`, `choices` or `levels` array (strings, or objects naming
/// `value` or `label`).
fn options(q: &Value) -> Option<Vec<String>> {
    if let Some(criteria) = q.get("criteria").and_then(Value::as_object) {
        return Some(criteria.keys().cloned().collect());
    }
    ["options", "choices", "levels"].iter().find_map(|k| {
        q.get(*k).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    option_name(item).or_else(|| {
                        item.get("value")
                            .or_else(|| item.get("label"))
                            .and_then(option_name)
                    })
                })
                .collect()
        })
    })
}

pub fn parse_request(body: &Value) -> Result<DecisionRequest, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .ok_or("a System One request names no model")?;
    let state = body
        .get("state")
        .filter(|s| !s.is_null())
        .ok_or("a System One request has no state")?;
    let questions = body
        .get("questions")
        .and_then(Value::as_object)
        .filter(|q| !q.is_empty())
        .ok_or("a System One request has no questions object")?;
    let questions = questions
        .iter()
        .map(|(name, q)| {
            let t = q.get("type").and_then(Value::as_str).unwrap_or_default();
            let qtype = question_type(t)
                .ok_or_else(|| format!("question {name} has an unknown type {t:?}"))?;
            Ok(DecisionQuestion {
                name: name.clone(),
                qtype,
                options: matches!(qtype, QuestionType::Choice | QuestionType::Score)
                    .then(|| options(q))
                    .flatten(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(DecisionRequest {
        model: model.to_string(),
        state: state_text(state),
        questions,
    })
}

/// A `probabilities` field as option → p: an object, or an array of
/// `{value|label, probability}`. Entries that are not probabilities are left out.
pub(crate) fn distribution(v: Option<&Value>) -> Option<BTreeMap<String, f64>> {
    let out: BTreeMap<String, f64> = match v? {
        Value::Object(map) => map
            .iter()
            .filter_map(|(k, p)| probability(Some(p)).map(|p| (k.clone(), p)))
            .collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                let name = item
                    .get("label")
                    .or_else(|| item.get("value"))
                    .and_then(option_name)?;
                probability(item.get("probability")).map(|p| (name, p))
            })
            .collect(),
        _ => return None,
    };
    (!out.is_empty()).then_some(out)
}

fn answer(a: &Value) -> Answer {
    match a.get("type").and_then(Value::as_str) {
        Some("noul") => {
            probability(a.get("noul")).map_or(Answer::Unanswered, Answer::YesProbability)
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
        .and_then(Value::as_object)
        .map(|answers| {
            answers
                .iter()
                .map(|(name, a)| (name.clone(), answer(a)))
                .collect()
        })
        .unwrap_or_default();
    let model_version = body.get("version").and_then(option_name).or_else(|| {
        body.get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    DecisionResponse {
        model_version,
        answers,
        input_tokens: usage_count(body, &["input_tokens", "prompt_tokens"]),
        output_tokens: usage_count(body, &["output_tokens", "completion_tokens"]),
    }
}
