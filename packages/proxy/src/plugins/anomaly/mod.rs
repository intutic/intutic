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
//! # Enforcement posture: deterministic kills, heuristic advises
//!
//! Detectors that check a *condition* (budget exceeded, forbidden succession,
//! DLP escalation) emit [`AnomalyFinding::kill`]; detectors that make a
//! *judgement* (transition plausibility, token waste, hallucination and
//! injection heuristics) emit [`AnomalyFinding::steer`] and never block. This
//! is the industry-consensus split, not a house quirk: OWASP LLM01 puts
//! enforcement weight on deterministic controls and treats detection filters
//! as one advisory layer; Lakera, LLM Guard, Azure Prompt Shields and AWS
//! Bedrock Guardrails all decouple heuristic detection from enforcement
//! (flag/annotate/DETECT modes), and published data shows why — pattern-based
//! injection detectors collapse below 60% accuracy on benign prompts that
//! merely contain trigger words (NotInject), and even Meta's tuned classifier
//! runs 3–5% false positives. A blocking heuristic at that FPR teaches users
//! to disable the guardrail, which ends with less protection than advising.
//!
//! Promotion rule: a heuristic (or a high-confidence subtier of one) may
//! graduate to `kill` only after advisory telemetry demonstrates a false
//! positive rate in the 0.1–1% band commercial blocking detectors operate at.
//! Do not promote on argument alone.

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
    /// Whether this should stop the request or merely steer it.
    pub kill: bool,
}

impl AnomalyFinding {
    pub fn kill(kind: AnomalyKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: 1.0,
            kill: true,
        }
    }

    pub fn steer(kind: AnomalyKind, reason: impl Into<String>, confidence: f64) -> Self {
        Self {
            kind,
            reason: reason.into(),
            confidence: confidence.clamp(0.0, 1.0),
            kill: false,
        }
    }

    /// Convert to the verdict the plugin pipeline understands.
    pub fn to_verdict(&self) -> Verdict {
        if self.kill {
            Verdict::Kill {
                reason: self.reason.clone(),
                policy_id: Some(self.kind.as_str().to_ascii_lowercase()),
            }
        } else {
            Verdict::Hijack {
                reason: self.reason.clone(),
                confidence: self.confidence,
            }
        }
    }
}

/// A hot-path detector.
///
/// Implementations must be side-effect free and must not block.
pub trait AnomalyDetector: Send + Sync {
    fn kind(&self) -> AnomalyKind;
    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding>;
}

/// Ordered set of detectors evaluated on every request.
pub struct DetectorRegistry {
    detectors: Vec<Box<dyn AnomalyDetector>>,
}

impl DetectorRegistry {
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

    /// The finding that should stop the request, if any.
    ///
    /// `None` means every finding was advisory and the request proceeds — the
    /// findings are still logged, broadcast and traced by the caller.
    ///
    /// This scans for *any* killing finding rather than testing whether the
    /// most severe one kills. `evaluate_all` sorts by severity with `kill` only
    /// as a tiebreak, so a High-severity steer sorts above a Medium-severity
    /// kill; testing `findings.first().kill` would let an advisory finding mask
    /// a real block. Among killers, the most severe wins the error message.
    pub fn blocking_finding(findings: &[AnomalyFinding]) -> Option<&AnomalyFinding> {
        findings
            .iter()
            .filter(|f| f.kill)
            .max_by_key(|f| f.kind.severity())
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
            .filter_map(|d| d.detect(ctx))
            .collect();
        findings.sort_by(|a, b| {
            b.kind
                .severity()
                .cmp(&a.kind.severity())
                .then(b.kill.cmp(&a.kill))
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
        // and the kill outranks the steer.
        let ctx = ctx_with_sequence(&["run_command"; 8]);
        let findings = reg.evaluate_all(&ctx);
        assert!(findings.len() >= 2, "expected multiple findings");
        assert!(findings[0].kill, "a kill must sort ahead of a steer");
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
        // findings.first().kill. evaluate_all sorts by severity with kill only
        // as a tiebreak, so the steer below sorts first — and a `worst.kill`
        // gate would let it suppress a genuine block.
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
                .then(b.kill.cmp(&a.kill))
        });
        assert!(!findings[0].kill, "test premise: the steer sorts first");

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
}
