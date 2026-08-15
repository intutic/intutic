//! Anomaly taxonomy and hot-path detector registry.
//!
//! # Taxonomy
//!
//! [`AnomalyKind`] mirrors the canonical 12-value runtime taxonomy exactly as
//! it is defined for the rest of the platform. The string forms returned by
//! [`AnomalyKind::as_str`] are the wire values, and they must not drift — they
//! are what a governance notification carries in its `category` field, and what
//! any consumer classifies on. A second vocabulary in the proxy would guarantee
//! divergence, so new detectors map onto an existing kind rather than inventing
//! one.
//!
//! # What belongs here
//!
//! Detectors in this module are **pure functions of a single
//! [`RequestContext`]**: no cross-session state, no rolling baselines, no
//! learned parameters, no model call. That is the line. Anything needing
//! history beyond the current session, fitted parameters, or judgement belongs
//! outside the hot path.
//!
//! The practical reason is latency, not licensing: this runs inline on every
//! request, so a detector that blocks on I/O blocks the user's agent.
//!
//! # Enforcement posture: conditions kill, thresholds reask, judgements advise
//!
//! Three dispositions, chosen by what a detector actually knows:
//!
//! | Disposition | For | Examples |
//! |---|---|---|
//! | [`AnomalyFinding::kill`] | a **condition** that was violated — true by construction, so there is no false-positive rate to be wrong about | budget exhausted, denied tool, declared scope path, forbidden succession, DLP escalation |
//! | [`AnomalyFinding::reask`] | an unmeasured **structural threshold** — a real signal plus a guess about where the line sits | consecutive repeats at 5, ping-pong at 3 cycles, recursion depth at 7, fan-out at 50 |
//! | [`AnomalyFinding::steer`] | a **judgement** | transition plausibility, token waste, hallucination heuristics |
//!
//! The kill/advise ends of that split are industry consensus, not a house
//! quirk: OWASP LLM01 puts enforcement weight on deterministic controls and
//! treats detection filters as one advisory layer; Lakera, LLM Guard, Azure
//! Prompt Shields and AWS Bedrock Guardrails all decouple heuristic detection
//! from enforcement (flag/annotate/DETECT modes), and published data shows why
//! — pattern-based injection detectors collapse below 60% accuracy on benign
//! prompts that merely contain trigger words (NotInject), and even Meta's tuned
//! classifier runs 3–5% false positives. A blocking heuristic at that FPR
//! teaches users to disable the guardrail, which ends with less protection than
//! advising.
//!
//! Promotion rule: a heuristic (or a high-confidence subtier of one) may
//! graduate to `kill` only after advisory telemetry demonstrates a false
//! positive rate in the 0.1–1% band commercial blocking detectors operate at.
//! Do not promote on argument alone.
//!
//! ## Why `reask` exists — this rule was being broken in writing
//!
//! The promotion rule above was here, and four detectors killed in violation of
//! it: `ConsecutiveRepeat` at 5, `PingPongCycle` at 3 cycles, `RecursionDepth`
//! at 7 on a *caller-asserted* depth, and `FanOutExplosion` at 50 nodes. None
//! has ever had an FPR measured, because nothing in this system records that a
//! firing was wrong. `PromptInjection` was worse: it killed at 2 regex matches
//! while the paragraph above said injection heuristics "emit steer and never
//! block".
//!
//! Demoting them all to `steer` would have honoured the rule and lost the
//! enforcement — a spin loop would stop being interrupted at all. `reask` is
//! the resolution: the agent is told exactly what it tripped and gets
//! [`REASK_MAX_ATTEMPTS`] tries to correct itself before the finding escalates
//! to a block. An unmeasured threshold can no longer end a task on its first
//! firing, and a genuine runaway still terminates.
//!
//! A detector reaching `kill` today should be able to name the declaration or
//! condition it checks. If the answer is "a number I picked", it belongs on
//! `reask` until there is data.

use crate::wasm::context::{RequestContext, Verdict};

pub mod actions;
pub mod broadcast;
pub mod detectors;

/// The 12-value runtime anomaly taxonomy.
///
/// Kept in lockstep with the platform-wide enum. Several distinct behaviours
/// map onto one kind by design — a spin loop and runaway recursion are both
/// `LoopDetected` — because their enforcement pathway is identical. The
/// detector's own reason string carries the distinction for forensics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnomalyKind {
    ToolAbuse,
    TokenWaste,
    LoopDetected,
    UnauthorizedTool,
    DataExfiltration,
    PromptInjection,
    Hallucination,
    ScopeViolation,
    BudgetBreach,
    SpawnBudgetBreach,
    WorkflowBudgetBreach,
    WorkflowGoalDrift,
}

/// Every taxonomy value, for exhaustive iteration.
///
/// The fixed length is deliberate: adding a variant without extending this
/// array is a compile error, so the list cannot silently fall behind the enum.
pub const ALL_KINDS: [AnomalyKind; 12] = [
    AnomalyKind::ToolAbuse,
    AnomalyKind::TokenWaste,
    AnomalyKind::LoopDetected,
    AnomalyKind::UnauthorizedTool,
    AnomalyKind::DataExfiltration,
    AnomalyKind::PromptInjection,
    AnomalyKind::Hallucination,
    AnomalyKind::ScopeViolation,
    AnomalyKind::BudgetBreach,
    AnomalyKind::SpawnBudgetBreach,
    AnomalyKind::WorkflowBudgetBreach,
    AnomalyKind::WorkflowGoalDrift,
];

impl AnomalyKind {
    /// Wire value. Must match the platform taxonomy string for string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ToolAbuse => "TOOL_ABUSE",
            Self::TokenWaste => "TOKEN_WASTE",
            Self::LoopDetected => "LOOP_DETECTED",
            Self::UnauthorizedTool => "UNAUTHORIZED_TOOL",
            Self::DataExfiltration => "DATA_EXFILTRATION",
            Self::PromptInjection => "PROMPT_INJECTION",
            Self::Hallucination => "HALLUCINATION",
            Self::ScopeViolation => "SCOPE_VIOLATION",
            Self::BudgetBreach => "BUDGET_BREACH",
            Self::SpawnBudgetBreach => "SPAWN_BUDGET_BREACH",
            Self::WorkflowBudgetBreach => "WORKFLOW_BUDGET_BREACH",
            Self::WorkflowGoalDrift => "WORKFLOW_GOAL_DRIFT",
        }
    }

    /// Severity, mirroring the platform-wide severity map.
    pub fn severity(self) -> Severity {
        match self {
            Self::DataExfiltration | Self::PromptInjection => Severity::Critical,
            Self::ToolAbuse
            | Self::LoopDetected
            | Self::UnauthorizedTool
            | Self::Hallucination
            | Self::BudgetBreach
            | Self::SpawnBudgetBreach
            | Self::WorkflowBudgetBreach => Severity::High,
            Self::TokenWaste | Self::ScopeViolation | Self::WorkflowGoalDrift => Severity::Medium,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Informational,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Informational => "INFORMATIONAL",
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
            Self::Critical => "CRITICAL",
        }
    }
}

/// What a finding should *do*, as distinct from what it found.
///
/// This replaced a `kill: bool`. Two booleans would have allowed the
/// meaningless "kill and also reask" state; an enum cannot represent it.
///
/// Declaration order is severity order, and [`Ord`] is derived from it, so
/// `b.disposition.cmp(&a.disposition)` sorts the most severe first. Adding a
/// variant means placing it correctly in this list, not editing a comparator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Disposition {
    /// Advise only. The request proceeds; the agent sees a corrective card.
    ///
    /// This is where a *judgement* belongs — transition plausibility, token
    /// waste, hallucination heuristics.
    Steer,
    /// Refuse this attempt and hand the reason back to the agent, which may
    /// try again. Escalates to [`Disposition::Kill`] after
    /// [`REASK_MAX_ATTEMPTS`] trips of the same finding in one session.
    ///
    /// This is where an unmeasured *structural threshold* belongs — "five
    /// identical calls in a row" is a real signal and a guess about where the
    /// line is, and the honest response to a guess is to say so and let the
    /// agent answer.
    Reask,
    /// Stop this attempt **and hold the whole run** until a human decides.
    ///
    /// Above `Reask` because self-correction cannot satisfy a declared review
    /// requirement — the operator asked to be asked, and an agent rephrasing
    /// itself is not a human approving. Below `Kill` because a hold is
    /// recoverable: a request that trips both must report as killed, since the
    /// kill has no approval path.
    ///
    /// Raised only from an operator declaration (`review_before:`), which is
    /// why [`AnomalyFinding::ask`] takes no confidence — there is nothing to
    /// grade.
    Ask,
    /// Block the request outright. No recourse in-band.
    ///
    /// Reserved for *conditions*: a declared policy was violated, a budget is
    /// exhausted, a tool is denied. These are true by construction, so there is
    /// no false-positive rate to be wrong about.
    Kill,
}

impl Disposition {
    /// Wire value, for telemetry and the control plane.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "STEER",
            Self::Reask => "REASK",
            Self::Ask => "ASK",
            Self::Kill => "KILL",
        }
    }
}

/// How many times one agent may trip the same reask finding before it blocks.
///
/// Three, not one: the first reask is information the agent did not have, and
/// an agent that corrects on the second attempt is exactly the outcome this
/// verb exists to produce. Escalation still arrives quickly enough that a
/// genuine runaway loop cannot spend a budget behind it.
pub const REASK_MAX_ATTEMPTS: u32 = 3;

/// A single detector's output.
#[derive(Debug, Clone)]
pub struct AnomalyFinding {
    pub kind: AnomalyKind,
    /// Human-readable explanation. Goes into the verdict shown to the agent, so
    /// it should say what tripped and why, not just name the rule.
    pub reason: String,
    /// 0.0–1.0. Deterministic detectors are certain by construction and report
    /// 1.0; the graded ones express how far past threshold they are.
    pub confidence: f64,
    /// Whether this should stop the request, ask the agent to correct itself,
    /// or merely steer it.
    pub disposition: Disposition,
    /// Which detector raised this — see [`AnomalyDetector::id`].
    ///
    /// **Written by the registry, not by the detector.** The constructors leave
    /// it empty and [`DetectorRegistry::evaluate_all`] stamps it from
    /// `detector.id()`. One write site cannot drift; twenty-two can, and a
    /// detector that stamped the wrong slug would silently merge its findings
    /// with another's everywhere this value is used as a key.
    ///
    /// Empty means the finding was built outside the registry — test fixtures do
    /// this. Callers keying on it must treat empty as "unattributed" rather than
    /// as a valid group.
    pub detector_id: &'static str,
}

impl AnomalyFinding {
    pub fn kill(kind: AnomalyKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: 1.0,
            disposition: Disposition::Kill,
            detector_id: "",
        }
    }

    /// Stop this attempt and hold the run for a human.
    ///
    /// No confidence parameter, deliberately, and hardcoded to 1.0 like
    /// [`Self::kill`]: a hold fires only off an operator declaration, so there
    /// is no false-positive rate to grade. Taking a confidence would invite a
    /// future detector to hold a run on a guess, which is the one thing this
    /// verb must not become — a human's attention is the scarcest resource the
    /// product spends.
    pub fn ask(kind: AnomalyKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: 1.0,
            disposition: Disposition::Ask,
            detector_id: "",
        }
    }

    /// Refuse this attempt and tell the agent why; escalate if it repeats.
    ///
    /// Confidence is carried because these are graded detectors — how far past
    /// threshold the sequence is belongs in the message the agent reads.
    pub fn reask(kind: AnomalyKind, reason: impl Into<String>, confidence: f64) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: confidence.clamp(0.0, 1.0),
            disposition: Disposition::Reask,
            detector_id: "",
        }
    }

    pub fn steer(kind: AnomalyKind, reason: impl Into<String>, confidence: f64) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: confidence.clamp(0.0, 1.0),
            disposition: Disposition::Steer,
            detector_id: "",
        }
    }

    /// True when this finding stops the request outright.
    ///
    /// A named predicate rather than a comparison, because "does this block?"
    /// is asked in several places and `== Disposition::Kill` invites someone to
    /// later write `>= Disposition::Reask` and change the answer by accident.
    pub fn blocks(&self) -> bool {
        // `Ask` is load-bearing here, not a nicety.
        //
        // The review hold used to be an `AnomalyFinding::kill`, so the request
        // that tripped `review_before: action:deploy` was refused and the deploy
        // did not happen. If `Ask` did not block, that request would fall
        // through and be served — the hold would be recorded and the deploy
        // would go out anyway, on the very request the hold exists to stop.
        matches!(self.disposition, Disposition::Kill | Disposition::Ask)
    }

    /// Convert to the verdict the plugin pipeline understands.
    ///
    /// `Reask` is rendered with a full attempt budget here. This path has no
    /// session state — it is used by [`DetectorRegistry::evaluate`], which is a
    /// pure function. The request path counts attempts and constructs the
    /// verdict itself; see `proxy.rs`.
    pub fn to_verdict(&self) -> Verdict {
        match self.disposition {
            // `Ask` maps to Kill, not to Hijack. `Verdict::Hijack` is documented
            // as "hold the request, render a decision card for human review" and
            // nothing has ever acted on it, so routing a real hold there would
            // add a second inert control beside the first.
            Disposition::Kill | Disposition::Ask => Verdict::Kill {
                reason: self.reason.clone(),
                policy_id: Some(self.kind.as_str().to_ascii_lowercase()),
            },
            Disposition::Reask => Verdict::Reask {
                reason: self.reason.clone(),
                attempts_remaining: REASK_MAX_ATTEMPTS,
                // The same id the request path keys the counter on.
                policy_id: Some(self.detector_id.to_string()),
            },
            Disposition::Steer => Verdict::Hijack {
                reason: self.reason.clone(),
                confidence: self.confidence,
            },
        }
    }
}

/// A hot-path detector.
///
/// Implementations must be side-effect free and must not block.
pub trait AnomalyDetector: Send + Sync {
    /// Stable identity for *this detector*, distinct from its taxonomy kind.
    ///
    /// [`AnomalyKind`] is deliberately shared — five detectors report
    /// `LoopDetected` and five report `ScopeViolation`, because their
    /// enforcement pathway is identical and a second vocabulary would drift
    /// from the platform's. But sixteen of twenty-two detectors share a kind
    /// with at least one sibling, so the kind cannot answer *which detector
    /// fired*, and several things need to know:
    ///
    /// * the reask escalation counter, which must give each detector its own
    ///   allowance — see the note on `incr_reask_attempt`;
    /// * sibling broadcast, which claims a slot per category and would
    ///   otherwise let one `LoopDetected` finding silence the other four;
    /// * any future attribution of a score, false positive or regression to the
    ///   detector responsible for it.
    ///
    /// Must be a stable snake_case slug, unique across the registry, and must
    /// **not** change once it has been persisted anywhere — it is an identifier,
    /// not a label. Uniqueness is enforced by a test.
    fn id(&self) -> &'static str;

    fn kind(&self) -> AnomalyKind;
    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding>;
}

/// Ordered set of detectors evaluated on every request.
pub struct DetectorRegistry {
    detectors: Vec<Box<dyn AnomalyDetector>>,
}

impl DetectorRegistry {
    /// A registry holding exactly `detectors`.
    ///
    /// Exists for the guard-liveness probes' falsifiability test: an EMPTY
    /// registry is the purest inert control, and the probe suite must fail
    /// against it or the suite is measuring nothing. Production always uses
    /// `with_defaults`.
    pub fn new(detectors: Vec<Box<dyn AnomalyDetector>>) -> Self {
        Self { detectors }
    }

    /// The default set: every detector that is a pure function of one request
    /// context. Detectors requiring node identity beyond what a single request
    /// carries are not registered here.
    pub fn with_defaults() -> Self {
        use detectors::*;
        Self {
            detectors: vec![
                Box::new(ConsecutiveRepeatDetector::default()),
                Box::new(PingPongCycleDetector::default()),
                Box::new(LandmarkCycleDetector::default()),
                Box::new(RecursionDepthDetector::default()),
                Box::new(FanOutExplosionDetector::default()),
                Box::new(TransitionProbabilityDetector::default()),
                Box::new(MissingPredecessorDetector::default()),
                Box::new(ForbiddenSuccessionDetector::default()),
                Box::new(CallCeilingDetector::default()),
                Box::new(TaintCooccurrenceDetector::default()),
                Box::new(CodeAsActionDetector::default()),
                Box::new(PlanAdherenceDetector::default()),
                Box::new(ScopePathDetector::default()),
                Box::new(ReviewGateDetector::default()),
                Box::new(DlpEscalationDetector::default()),
                Box::new(ToolDiversityCollapseDetector::default()),
                Box::new(SchemaDriftDetector::default()),
                Box::new(ContextGrowthDetector::default()),
                Box::new(BudgetExhaustionDetector::default()),
                Box::new(SpawnBudgetBreachDetector::default()),
                Box::new(OrphanExecutionDetector::default()),
                Box::new(UnauthorizedToolDetector::default()),
                Box::new(PromptInjectionDetector::default()),
                Box::new(ToolPoisoningDetector::default()),
                Box::new(WorkflowBudgetBreachDetector::default()),
                Box::new(CrossHarnessViolationDetector::default()),
            ],
        }
    }

    pub fn len(&self) -> usize {
        self.detectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.detectors.is_empty()
    }

    /// Every registered detector's stable id.
    ///
    /// `detectors` is private, so an integration test under `tests/` cannot
    /// enumerate the registry. Without this it would have to hardcode the list
    /// and compare against [`Self::len`] — which still passes when a detector is
    /// *renamed*, and [`AnomalyDetector::id`] says a rename is exactly what must
    /// not happen silently: "it is an identifier, not a label".
    pub fn ids(&self) -> Vec<&'static str> {
        self.detectors.iter().map(|d| d.id()).collect()
    }

    /// The finding that should stop the request, if any.
    ///
    /// `None` means every finding was advisory and the request proceeds — the
    /// findings are still logged, broadcast and traced by the caller.
    ///
    /// This scans for *any* killing finding rather than testing whether the
    /// most severe one kills. `evaluate_all` sorts by severity with disposition
    /// only as a tiebreak, so a High-severity steer sorts above a
    /// Medium-severity kill; testing `findings.first()` would let an advisory
    /// finding mask a real block. Among killers, the most severe wins the error
    /// message.
    pub fn blocking_finding(findings: &[AnomalyFinding]) -> Option<&AnomalyFinding> {
        findings
            .iter()
            .filter(|f| f.blocks())
            .max_by_key(|f| f.kind.severity())
    }

    /// The finding that should be handed back to the agent to retry, if any.
    ///
    /// Same scan-everything discipline as [`Self::blocking_finding`], and for
    /// the same reason: a reask that happens to sort below a steer must still
    /// be found.
    ///
    /// The caller must check [`Self::blocking_finding`] first. A request that
    /// trips both a kill and a reask is blocked — the kill is a condition that
    /// was violated, and no amount of agent self-correction makes it not have
    /// been.
    pub fn reask_finding(findings: &[AnomalyFinding]) -> Option<&AnomalyFinding> {
        findings
            .iter()
            .filter(|f| matches!(f.disposition, Disposition::Reask))
            .max_by_key(|f| f.kind.severity())
    }

    /// The finding that should hold this run for a human, if any.
    ///
    /// Replaces an inline substring match on the *reason prose* — the request
    /// path used to find a hold with
    /// `findings.iter().find(|f| f.reason.contains(REVIEW_HOLD_MARKER))`, which
    /// meant only `ReviewGateDetector` could ever raise one, and it did so by
    /// interpolating a literal into a human-readable sentence and matching it
    /// back out. Any detector can now hold by returning [`AnomalyFinding::ask`].
    ///
    /// **No back-compatibility arm for the old marker.** One was drafted and
    /// dropped: an `AnomalyFinding` never crosses a process or storage boundary
    /// — the registry's detector list is a fixed vec with no registration API,
    /// `broadcast_findings` is write-only, nothing deserialises a finding back,
    /// and WASM plugins return a `Verdict` on a separate path entirely. During a
    /// rolling deploy an old replica evaluates its own findings with its own
    /// inline matcher, so old findings never reach this code. The arm would have
    /// been unreachable the day it shipped, and its test would have passed
    /// against code nothing calls.
    ///
    /// `find`, not `max_by_key`: `evaluate_all` returns findings already sorted
    /// most-severe-first, and the hold write is `SET NX` so re-tripping is
    /// idempotent.
    pub fn holding_finding(findings: &[AnomalyFinding]) -> Option<&AnomalyFinding> {
        findings
            .iter()
            .find(|f| matches!(f.disposition, Disposition::Ask))
    }

    /// Fused, not flattened: the escalated finding when independent detectors
    /// corroborate, if any.
    ///
    /// [`Self::blocking_finding`] and [`Self::reask_finding`] each surface the
    /// single worst finding on its own axis — neither can see that two
    /// *different* detectors independently flagged the same request, because
    /// picking a winner is exactly what discards that fact. Two distinct
    /// heuristics agreeing is stronger evidence than either alone, even when
    /// neither individually cleared the bar for its next disposition.
    ///
    /// When at least 2 distinct `detector_id`s report a finding at
    /// [`Severity::Medium`] or worse, this escalates the most severe
    /// [`Disposition::Steer`] or [`Disposition::Reask`] finding among the
    /// corroborating set by exactly one rung — `Steer` becomes `Reask`,
    /// `Reask` becomes `Ask` — and returns a clone carrying the bump, its
    /// reason annotated with how many other detectors agreed. `Kill` and `Ask`
    /// findings are excluded from the pool that can *supply* the escalated
    /// finding (blocking already fires on its own, and a hold does not need
    /// help from a second signal), but still count toward the >= 2 threshold —
    /// a corroborating `Kill` is still corroboration.
    ///
    /// Detectors return `Some`/`None`, never a graded score, so how many
    /// independently agree is the only additional signal observable here —
    /// not stacked confidence, which no detector reports. That is the honest
    /// primitive: this counts agreement, it does not invent precision.
    pub fn corroborated_finding(findings: &[AnomalyFinding]) -> Option<AnomalyFinding> {
        let mut corroborating_ids: Vec<&'static str> = findings
            .iter()
            .filter(|f| f.kind.severity() >= Severity::Medium)
            .map(|f| f.detector_id)
            .filter(|id| !id.is_empty())
            .collect();
        corroborating_ids.sort_unstable();
        corroborating_ids.dedup();
        if corroborating_ids.len() < 2 {
            return None;
        }

        let worst = findings
            .iter()
            .filter(|f| f.kind.severity() >= Severity::Medium)
            .filter(|f| matches!(f.disposition, Disposition::Steer | Disposition::Reask))
            .max_by_key(|f| f.kind.severity())?;

        let mut escalated = worst.clone();
        escalated.disposition = match worst.disposition {
            Disposition::Steer => Disposition::Reask,
            Disposition::Reask => Disposition::Ask,
            // Unreachable given the filter above, kept exhaustive rather than
            // `unreachable!()` so a future disposition variant fails to
            // compile here instead of panicking in production.
            other @ (Disposition::Ask | Disposition::Kill) => other,
        };
        escalated.reason = format!(
            "{} (corroborated: {} other independent detector{} also fired on this request)",
            worst.reason,
            corroborating_ids.len() - 1,
            if corroborating_ids.len() - 1 == 1 { "" } else { "s" },
        );
        Some(escalated)
    }

    /// Run every detector and return all findings, most severe first.
    ///
    /// All detectors run rather than short-circuiting on the first hit: a
    /// request that trips three checks is more informative than one that trips
    /// one, and the cost is trivial for pure functions over a bounded sequence.
    pub fn evaluate_all(&self, ctx: &RequestContext) -> Vec<AnomalyFinding> {
        let mut findings: Vec<AnomalyFinding> = self
            .detectors
            .iter()
            .filter_map(|d| {
                // Stamp attribution here — the single write site. Letting each
                // detector set its own `detector_id` in its constructor call
                // would put twenty-two copies of the same fact in the tree, and
                // one that drifted would silently merge its findings with
                // another detector's wherever the id is used as a key.
                d.detect(ctx).map(|mut f| {
                    f.detector_id = d.id();
                    f
                })
            })
            .collect();
        findings.sort_by(|a, b| {
            b.kind
                .severity()
                .cmp(&a.kind.severity())
                .then(b.disposition.cmp(&a.disposition))
        });
        findings
    }

    /// The single most severe finding, as a verdict. `Bypass` when clean.
    pub fn evaluate(&self, ctx: &RequestContext) -> Verdict {
        self.evaluate_all(ctx)
            .first()
            .map(|f| f.to_verdict())
            .unwrap_or(Verdict::Bypass)
    }
}

impl Default for DetectorRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::anomaly::detectors::test_support::ctx_with_sequence;

    #[test]
    fn taxonomy_strings_match_platform_values() {
        // These are the wire values. If one of these assertions fails, the
        // proxy has drifted from the platform taxonomy and consumers will
        // silently fail to classify.
        let expected = [
            (AnomalyKind::ToolAbuse, "TOOL_ABUSE"),
            (AnomalyKind::TokenWaste, "TOKEN_WASTE"),
            (AnomalyKind::LoopDetected, "LOOP_DETECTED"),
            (AnomalyKind::UnauthorizedTool, "UNAUTHORIZED_TOOL"),
            (AnomalyKind::DataExfiltration, "DATA_EXFILTRATION"),
            (AnomalyKind::PromptInjection, "PROMPT_INJECTION"),
            (AnomalyKind::Hallucination, "HALLUCINATION"),
            (AnomalyKind::ScopeViolation, "SCOPE_VIOLATION"),
            (AnomalyKind::BudgetBreach, "BUDGET_BREACH"),
            (AnomalyKind::SpawnBudgetBreach, "SPAWN_BUDGET_BREACH"),
            (AnomalyKind::WorkflowBudgetBreach, "WORKFLOW_BUDGET_BREACH"),
            (AnomalyKind::WorkflowGoalDrift, "WORKFLOW_GOAL_DRIFT"),
        ];
        assert_eq!(expected.len(), 12, "taxonomy must have exactly 12 values");
        for (kind, s) in expected {
            assert_eq!(kind.as_str(), s);
        }
    }

    /// Cross-check the Rust taxonomy against `@intutic/anomaly-taxonomy`,
    /// which is the source of truth.
    ///
    /// The enum is declared twice — once here, once in that package — because
    /// the hot path is Rust and cannot call into TypeScript. Two
    /// hand-maintained copies drift, and drift here is silent: a renamed
    /// category simply stops being classified downstream, with no error
    /// anywhere.
    ///
    /// So the test parses the published source and fails the build on any
    /// divergence, which turns a silent classification gap into a broken build.
    #[test]
    fn taxonomy_matches_typescript_source() {
        let ts_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../anomaly-taxonomy/src/index.ts");

        let Ok(src) = std::fs::read_to_string(&ts_path) else {
            // The crate can be built outside the monorepo, where the sibling
            // package is absent. Loud, because a silent skip is how a guard
            // like this rots.
            eprintln!(
                "SKIPPED taxonomy cross-check: {} not found (expected only outside the monorepo)",
                ts_path.display()
            );
            return;
        };

        // Pull the value strings out of `export const AnomalyType = { ... }`.
        let body = src
            .split("export const AnomalyType = {")
            .nth(1)
            .and_then(|s| s.split("} as const").next())
            .expect("AnomalyType declaration not found in enums.ts — did it move or get renamed?");

        let mut ts_values: Vec<String> = body
            .lines()
            .filter_map(|l| l.split(':').nth(1))
            .filter_map(|v| v.split('\'').nth(1))
            .map(str::to_string)
            .collect();

        let mut rust_values: Vec<String> = ALL_KINDS
            .iter()
            .map(|k| k.as_str().to_string())
            .collect();

        ts_values.sort();
        rust_values.sort();

        assert_eq!(
            rust_values, ts_values,
            "Rust taxonomy has drifted from packages/anomaly-taxonomy/src/index.ts"
        );
    }

    #[test]
    fn severity_matches_platform_map() {
        assert_eq!(
            AnomalyKind::DataExfiltration.severity(),
            Severity::Critical
        );
        assert_eq!(AnomalyKind::PromptInjection.severity(), Severity::Critical);
        assert_eq!(AnomalyKind::LoopDetected.severity(), Severity::High);
        assert_eq!(AnomalyKind::TokenWaste.severity(), Severity::Medium);
        assert_eq!(AnomalyKind::ScopeViolation.severity(), Severity::Medium);
        assert_eq!(AnomalyKind::WorkflowGoalDrift.severity(), Severity::Medium);
    }

    #[test]
    fn clean_sequence_bypasses() {
        let reg = DetectorRegistry::with_defaults();
        let ctx = ctx_with_sequence(&["list_dir", "view_file", "replace_file_content"]);
        assert!(matches!(reg.evaluate(&ctx), Verdict::Bypass));
    }

    #[test]
    fn registry_returns_most_severe_first() {
        let reg = DetectorRegistry::with_defaults();
        // A spin loop (HIGH) alongside diversity collapse (HIGH) — both fire,
        // and the more severe disposition outranks the weaker one. The spin is
        // a reask rather than a kill since the promotion-rule fix: five in a
        // row is an unmeasured threshold, so it interrupts rather than blocks.
        let ctx = ctx_with_sequence(&["run_command"; 8]);
        let findings = reg.evaluate_all(&ctx);
        assert!(findings.len() >= 2, "expected multiple findings");
        assert_eq!(
            findings[0].disposition,
            Disposition::Reask,
            "a reask must sort ahead of a steer",
        );
    }

    #[test]
    fn empty_sequence_is_not_an_anomaly() {
        let reg = DetectorRegistry::with_defaults();
        let ctx = ctx_with_sequence(&[]);
        assert!(reg.evaluate_all(&ctx).is_empty());
    }

    #[test]
    fn default_registry_is_populated() {
        assert!(!DetectorRegistry::default().is_empty());
    }

    /// Plan adherence is reachable through the registry, not just as a struct.
    ///
    /// Its own unit tests instantiate the detector directly, which proves the
    /// comparison and nothing about whether anything ever calls it. A detector
    /// written, tested and never registered is the exact shape of defect this
    /// module keeps finding — so the wiring gets its own assertion.
    #[test]
    fn a_declared_plan_is_evaluated_by_the_registry() {
        let reg = DetectorRegistry::with_defaults();
        let mut ctx = ctx_with_sequence(&["list_dir", "kubectl", "curl", "action:deploy"]);
        ctx.plan_steps = vec!["list_dir".into()];

        assert!(
            reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.kind == AnomalyKind::ScopeViolation
                    && f.reason.contains("declared plan")),
            "the registry must reach PlanAdherenceDetector"
        );
    }

    /// Scope-path checking is reachable through the registry, not just as a
    /// struct. Same guard as the plan check above, for the same reason.
    #[test]
    fn a_declared_scope_path_is_evaluated_by_the_registry() {
        use crate::manifest::{ChangeEntry, ChangeOp, TargetKind};
        let reg = DetectorRegistry::with_defaults();
        let mut ctx = ctx_with_sequence(&["Write"]);
        ctx.scope_paths = vec!["packages/proxy".into()];
        ctx.changes = vec![ChangeEntry {
            tool: "Write".into(),
            op: ChangeOp::Write,
            target: "infra/kubernetes/base/configmap.yaml".into(),
            target_kind: TargetKind::Path,
            risk: Vec::new(),
            bytes: None,
        }];

        assert!(
            reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.kind == AnomalyKind::ScopeViolation
                    && f.reason.contains("declared file scope")),
            "the registry must reach ScopePathDetector"
        );
    }

    /// And the same change with no scope declared raises nothing — the opt-in
    /// holds through the registry.
    #[test]
    fn the_same_change_without_a_scope_raises_no_scope_violation() {
        use crate::manifest::{ChangeEntry, ChangeOp, TargetKind};
        let reg = DetectorRegistry::with_defaults();
        let mut ctx = ctx_with_sequence(&["Write"]);
        ctx.changes = vec![ChangeEntry {
            tool: "Write".into(),
            op: ChangeOp::Write,
            target: "/etc/passwd".into(),
            target_kind: TargetKind::Path,
            risk: Vec::new(),
            bytes: None,
        }];
        assert!(
            !reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.reason.contains("declared file scope")),
            "scope checking must be silent without a declared scope"
        );
    }

    /// The review hold is reachable through the registry.
    #[test]
    fn a_declared_review_action_is_evaluated_by_the_registry() {
        let reg = DetectorRegistry::with_defaults();
        let mut ctx = ctx_with_sequence(&["Bash"]);
        ctx.review_before = vec!["action:deploy".into()];
        ctx.new_tool_calls = vec!["Bash".into(), "action:deploy".into()];

        let findings = reg.evaluate_all(&ctx);
        assert!(
            findings
                .iter()
                .any(|f| f.reason.contains(crate::plugins::anomaly::detectors::REVIEW_HOLD_MARKER)),
            "the registry must reach ReviewGateDetector"
        );
        assert!(
            DetectorRegistry::blocking_finding(&findings).is_some(),
            "a hold must actually block, or the run continues past it"
        );
    }

    /// The markers the reachability tests key on must stay disjoint.
    ///
    /// Several detectors now share `ScopeViolation`, and each is proven
    /// reachable by a substring of its reason. If two of those substrings ever
    /// overlap, one detector's test starts passing on another's finding — and
    /// the detector it was written for could be unregistered entirely without
    /// anything going red. The guard is cheap; the failure mode is invisible.
    /// Landmark cycle detection is reachable through the registry.
    #[test]
    fn a_landmark_cycle_is_evaluated_by_the_registry() {
        use crate::plugins::anomaly::detectors::CYCLE_PERIOD_MARKER;
        let reg = DetectorRegistry::with_defaults();
        // A period-3 cycle: invisible to every other detector on the built-in
        // path, which `a_three_cycle_escapes_the_builtin_table_entirely` pins.
        let ctx = ctx_with_sequence(&[
            "Read", "Grep", "Bash", "Read", "Grep", "Bash",
            "Read", "Grep", "Bash", "Read", "Grep", "Bash",
        ]);
        assert!(
            reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.kind == AnomalyKind::LoopDetected
                    && f.reason.contains(CYCLE_PERIOD_MARKER)),
            "the registry must reach LandmarkCycleDetector"
        );
    }

    /// The same sequence with only three entries raises nothing — the detector
    /// declines to judge rather than guessing from too little.
    #[test]
    fn a_short_sequence_raises_no_cycle_finding() {
        use crate::plugins::anomaly::detectors::CYCLE_PERIOD_MARKER;
        let reg = DetectorRegistry::with_defaults();
        let ctx = ctx_with_sequence(&["Read", "Grep", "Bash"]);
        assert!(
            !reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.reason.contains(CYCLE_PERIOD_MARKER))
        );
    }

    /// Every marker a reachability test keys on must be pairwise disjoint.
    ///
    /// Generalised from a `ScopeViolation`-only guard once `LoopDetected` grew a
    /// third producer. The hazard is the same in both families and worth stating
    /// once: if two markers overlap, one detector's reachability test starts
    /// passing on another detector's finding — so the detector it was written
    /// for could be unregistered entirely without anything going red.
    ///
    /// The `LoopDetected` markers are `pub const`s interpolated into their own
    /// format strings, so this cannot assert a phrase the code stopped emitting.
    #[test]
    fn all_reachability_markers_are_pairwise_disjoint() {
        use crate::plugins::anomaly::detectors::{
            ALTERNATION_MARKER, CYCLE_PERIOD_MARKER, REVIEW_HOLD_MARKER, SPIN_MARKER,
        };
        const MARKERS: [&str; 6] = [
            "declared plan",
            "declared file scope",
            REVIEW_HOLD_MARKER,
            SPIN_MARKER,
            ALTERNATION_MARKER,
            CYCLE_PERIOD_MARKER,
        ];
        for (i, a) in MARKERS.iter().enumerate() {
            for (j, b) in MARKERS.iter().enumerate() {
                if i != j {
                    assert!(
                        !a.contains(b) && !b.contains(a),
                        "marker {a:?} and {b:?} overlap; one reachability test could \
                         pass on the other detector's finding"
                    );
                }
            }
        }
    }

    /// And the same sequence with no plan declared stays clean — the opt-in
    /// holds through the registry too, so enabling the feature for one
    /// workspace cannot start flagging every other one.
    #[test]
    fn the_same_sequence_without_a_plan_raises_no_scope_violation() {
        let reg = DetectorRegistry::with_defaults();
        let ctx = ctx_with_sequence(&["list_dir", "kubectl", "curl", "action:deploy"]);
        assert!(
            !reg.evaluate_all(&ctx)
                .iter()
                .any(|f| f.reason.contains("declared plan")),
            "plan adherence must be silent without a declared plan"
        );
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::detectors::test_support::*;
    use super::*;
    use crate::wasm::context::{NodeIdentity, RequestContext};

    /// Which taxonomy categories the hot path can actually raise.
    ///
    /// This asserts *fireability*, not registration. The previous version of this
    /// test counted registered detectors, and its own docstring warned about the
    /// gap it then fell into: "a detector that exists but can never fire looks
    /// the same from the outside as one that works". Eleven were registered;
    /// several could not fire, because their inputs were produced by nothing —
    /// graph identity was never set, so the four graph-shaped detectors were
    /// unreachable, and the scope rules named tools no harness emits.
    ///
    /// So every category here is proved by constructing a context that makes it
    /// fire. A detector that stops being reachable now fails the build, which is
    /// the guard that would have caught this class years earlier.
    #[test]
    fn every_hot_path_category_can_actually_fire() {
        let registry = DetectorRegistry::with_defaults();

        // (category, a context that must raise it)
        let cases: Vec<(&str, RequestContext)> = vec![
            (
                "LOOP_DETECTED",
                ctx_with_sequence(&["Bash", "Bash", "Bash", "Bash", "Bash"]),
            ),
            (
                "TOOL_ABUSE",
                ctx_with_sequence(&["run_command", "run_command", "run_command"]),
            ),
            (
                // Reachable only because `actions::classify` now translates
                // `git push` into `action:deploy`.
                "SCOPE_VIOLATION",
                ctx_with_sequence(&["Bash", "action:deploy"]),
            ),
            (
                "DATA_EXFILTRATION",
                RequestContext {
                    // Three distinct patterns is the escalation threshold: one
                    // secret is a mistake, a sweep of them is an exfiltration.
                    dlp_findings: vec![
                        dlp("aws_key", "block"),
                        dlp("anthropic_key", "block"),
                        dlp("github_token", "block"),
                    ],
                    ..base_ctx()
                },
            ),
            (
                "PROMPT_INJECTION",
                RequestContext {
                    injection_findings: vec!["ignore all previous instructions".into()],
                    ..base_ctx()
                },
            ),
            (
                "BUDGET_BREACH",
                RequestContext { budget_remaining_usd: 0.0, ..base_ctx() },
            ),
            (
                "TOKEN_WASTE",
                // Both halves are required: a big context is only waste if the
                // agent has been working long enough for it to have compounded.
                RequestContext {
                    estimated_input_tokens: 200_000,
                    tool_sequence: vec![
                        "Read".into(),
                        "Grep".into(),
                        "Write".into(),
                        "Bash".into(),
                        "Glob".into(),
                    ],
                    ..base_ctx()
                },
            ),
            (
                "UNAUTHORIZED_TOOL",
                // The denial has to meet an actual call: a denied tool nobody
                // invoked is a policy, not an incident.
                RequestContext {
                    denied_tools: vec!["Bash".into()],
                    tool_calls: vec![crate::wasm::context::ToolCall {
                        id: "tc_1".into(),
                        name: "Bash".into(),
                        arguments: serde_json::json!({"command": "rm -rf /"}),
                    }],
                    ..base_ctx()
                },
            ),
            (
                "WORKFLOW_BUDGET_BREACH",
                RequestContext {
                    workflow_spend_usd: Some(50.0),
                    workflow_budget_usd: Some(10.0),
                    ..base_ctx()
                },
            ),
            (
                // The four below need graph identity, which nothing set until
                // `intutic exec` and the SDK started emitting it.
                "SPAWN_BUDGET_BREACH",
                RequestContext {
                    node: NodeIdentity {
                        graph_id: "fleet".into(),
                        node_id: "worker".into(),
                        graph_spend_usd: Some(500.0),
                        graph_budget_usd: Some(10.0),
                        ..NodeIdentity::default()
                    },
                    ..base_ctx()
                },
            ),
            (
                "HALLUCINATION",
                RequestContext {
                    node: NodeIdentity {
                        graph_id: "fleet".into(),
                        node_id: "worker".into(),
                        parent_session_id: "lead".into(),
                        parent_alive: Some(false),
                        ..NodeIdentity::default()
                    },
                    ..base_ctx()
                },
            ),
        ];

        let mut fired: Vec<&str> = Vec::new();
        for (category, ctx) in &cases {
            let findings = registry.evaluate_all(ctx);
            let kinds: Vec<&str> = findings.iter().map(|f| f.kind.as_str()).collect();
            assert!(
                kinds.contains(category),
                "{category} did not fire; this context raised {kinds:?}. A category \
                 that cannot be reached is not covered, however many detectors are \
                 registered for it.",
            );
            fired.push(category);
        }

        fired.sort_unstable();
        fired.dedup();

        // Everything registered must also be provably fireable — no category may
        // be claimed by a detector that nothing can reach.
        let mut registered: Vec<&str> = registry
            .detectors
            .iter()
            .map(|d| d.kind().as_str())
            .collect();
        registered.sort_unstable();
        registered.dedup();
        assert_eq!(
            fired, registered,
            "every registered category needs a case here proving it can fire",
        );

        // WORKFLOW_GOAL_DRIFT is the twelfth and is deliberately not here. It
        // asks whether an agent is still doing what it was asked to do, which
        // needs the plan it was given and a record of how far execution has
        // strayed — both live in the control plane, and reaching them means a
        // database lookup that does not belong inline on the hot path. The
        // scoring is a plain threshold against a 0..1 score; what the proxy
        // lacks is the plan, not the arithmetic. Its fireability is proved by
        // the control plane's own suite.
        let uncovered: Vec<&str> = ALL_KINDS
            .iter()
            .map(|k| k.as_str())
            .filter(|k| !registered.contains(k))
            .collect();
        assert_eq!(uncovered, vec!["WORKFLOW_GOAL_DRIFT"]);
    }

    // ── blocking_finding ────────────────────────────────────────────────
    //
    // The request path returned 403 for every finding, using `kill` only to
    // choose between two error strings. Many detectors emit `kill: false`,
    // which `to_verdict` maps to Hijack — advise, do not block — and those
    // paths were hard-blocking requests they were written to advise on. These
    // tests pin the corrected selection.
    //
    // No detector census here on purpose: the count in this comment was wrong
    // twice before anyone noticed, because prose does not fail the build. What
    // matters is enforced by `every_hot_path_category_can_actually_fire`, which
    // does.

    #[test]
    fn advisory_findings_alone_do_not_block() {
        let findings = vec![
            AnomalyFinding::steer(AnomalyKind::ToolAbuse, "repetitive", 0.7),
            AnomalyFinding::steer(AnomalyKind::TokenWaste, "wasteful", 0.4),
        ];
        assert!(
            DetectorRegistry::blocking_finding(&findings).is_none(),
            "steer-only findings must not stop the request"
        );
    }

    /// Any detector can hold a run — that is the whole point of the change.
    ///
    /// Before this, the request path found a hold by scanning finding *reasons*
    /// for the literal "held for human review", so `ReviewGateDetector` was the
    /// only thing in the system that could ever raise one, and it did so by
    /// interpolating a marker into a human-readable sentence.
    #[test]
    fn any_detector_can_raise_a_hold() {
        // Deliberately a kind ReviewGateDetector never uses, and a reason that
        // does not contain the old marker. Under the substring matcher this
        // finding was invisible.
        let findings = vec![AnomalyFinding::ask(
            AnomalyKind::DataExfiltration,
            "a human declared this needs approval",
        )];
        let hold = DetectorRegistry::holding_finding(&findings)
            .expect("an Ask must be found regardless of its wording or kind");
        assert_eq!(hold.kind, AnomalyKind::DataExfiltration);
        assert!(
            !hold.reason.contains(crate::plugins::anomaly::detectors::REVIEW_HOLD_MARKER),
            "test premise: this finding is invisible to the old substring matcher",
        );
    }

    /// A hold must still stop the request it was raised on.
    ///
    /// The hold used to be a `kill`, so tripping `review_before: action:deploy`
    /// refused the request and the deploy did not happen. If `Ask` stopped
    /// blocking, the hold would be recorded and the deploy would go out anyway —
    /// on the very request the hold exists to stop.
    #[test]
    fn a_hold_blocks_the_request_that_raised_it() {
        let findings = vec![AnomalyFinding::ask(AnomalyKind::ScopeViolation, "held")];
        assert!(findings[0].blocks(), "an Ask must block");
        assert!(
            DetectorRegistry::blocking_finding(&findings).is_some(),
            "and must be found by the blocking scan the 403 is driven from",
        );
    }

    /// A kill outranks a hold on the same request.
    ///
    /// A hold is recoverable — a human can approve it. A kill is not. Reporting
    /// the hold would offer an approval path for a request that has none.
    #[test]
    fn a_kill_outranks_a_hold() {
        assert!(Disposition::Kill > Disposition::Ask);
        assert!(Disposition::Ask > Disposition::Reask);
    }

    /// The review-hold reason must not move, ever.
    ///
    /// Clearing a hold compares FULL string equality: the control plane stores
    /// this exact reason as the cleared-watermark, and the proxy compares it
    /// before deciding whether to re-hold. One changed character makes every
    /// already-approved run re-hold itself — the precise failure the watermark
    /// exists to prevent, and it would present as "approval is broken".
    #[test]
    fn the_review_hold_reason_is_byte_stable() {
        use crate::plugins::anomaly::detectors::{ReviewGateDetector, REVIEW_HOLD_MARKER};
        let mut ctx = ctx_with_sequence(&[]);
        ctx.review_before = vec!["action:deploy".into()];
        ctx.new_tool_calls = vec!["action:deploy".into()];

        let f = ReviewGateDetector
            .detect(&ctx)
            .expect("a declared action must hold");
        assert_eq!(
            f.reason,
            format!("Run {REVIEW_HOLD_MARKER}: action:deploy — declared in review_before:"),
            "the stored cleared-watermark is compared against this string verbatim",
        );
        assert_eq!(f.disposition, Disposition::Ask);
    }

    #[test]
    fn a_reask_does_not_block() {
        // The whole point of the verb. If `blocking_finding` ever picked these
        // up, the promotion-rule fix would have been cosmetic: the same four
        // detectors would still be terminating tasks, just under a new name.
        let findings = vec![AnomalyFinding::reask(
            AnomalyKind::LoopDetected,
            "spinning on Bash",
            0.65,
        )];
        assert!(
            DetectorRegistry::blocking_finding(&findings).is_none(),
            "a reask must not stop the request outright",
        );
        assert!(
            DetectorRegistry::reask_finding(&findings).is_some(),
            "...but it must be found by the reask scan",
        );
    }

    #[test]
    fn a_kill_outranks_a_reask_on_the_same_request() {
        // A request that trips both is blocked. The kill is a condition that was
        // violated, and no amount of agent self-correction makes it not have
        // been — so the reask must not be able to soften it into a retry.
        let findings = vec![
            AnomalyFinding::reask(AnomalyKind::LoopDetected, "spinning", 0.6),
            AnomalyFinding::kill(AnomalyKind::DataExfiltration, "credentials in arguments"),
        ];
        let blocking = DetectorRegistry::blocking_finding(&findings)
            .expect("the kill must still be found alongside a reask");
        assert_eq!(blocking.kind, AnomalyKind::DataExfiltration);
    }

    #[test]
    fn a_high_severity_steer_does_not_mask_a_lower_severity_reask() {
        // Same trap as `a_high_severity_steer_does_not_mask_a_lower_severity_kill`
        // below, one rung down. `evaluate_all` sorts by severity first, so a
        // reask can sit behind a more severe advisory finding — and a
        // `findings.first()` gate would silently drop the interrupt.
        let steer = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "advisory", 0.9);
        let reasker = AnomalyFinding::reask(AnomalyKind::TokenWaste, "spinning", 0.6);
        assert!(
            steer.kind.severity() > reasker.kind.severity(),
            "test premise: the steer must outrank the reask by severity",
        );

        let mut findings = vec![steer, reasker];
        findings.sort_by(|a, b| {
            b.kind
                .severity()
                .cmp(&a.kind.severity())
                .then(b.disposition.cmp(&a.disposition))
        });
        assert_eq!(
            findings[0].disposition,
            Disposition::Steer,
            "test premise: the steer sorts first",
        );

        let found = DetectorRegistry::reask_finding(&findings)
            .expect("the reask must be found behind the higher-severity steer");
        assert_eq!(found.kind, AnomalyKind::TokenWaste);
    }

    /// Every registered detector must have a unique, non-empty id.
    ///
    /// A duplicate is silent and expensive: `detector_id` keys the reask
    /// escalation counter and sibling broadcast, so two detectors sharing a slug
    /// would merge their allowances and one would suppress the other — which is
    /// precisely the bug that keying on `AnomalyKind` produced, reintroduced one
    /// layer down.
    ///
    /// Empty is checked separately because the constructors default to `""`, so
    /// a detector added without an `id()` would otherwise pass the uniqueness
    /// check for exactly as long as it was the only one missing.
    #[test]
    fn every_detector_id_is_unique_and_non_empty() {
        let reg = DetectorRegistry::with_defaults();
        let ids: Vec<&'static str> = reg.ids();

        // 26: code_as_action joined — the in-blob analogue of forbid_with
        // secrets()+http_post, for the one-REPL-call-bundles-everything shape
        // that per-call gates cannot see into.
        assert_eq!(ids.len(), 26, "registry size changed — update this test deliberately");

        for id in &ids {
            assert!(!id.is_empty(), "a registered detector has no id");
            assert!(
                id.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "id {id:?} must be a snake_case slug — it is an identifier, not a label",
            );
        }

        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(
            unique.len(),
            ids.len(),
            "duplicate detector id — these would share a reask allowance and a \
             broadcast slot. ids: {ids:?}",
        );
    }

    /// `evaluate_all` must stamp attribution onto every finding it returns.
    ///
    /// The constructors leave `detector_id` empty on purpose, so a finding that
    /// escaped the registry unstamped would carry `""` — and `""` is a perfectly
    /// good Valkey key. Every reask in the process would then share one
    /// allowance, which is the original bug with no detector name on it at all.
    #[test]
    fn evaluate_all_stamps_the_detector_id() {
        let reg = DetectorRegistry::with_defaults();
        let ctx = ctx_with_sequence(&["run_command"; 8]);
        let findings = reg.evaluate_all(&ctx);

        assert!(!findings.is_empty(), "fixture must trip something");
        for f in &findings {
            assert!(
                !f.detector_id.is_empty(),
                "finding {:?} left the registry unattributed",
                f.kind.as_str(),
            );
        }
        assert!(
            findings.iter().any(|f| f.detector_id == "consecutive_repeat"),
            "the spin detector must be identifiable by name, not just by kind",
        );
    }

    #[test]
    fn disposition_orders_by_severity() {
        // `evaluate_all`'s tiebreak is `b.disposition.cmp(&a.disposition)`, which
        // is correct only if declaration order is severity order. Pin it: a
        // variant inserted in the wrong place would silently reorder findings.
        assert!(Disposition::Kill > Disposition::Reask);
        assert!(Disposition::Reask > Disposition::Steer);
    }

    #[test]
    fn a_killing_finding_blocks() {
        let findings = vec![AnomalyFinding::kill(
            AnomalyKind::DataExfiltration,
            "credentials in tool arguments",
        )];
        let blocking = DetectorRegistry::blocking_finding(&findings).expect("must block");
        assert_eq!(blocking.kind, AnomalyKind::DataExfiltration);
    }

    #[test]
    fn a_high_severity_steer_does_not_mask_a_lower_severity_kill() {
        // The reason this scans for any killer instead of testing
        // findings.first(). evaluate_all sorts by severity with disposition
        // only as a tiebreak, so the steer below sorts first — and gating on
        // the first finding would let it suppress a genuine block.
        let steer = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "advisory", 0.9);
        let killer = AnomalyFinding::kill(AnomalyKind::TokenWaste, "budget exhausted");

        assert!(
            steer.kind.severity() > killer.kind.severity(),
            "test premise: the steer must outrank the kill by severity"
        );

        let mut findings = vec![steer, killer];
        findings.sort_by(|a, b| {
            b.kind
                .severity()
                .cmp(&a.kind.severity())
                .then(b.disposition.cmp(&a.disposition))
        });
        assert!(!findings[0].blocks(), "test premise: the steer sorts first");

        let blocking = DetectorRegistry::blocking_finding(&findings)
            .expect("the kill must still be found behind the higher-severity steer");
        assert_eq!(blocking.kind, AnomalyKind::TokenWaste);
    }

    #[test]
    fn the_most_severe_killer_supplies_the_message() {
        let findings = vec![
            AnomalyFinding::kill(AnomalyKind::TokenWaste, "lower severity"),
            AnomalyFinding::kill(AnomalyKind::DataExfiltration, "higher severity"),
        ];
        let blocking = DetectorRegistry::blocking_finding(&findings).expect("must block");
        assert_eq!(blocking.kind, AnomalyKind::DataExfiltration);
        assert_eq!(blocking.reason, "higher severity");
    }

    /// A lone finding is not corroboration, no matter its severity or
    /// disposition — the whole primitive is *agreement between distinct
    /// detectors*, and one detector cannot agree with itself.
    #[test]
    fn a_single_finding_does_not_corroborate() {
        let mut steer = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "advisory", 0.9);
        steer.detector_id = "tool_diversity_collapse";
        assert!(DetectorRegistry::corroborated_finding(&[steer]).is_none());
    }

    /// Two findings from the SAME detector id are not corroboration either —
    /// `detector_id` is deduplicated before counting, so a detector that
    /// somehow fired twice in one evaluation must not look like two detectors
    /// agreeing.
    #[test]
    fn duplicate_detector_ids_do_not_corroborate() {
        let mut a = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "first", 0.9);
        a.detector_id = "tool_diversity_collapse";
        let mut b = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "second", 0.6);
        b.detector_id = "tool_diversity_collapse";
        assert!(DetectorRegistry::corroborated_finding(&[a, b]).is_none());
    }

    /// Two distinct detectors agreeing at Steer escalates the worse one to
    /// Reask — a judgement two independent heuristics both reached is treated
    /// as more than either alone, even though neither cleared its own bar.
    #[test]
    fn two_distinct_steers_escalate_to_reask() {
        let mut a = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "wasteful pattern", 0.7);
        a.detector_id = "tool_diversity_collapse";
        let mut b = AnomalyFinding::steer(AnomalyKind::TokenWaste, "verbose output", 0.5);
        b.detector_id = "context_growth";

        let escalated = DetectorRegistry::corroborated_finding(&[a, b])
            .expect("two distinct steers at >= Medium severity must corroborate");
        assert_eq!(escalated.disposition, Disposition::Reask);
        // ToolAbuse (High) outranks TokenWaste (Medium) — the worse of the two
        // supplies the escalated finding.
        assert_eq!(escalated.kind, AnomalyKind::ToolAbuse);
        assert!(
            escalated.reason.contains("corroborated"),
            "the escalated reason must say why it escalated: {:?}",
            escalated.reason,
        );
    }

    /// One rung, not straight to a hold: two agreeing Reask findings escalate
    /// to Ask, never past it. Corroboration argues the signal is stronger, not
    /// that it becomes a declared condition — only `review_before:` may raise
    /// an `ask` per `AnomalyFinding::ask`'s own contract.
    #[test]
    fn two_distinct_reasks_escalate_to_ask_not_further() {
        let mut a = AnomalyFinding::reask(AnomalyKind::LoopDetected, "spinning", 0.6);
        a.detector_id = "consecutive_repeat";
        let mut b = AnomalyFinding::reask(AnomalyKind::LoopDetected, "cycling", 0.55);
        b.detector_id = "ping_pong_cycle";

        let escalated = DetectorRegistry::corroborated_finding(&[a, b])
            .expect("two distinct reasks must corroborate");
        assert_eq!(escalated.disposition, Disposition::Ask);
    }

    /// Severity below Medium never counts toward the threshold, matching the
    /// plan's own bar — a corroborating pair of low-severity advisories is not
    /// the same signal as two detectors independently flagging something the
    /// taxonomy already treats as serious.
    #[test]
    fn below_medium_severity_does_not_corroborate() {
        // Every AnomalyKind is Medium or above by construction (see
        // `AnomalyKind::severity`), so this pins that invariant rather than
        // constructing an impossible finding — if a future kind introduces a
        // Low/Informational severity, this test starts failing loudly instead
        // of the corroboration threshold silently admitting it.
        for kind in ALL_KINDS {
            assert!(
                kind.severity() >= Severity::Medium,
                "{kind:?} is below Medium — corroborated_finding's threshold check \
                 must be revisited for it",
            );
        }
    }

    /// A `Kill` finding counts toward the >= 2 threshold — corroboration is
    /// about *agreement*, and a kill is still a detector firing — but it is
    /// excluded from the pool that can supply the escalated finding, since a
    /// kill already blocks on its own and does not need help from a second
    /// signal.
    #[test]
    fn a_kill_counts_toward_the_threshold_but_never_supplies_the_escalation() {
        let mut killer = AnomalyFinding::kill(AnomalyKind::DataExfiltration, "credentials");
        killer.detector_id = "taint_cooccurrence";
        let mut steer = AnomalyFinding::steer(AnomalyKind::ToolAbuse, "advisory", 0.8);
        steer.detector_id = "tool_diversity_collapse";

        let escalated = DetectorRegistry::corroborated_finding(&[killer, steer])
            .expect("the kill must still count toward corroboration");
        assert_eq!(
            escalated.disposition,
            Disposition::Reask,
            "the steer, not the kill, must be the one escalated",
        );
        assert_eq!(escalated.kind, AnomalyKind::ToolAbuse);
    }
}
