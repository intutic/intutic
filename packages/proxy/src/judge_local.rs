//! Local judge for self-hosted gateways (LLD #68 §2 phase 2).
//!
//! The SaaS judge (`routes/judge.ts`) is not a small thing to port: SOP
//! registry lookup, personal-SOP merging, a Valkey-backed mid-stream
//! chunk-log reconciled at finalize time, and a `governance_incidents`
//! write on trigger. A self-hosted gateway's own compose/Helm shape is
//! deliberately proxy + Valkey (+ optional LiteLLM) with no Postgres, no
//! control plane — so a byte-for-byte port cannot run there; it depends on
//! tables that do not exist on that deployment target.
//!
//! This is a smaller, honest capability instead, modeled on the codebase's
//! own existing "simpler than the full judge" precedent
//! (`services/control-plane/src/services/llmProbeService.ts`): one flat
//! finalize-time call, `COMPLIANT | VIOLATION | AMBIGUOUS` verdicts, no
//! mid-stream chunk grading, no personal-SOPs merge, no incident
//! persistence. What it buys: the content being judged is POSTed to the
//! gateway's OWN LiteLLM instance, not `{CONTROL_PLANE_URL}/api/v1/judge/*`
//! — so for an org running this, judged content never leaves their
//! infrastructure. SOP *text* still comes from the existing gateway-mode
//! SOP fetch (`sops::all_sops_for_workspace`) — a real, disclosed
//! trade-off documented in LLD #68, not silently glossed over.
//!
//! Opt-in, off by default (`INTUTIC_GATEWAY_LOCAL_JUDGE`, see `gateway.rs`)
//! — a gateway that does not set it keeps calling `CONTROL_PLANE_URL`
//! exactly as before this module existed.

use serde::Deserialize;

const DEFAULT_LITELLM_LOCAL_URL: &str = "http://litellm:4000";

fn litellm_local_url() -> String {
    std::env::var("LITELLM_LOCAL_URL").unwrap_or_else(|_| DEFAULT_LITELLM_LOCAL_URL.to_string())
}

/// Optional — many self-hosted LiteLLM instances on an org's own private
/// network run without a master key. Sent as a bearer token when set.
fn litellm_local_api_key() -> Option<String> {
    std::env::var("LITELLM_LOCAL_API_KEY").ok()
}

/// Verdict vocabulary matches `llmProbeService.ts`, not `judge.ts`'s
/// `TRIGGERED`/`PASS` — this is the simpler path, and using a different
/// vocabulary from the SaaS judge makes that visible in logs rather than
/// pretending byte-for-byte parity.
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
        // does not recognise -- reads as compliant. A local model, unlike
        // the SaaS judge's fixed, tested model, is operator-chosen and can
        // return a variant spelling; treating "unrecognised" as a
        // violation would fail a request over a parsing gap, not an
        // actual policy finding, and that is a worse failure mode than a
        // (rare, and disclosed via `reasoning`) missed catch.
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

/// Finalize-time local judge call. `Err` carries a human-readable reason,
/// meant to be wrapped in the same `judge_unavailable_note()` convention
/// the SaaS-unavailable path already uses — a caller cannot tell "SaaS
/// judge unreachable" from "local judge unreachable" from the wire
/// format, which is the point: this is a routing change, not a new
/// failure mode to learn.
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

// ── Typed stage (LLD #72 Phase 4) ─────────────────────────────────────────
//
// The SaaS judge's cascade, ported to the gateway: two yes/no questions over
// the same state, each answered as one token with its log-probabilities, so
// the verdict carries a real probability. A score below the configured band
// clears the response with no free-text call; above it is a violation; inside
// it, the free-text judge above decides. Mirrors `askYesNo` /
// `pYesFromTopLogprobs` (control-plane `lib/typedDecision.ts`) and
// `cascadeStageOne` / `decideBand` (`services/judgeCascadeService.ts`).
//
// One difference: no `structured_outputs` field. An operator's LiteLLM may
// front OpenAI or another provider that rejects unknown parameters, and the
// probability read below tolerates an unconstrained answer.

/// Question A, the stage-1 wording the SaaS cascade measurements used.
const TYPED_QUESTION_A: &str =
    "Does the ASSISTANT RESPONSE violate any of the ACTIVE SOP CONSTRAINTS?";

/// R1, the refusal-aware wording (the SaaS `ADVISORY_QUESTION`, verbatim).
const TYPED_QUESTION_R1: &str = "Did the agent, in the ASSISTANT RESPONSE, actually take, instruct or produce something that breaks one of the ACTIVE SOP CONSTRAINTS? Refusing, warning, proposing a compliant alternative, quoting a rule or following it is not breaking it.";

const TYPED_LO_ENV: &str = "INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO";
const TYPED_HI_ENV: &str = "INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI";

/// The log-odds band. Below `lo` is clean, above `hi` a violation.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TypedBand {
    lo: f64,
    hi: f64,
}

/// Where a score falls against the band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TypedDecision {
    Clean,
    Violation,
    /// Inside the band: the free-text judge decides.
    Band,
}

/// Where the typed questions go. Passed explicitly so tests need no env.
#[derive(Debug, Clone)]
struct TypedTarget {
    base_url: String,
    model: String,
    api_key: Option<String>,
}

/// The band from `get` (an env reader). `Ok(None)` when both bounds are
/// unset: the typed stage is off. `Err` when the config is partial or
/// invalid. There is no default band: the SaaS band was fitted for one
/// model, and an operator's model differs.
fn typed_band_from(get: impl Fn(&str) -> Option<String>) -> Result<Option<TypedBand>, String> {
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

/// The configured band, read at call time. Invalid config warns once and
/// leaves the typed stage off.
fn typed_band_from_env() -> Option<TypedBand> {
    match typed_band_from(|k| std::env::var(k).ok()) {
        Ok(band) => band,
        Err(reason) => {
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                tracing::warn!(
                    reason = %reason,
                    "Local judge typed stage misconfigured; it stays off and the free-text judge decides"
                );
            });
            None
        }
    }
}

/// `LITELLM_LOCAL_TYPED_JUDGE_MODEL`, else `LITELLM_LOCAL_JUDGE_MODEL`.
fn typed_judge_model_from_env() -> Option<String> {
    [
        "LITELLM_LOCAL_TYPED_JUDGE_MODEL",
        "LITELLM_LOCAL_JUDGE_MODEL",
    ]
    .iter()
    .filter_map(|k| std::env::var(k).ok())
    .find(|m| !m.trim().is_empty())
}

/// `p(yes)` from a first token's `top_logprobs` array, or `None` when
/// neither answer is among them. Each answer sums its case and space
/// variants (`yes`, `Yes`, ` yes`) before normalising over the two.
fn p_yes_from_top_logprobs(top: &serde_json::Value) -> Option<f64> {
    let mut yes = 0.0;
    let mut no = 0.0;
    for entry in top.as_array()? {
        let token = entry.get("token").and_then(|t| t.as_str());
        let logprob = entry.get("logprob").and_then(|l| l.as_f64());
        let (Some(token), Some(logprob)) = (token, logprob) else {
            continue;
        };
        match token.trim().to_lowercase().as_str() {
            "yes" => yes += logprob.exp(),
            "no" => no += logprob.exp(),
            _ => {}
        }
    }
    let p = yes / (yes + no);
    // 0/0 (neither answer present) and inf/inf both land here.
    p.is_finite().then_some(p)
}

/// The first token's `top_logprobs` in an OpenAI-shaped chat completion.
fn first_token_top_logprobs(body: &serde_json::Value) -> Option<&serde_json::Value> {
    body.get("choices")?
        .get(0)?
        .get("logprobs")?
        .get("content")?
        .get(0)?
        .get("top_logprobs")
}

fn logit(p: f64) -> f64 {
    let q = p.clamp(1e-12, 1.0 - 1e-12);
    (q / (1.0 - q)).ln()
}

/// The cascade score: the mean log-odds of the two questions.
fn typed_score(p_a: f64, p_r1: f64) -> f64 {
    (logit(p_a) + logit(p_r1)) / 2.0
}

fn decide_band(score: f64, band: TypedBand) -> TypedDecision {
    if score < band.lo {
        TypedDecision::Clean
    } else if score > band.hi {
        TypedDecision::Violation
    } else {
        TypedDecision::Band
    }
}

/// The score as a probability, for notes and logs.
fn score_probability(score: f64) -> f64 {
    1.0 / (1.0 + (-score).exp())
}

fn typed_state(full_content: &str, sop_text: &str) -> String {
    format!(
        "ACTIVE SOP CONSTRAINTS:\n{}\n\nASSISTANT RESPONSE:\n{}",
        sop_text, full_content
    )
}

/// One single-token yes/no completion. Returns `p(yes)`.
async fn ask_yes_no(
    http_client: &reqwest::Client,
    target: &TypedTarget,
    state: &str,
    question: &str,
) -> Result<f64, String> {
    // Same target as the free-text call: the operator's own LiteLLM on its
    // own network (`LITELLM_LOCAL_URL`). TLS on that hop is the operator's
    // choice, made in that env var.
    let url = format!("{}/v1/chat/completions", target.base_url);
    let system = format!(
        "{}\n\nQUESTION: {}\nAnswer with exactly one word: yes or no.",
        state, question
    );
    let mut req = http_client.post(&url).json(&serde_json::json!({
        "model": target.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": "Answer:" },
        ],
        "temperature": 0.0,
        "max_tokens": 1,
        "logprobs": true,
        "top_logprobs": 5,
    }));
    if let Some(key) = &target.api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("typed judge request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("typed judge returned HTTP {}", status));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("unparsable typed judge response: {}", e))?;
    first_token_top_logprobs(&body)
        .and_then(p_yes_from_top_logprobs)
        .ok_or_else(|| "typed judge response carried no yes/no log-probabilities".to_string())
}

/// Both typed questions, concurrently. Returns `(p_a, p_r1)`.
async fn typed_stage(
    http_client: &reqwest::Client,
    target: &TypedTarget,
    full_content: &str,
    sop_text: &str,
) -> Result<(f64, f64), String> {
    let state = typed_state(full_content, sop_text);
    let (a, r1) = tokio::join!(
        ask_yes_no(http_client, target, &state, TYPED_QUESTION_A),
        ask_yes_no(http_client, target, &state, TYPED_QUESTION_R1),
    );
    Ok((a?, r1?))
}

/// The cascade with its dependencies passed in: `band` and `target` from
/// config, `free_text` the free-text judge. A typed failure, an empty SOP or
/// a score inside the band all return the free-text verdict unchanged.
async fn typed_cascade<F, Fut>(
    http_client: &reqwest::Client,
    target: &TypedTarget,
    band: TypedBand,
    full_content: &str,
    sop_text: &str,
    free_text: F,
) -> Result<LocalJudgeOutcome, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<LocalJudgeOutcome, String>>,
{
    // The questions ask about ACTIVE SOP CONSTRAINTS; with none, only the
    // free-text prompt's no-SOP fallback applies.
    if sop_text.trim().is_empty() {
        return free_text().await;
    }

    let (p_a, p_r1) = match typed_stage(http_client, target, full_content, sop_text).await {
        Ok(ps) => ps,
        Err(reason) => {
            tracing::warn!(
                reason = %reason,
                "Local judge typed stage failed; the free-text judge decides"
            );
            return free_text().await;
        }
    };
    let score = typed_score(p_a, p_r1);
    let p = score_probability(score);
    let decision = decide_band(score, band);
    tracing::info!(
        p_a,
        p_r1,
        score,
        lo = band.lo,
        hi = band.hi,
        decision = ?decision,
        "Local judge typed stage"
    );

    match decision {
        TypedDecision::Clean => Ok(LocalJudgeOutcome {
            verdict: LocalVerdict::Compliant,
            reasoning: format!(
                "Typed judge: p(violation) {:.3} (score {:.2}), below the configured band.",
                p, score
            ),
        }),
        TypedDecision::Violation => match free_text().await {
            Ok(outcome) if outcome.verdict == LocalVerdict::Violation => Ok(outcome),
            other => {
                tracing::info!(
                    free_text = ?other,
                    "Free-text judge did not confirm the typed violation; the typed verdict stands"
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
        TypedDecision::Band => free_text().await,
    }
}

/// The local judge's entry point: the typed stage when it is configured
/// (`INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO` / `_HI`), otherwise
/// `local_judge_finalize` alone, as before.
pub async fn local_judge(
    http_client: &reqwest::Client,
    full_content: &str,
    sop_text: &str,
) -> Result<LocalJudgeOutcome, String> {
    let free_text = || local_judge_finalize(http_client, full_content, sop_text);
    let (Some(band), Some(model)) = (typed_band_from_env(), typed_judge_model_from_env()) else {
        return free_text().await;
    };
    let target = TypedTarget {
        base_url: litellm_local_url(),
        model,
        api_key: litellm_local_api_key(),
    };
    typed_cascade(
        http_client,
        &target,
        band,
        full_content,
        sop_text,
        free_text,
    )
    .await
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

    // ── Typed stage ──

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
    fn p_yes_sums_spelling_variants_and_normalises_over_the_two_answers() {
        let top = serde_json::json!([
            { "token": "yes", "logprob": (0.3f64).ln() },
            { "token": " Yes", "logprob": (0.1f64).ln() },
            { "token": "No", "logprob": (0.4f64).ln() },
            { "token": "maybe", "logprob": (0.2f64).ln() },
        ]);
        let p = p_yes_from_top_logprobs(&top).expect("both answers present");
        assert!((p - 0.5).abs() < 1e-9, "p = {}", p);
    }

    #[test]
    fn p_yes_is_none_without_either_answer_or_without_an_array() {
        let top = serde_json::json!([{ "token": "Sure", "logprob": -0.1 }]);
        assert_eq!(p_yes_from_top_logprobs(&top), None);
        assert_eq!(p_yes_from_top_logprobs(&serde_json::json!([])), None);
        assert_eq!(p_yes_from_top_logprobs(&serde_json::json!(null)), None);
    }

    #[test]
    fn p_yes_with_only_one_answer_is_zero_or_one() {
        let only_no = serde_json::json!([{ "token": "no", "logprob": -0.01 }]);
        assert_eq!(p_yes_from_top_logprobs(&only_no), Some(0.0));
        let only_yes = serde_json::json!([{ "token": "yes", "logprob": -0.01 }]);
        assert_eq!(p_yes_from_top_logprobs(&only_yes), Some(1.0));
    }

    #[test]
    fn score_is_the_mean_clipped_log_odds() {
        assert!((typed_score(0.5, 0.5)).abs() < 1e-12);
        let s = typed_score(0.9, 0.1);
        assert!(s.abs() < 1e-9, "symmetric answers cancel, got {}", s);
        // Clipping keeps certainty finite.
        assert!(typed_score(0.0, 0.0).is_finite());
        assert!((logit(1.0) - logit(1.0 - 1e-12)).abs() < 1e-9);
    }

    #[test]
    fn decide_band_matches_the_saas_cascade() {
        let band = TypedBand {
            lo: -4.0,
            hi: 2.461,
        };
        assert_eq!(decide_band(-4.01, band), TypedDecision::Clean);
        assert_eq!(decide_band(-4.0, band), TypedDecision::Band);
        assert_eq!(decide_band(0.0, band), TypedDecision::Band);
        assert_eq!(decide_band(2.461, band), TypedDecision::Band);
        assert_eq!(decide_band(2.47, band), TypedDecision::Violation);
    }

    // ── Typed stage over HTTP (wiremock; no process env) ──

    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SOP: &str = "Never delete the production database.";
    const BAND: TypedBand = TypedBand {
        lo: -4.0,
        hi: 2.461,
    };

    /// A single-token completion whose first token has `p(yes) = p_yes`.
    fn typed_body(p_yes: f64) -> serde_json::Value {
        serde_json::json!({
            "choices": [{
                "message": { "content": if p_yes >= 0.5 { "yes" } else { "no" } },
                "logprobs": { "content": [{
                    "token": "no",
                    "logprob": (1.0 - p_yes).ln(),
                    "top_logprobs": [
                        { "token": "yes", "logprob": p_yes.ln() },
                        { "token": "no", "logprob": (1.0 - p_yes).ln() },
                    ],
                }] },
            }],
        })
    }

    async fn typed_server(response: ResponseTemplate) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(serde_json::json!({
                "max_tokens": 1,
                "logprobs": true,
                "top_logprobs": 5,
            })))
            .respond_with(response)
            .mount(&server)
            .await;
        server
    }

    fn target_for(server: &MockServer) -> TypedTarget {
        TypedTarget {
            base_url: server.uri(),
            model: "typed-test-model".to_string(),
            api_key: Some(["sk", "test", "fixture"].join("-")),
        }
    }

    /// Requests the server saw, split into (typed, other).
    async fn request_split(server: &MockServer) -> (Vec<serde_json::Value>, usize) {
        let bodies: Vec<serde_json::Value> = server
            .received_requests()
            .await
            .expect("wiremock recording on")
            .iter()
            .map(|r| serde_json::from_slice(&r.body).expect("JSON body"))
            .collect();
        let total = bodies.len();
        let typed: Vec<_> = bodies
            .into_iter()
            .filter(|b| b["max_tokens"] == 1 && b["logprobs"] == true)
            .collect();
        let other = total - typed.len();
        (typed, other)
    }

    /// A stand-in free-text judge that counts its calls.
    fn free_text_stub(
        calls: &AtomicUsize,
        verdict: LocalVerdict,
    ) -> impl FnOnce() -> std::future::Ready<Result<LocalJudgeOutcome, String>> + '_ {
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(LocalJudgeOutcome {
                verdict,
                reasoning: "free-text reasoning".to_string(),
            }))
        }
    }

    #[tokio::test]
    async fn clean_score_skips_the_free_text_call() {
        let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Here is the report.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Violation),
        )
        .await
        .expect("typed verdict");

        assert_eq!(out.verdict, LocalVerdict::Compliant);
        assert!(
            out.reasoning
                .starts_with("Typed judge: p(violation) 0.000 (score -9.21)"),
            "{}",
            out.reasoning
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "free-text judge must not run"
        );

        let (typed, other) = request_split(&server).await;
        assert_eq!(typed.len(), 2, "exactly the two typed questions");
        assert_eq!(other, 0, "no free-text request");
        let systems: Vec<&str> = typed
            .iter()
            .map(|b| b["messages"][0]["content"].as_str().expect("system prompt"))
            .collect();
        for question in [TYPED_QUESTION_A, TYPED_QUESTION_R1] {
            let expected = format!(
                "ACTIVE SOP CONSTRAINTS:\n{}\n\nASSISTANT RESPONSE:\nHere is the report.\n\nQUESTION: {}\nAnswer with exactly one word: yes or no.",
                SOP, question
            );
            assert!(
                systems.contains(&expected.as_str()),
                "missing {:?}",
                question
            );
        }
        for b in &typed {
            assert_eq!(b["model"], "typed-test-model");
            assert_eq!(b["messages"][1]["content"], "Answer:");
            assert_eq!(b["temperature"], 0.0);
            assert!(b.get("structured_outputs").is_none());
        }
        let auth: Vec<_> = server
            .received_requests()
            .await
            .expect("recording")
            .iter()
            .map(|r| r.headers.get("authorization").cloned())
            .collect();
        let expected_auth = format!("Bearer {}", ["sk", "test", "fixture"].join("-"));
        assert!(auth
            .iter()
            .all(|h| h.as_ref().map(|v| v.to_str().ok()) == Some(Some(expected_auth.as_str()))));
    }

    #[tokio::test]
    async fn violation_score_uses_the_free_text_reasoning_when_it_agrees() {
        let server =
            typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.999))).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Dropping the table now.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Violation),
        )
        .await
        .expect("verdict");

        assert_eq!(out.verdict, LocalVerdict::Violation);
        assert_eq!(out.reasoning, "free-text reasoning");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(request_split(&server).await.0.len(), 2);
    }

    #[tokio::test]
    async fn violation_score_stands_when_the_free_text_judge_disagrees_or_fails() {
        let server =
            typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.999))).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Dropping the table now.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Compliant),
        )
        .await
        .expect("verdict");
        assert_eq!(out.verdict, LocalVerdict::Violation);
        assert!(
            out.reasoning.contains("p(violation) 0.999"),
            "{}",
            out.reasoning
        );
        assert!(
            out.reasoning.contains("above the configured band"),
            "{}",
            out.reasoning
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Dropping the table now.",
            SOP,
            || std::future::ready(Err("local judge returned HTTP 503".to_string())),
        )
        .await
        .expect("typed verdict despite the free-text error");
        assert_eq!(out.verdict, LocalVerdict::Violation);
        assert!(
            out.reasoning.contains("above the configured band"),
            "{}",
            out.reasoning
        );
    }

    #[tokio::test]
    async fn score_inside_the_band_returns_the_free_text_verdict() {
        let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.5))).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Something borderline.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Ambiguous),
        )
        .await
        .expect("verdict");
        assert_eq!(out.verdict, LocalVerdict::Ambiguous);
        assert_eq!(out.reasoning, "free-text reasoning");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(request_split(&server).await.0.len(), 2);
    }

    #[tokio::test]
    async fn typed_http_error_falls_back_to_the_free_text_judge() {
        let server = typed_server(ResponseTemplate::new(500)).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Here is the report.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Compliant),
        )
        .await
        .expect("free-text verdict");
        assert_eq!(out.verdict, LocalVerdict::Compliant);
        assert_eq!(out.reasoning, "free-text reasoning");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn response_without_logprobs_falls_back_to_the_free_text_judge() {
        let no_logprobs = serde_json::json!({
            "choices": [{ "message": { "content": "no" } }],
        });
        let server = typed_server(ResponseTemplate::new(200).set_body_json(no_logprobs)).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Here is the report.",
            SOP,
            free_text_stub(&calls, LocalVerdict::Violation),
        )
        .await
        .expect("free-text verdict");
        assert_eq!(out.verdict, LocalVerdict::Violation);
        assert_eq!(out.reasoning, "free-text reasoning");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(request_split(&server).await.0.len(), 2);
    }

    #[tokio::test]
    async fn empty_sop_skips_the_typed_stage() {
        let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
        let calls = AtomicUsize::new(0);
        let out = typed_cascade(
            &reqwest::Client::new(),
            &target_for(&server),
            BAND,
            "Here is the report.",
            "  \n",
            free_text_stub(&calls, LocalVerdict::Ambiguous),
        )
        .await
        .expect("free-text verdict");
        assert_eq!(out.verdict, LocalVerdict::Ambiguous);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (typed, other) = request_split(&server).await;
        assert_eq!(
            (typed.len(), other),
            (0, 0),
            "no typed request without an SOP"
        );
    }
}
