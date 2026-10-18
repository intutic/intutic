//! The local judge's deprecated typed band, mapped to the decide rule
//! `local-judge`: `{no_below: σ(LO), yes_at: σ(HI)}` over the combiner
//! `{bias: 0, weights: {a: 0.5, r1: 0.5}}`, with refuse → VIOLATION,
//! allow → COMPLIANT and escalate → AMBIGUOUS.
//!
//! "Before" is the typed judge's own rule, kept here as the reference: the
//! score is the mean clipped log-odds of the two answers, below LO is clean,
//! above HI a violation, and in between (edges included) the free-text judge
//! decided. "After" is the mapped rule. They agree on every answer pair
//! except a score of exactly HI, which is now a violation (a decide answer is
//! yes at `p ≥ yes_at`); inside the band the verdict is now AMBIGUOUS, where
//! the free-text judge used to decide.
//!
//! Three parts:
//! - pure: representative scores, the band edges, and a sweep;
//! - over HTTP with an engine on a wiremock server, no environment;
//! - ONE env test (`the_deprecated_variables_map_to_the_rule`): the
//!   variables are process-global, so its scenarios run in sequence.

use intutic_proxy::decide::engine::{
    DecideEngine, DecideEngineError, DECIDE_MAX_RESPONSE_STATE_BYTES, DECIDE_MAX_STATE_BYTES,
};
use intutic_proxy::decide::local_judge::{
    judge_with_rule, legacy_engine_config, local_judge, local_judge_rule, local_judge_verdict,
    LocalJudgeOutcome, LocalJudgeRule, LocalVerdict, TypedBand, TYPED_QUESTION_A,
    TYPED_QUESTION_R1,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── The reference: the typed judge before the mapping ────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Before {
    Clean,
    Violation,
    /// The free-text judge decided.
    Band,
}

fn logit(p: f64) -> f64 {
    let q = p.clamp(1e-12, 1.0 - 1e-12);
    (q / (1.0 - q)).ln()
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn score(p_a: f64, p_r1: f64) -> f64 {
    (logit(p_a) + logit(p_r1)) / 2.0
}

fn before(band: TypedBand, p_a: f64, p_r1: f64) -> Before {
    let s = score(p_a, p_r1);
    if s < band.lo {
        Before::Clean
    } else if s > band.hi {
        Before::Violation
    } else {
        Before::Band
    }
}

/// The verdict the mapping must give for each reference decision.
fn mapped(b: Before) -> LocalVerdict {
    match b {
        Before::Clean => LocalVerdict::Compliant,
        Before::Violation => LocalVerdict::Violation,
        Before::Band => LocalVerdict::Ambiguous,
    }
}

fn after(rule: &LocalJudgeRule, p_a: f64, p_r1: f64) -> LocalVerdict {
    local_judge_verdict(rule, Some(p_a), Some(p_r1)).0
}

const BAND: TypedBand = TypedBand {
    lo: -4.0,
    hi: 2.461,
};

// ── Pure ──────────────────────────────────────────────────────────────────

#[test]
fn representative_scores_reach_the_same_verdicts() {
    let rule = local_judge_rule(BAND).expect("maps");
    // (p_a, p_r1, before): clean, both sides of each edge, the middle, a
    // violation, disagreeing answers, and answers at the clip.
    let rows: &[(f64, f64, Before)] = &[
        (1e-4, 1e-4, Before::Clean),
        (0.01, 0.02, Before::Clean),
        (0.017, 0.017, Before::Clean),
        (0.019, 0.019, Before::Band),
        (0.5, 0.5, Before::Band),
        (0.9, 0.1, Before::Band),
        (0.92, 0.92, Before::Band),
        (0.93, 0.93, Before::Violation),
        (0.999, 0.999, Before::Violation),
        (0.999_999, 0.2, Before::Violation),
        (0.0, 0.0, Before::Clean),
        (1.0, 1.0, Before::Violation),
        (1.0, 0.0, Before::Band),
    ];
    for &(p_a, p_r1, want) in rows {
        assert_eq!(
            before(BAND, p_a, p_r1),
            want,
            "reference at ({p_a}, {p_r1})"
        );
        assert_eq!(
            after(&rule, p_a, p_r1),
            mapped(want),
            "mapped at ({p_a}, {p_r1}), score {}",
            score(p_a, p_r1)
        );
    }
}

#[test]
fn the_combiner_score_is_the_mean_log_odds_through_sigma() {
    let rule = local_judge_rule(BAND).expect("maps");
    for (p_a, p_r1) in [(0.3, 0.6), (1e-9, 0.999), (0.5, 0.5), (0.123, 0.456)] {
        let (_, s) = local_judge_verdict(&rule, Some(p_a), Some(p_r1));
        // Bit for bit: ½a + ½b and (a + b) / 2 round the same.
        assert_eq!(s, Some(sigmoid(score(p_a, p_r1))), "({p_a}, {p_r1})");
    }
}

#[test]
fn band_edges_reach_the_same_verdicts_but_exactly_hi() {
    // Bands whose edges are exact scores of known answers, so the answers
    // land on each edge to the bit.
    let at_lo = (0.01, 0.03);
    let at_hi = (0.9, 0.97);
    let band = TypedBand {
        lo: score(at_lo.0, at_lo.1),
        hi: score(at_hi.0, at_hi.1),
    };
    let rule = local_judge_rule(band).expect("maps");

    // Exactly LO: inside the band before (score < lo is false), unknown after
    // (σ(lo) < σ(lo) is false).
    assert_eq!(before(band, at_lo.0, at_lo.1), Before::Band);
    assert_eq!(after(&rule, at_lo.0, at_lo.1), LocalVerdict::Ambiguous);

    // Exactly HI: inside the band before (score > hi is false), a violation
    // after (σ(hi) ≥ yes_at). The one verdict the mapping changes outside
    // the band's interior.
    assert_eq!(before(band, at_hi.0, at_hi.1), Before::Band);
    assert_eq!(after(&rule, at_hi.0, at_hi.1), LocalVerdict::Violation);

    // One step either side of each edge: move p_a by 1e-9.
    for (p, edge) in [(at_lo, band.lo), (at_hi, band.hi)] {
        for d in [-1e-9, 1e-9] {
            let (p_a, p_r1) = (p.0 + d, p.1);
            let b = before(band, p_a, p_r1);
            assert_ne!(score(p_a, p_r1), edge);
            assert_eq!(
                after(&rule, p_a, p_r1),
                mapped(b),
                "({p_a}, {p_r1}) near {edge}"
            );
        }
    }
}

/// The two ways the verdicts can differ, and only these: a score of exactly
/// HI, or a score so close to an edge that σ rounds it onto σ(edge).
fn allowed_difference(band: TypedBand, s: f64, b: Before, a: &LocalVerdict) -> bool {
    match (b, a) {
        (Before::Band, LocalVerdict::Violation) => s <= band.hi && sigmoid(s) >= sigmoid(band.hi),
        (Before::Clean, LocalVerdict::Ambiguous) => s < band.lo && sigmoid(s) >= sigmoid(band.lo),
        _ => false,
    }
}

#[test]
fn a_sweep_reaches_the_same_verdicts_and_counts_the_edge_cases() {
    let bands = [
        BAND,
        TypedBand { lo: -2.0, hi: 0.5 },
        TypedBand { lo: -8.0, hi: 6.0 },
        TypedBand { lo: -1.0, hi: 1e-3 },
        TypedBand {
            lo: -20.0,
            hi: 20.0,
        },
    ];
    // Answers on a grid in log-odds from -30 to 30, step 0.25, for each
    // question, plus equal answers within ±1e-3 of each edge.
    let grid: Vec<f64> = (-120..=120).map(|i| sigmoid(i as f64 * 0.25)).collect();
    let mut compared = 0usize;
    let mut differed = Vec::new();
    for band in bands {
        let rule = local_judge_rule(band).expect("maps");
        let mut pairs: Vec<(f64, f64)> = Vec::new();
        for &a in &grid {
            for &b in &grid {
                pairs.push((a, b));
            }
        }
        for edge in [band.lo, band.hi] {
            for k in -60i32..=60 {
                let d = if k == 0 {
                    0.0
                } else {
                    (k as f64).signum() * 10f64.powf(-3.0 - (60 - k.abs()) as f64 * 0.2)
                };
                let p = sigmoid(edge + d);
                pairs.push((p, p));
            }
        }
        for (p_a, p_r1) in pairs {
            let b = before(band, p_a, p_r1);
            let a = after(&rule, p_a, p_r1);
            compared += 1;
            if a != mapped(b) {
                let s = score(p_a, p_r1);
                assert!(
                    allowed_difference(band, s, b, &a),
                    "band {band:?}: ({p_a}, {p_r1}) score {s}: before {b:?}, after {a:?}"
                );
                differed.push((band, s, b, a));
            }
        }
    }
    assert!(compared > 280_000);
    // Every difference sits where σ cannot tell the score from the edge: within
    // two ulps of σ(edge), divided by σ's slope there. That is under 1e-12 in
    // log-odds for an edge within ±10, and about 1e-7 at ±20.
    let mut widest: Vec<(f64, f64)> = Vec::new();
    for (band, s, _, _) in &differed {
        let edge = if (s - band.hi).abs() < (s - band.lo).abs() {
            band.hi
        } else {
            band.lo
        };
        let slope = sigmoid(edge) * (1.0 - sigmoid(edge));
        let zone = 2.0 * f64::EPSILON / slope;
        assert!((s - edge).abs() <= zone, "{s} vs {edge}: outside {zone}");
        match widest.iter_mut().find(|(e, _)| *e == edge) {
            Some((_, w)) => *w = w.max((s - edge).abs()),
            None => widest.push((edge, (s - edge).abs())),
        }
    }
    eprintln!(
        "local-judge mapping sweep: {compared} answer pairs compared, {} differ; \
         farthest from its edge, per edge: {widest:?}",
        differed.len()
    );
}

#[test]
fn a_missing_answer_is_unknown() {
    let rule = local_judge_rule(BAND).expect("maps");
    assert_eq!(
        local_judge_verdict(&rule, None, Some(0.0)).0,
        LocalVerdict::Ambiguous
    );
    assert_eq!(
        local_judge_verdict(&rule, None, None).0,
        LocalVerdict::Ambiguous
    );
}

#[test]
fn no_band_with_yes_at_at_or_below_one_half_is_produced() {
    for hi in [0.0, -1e-12, -0.5, -3.0] {
        let err = local_judge_rule(TypedBand { lo: -4.0, hi }).expect_err("refused");
        assert!(err.contains("must be above 0.5"), "{err}");
    }
}

// ── Over HTTP, no environment ─────────────────────────────────────────────

const SOP: &str = "Never delete the production database.";

/// A single-token completion whose first token gives `p(yes) = p_yes`.
fn typed_body(p_yes: f64) -> serde_json::Value {
    let (yes, no) = (p_yes.ln(), (1.0 - p_yes).ln());
    let (first, second) = if yes >= no {
        (("yes", yes), ("no", no))
    } else {
        (("no", no), ("yes", yes))
    };
    serde_json::json!({
        "choices": [{
            "message": { "content": first.0 },
            "logprobs": { "content": [{
                "token": first.0,
                "logprob": first.1,
                "top_logprobs": [
                    { "token": first.0, "logprob": first.1 },
                    { "token": second.0, "logprob": second.1 },
                ],
            }] },
        }],
    })
}

/// What the engine reads back from `typed_body(p)`.
fn p_read(p: f64) -> f64 {
    let (yes, no) = (p.ln().exp(), (1.0 - p).ln().exp());
    yes / (yes + no)
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

fn engine_for(server: &MockServer) -> DecideEngine {
    DecideEngine::new(legacy_engine_config(
        server.uri(),
        "typed-test-model".to_string(),
        Some(["sk", "test", "fixture"].join("-")),
    ))
    .expect("loopback engine")
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

async fn judge(
    server: &MockServer,
    content: &str,
    sop: &str,
    calls: &AtomicUsize,
    free_text: LocalVerdict,
) -> Result<LocalJudgeOutcome, String> {
    let engine = engine_for(server);
    judge_with_rule(
        Ok(&engine),
        &local_judge_rule(BAND).expect("maps"),
        content,
        sop,
        free_text_stub(calls, free_text),
    )
    .await
}

#[tokio::test]
async fn a_clean_score_asks_both_questions_and_skips_the_free_text_judge() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        "Here is the report.",
        SOP,
        &calls,
        LocalVerdict::Violation,
    )
    .await
    .expect("typed verdict");

    assert_eq!(out.verdict, LocalVerdict::Compliant);
    assert!(
        out.reasoning.starts_with(
            "Typed judge: p(violation) 0.000 (score -9.21), below the configured band."
        ),
        "{}",
        out.reasoning
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "free-text judge must not run"
    );

    let (typed, other) = request_split(&server).await;
    assert_eq!(typed.len(), 2, "exactly the two questions");
    assert_eq!(other, 0, "no free-text request");
    let systems: Vec<&str> = typed
        .iter()
        .map(|b| b["messages"][0]["content"].as_str().expect("system prompt"))
        .collect();
    for question in [TYPED_QUESTION_A, TYPED_QUESTION_R1] {
        // The same prompt the typed judge always sent.
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
        assert_eq!(b["temperature"], 0);
        assert!(b.get("structured_outputs").is_none());
    }
    let expected_auth = format!("Bearer {}", ["sk", "test", "fixture"].join("-"));
    for r in server.received_requests().await.expect("recording") {
        let auth = r.headers.get("authorization").and_then(|v| v.to_str().ok());
        assert_eq!(auth, Some(expected_auth.as_str()));
    }
}

#[tokio::test]
async fn a_violation_takes_its_note_from_the_free_text_judge_when_it_agrees() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.999))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        "Dropping the table now.",
        SOP,
        &calls,
        LocalVerdict::Violation,
    )
    .await
    .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    assert_eq!(out.reasoning, "free-text reasoning");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(request_split(&server).await.0.len(), 2);
}

#[tokio::test]
async fn a_violation_stands_when_the_free_text_judge_disagrees_or_fails() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.999))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        "Dropping the table now.",
        SOP,
        &calls,
        LocalVerdict::Compliant,
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

    let engine = engine_for(&server);
    let out = judge_with_rule(
        Ok(&engine),
        &local_judge_rule(BAND).expect("maps"),
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
async fn a_score_inside_the_band_is_ambiguous_and_the_free_text_judge_does_not_decide() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(0.5))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        "Something borderline.",
        SOP,
        &calls,
        LocalVerdict::Compliant,
    )
    .await
    .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Ambiguous);
    assert!(
        out.reasoning.contains("inside the configured band"),
        "{}",
        out.reasoning
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "free text no longer decides"
    );
    assert_eq!(
        counts(&server).await,
        (2, 0),
        "both questions, no free-text request"
    );
}

#[tokio::test]
async fn an_engine_error_is_the_judge_unavailable_not_a_free_text_verdict() {
    let calls = AtomicUsize::new(0);
    let server = typed_server(ResponseTemplate::new(500)).await;
    let err = judge(
        &server,
        "Here is the report.",
        SOP,
        &calls,
        LocalVerdict::Compliant,
    )
    .await
    .expect_err("unavailable");
    assert!(err.contains("unavailable (upstream)"), "{err}");

    let no_logprobs = serde_json::json!({ "choices": [{ "message": { "content": "no" } }] });
    let server = typed_server(ResponseTemplate::new(200).set_body_json(no_logprobs)).await;
    let err = judge(
        &server,
        "Here is the report.",
        SOP,
        &calls,
        LocalVerdict::Compliant,
    )
    .await
    .expect_err("unavailable");
    assert!(err.contains("unavailable (no_logprobs)"), "{err}");

    let refused: Result<&DecideEngine, DecideEngineError> = Err(DecideEngineError::HostRefused(
        "api.openai.com (denylist)".into(),
    ));
    let err = judge_with_rule(
        refused,
        &local_judge_rule(BAND).expect("maps"),
        "Here is the report.",
        SOP,
        free_text_stub(&calls, LocalVerdict::Compliant),
    )
    .await
    .expect_err("unavailable");
    assert!(err.contains("host refused"), "{err}");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_empty_sop_leaves_the_free_text_judge_to_decide() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        "Here is the report.",
        "  \n",
        &calls,
        LocalVerdict::Ambiguous,
    )
    .await
    .expect("free-text verdict");
    assert_eq!(out.verdict, LocalVerdict::Ambiguous);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(request_split(&server).await.0.len(), 0);
}

#[tokio::test]
async fn a_response_over_the_tool_call_limit_is_still_judged() {
    // An ordinary long response: over a tool call's 16 KiB, inside a
    // response state's own 32 KiB, so it is asked about, not left AMBIGUOUS.
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
    let calls = AtomicUsize::new(0);
    let content = "x".repeat(DECIDE_MAX_STATE_BYTES + 1_000);
    let out = judge(&server, &content, SOP, &calls, LocalVerdict::Violation)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Compliant);
    assert_eq!(request_split(&server).await.0.len(), 2);
}

#[tokio::test]
async fn a_state_over_the_limit_is_ambiguous_and_sends_nothing() {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(1e-4))).await;
    let calls = AtomicUsize::new(0);
    let out = judge(
        &server,
        &"x".repeat(DECIDE_MAX_RESPONSE_STATE_BYTES),
        SOP,
        &calls,
        LocalVerdict::Compliant,
    )
    .await
    .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Ambiguous);
    assert!(out.reasoning.contains("too large"), "{}", out.reasoning);
    assert!(
        out.reasoning.contains("over 32768 bytes"),
        "{}",
        out.reasoning
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(request_split(&server).await.0.len(), 0);

    // The rule's own limit, as INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES sets
    // it, holds even under the engine's larger one.
    let rule = LocalJudgeRule {
        max_state_bytes: 8_192,
        ..local_judge_rule(BAND).expect("maps")
    };
    let engine = engine_for(&server);
    let out = judge_with_rule(
        Ok(&engine),
        &rule,
        &"x".repeat(9_000),
        SOP,
        free_text_stub(&calls, LocalVerdict::Compliant),
    )
    .await
    .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Ambiguous);
    assert!(
        out.reasoning.contains("over 8192 bytes"),
        "{}",
        out.reasoning
    );
    assert_eq!(request_split(&server).await.0.len(), 0);
}

// ── The environment ───────────────────────────────────────────────────────

/// A LiteLLM stand-in: typed requests get `p_yes`, free-text requests a
/// VIOLATION verdict.
async fn litellm(p_yes: f64) -> MockServer {
    let server = typed_server(ResponseTemplate::new(200).set_body_json(typed_body(p_yes))).await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(body_partial_json(
            serde_json::json!({ "response_format": { "type": "json_object" } }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "choices": [{ "message": {
                "content": "{\"verdict\": \"VIOLATION\", \"reasoning\": \"Free-text: dropped a table.\"}"
            } }]
        })))
        .mount(&server)
        .await;
    server
}

/// (typed requests, free-text requests).
async fn counts(server: &MockServer) -> (usize, usize) {
    let (typed, other) = request_split(server).await;
    (typed.len(), other)
}

#[tokio::test]
async fn the_deprecated_variables_map_to_the_rule() {
    let http = reqwest::Client::new();
    std::env::set_var("LITELLM_LOCAL_JUDGE_MODEL", "free-text-model");
    std::env::remove_var("LITELLM_LOCAL_TYPED_JUDGE_MODEL");
    std::env::remove_var("LITELLM_LOCAL_API_KEY");

    // ── Representative scores, each side of both edges, through the
    //    variables and the engine: the verdict the reference band gives. ──
    for (lo, hi) in [(-4.0, 2.461), (-2.0, 0.5)] {
        let band = TypedBand { lo, hi };
        std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO", lo.to_string());
        std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI", hi.to_string());
        let ps = [
            1e-4,
            sigmoid(lo - 1e-6),
            sigmoid(lo + 1e-6),
            0.5,
            sigmoid(hi - 1e-6),
            sigmoid(hi + 1e-6),
            0.999,
        ];
        for p in ps {
            let server = litellm(p).await;
            std::env::set_var("LITELLM_LOCAL_URL", server.uri());
            let want = before(band, p_read(p), p_read(p));
            let out = local_judge(&http, "DROP TABLE users;", SOP)
                .await
                .expect("verdict");
            assert_eq!(
                out.verdict,
                mapped(want),
                "band ({lo}, {hi}), p {p}: before {want:?}"
            );
            let free_text = usize::from(want == Before::Violation);
            assert_eq!(
                counts(&server).await,
                (2, free_text),
                "band ({lo}, {hi}), p {p}"
            );
            if want == Before::Violation {
                assert_eq!(out.reasoning, "Free-text: dropped a table.");
            }
        }
    }

    // ── No band: the free-text verdict decides, as before. ──
    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO");
    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "DROP TABLE users;", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    assert_eq!(counts(&server).await, (0, 1));

    // ── HI at or below 0 maps to yes_at ≤ 0.5: the mapping is refused and
    //    the free-text verdict decides; no invalid band is ever asked. ──
    for hi in ["0", "-0.5"] {
        std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO", "-4");
        std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI", hi);
        let server = litellm(1e-4).await;
        std::env::set_var("LITELLM_LOCAL_URL", server.uri());
        let out = local_judge(&http, "DROP TABLE users;", SOP)
            .await
            .expect("verdict");
        assert_eq!(out.verdict, LocalVerdict::Violation, "HI {hi}");
        assert_eq!(counts(&server).await, (0, 1), "HI {hi}");
    }

    // ── A typed model of its own; the free text keeps its model. ──
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO", "-4");
    std::env::set_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI", "2.461");
    std::env::set_var("LITELLM_LOCAL_TYPED_JUDGE_MODEL", "typed-model");
    let server = litellm(0.999).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, "DROP TABLE users;", SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Violation);
    let models: Vec<String> = server
        .received_requests()
        .await
        .expect("recording")
        .iter()
        .map(|r| {
            let b: serde_json::Value = serde_json::from_slice(&r.body).expect("JSON");
            b["model"].as_str().unwrap_or_default().to_string()
        })
        .collect();
    let mut sorted = models.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec!["free-text-model", "typed-model", "typed-model"]
    );

    // ── INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES: a larger limit asks about
    //    a response the default would leave AMBIGUOUS; a smaller one leaves
    //    AMBIGUOUS what the default asks about; one that does not read
    //    leaves the judge unavailable. ──
    let long = "x".repeat(40_000);
    std::env::set_var("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES", "65536");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, &long, SOP).await.expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Compliant);
    assert_eq!(counts(&server).await, (2, 0));

    std::env::set_var("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES", "1024");
    let server = litellm(1e-4).await;
    std::env::set_var("LITELLM_LOCAL_URL", server.uri());
    let out = local_judge(&http, &"x".repeat(2_000), SOP)
        .await
        .expect("verdict");
    assert_eq!(out.verdict, LocalVerdict::Ambiguous);
    assert!(
        out.reasoning.contains("over 1024 bytes"),
        "{}",
        out.reasoning
    );
    assert_eq!(counts(&server).await, (0, 0));

    for bad in ["big", "0", "2000000"] {
        std::env::set_var("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES", bad);
        let err = local_judge(&http, "DROP TABLE users;", SOP)
            .await
            .expect_err("unavailable");
        assert!(err.contains("local judge unavailable"), "{bad}: {err}");
    }
    std::env::remove_var("INTUTIC_DECIDE_MAX_RESPONSE_STATE_BYTES");

    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO");
    std::env::remove_var("INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI");
    std::env::remove_var("LITELLM_LOCAL_TYPED_JUDGE_MODEL");
    std::env::remove_var("LITELLM_LOCAL_JUDGE_MODEL");
    std::env::remove_var("LITELLM_LOCAL_URL");
}
