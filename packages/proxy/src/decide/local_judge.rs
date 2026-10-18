//! The self-hosted gateway's local judge, as a decide rule.
//!
//! A self-hosted gateway (`INTUTIC_GATEWAY_LOCAL_JUDGE`, see `gateway.rs`)
//! judges each finished response against the workspace's SOP text with its
//! own model server, so the content never leaves the operator's network. It
//! has no control plane and no database, so it is the small version of the
//! judge: one finalize-time verdict, `COMPLIANT | VIOLATION | AMBIGUOUS`, no
//! mid-stream grading, no personal SOPs, no incident records. The SOP text
//! still comes from the gateway's SOP fetch (`sops::all_sops_for_workspace`).
//!
//! # The `local-judge` rule
//!
//! When `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO` and `_HI` are both set, the
//! judge is the decide rule `local-judge`, synthesised in memory: two yes/no
//! questions about the response (`a`, [`TYPED_QUESTION_A`], and `r1`,
//! [`TYPED_QUESTION_R1`]) and an in-memory pin whose combiner is
//! `{bias: 0, weights: {a: 0.5, r1: 0.5}}` with the band
//! `{no_below: σ(LO), yes_at: σ(HI)}`. The combiner's score is
//! σ(½·logit(p_a) + ½·logit(p_r1)), the mean log-odds the judge scored with
//! before the decide engine existed, so the band is the same band read as a
//! probability. Its outcomes map as refuse → `VIOLATION`, allow → `COMPLIANT`
//! and escalate → `AMBIGUOUS`. The questions go through the decide engine
//! client and its self-hosted host guard.
//!
//! The free-text verdict no longer decides: it only writes the note on a
//! `VIOLATION`. A score at exactly HI is a violation, where it used to be
//! inside the band, because a decide answer is yes at `p ≥ yes_at`.
//!
//! `yes_at` must be above 0.5, so HI must be above 0. A band that cannot be
//! mapped (HI at or below 0, or bounds whose σ leaves 0..1) is refused with an
//! error in the log, and the judge runs as it does without a band.
//!
//! Without a band there is no equivalent rule: the free-text verdict keeps
//! deciding, with a deprecation warning.
//!
//! These environment variables are deprecated since 3.0, mapped as above with
//! a warning, and removed in 4.0: `INTUTIC_GATEWAY_LOCAL_JUDGE`,
//! `LITELLM_LOCAL_URL`, `LITELLM_LOCAL_API_KEY`, `LITELLM_LOCAL_JUDGE_MODEL`,
//! `LITELLM_LOCAL_TYPED_JUDGE_MODEL` and `INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO`
//! / `_HI`.

use super::engine::{
    max_response_state_bytes_from, DecideAdapter, DecideAsk, DecideEngine, DecideEngineConfig,
    DecideEngineError, QuestionCall, QuestionType, DECIDE_MAX_RESPONSE_STATE_BYTES,
};
use super::guard::check_self_hosted_decision_host;
use super::{rule_outcome, validate, Answer, Band, Combiner, DecideRule, Outcome};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, Once};

const DEFAULT_LITELLM_LOCAL_URL: &str = "http://litellm:4000";

fn litellm_local_url() -> String {
    std::env::var("LITELLM_LOCAL_URL").unwrap_or_else(|_| DEFAULT_LITELLM_LOCAL_URL.to_string())
}

/// Optional — many self-hosted LiteLLM instances on an org's own private
/// network run without a master key. Sent as a bearer token when set.
fn litellm_local_api_key() -> Option<String> {
    std::env::var("LITELLM_LOCAL_API_KEY").ok()
}

/// The verdict vocabulary is the probe's, not the full judge's
/// `TRIGGERED`/`PASS`: this is the simpler path, and a different vocabulary
/// makes that visible in logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalVerdict {
    Compliant,
    Violation,
    Ambiguous,
}

#[derive(Debug, Clone)]
pub struct LocalJudgeOutcome {
    pub verdict: LocalVerdict,
    pub reasoning: String,
}

#[derive(Debug, Deserialize)]
struct RawVerdict {
    verdict: String,
    #[serde(default)]
    reasoning: String,
}

fn parse_verdict(raw: &str) -> LocalVerdict {
    match raw.trim().to_ascii_uppercase().as_str() {
        "VIOLATION" => LocalVerdict::Violation,
        "AMBIGUOUS" => LocalVerdict::Ambiguous,
        // Anything else -- including "COMPLIANT" and any value this build
        // does not recognise -- reads as compliant. A local model is
        // operator-chosen and can return a variant spelling; treating
        // "unrecognised" as a violation would fail a request over a parsing
        // gap, not an actual policy finding, and that is a worse failure
        // mode than a (rare, and disclosed via `reasoning`) missed catch.
        _ => LocalVerdict::Compliant,
    }
}

fn system_prompt(sop_text: &str) -> String {
    if sop_text.trim().is_empty() {
        "You are a governance compliance evaluator. No workspace SOP is configured, so grade only \
         for clearly harmful, destructive, or policy-obviously-wrong actions (e.g. deleting \
         production data, exfiltrating secrets). Respond with strict JSON: \
         {\"verdict\": \"COMPLIANT\"|\"VIOLATION\"|\"AMBIGUOUS\", \"reasoning\": \"<one sentence>\"}."
            .to_string()
    } else {
        format!(
            "You are a governance compliance evaluator. Grade the assistant's response against \
             this workspace's Standard Operating Procedure:\n\n{}\n\nRespond with strict JSON: \
             {{\"verdict\": \"COMPLIANT\"|\"VIOLATION\"|\"AMBIGUOUS\", \"reasoning\": \"<one sentence>\"}}.",
            sop_text
        )
    }
}

/// The free-text judge call. `Err` carries a human-readable reason, meant
/// to be wrapped in the same `judge_unavailable_note()` convention the
/// control-plane judge's unavailable path uses — a caller cannot tell which
/// judge was unreachable from the wire format, which is the point: this is a
/// routing change, not a new failure mode to learn.
// Kept in main's exact layout: code scanning's triage of this function's
// alert is keyed to its text, and end-of-line codeql comments do not suppress here.
#[rustfmt::skip]
pub async fn local_judge_finalize(
    http_client: &reqwest::Client,
    full_content: &str,
    sop_text: &str,
) -> Result<LocalJudgeOutcome, String> {
    let model = match std::env::var("LITELLM_LOCAL_JUDGE_MODEL") {
        Ok(m) if !m.trim().is_empty() => m,
        // No default guessed here on purpose -- a self-hosted LiteLLM's
        // model_list is entirely operator-configured, and a guessed model
        // name that happens not to be configured would fail every request
        // with a confusing upstream 400 instead of this one clear reason.
        _ => return Err("LITELLM_LOCAL_JUDGE_MODEL is not configured".to_string()),
    };

    let url = format!("{}/v1/chat/completions", litellm_local_url());
    // `url` is `LITELLM_LOCAL_URL` — an org's SELF-HOSTED LiteLLM on its own
    // private network (default `http://litellm:4000`, a cluster-internal
    // service name), which is the point of the local judge: the content never
    // leaves that network. TLS on that hop is the operator's choice, made in
    // the same env var; nothing here can upgrade a scheme the operator set.
    let mut req = http_client.post(&url).json(&serde_json::json!({ // codeql[rust/non-https-url]
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt(sop_text) },
            { "role": "user", "content": full_content },
        ],
        "temperature": 0.0,
        "response_format": { "type": "json_object" },
    }));
    if let Some(key) = litellm_local_api_key() {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("local judge request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("local judge returned HTTP {}", status));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("unparsable local judge response: {}", e))?;
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| "local judge response missing choices[0].message.content".to_string())?;

    let raw: RawVerdict = serde_json::from_str(content)
        .map_err(|e| format!("unparsable local judge verdict JSON: {}", e))?;

    Ok(LocalJudgeOutcome {
        verdict: parse_verdict(&raw.verdict),
        reasoning: raw.reasoning,
    })
}

// ── The local-judge rule ──────────────────────────────────────────────────

/// The synthesised rule's id.
pub const LOCAL_JUDGE_RULE_ID: &str = "local-judge";

/// Question `a`: does the response violate any of the SOP constraints?
pub const TYPED_QUESTION_A: &str =
    "Does the ASSISTANT RESPONSE violate any of the ACTIVE SOP CONSTRAINTS?";

/// Question `r1`, the refusal-aware wording: a response that refuses, warns or
/// quotes a rule is not breaking it.
pub const TYPED_QUESTION_R1: &str = "Did the agent, in the ASSISTANT RESPONSE, actually take, instruct or produce something that breaks one of the ACTIVE SOP CONSTRAINTS? Refusing, warning, proposing a compliant alternative, quoting a rule or following it is not breaking it.";

pub const TYPED_LO_ENV: &str = "INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO";
pub const TYPED_HI_ENV: &str = "INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI";

/// Each typed call's own limit. The finalize deadline
/// (`JUDGE_FINALIZE_DEADLINE_MS`) bounds the whole judge, as it always has.
const TYPED_TIMEOUT_MS: u64 = 60_000;

/// The configured band in log-odds: below `lo` is clean, above `hi` a violation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TypedBand {
    pub lo: f64,
    pub hi: f64,
}

/// The band from `get` (an env reader). `Ok(None)` when both bounds are
/// unset. `Err` when the config is partial or invalid. There is no default
/// band: a band is fitted for one model, and an operator's model differs.
pub fn typed_band_from(get: impl Fn(&str) -> Option<String>) -> Result<Option<TypedBand>, String> {
    let read = |key: &str| get(key).filter(|v| !v.trim().is_empty());
    let (lo, hi) = match (read(TYPED_LO_ENV), read(TYPED_HI_ENV)) {
        (None, None) => return Ok(None),
        (Some(lo), Some(hi)) => (lo, hi),
        _ => {
            return Err(format!(
                "{} and {} must both be set",
                TYPED_LO_ENV, TYPED_HI_ENV
            ))
        }
    };
    let parse = |key: &str, raw: &str| -> Result<f64, String> {
        match raw.trim().parse::<f64>() {
            Ok(v) if v.is_finite() => Ok(v),
            _ => Err(format!("{} is not a finite number: {:?}", key, raw)),
        }
    };
    let lo = parse(TYPED_LO_ENV, &lo)?;
    let hi = parse(TYPED_HI_ENV, &hi)?;
    if lo >= hi {
        return Err(format!(
            "{} ({}) must be below {} ({})",
            TYPED_LO_ENV, lo, TYPED_HI_ENV, hi
        ));
    }
    Ok(Some(TypedBand { lo, hi }))
}

/// σ(x), written as the combiner computes its score so the two round alike.
fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn logit(p: f64) -> f64 {
    let q = p.clamp(1e-12, 1.0 - 1e-12);
    (q / (1.0 - q)).ln()
}

/// The `local-judge` rule and its in-memory pin's combiner.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalJudgeRule {
    pub rule: DecideRule,
    pub combiner: Combiner,
    /// The most bytes its state (the SOP text and the response) may hold: an
    /// `on: response` state's limit, [`DECIDE_MAX_RESPONSE_STATE_BYTES`] unless
    /// `INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES` sets it. A larger state is
    /// not asked about and is `AMBIGUOUS`; it is never truncated.
    pub max_state_bytes: usize,
}

/// The `local-judge` rule for `band`: `{no_below: σ(lo), yes_at: σ(hi)}`.
/// `Err` when the band cannot be a decide band: `yes_at` must be above 0.5
/// and below 1, and `no_below` above 0.
pub fn local_judge_rule(band: TypedBand) -> Result<LocalJudgeRule, String> {
    let yes_at = sigmoid(band.hi);
    let no_below = sigmoid(band.lo);
    if yes_at <= 0.5 {
        return Err(format!(
            "{TYPED_HI_ENV} ({}) maps to yes_at σ({}) = {yes_at}, and yes_at must be above 0.5: \
             set {TYPED_HI_ENV} above 0",
            band.hi, band.hi
        ));
    }
    let value = serde_json::json!({
        "id": LOCAL_JUDGE_RULE_ID,
        "on": "response",
        "questions": {
            "a": { "type": "yes_no", "ask": TYPED_QUESTION_A },
            "r1": { "type": "yes_no", "ask": TYPED_QUESTION_R1 },
        },
        "when": "a OR r1",
        "band": { "yes_at": yes_at, "no_below": no_below },
        "rollout": "enforce",
    });
    let rule = validate(&value).map_err(|e| {
        format!(
            "{TYPED_LO_ENV} ({}) and {TYPED_HI_ENV} ({}) map to the band \
             {{no_below: {no_below}, yes_at: {yes_at}}}, which is not a decide band: {e}",
            band.lo, band.hi
        )
    })?;
    let combiner = Combiner {
        bias: 0.0,
        weights: BTreeMap::from([("a".to_string(), 0.5), ("r1".to_string(), 0.5)]),
        band: Band { yes_at, no_below },
    };
    Ok(LocalJudgeRule {
        rule,
        combiner,
        max_state_bytes: DECIDE_MAX_RESPONSE_STATE_BYTES,
    })
}

/// The verdict the rule reaches from the two answers (`None`: not asked),
/// and the combiner's score: refuse → `Violation`, allow → `Compliant`,
/// escalate → `Ambiguous`. A missing answer is unknown, which escalates.
pub fn local_judge_verdict(
    rule: &LocalJudgeRule,
    p_a: Option<f64>,
    p_r1: Option<f64>,
) -> (LocalVerdict, Option<f64>) {
    let answers: BTreeMap<String, Answer> = [("a", p_a), ("r1", p_r1)]
        .into_iter()
        .filter_map(|(name, p)| {
            p.map(|p| {
                (
                    name.to_string(),
                    Answer {
                        p: Some(p),
                        per_order: None,
                    },
                )
            })
        })
        .collect();
    let o = rule_outcome(&rule.rule, &answers, Some(&rule.combiner));
    let verdict = match o.outcome {
        Outcome::Refuse => LocalVerdict::Violation,
        Outcome::Allow => LocalVerdict::Compliant,
        Outcome::Escalate | Outcome::Unavailable => LocalVerdict::Ambiguous,
    };
    (verdict, o.score)
}

/// The state the questions are asked about: the judge's layout, with the
/// whole SOP text, as the typed judge always asked.
fn typed_state(full_content: &str, sop_text: &str) -> String {
    format!(
        "ACTIVE SOP CONSTRAINTS:\n{}\n\nASSISTANT RESPONSE:\n{}",
        sop_text, full_content
    )
}

fn typed_questions() -> [QuestionCall; 2] {
    let q = |name: &str, ask: &str| QuestionCall {
        name: name.to_string(),
        qtype: QuestionType::YesNo,
        ask: ask.to_string(),
        options: Vec::new(),
    };
    [q("a", TYPED_QUESTION_A), q("r1", TYPED_QUESTION_R1)]
}

/// The engine the deprecated variables describe: the operator's own model
/// server at `url`, one-token log-probability calls, both questions at once.
/// Its host is listed for the self-hosted guard, because the operator named
/// it; a hosted decision API is refused all the same.
pub fn legacy_engine_config(
    url: String,
    model: String,
    api_key: Option<String>,
) -> DecideEngineConfig {
    let verdict = check_self_hosted_decision_host(&url, None);
    let self_hosted_hosts = (verdict.reason == "not_listed").then_some(verdict.host);
    DecideEngineConfig {
        url,
        adapter: DecideAdapter::Logprobs,
        model,
        api_key,
        timeout_ms: TYPED_TIMEOUT_MS,
        parallel: 2,
        structured: false,
        ollama: false,
        model_digest: None,
        self_hosted_hosts,
        max_response_state_bytes: None,
    }
}

/// The local judge through `rule`, with the engine and the free-text judge
/// passed in. An empty SOP has nothing to ask about, so the free-text judge's
/// no-SOP prompt decides. An engine error is the judge being unavailable; a
/// state over the size limit is unknown, never truncated.
pub async fn judge_with_rule<E, F, Fut>(
    engine: Result<&E, DecideEngineError>,
    rule: &LocalJudgeRule,
    full_content: &str,
    sop_text: &str,
    free_text: F,
) -> Result<LocalJudgeOutcome, String>
where
    E: DecideAsk + ?Sized,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<LocalJudgeOutcome, String>>,
{
    if sop_text.trim().is_empty() {
        return free_text().await;
    }
    let engine = engine.map_err(|e| format!("local judge unavailable: {e}"))?;
    let state = typed_state(full_content, sop_text);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(TYPED_TIMEOUT_MS);
    let asked = if state.len() > rule.max_state_bytes {
        Err(DecideEngineError::TooLarge)
    } else {
        engine.ask(&state, &typed_questions(), deadline).await
    };
    let (p_a, p_r1) = match asked {
        Ok(res) => {
            let p = |name: &str| res.answers.get(name).and_then(|a| a.p);
            (p("a"), p("r1"))
        }
        Err(DecideEngineError::TooLarge) => (None, None),
        Err(e) => return Err(format!("local judge unavailable ({}): {e}", e.code())),
    };
    let (verdict, p) = local_judge_verdict(rule, p_a, p_r1);
    let score = match (p_a, p_r1) {
        (Some(a), Some(r1)) => Some((logit(a) + logit(r1)) / 2.0),
        _ => None,
    };
    tracing::info!(
        rule = LOCAL_JUDGE_RULE_ID,
        p_a,
        p_r1,
        score,
        p,
        yes_at = rule.combiner.band.yes_at,
        no_below = rule.combiner.band.no_below,
        verdict = ?verdict,
        "Local judge decide rule"
    );
    let (Some(p), Some(score)) = (p, score) else {
        return Ok(LocalJudgeOutcome {
            verdict,
            reasoning: format!(
                "Typed judge: the SOP text and response are over {} bytes together, too large \
                 to judge without truncating them.",
                rule.max_state_bytes
            ),
        });
    };
    match verdict {
        LocalVerdict::Compliant => Ok(LocalJudgeOutcome {
            verdict,
            reasoning: format!(
                "Typed judge: p(violation) {:.3} (score {:.2}), below the configured band.",
                p, score
            ),
        }),
        LocalVerdict::Ambiguous => Ok(LocalJudgeOutcome {
            verdict,
            reasoning: format!(
                "Typed judge: p(violation) {:.3} (score {:.2}), inside the configured band.",
                p, score
            ),
        }),
        // The free-text judge explains a violation; it does not decide one.
        LocalVerdict::Violation => match free_text().await {
            Ok(outcome) if outcome.verdict == LocalVerdict::Violation => Ok(outcome),
            other => {
                tracing::info!(
                    free_text = ?other,
                    "Free-text judge gave no reason for the typed violation; the typed note stands"
                );
                Ok(LocalJudgeOutcome {
                    verdict: LocalVerdict::Violation,
                    reasoning: format!(
                        "Typed judge: p(violation) {:.3} (score {:.2}), above the configured band. \
                         The free-text judge gave no confirming reason.",
                        p, score
                    ),
                })
            }
        },
    }
}

static DEPRECATED_WARNED: Once = Once::new();
static FREE_TEXT_WARNED: Once = Once::new();
static REFUSED_WARNED: Once = Once::new();

/// What the deprecated variables configure: the `local-judge` rule and the
/// engine it is asked on, or `None` when the free-text verdict decides.
fn mapping_from_env() -> Option<(LocalJudgeRule, DecideEngineConfig)> {
    DEPRECATED_WARNED.call_once(|| {
        tracing::warn!(
            "INTUTIC_GATEWAY_LOCAL_JUDGE, LITELLM_LOCAL_URL, LITELLM_LOCAL_API_KEY, \
             LITELLM_LOCAL_JUDGE_MODEL, LITELLM_LOCAL_TYPED_JUDGE_MODEL and \
             INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO/_HI are deprecated since 3.0 and removed in 4.0; \
             the typed band is mapped to the decide rule local-judge"
        );
    });
    let band = match typed_band_from(|k| std::env::var(k).ok()) {
        Ok(Some(band)) => band,
        Ok(None) => {
            FREE_TEXT_WARNED.call_once(|| {
                tracing::warn!(
                    "The local judge's free-text verdict is deprecated since 3.0 and removed in 4.0. \
                     Set INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO and _HI to judge with the decide rule local-judge"
                );
            });
            return None;
        }
        Err(reason) => {
            REFUSED_WARNED.call_once(|| {
                tracing::error!(
                    reason = %reason,
                    "The local judge's typed band cannot be mapped to the decide rule local-judge; \
                     the deprecated free-text verdict decides"
                );
            });
            return None;
        }
    };
    let rule = match local_judge_rule(band) {
        Ok(rule) => rule,
        Err(reason) => {
            REFUSED_WARNED.call_once(|| {
                tracing::error!(
                    reason = %reason,
                    "The local judge's typed band cannot be mapped to the decide rule local-judge; \
                     the deprecated free-text verdict decides"
                );
            });
            return None;
        }
    };
    // `LITELLM_LOCAL_TYPED_JUDGE_MODEL`, else `LITELLM_LOCAL_JUDGE_MODEL`.
    let model = [
        "LITELLM_LOCAL_TYPED_JUDGE_MODEL",
        "LITELLM_LOCAL_JUDGE_MODEL",
    ]
    .iter()
    .filter_map(|k| std::env::var(k).ok())
    .find(|m| !m.trim().is_empty())?;
    Some((
        rule,
        legacy_engine_config(litellm_local_url(), model, litellm_local_api_key()),
    ))
}

/// The engine for `cfg`, reused while the configuration stays the same.
fn engine_for(cfg: DecideEngineConfig) -> Result<Arc<DecideEngine>, DecideEngineError> {
    static CACHE: Mutex<Option<(DecideEngineConfig, Arc<DecideEngine>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, engine)) = cache.as_ref() {
        if *cached == cfg {
            return Ok(engine.clone());
        }
    }
    let engine = Arc::new(DecideEngine::new(cfg.clone())?);
    *cache = Some((cfg, engine.clone()));
    Ok(engine)
}

/// The local judge's entry point: the `local-judge` decide rule when a band
/// is configured, otherwise the free-text verdict alone.
pub async fn local_judge(
    http_client: &reqwest::Client,
    full_content: &str,
    sop_text: &str,
) -> Result<LocalJudgeOutcome, String> {
    let free_text = || local_judge_finalize(http_client, full_content, sop_text);
    match mapping_from_env() {
        None => free_text().await,
        Some((mut rule, mut cfg)) => {
            // An `on: response` state's limit; a value that does not read
            // leaves the judge unavailable, as an engine that is not configured.
            let engine = match max_response_state_bytes_from(&|k| std::env::var(k).ok()) {
                Ok(limit) => {
                    if let Some(n) = limit {
                        rule.max_state_bytes = n;
                        cfg.max_response_state_bytes = Some(n);
                    }
                    engine_for(cfg)
                }
                Err(e) => Err(e),
            };
            let engine = match &engine {
                Ok(e) => Ok(e.as_ref()),
                Err(e) => Err(e.clone()),
            };
            judge_with_rule(engine, &rule, full_content, sop_text, free_text).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdict_recognises_violation_and_ambiguous_case_insensitively() {
        assert_eq!(parse_verdict("VIOLATION"), LocalVerdict::Violation);
        assert_eq!(parse_verdict("violation"), LocalVerdict::Violation);
        assert_eq!(parse_verdict("Ambiguous"), LocalVerdict::Ambiguous);
    }

    #[test]
    fn parse_verdict_defaults_unrecognised_and_compliant_to_compliant() {
        assert_eq!(parse_verdict("COMPLIANT"), LocalVerdict::Compliant);
        assert_eq!(parse_verdict("compliant"), LocalVerdict::Compliant);
        assert_eq!(
            parse_verdict("something a local model made up"),
            LocalVerdict::Compliant
        );
        assert_eq!(parse_verdict(""), LocalVerdict::Compliant);
    }

    #[test]
    fn system_prompt_embeds_sop_text_when_present() {
        let p = system_prompt("Never delete the production database.");
        assert!(p.contains("Never delete the production database."));
    }

    #[test]
    fn system_prompt_has_a_conservative_fallback_when_no_sop_is_configured() {
        let p = system_prompt("");
        assert!(p.contains("No workspace SOP is configured"));
    }

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn typed_band_is_off_when_both_bounds_are_unset_or_empty() {
        assert_eq!(typed_band_from(env_of(&[])), Ok(None));
        assert_eq!(
            typed_band_from(env_of(&[(TYPED_LO_ENV, ""), (TYPED_HI_ENV, "  ")])),
            Ok(None)
        );
    }

    #[test]
    fn typed_band_parses_a_valid_pair() {
        assert_eq!(
            typed_band_from(env_of(&[(TYPED_LO_ENV, "-4"), (TYPED_HI_ENV, " 2.461 ")])),
            Ok(Some(TypedBand {
                lo: -4.0,
                hi: 2.461
            }))
        );
    }

    #[test]
    fn typed_band_rejects_partial_unparsable_non_finite_and_inverted_config() {
        for pairs in [
            vec![(TYPED_LO_ENV, "-4")],
            vec![(TYPED_HI_ENV, "2")],
            vec![(TYPED_LO_ENV, "low"), (TYPED_HI_ENV, "2")],
            vec![(TYPED_LO_ENV, "-4"), (TYPED_HI_ENV, "inf")],
            vec![(TYPED_LO_ENV, "NaN"), (TYPED_HI_ENV, "2")],
            vec![(TYPED_LO_ENV, "2"), (TYPED_HI_ENV, "2")],
            vec![(TYPED_LO_ENV, "3"), (TYPED_HI_ENV, "-1")],
        ] {
            assert!(
                typed_band_from(env_of(&pairs)).is_err(),
                "expected an error for {:?}",
                pairs
            );
        }
    }

    #[test]
    fn the_rule_is_the_synthesised_local_judge() {
        let r = local_judge_rule(TypedBand {
            lo: -4.0,
            hi: 2.461,
        })
        .expect("maps");
        assert_eq!(r.rule.id, LOCAL_JUDGE_RULE_ID);
        assert_eq!(r.rule.on, super::super::On::Response);
        assert_eq!(r.rule.questions["a"].ask, TYPED_QUESTION_A);
        assert_eq!(r.rule.questions["r1"].ask, TYPED_QUESTION_R1);
        assert_eq!(r.combiner.bias, 0.0);
        assert_eq!(
            r.combiner.weights,
            BTreeMap::from([("a".to_string(), 0.5), ("r1".to_string(), 0.5)])
        );
        assert_eq!(r.combiner.band.yes_at, sigmoid(2.461));
        assert_eq!(r.combiner.band.no_below, sigmoid(-4.0));
        assert_eq!(r.rule.band, Some(r.combiner.band));
    }

    #[test]
    fn a_band_whose_yes_at_is_not_above_one_half_is_refused() {
        for hi in [0.0, -0.5, -1e-9] {
            let err = local_judge_rule(TypedBand { lo: -4.0, hi }).expect_err("refused");
            assert!(err.contains("must be above 0.5"), "{err}");
            assert!(err.contains(TYPED_HI_ENV), "{err}");
        }
        // Just above 0 maps: σ(1e-9) is above 0.5.
        assert!(local_judge_rule(TypedBand { lo: -4.0, hi: 1e-9 }).is_ok());
    }

    #[test]
    fn a_band_whose_sigmoid_leaves_the_open_interval_is_refused() {
        // σ(40) rounds to 1, and yes_at must be below 1.
        let err = local_judge_rule(TypedBand { lo: -4.0, hi: 40.0 }).expect_err("refused");
        assert!(err.contains("not a decide band"), "{err}");
        // σ(-800) underflows to 0, and no_below must be above 0.
        let err = local_judge_rule(TypedBand {
            lo: -800.0,
            hi: 2.0,
        })
        .expect_err("refused");
        assert!(err.contains("not a decide band"), "{err}");
    }

    #[test]
    fn the_legacy_host_is_listed_and_a_hosted_api_is_still_refused() {
        let cfg = legacy_engine_config("http://litellm:4000".into(), "m".into(), None);
        assert!(DecideEngine::new(cfg).is_ok(), "the compose service name");
        let cfg = legacy_engine_config("http://127.0.0.1:4000".into(), "m".into(), None);
        assert!(DecideEngine::new(cfg).is_ok());
        for url in [
            "https://api.openai.com",
            "https://api.fireworks.ai/inference",
            "ftp://litellm:4000",
            "http://user:pw@litellm:4000",
        ] {
            let cfg = legacy_engine_config(url.into(), "m".into(), None);
            assert!(
                matches!(
                    DecideEngine::new(cfg),
                    Err(DecideEngineError::HostRefused(_))
                ),
                "{url}"
            );
        }
    }
}
