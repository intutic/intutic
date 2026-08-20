//! Mirror sampling: the only thing in the routing plan that measures quality.
//!
//! Shadow routing records what the router *would* have picked and can say
//! nothing about whether that pick was any good, because the other model never
//! ran. Mirroring runs it: on a small sample, the same request is issued to the
//! candidate as well, the requested model's response is served, and the
//! candidate's is scored and thrown away.
//!
//! ## Three properties this file exists to guarantee
//!
//! **Off the latency path.** The mirrored call is spawned after the real
//! response has been handed back. A user's request must never wait on a second
//! model, and a mirrored call that times out must cost them nothing.
//!
//! **Never cached.** A mirrored response was produced by a model the user did
//! not ask for and never received. `write_cache` takes
//! [`ResponseProvenance`](crate::plugins::semantic_cache::ResponseProvenance) as
//! its first parameter and refuses `Mirrored` — this module never calls it at
//! all, and could not cache by accident if it tried.
//!
//! **Bounded.** Every mirrored request is paid for twice, so the sample rate is
//! capped at 5% and a concurrency limit stops a burst from doubling the bill.
//!
//! ## What its evidence is worth
//!
//! A candidate's fault rate measured this way is on the *requested* traffic —
//! the same prompts the primary model saw — so it is free of the selection bias
//! that shadow's "candidate scored on its own traffic" report carries. It still
//! cannot see wrong-but-well-formed answers, because the score cannot: mirroring
//! measures whether the candidate returns something *usable*, not something
//! *right*.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use serde_json::Value;

use super::integrity::{self, Integrity, ResponseFacts};

/// Hard ceiling on the sample rate, whatever the config says.
///
/// Every mirrored request is billed twice. A typo adding a zero should cost a
/// rounding error, not double the month.
pub const MAX_SAMPLE_RATE: f64 = 0.05;

/// Mirrored calls allowed in flight at once, process-wide.
///
/// A burst of traffic at 5% is still a burst. This bounds the blast radius of
/// mirroring on the upstream's rate limits, which the *real* requests share.
pub const MAX_CONCURRENT: usize = 4;

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Whether this request should be mirrored.
///
/// Returns false for anything that would make the comparison meaningless or the
/// cost unbounded:
///
/// - streaming, because the two responses cannot be compared turn-for-turn and
///   the mirrored stream would have to be fully consumed to score;
/// - no candidate distinct from the requested model — mirroring a model against
///   itself measures noise;
/// - the concurrency ceiling already reached.
pub fn should_mirror(
    sample_rate: f64,
    is_streaming: bool,
    requested_model: &str,
    candidate_model: &str,
    roll: f64,
) -> Option<MirrorSlot> {
    if is_streaming {
        return None;
    }
    if requested_model == candidate_model {
        return None;
    }
    let rate = sample_rate.clamp(0.0, MAX_SAMPLE_RATE);
    if rate <= 0.0 {
        return None;
    }
    if roll >= rate {
        return None;
    }
    // Reserve a slot. Released by `MirrorSlot`'s Drop, so an early return or a
    // panic inside the task cannot leak it.
    let prev = IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
    if prev >= MAX_CONCURRENT {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        return None;
    }
    Some(MirrorSlot { _private: () })
}

/// Holds a concurrency slot for the life of one mirrored call.
///
/// A guard rather than a matching `fetch_sub` at each exit: the mirrored task
/// has several early returns and any missed one would permanently shrink the
/// pool until the process restarted.
///
/// **Only [`should_mirror`] can construct one.** The private field is the whole
/// point: this was a unit struct anyone could build, so a `MirrorSlot` created
/// without a matching acquire would decrement a counter that was never
/// incremented. That is not a tidiness concern — `usize` wraps, so one stray
/// drop takes `IN_FLIGHT` to `usize::MAX - n`, `prev >= MAX_CONCURRENT` is then
/// true forever, and **mirroring silently stops for the life of the process**.
/// The end-to-end test found exactly that by constructing slots directly.
pub struct MirrorSlot {
    _private: (),
}

impl Drop for MirrorSlot {
    fn drop(&mut self) {
        // Saturating as a second line of defence. The private field should make
        // an unpaired drop impossible; if one happens anyway, refusing to wrap
        // keeps mirroring degraded rather than permanently dead.
        let _ = IN_FLIGHT.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            Some(n.saturating_sub(1))
        });
    }
}

/// In-flight count, for tests and for a health endpoint.
pub fn in_flight() -> usize {
    IN_FLIGHT.load(Ordering::SeqCst)
}

/// What one mirrored call found.
#[derive(Debug, Clone)]
pub struct MirrorOutcome {
    pub candidate_model: String,
    pub integrity: Integrity,
    pub latency_ms: u32,
    /// Cost of the mirrored call. Real money, spent to learn this.
    pub cost_usd: f64,
    /// The mirrored response's raw body text, carried ONLY as far as the
    /// caller's DLP-scrub-and-publish step (see `run_mirror`'s doc comment).
    ///
    /// This is not a second discard site to relitigate: nothing durable ever
    /// reads this field. It exists so `run_mirror`'s caller can build the
    /// scrubbed transient pub/sub pair (request + both responses) documented
    /// on `run_mirror` without re-issuing or re-parsing the mirrored call.
    /// `None` whenever the response body wasn't valid UTF-8.
    pub response_text: Option<String>,
}

/// Scrubs `text` with the same DLP scan-then-redact call used at every other
/// site that carries model text past a trust boundary (e.g.
/// `injection::extract_scrubbed_snippet`, the output-DLP block in
/// `proxy.rs`). A clean string is returned unchanged rather than round-tripped
/// through `redact`, matching those call sites.
pub fn dlp_scrub(text: &str) -> String {
    let findings = crate::dlp::scan(text);
    if findings.is_empty() {
        text.to_string()
    } else {
        crate::dlp::redact(text, &findings)
    }
}

/// The transient, judge-at-ingest message published on mirror completion.
///
/// **This is the one place in the mirror path that carries two full model
/// responses at once.** TD-346 (see `docs/TECH_DEBT.md`) forbids persisting
/// raw model response text; storing an original/mirror response PAIR
/// durably would be a far larger exception to that discipline than anything
/// shipped under it so far. The decision made for this phase is
/// judge-at-ingest, verdict-only storage: this struct is published to a
/// Valkey pub/sub channel — transient by construction, nothing durable about
/// a channel with no persistence — and NEVER written to a database table by
/// this proxy.
///
/// Every text field here MUST already be DLP-scrubbed (via [`dlp_scrub`])
/// before this struct is constructed; construction is not itself where
/// scrubbing happens, so an unscrubbed field is a caller bug, not a type
/// this struct catches.
///
/// **No durable consumer exists in this phase.** A later, separate phase
/// (7b — control-plane) subscribes to this channel, judges the pair
/// immediately, records only the verdict, and discards the raw content. Until
/// that subscriber ships, this message has no consumer at all and is
/// published purely so 7b has a stable wire shape to build against.
#[derive(Debug, Clone, Serialize)]
pub struct MirrorPairEvent {
    pub workspace_id: String,
    /// The model the caller actually asked for (pre-routing).
    pub requested_model: String,
    /// The mirror candidate this pair was measured against.
    pub candidate_model: String,
    /// DLP-scrubbed request body text, shared by both calls.
    pub request_text: String,
    /// DLP-scrubbed response text from the model that actually served the
    /// request.
    pub original_response_text: String,
    /// DLP-scrubbed response text from the mirror candidate.
    pub mirror_response_text: String,
    /// Whether `integrity::score` found a fault in the mirrored response —
    /// duplicated from the aggregate counter write so a 7b judge has the
    /// deterministic-scorer's own verdict available alongside its own.
    pub mirror_faulted: bool,
    pub mirror_latency_ms: u32,
    /// Cost of the mirrored call, in USD.
    pub mirror_cost_usd: f64,
    pub created_at: String,
}

/// Scores a mirrored response.
///
/// Split from the HTTP call so the scoring is testable without a network, and
/// so it is visibly the *same* `integrity::score` the served path uses — a
/// second scorer here would make the two incomparable, which is the whole point
/// of the exercise.
pub fn score_mirrored(
    candidate_model: &str,
    request_body: Option<&Value>,
    response_body: Option<&Value>,
    latency_ms: u32,
    cost_usd: f64,
) -> MirrorOutcome {
    let facts = ResponseFacts {
        body: response_body,
        request: request_body,
        // Non-streaming only, so there is no terminal event to have missed.
        done_received: None,
    };
    MirrorOutcome {
        candidate_model: candidate_model.to_string(),
        integrity: integrity::score(&facts),
        latency_ms,
        cost_usd,
        // Set by `run_mirror` after scoring, from the same bytes `facts.body`
        // was parsed from. `score_mirrored` itself stays response-text-free so
        // its existing direct unit tests (constructing a `Value` in memory,
        // with no raw bytes in hand) don't have to invent any.
        response_text: None,
    }
}

/// Issues the mirrored request, scores it, and reports.
///
/// Takes an owned body and client so it can be spawned detached. Errors are
/// logged and dropped: a mirrored call is an observation, and a failed
/// observation must never surface to the user whose request has already been
/// answered.
///
/// The returned [`MirrorOutcome`] carries the mirrored response's raw text in
/// [`MirrorOutcome::response_text`]. That is NOT a durable-storage exception —
/// TD-346's discipline (never persist raw model response text) is unchanged.
/// The caller's only sanctioned use of that field is: DLP-scrub it alongside
/// the request text and the original (served) response text, and publish the
/// three together as a TRANSIENT Valkey pub/sub message (`Store::
/// publish_mirror_pair`, same channel-per-workspace shape as `publish_trace`)
/// for a separate, later phase's subscriber to judge and immediately discard.
/// This function never writes anywhere itself — see its caller in `proxy.rs`.
pub async fn run_mirror(
    _slot: MirrorSlot,
    http_client: reqwest::Client,
    url: String,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
    request_json: Option<Value>,
    candidate_model: String,
    workspace_id: String,
    estimate_cost: Arc<dyn Fn(&str, u32, u32) -> f64 + Send + Sync>,
) -> Option<MirrorOutcome> {
    let started = std::time::Instant::now();

    let resp = http_client
        .post(&url)
        .headers(headers)
        .body(body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(
                workspace_id = %workspace_id,
                candidate = %candidate_model,
                "Mirrored request failed: {e}"
            );
            return None;
        }
    };

    let status = resp.status();
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!(candidate = %candidate_model, "Mirrored body read failed: {e}");
            return None;
        }
    };

    if !status.is_success() {
        // An upstream refusal is not a quality fault — it says nothing about the
        // answer, only that there wasn't one. Scoring it would charge the
        // candidate for the provider's availability.
        tracing::debug!(
            candidate = %candidate_model,
            status = %status,
            "Mirrored request returned non-success; not scored"
        );
        return None;
    }

    let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
    let (prompt_tokens, completion_tokens) = parsed
        .as_ref()
        .map(usage_of)
        .unwrap_or((0, 0));
    let cost = estimate_cost(&candidate_model, prompt_tokens, completion_tokens);

    let mut outcome = score_mirrored(
        &candidate_model,
        request_json.as_ref(),
        parsed.as_ref(),
        started.elapsed().as_millis() as u32,
        cost,
    );
    // Raw text, not `parsed.to_string()`: a body that failed to parse as JSON
    // still deserves to reach the scrub-and-publish step verbatim rather than
    // as `None`. Lossy only for the (rare, non-UTF-8) response body case.
    outcome.response_text = Some(String::from_utf8_lossy(&bytes).into_owned());

    tracing::info!(
        workspace_id = %workspace_id,
        candidate = %outcome.candidate_model,
        mirrored = true,
        integrity = outcome.integrity.score,
        fault = ?outcome.integrity.fault,
        latency_ms = outcome.latency_ms,
        cost_usd = outcome.cost_usd,
        "Mirrored candidate scored"
    );

    // Deliberately no `write_cache` call, and never a durable-store write of
    // `outcome.response_text` from this function. The response text is
    // carried only as far as the caller's DLP-scrub-and-publish step — see
    // this function's doc comment.
    Some(outcome)
}

/// Token counts from a provider response, whichever shape it uses.
///
/// Deliberately CACHE-BLIND (TD-347): this reads [`crate::usage::TokenUsage`]'s
/// `total_input()`, never a cache-discounted cost. A mirror candidate is, by
/// definition, evaluating a model choice this session has never actually
/// routed to — the whole point of mirroring is measuring what a DIFFERENT
/// arm would have done on the same traffic the served arm actually saw. Such
/// a candidate cannot have a warm provider-side prompt cache from a prior
/// turn, so pricing it cache-aware would not be "fixing" a missed discount;
/// it would be crediting a discount no real request could ever have earned
/// from this candidate. Do not wire this through `estimate_cost_cached`.
///
/// Tries the Anthropic shape first, then falls back to OpenAI chat shape —
/// whichever the candidate model's provider actually used. This mirrors the
/// old dual-key-name heuristic's coverage (Gemini's `usageMetadata` was never
/// read here either, since it isn't nested under a `usage` key at all).
fn usage_of(body: &Value) -> (u32, u32) {
    let anthropic = crate::usage::TokenUsage::from_anthropic(body);
    let usage = if anthropic.uncached_input.is_some() || anthropic.output.is_some() {
        anthropic
    } else {
        crate::usage::TokenUsage::from_openai_chat(body)
    };
    (usage.total_input(), usage.output.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Serialises the tests that touch the process-wide counter.
    ///
    /// `IN_FLIGHT` is one static shared by every test in this module, and cargo
    /// runs them in parallel — so without this they race and fail in a
    /// different combination each run. Relying on `--test-threads=1` instead
    /// would mean the suite passes locally and fails in whatever runs it
    /// without that flag.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Takes the lock and zeroes the counter. Returns the guard, so a test
    /// holds it for its whole body rather than releasing at the end of `reset`.
    fn reset() -> std::sync::MutexGuard<'static, ()> {
        // A poisoned lock means an earlier test panicked; the counter still
        // needs zeroing, so recover rather than cascading the failure.
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        IN_FLIGHT.store(0, Ordering::SeqCst);
        guard
    }

    #[test]
    fn never_mirrors_a_stream() {
        let _serial = reset();
        // The two responses cannot be compared turn-for-turn, and scoring one
        // would mean fully consuming a second stream nobody is waiting for.
        assert!(should_mirror(1.0, true, "a", "b", 0.0).is_none());
        assert_eq!(in_flight(), 0, "a refused mirror must not hold a slot");
    }

    #[test]
    fn never_mirrors_a_model_against_itself() {
        let _serial = reset();
        assert!(should_mirror(1.0, false, "same", "same", 0.0).is_none());
        assert_eq!(in_flight(), 0);
    }

    #[test]
    fn does_not_mirror_when_disabled() {
        let _serial = reset();
        assert!(should_mirror(0.0, false, "a", "b", 0.0).is_none());
        assert_eq!(in_flight(), 0);
    }

    #[test]
    fn caps_the_sample_rate_however_it_is_configured() {
        let _serial = reset();
        // A typo adding a zero must cost a rounding error, not double the month.
        // At a configured 1.0, a roll above the 5% ceiling must still refuse.
        assert!(should_mirror(1.0, false, "a", "b", 0.5).is_none());
        assert_eq!(in_flight(), 0);
        assert!(
            should_mirror(1.0, false, "a", "b", 0.01).is_some(),
            "a roll inside the 5% ceiling must be permitted"
        );
    }

    #[test]
    fn honours_the_concurrency_ceiling() {
        let _serial = reset();
        let mut slots = Vec::new();
        for _ in 0..MAX_CONCURRENT {
            // The slot IS the permission. It cannot be constructed here — that
            // is what stopped a stray drop from underflowing the counter.
            slots.push(should_mirror(0.05, false, "a", "b", 0.0).expect("under the ceiling"));
        }
        assert_eq!(in_flight(), MAX_CONCURRENT);
        assert!(
            should_mirror(0.05, false, "a", "b", 0.0).is_none(),
            "a burst at the sample rate is still a burst; the ceiling bounds it"
        );
        // And the refusal did not leak a slot.
        assert_eq!(in_flight(), MAX_CONCURRENT);
        drop(slots);
        assert_eq!(in_flight(), 0, "slots must release on drop, not on a matched decrement");
    }

    #[test]
    fn a_slot_releases_even_when_the_task_returns_early() {
        let _serial = reset();
        {
            let _slot = should_mirror(0.05, false, "a", "b", 0.0).expect("permitted");
            // Simulates every early return inside run_mirror.
        }
        assert_eq!(in_flight(), 0);
    }

    #[test]
    fn scores_a_mirrored_response_with_the_same_scorer_as_the_served_path() {
        let _serial = reset();
        let request = json!({
            "tools": [{ "name": "get_weather", "input_schema": { "required": ["city"] } }]
        });
        // A tool call naming a tool that was never offered.
        let bad = json!({
            "content": [{ "type": "tool_use", "name": "rm_rf", "input": {} }]
        });
        let out = score_mirrored("cheap-model", Some(&request), Some(&bad), 120, 0.001);
        assert!(
            out.integrity.score < integrity::RIS_MAX,
            "an invented tool name must fault, or mirroring measures nothing"
        );
        assert!(out.integrity.fault.is_some(), "a bare score is not auditable");
        assert_eq!(out.candidate_model, "cheap-model");
        assert_eq!(out.latency_ms, 120);
    }

    /// The module must be CALLED, not merely present.
    ///
    /// This whole codebase's signature defect is the inert control — code that
    /// looks like it enforces something and reaches nothing. A mirror module
    /// with eight passing tests and no caller is exactly that shape, and it is
    /// the shape I shipped on the first pass here.
    #[test]
    fn the_request_path_actually_invokes_the_mirror() {
        let proxy = include_str!("../proxy.rs");
        assert!(
            proxy.contains("mirror::should_mirror("),
            "nothing asks whether to mirror; the module is inert"
        );
        assert!(
            proxy.contains("mirror::run_mirror("),
            "the sampling decision is made and never acted on"
        );
        // Detached. Awaiting it would put a second model on the user's latency
        // path, which is the one thing mirroring must never do.
        let spawn_idx = proxy.find("mirror::run_mirror(").expect("call present");
        let before = &proxy[spawn_idx.saturating_sub(600)..spawn_idx];
        assert!(
            before.contains("tokio::spawn"),
            "run_mirror must be spawned, not awaited inline — a mirrored call that \
             times out would otherwise be paid for by the user's request"
        );
        // The slot must be PASSED to `run_mirror`, not merely bound.
        //
        // `should_mirror` returning `Option<MirrorSlot>` already makes it
        // impossible to mirror without being permitted, but binding the slot and
        // then dropping it at the end of the `if` block would release it before
        // the call finishes — and the ceiling would bound nothing.
        //
        // Asserted on the argument rather than on a window of surrounding text:
        // the first version searched 600 characters before the call and failed
        // because the decision sits thirteen lines up, which is a fact about
        // formatting rather than about correctness.
        let after = &proxy[spawn_idx..];
        let first_arg = after
            .split_once('(')
            .and_then(|(_, rest)| rest.split(',').next())
            .map(str::trim)
            .unwrap_or("");
        assert_eq!(
            first_arg, "slot",
            "run_mirror's first argument must be the slot from the decision, got {first_arg:?}"
        );
    }

    #[test]
    fn reads_usage_from_either_provider_shape() {
        assert_eq!(usage_of(&json!({"usage":{"input_tokens":10,"output_tokens":5}})), (10, 5));
        assert_eq!(
            usage_of(&json!({"usage":{"prompt_tokens":7,"completion_tokens":3}})),
            (7, 3)
        );
        // A body with no usage costs zero rather than throwing off the estimate
        // with a guess.
        assert_eq!(usage_of(&json!({})), (0, 0));
    }
}

#[cfg(test)]
mod evidence_is_kept {
    //! Mirroring bills a second upstream call. Discarding the result makes that
    //! pure cost.
    //!
    //! `run_mirror` has always returned a `MirrorOutcome`, and the spawn in
    //! `proxy.rs` dropped it — so the only trace of a mirrored call was a
    //! `tracing::info!` line. C6 and C7 were deferred "pending mirror-measured
    //! data" while that data was being thrown away one line after it was
    //! computed.
    //!
    //! The call site is what records it, so this asserts on the source: a
    //! behavioural test would need a live store, and the property that actually
    //! broke is "nobody calls the recorder".

    #[test]
    fn the_mirror_spawn_records_its_outcome() {
        let proxy = include_str!("../proxy.rs");
        assert!(
            proxy.contains("record_mirror_outcome("),
            "the mirror spawn discards its outcome again — mirroring is then \
             pure cost, and C6/C7 wait on evidence that is never kept",
        );
        // Bound to the mirror spawn specifically, not merely present in the file.
        let spawn = proxy
            .split("mirror::run_mirror(")
            .nth(1)
            .expect("the mirror is still invoked from proxy.rs");
        let window = &spawn[..spawn.len().min(2_000)];
        assert!(
            window.contains("record_mirror_outcome("),
            "the recorder must be in the mirror spawn, not merely somewhere in the file",
        );
    }

    /// A non-2xx is not the candidate's fault, and must not be recorded as one.
    #[test]
    fn an_unscoreable_call_is_not_recorded_as_a_fault() {
        let proxy = include_str!("../proxy.rs");
        let spawn = proxy.split("mirror::run_mirror(").nth(1).unwrap();
        let window = &spawn[..spawn.len().min(2_000)];
        assert!(
            window.contains("if let Some(o) = outcome"),
            "recording must be conditional on an outcome existing: `None` means the \
             upstream refused, which says nothing about the candidate's quality",
        );
    }
}

#[cfg(test)]
mod streaming_parity {
    //! Agent harnesses stream by default, so anything set only on the
    //! non-streaming builder is absent from the traffic that matters.
    //!
    //! Two things were: the substitution disclosure header, and the shadow
    //! counterfactual. Both are asserted here on the source, because the
    //! difference is which branch of `proxy.rs` sets them rather than any value
    //! a unit test could observe.

    /// A customer who asked for Opus and got Haiku must be told, on every shape.
    #[test]
    fn the_routed_from_header_is_set_on_both_paths() {
        let proxy = include_str!("../proxy.rs");
        let n = proxy.matches("x-intutic-routed-from").count();
        assert!(
            n >= 2,
            "`x-intutic-routed-from` appears {n} time(s): it was set on the \
             non-streaming builder only, so silent substitution stayed silent \
             for the dominant traffic shape",
        );
    }

    /// Shadow mode's entire output is the counterfactual.
    #[test]
    fn the_streaming_trace_carries_the_shadow_counterfactual() {
        let proxy = include_str!("../proxy.rs");
        assert!(
            proxy.contains("routing_shadow_model: shadow_selection_clone"),
            "the streaming trace hardcoded `None` with a comment claiming routing \
             was never reached — `shadow_selection` is decided long before that \
             branch, so shadow mode recorded nothing for streamed requests",
        );
        // The same comment is TRUE at the cache-hit and error-short-circuit
        // traces, which genuinely never routed. Only the streaming one was
        // false, so this checks adjacency rather than absence.
        let at_streaming = proxy
            .split("routing_shadow_model: shadow_selection_clone")
            .next()
            .expect("the streaming site exists");
        let preceding = &at_streaming[at_streaming.len().saturating_sub(400)..];
        assert!(
            !preceding.contains("Never reached routing"),
            "the comment asserting the opposite still sits above the corrected line",
        );
    }
}
