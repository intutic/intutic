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

use crate::wasm::context::{RequestContext, Verdict};

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
                Box::new(RecursionDepthDetector::default()),
                Box::new(FanOutExplosionDetector::default()),
                Box::new(TransitionProbabilityDetector::default()),
                Box::new(MissingPredecessorDetector::default()),
                Box::new(ForbiddenSuccessionDetector::default()),
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
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    /// Which taxonomy categories the hot path can actually raise.
    ///
    /// Pinned deliberately. "Coverage" is easy to overstate — a detector that
    /// exists but can never fire looks the same from the outside as one that
    /// works — so this asserts the exact set and fails if a category is added
    /// or quietly dropped.
    #[test]
    fn hot_path_covers_eleven_of_twelve_categories() {
        let registry = DetectorRegistry::with_defaults();
        let mut covered: Vec<&str> = registry
            .detectors
            .iter()
            .map(|d| d.kind().as_str())
            .collect();
        covered.sort_unstable();
        covered.dedup();

        let expected = [
            "BUDGET_BREACH",
            "DATA_EXFILTRATION",
            "HALLUCINATION",
            "LOOP_DETECTED",
            "PROMPT_INJECTION",
            "SCOPE_VIOLATION",
            "SPAWN_BUDGET_BREACH",
            "TOKEN_WASTE",
            "TOOL_ABUSE",
            "UNAUTHORIZED_TOOL",
            "WORKFLOW_BUDGET_BREACH",
        ];
        assert_eq!(covered, expected);

        // The remainder, and why it is not here rather than merely missing.
        //
        // WORKFLOW_GOAL_DRIFT asks whether an agent is still doing what it was
        // asked to do. That is not a pure function of one request: it needs the
        // plan the agent was given, and a record of how far execution has strayed
        // from it. Both live in the control plane — `storedPlans.complianceScore`,
        // decremented per recorded deviation — and reaching them means a database
        // lookup, which does not belong inline on the hot path.
        //
        // Note the scoring itself is *not* the obstacle, and earlier revisions of
        // this comment were wrong to say it needed an embedding or a model call.
        // The control plane's own check is a plain threshold comparison against a
        // 0..1 score. What the proxy lacks is the plan, not the arithmetic.
        // It is deliberately out of scope here, not overlooked.
        let uncovered: Vec<&str> = ALL_KINDS
            .iter()
            .map(|k| k.as_str())
            .filter(|k| !covered.contains(k))
            .collect();
        assert_eq!(uncovered, vec!["WORKFLOW_GOAL_DRIFT"]);
    }
}
