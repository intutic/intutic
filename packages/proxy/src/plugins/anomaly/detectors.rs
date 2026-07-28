//! Hot-path anomaly detectors.
//!
//! Each is a pure function of one [`RequestContext`]. They read the session's
//! tool history (`tool_sequence`, oldest first), the DLP findings, token
//! estimates and budget headroom — everything the proxy already knows without
//! reaching for storage.
//!
//! Thresholds are stated as named constants rather than inline literals so the
//! tuning surface is visible in one place.

use super::{AnomalyDetector, AnomalyFinding, AnomalyKind};
use crate::wasm::context::RequestContext;
use std::collections::HashSet;

// ── Loop and cycle detection ────────────────────────────────────────────────

/// Consecutive calls to one tool before it is treated as a spin.
const REPETITION_THRESHOLD: usize = 5;

/// A node calling the same tool over and over is the most common shape of a
/// graph that has stopped making progress.
pub struct ConsecutiveRepeatDetector {
    threshold: usize,
}

impl Default for ConsecutiveRepeatDetector {
    fn default() -> Self {
        Self {
            threshold: REPETITION_THRESHOLD,
        }
    }
}

impl AnomalyDetector for ConsecutiveRepeatDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::LoopDetected
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        let mut run = 1;
        for i in 1..seq.len() {
            if seq[i] == seq[i - 1] {
                run += 1;
                if run >= self.threshold {
                    return Some(AnomalyFinding::kill(
                        AnomalyKind::LoopDetected,
                        format!(
                            "Loop detected: '{}' called {} times consecutively without progress",
                            seq[i], run
                        ),
                    ));
                }
            } else {
                run = 1;
            }
        }
        None
    }
}

/// Full A→B→A→B repetitions before a two-tool alternation counts as a cycle.
const PING_PONG_CYCLES: usize = 3;

/// Two nodes handing work back and forth. Invisible to a consecutive-repeat
/// check, because no tool ever repeats twice in a row — which is exactly why
/// this one exists.
pub struct PingPongCycleDetector {
    cycles: usize,
}

impl Default for PingPongCycleDetector {
    fn default() -> Self {
        Self {
            cycles: PING_PONG_CYCLES,
        }
    }
}

impl AnomalyDetector for PingPongCycleDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::LoopDetected
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        let needed = self.cycles * 2;
        if seq.len() < needed {
            return None;
        }
        let tail = &seq[seq.len() - needed..];
        let (a, b) = (&tail[0], &tail[1]);
        if a == b {
            return None; // that is a spin, not an alternation
        }
        let alternating = tail
            .iter()
            .enumerate()
            .all(|(i, t)| if i % 2 == 0 { t == a } else { t == b });
        if !alternating {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::LoopDetected,
            format!(
                "Loop detected: '{}' and '{}' alternating for {} cycles with no other activity",
                a, b, self.cycles
            ),
        ))
    }
}

/// Depth beyond which a graph is treated as runaway recursion.
const MAX_GRAPH_DEPTH: u32 = 7;

/// Runaway recursion — a node spawning a node spawning a node. Uses the depth
/// the caller reports, which is untrusted, so this can be defeated by a caller
/// that simply lies. It is a guard against accidental recursion, not an
/// adversary.
pub struct RecursionDepthDetector {
    max_depth: u32,
}

impl Default for RecursionDepthDetector {
    fn default() -> Self {
        Self {
            max_depth: MAX_GRAPH_DEPTH,
        }
    }
}

impl AnomalyDetector for RecursionDepthDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::LoopDetected
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.node.depth <= self.max_depth {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::LoopDetected,
            format!(
                "Runaway recursion: graph depth {} exceeds the maximum of {}",
                ctx.node.depth, self.max_depth
            ),
        ))
    }
}

// ── Transition scoring ──────────────────────────────────────────────────────

/// Average transition score below which a sequence is treated as drifting.
const MIN_TRANSITION_PROBABILITY: f64 = 0.35;

/// Scores each `A → B` step against a fixed table of plausible transitions.
///
/// The table is **hardcoded on purpose**. A fitted matrix would be a learned
/// parameter, which is a different tier of functionality and a different
/// deployment story; keeping this fixed makes the detector a pure function.
pub struct TransitionProbabilityDetector {
    min_probability: f64,
}

impl Default for TransitionProbabilityDetector {
    fn default() -> Self {
        Self {
            min_probability: MIN_TRANSITION_PROBABILITY,
        }
    }
}

impl TransitionProbabilityDetector {
    fn probability(from: &str, to: &str) -> f64 {
        match (from, to) {
            ("list_dir", "view_file") => 0.90,
            ("grep_search", "view_file") => 0.90,
            ("view_file", "view_file") => 0.85,
            ("view_file", "replace_file_content") => 0.80,
            ("replace_file_content", "run_command") => 0.75,
            ("Write", "Write") => 0.85,
            ("Write", "Bash") => 0.80,
            ("Bash", "Bash") => 0.70,
            ("View", "View") => 0.85,
            ("View", "Write") => 0.80,
            ("Glob", "View") => 0.90,
            ("Grep", "View") => 0.90,
            ("run_command", "run_command") => 0.15,
            ("replace_file_content", "replace_file_content") => 0.30,
            (a, b) if a == b => 0.20,
            _ => 0.50,
        }
    }
}

impl AnomalyDetector for TransitionProbabilityDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::ToolAbuse
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        if seq.len() < 2 {
            return None;
        }
        let total: f64 = seq
            .windows(2)
            .map(|w| Self::probability(&w[0], &w[1]))
            .sum();
        let avg = total / (seq.len() - 1) as f64;
        if avg >= self.min_probability {
            return None;
        }
        Some(AnomalyFinding::steer(
            AnomalyKind::ToolAbuse,
            format!(
                "Anomalous tool sequence: average transition plausibility {:.2} is below {:.2}",
                avg, self.min_probability
            ),
            1.0 - avg,
        ))
    }
}

// ── Ordering invariants ─────────────────────────────────────────────────────

/// A tool that must not run unless a prerequisite ran earlier in the session.
///
/// These are the invariants a single node cannot check for itself, because the
/// node that deploys is usually not the node that tested.
const REQUIRED_PREDECESSORS: &[(&str, &str)] = &[
    ("deploy", "run_tests"),
    ("publish", "run_tests"),
    ("release", "run_tests"),
];

pub struct MissingPredecessorDetector {
    rules: &'static [(&'static str, &'static str)],
}

impl Default for MissingPredecessorDetector {
    fn default() -> Self {
        Self {
            rules: REQUIRED_PREDECESSORS,
        }
    }
}

impl AnomalyDetector for MissingPredecessorDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::ScopeViolation
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        for (tool, prerequisite) in self.rules {
            let used = seq.iter().position(|t| t == tool)?;
            if seq[..used].iter().any(|t| t == prerequisite) {
                continue;
            }
            return Some(AnomalyFinding::kill(
                AnomalyKind::ScopeViolation,
                format!(
                    "Ordering violation: '{}' ran with no prior '{}' anywhere in this session",
                    tool, prerequisite
                ),
            ));
        }
        None
    }
}

/// A tool that must not run *after* another has run.
const FORBIDDEN_SUCCESSIONS: &[(&str, &str)] = &[
    ("pii_export", "db_write"),
    ("pii_export", "http_post"),
    ("secret_read", "http_post"),
];

pub struct ForbiddenSuccessionDetector {
    rules: &'static [(&'static str, &'static str)],
}

impl Default for ForbiddenSuccessionDetector {
    fn default() -> Self {
        Self {
            rules: FORBIDDEN_SUCCESSIONS,
        }
    }
}

impl AnomalyDetector for ForbiddenSuccessionDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::ScopeViolation
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        for (first, then) in self.rules {
            let Some(first_at) = seq.iter().position(|t| t == first) else {
                continue;
            };
            let violated = seq[first_at + 1..].iter().any(|t| t == then);
            if !violated {
                continue;
            }
            return Some(AnomalyFinding::kill(
                AnomalyKind::ScopeViolation,
                format!(
                    "Forbidden succession: '{}' ran after '{}' in the same session",
                    then, first
                ),
            ));
        }
        None
    }
}

// ── Data flow ───────────────────────────────────────────────────────────────

/// Distinct blocking DLP findings before the session is treated as probing.
const DLP_ESCALATION_THRESHOLD: usize = 3;

/// One redacted secret is a mistake. Several distinct blocking findings in one
/// session is a pattern — often a node retrying an exfiltration by another
/// route after the first was masked.
pub struct DlpEscalationDetector {
    threshold: usize,
}

impl Default for DlpEscalationDetector {
    fn default() -> Self {
        Self {
            threshold: DLP_ESCALATION_THRESHOLD,
        }
    }
}

impl AnomalyDetector for DlpEscalationDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::DataExfiltration
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let blocking: HashSet<&str> = ctx
            .dlp_findings
            .iter()
            .filter(|f| f.action == "block")
            .map(|f| f.pattern_name.as_str())
            .collect();
        if blocking.len() < self.threshold {
            return None;
        }
        let mut names: Vec<&str> = blocking.into_iter().collect();
        names.sort_unstable();
        Some(AnomalyFinding::kill(
            AnomalyKind::DataExfiltration,
            format!(
                "Repeated exfiltration attempts: {} distinct blocked patterns in one request ({})",
                names.len(),
                names.join(", ")
            ),
        ))
    }
}

// ── Progress and cost ───────────────────────────────────────────────────────

/// Window examined for diversity collapse.
const DIVERSITY_WINDOW: usize = 10;
/// Distinct tools required within that window.
const DIVERSITY_MIN_DISTINCT: usize = 2;

/// A long run drawing on a single tool. Distinct from a consecutive spin: the
/// calls may be interleaved with nothing else, yet still make no progress.
pub struct ToolDiversityCollapseDetector {
    window: usize,
    min_distinct: usize,
}

impl Default for ToolDiversityCollapseDetector {
    fn default() -> Self {
        Self {
            window: DIVERSITY_WINDOW,
            min_distinct: DIVERSITY_MIN_DISTINCT,
        }
    }
}

impl AnomalyDetector for ToolDiversityCollapseDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::TokenWaste
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let seq = &ctx.tool_sequence;
        if seq.len() < self.window {
            return None;
        }
        let tail = &seq[seq.len() - self.window..];
        let distinct: HashSet<&String> = tail.iter().collect();
        if distinct.len() >= self.min_distinct {
            return None;
        }
        Some(AnomalyFinding::steer(
            AnomalyKind::TokenWaste,
            format!(
                "No progress: the last {} tool calls used only '{}'",
                self.window, tail[0]
            ),
            0.8,
        ))
    }
}

/// Estimated input tokens beyond which context growth is flagged.
const CONTEXT_GROWTH_TOKENS: u32 = 150_000;
/// Tool calls by which that size is considered disproportionate.
const CONTEXT_GROWTH_MIN_CALLS: usize = 5;

/// Context ballooning across hops. Each handoff in a graph tends to carry the
/// previous node's context forward, so growth compounds in a way it does not in
/// a single loop.
pub struct ContextGrowthDetector {
    max_tokens: u32,
    min_calls: usize,
}

impl Default for ContextGrowthDetector {
    fn default() -> Self {
        Self {
            max_tokens: CONTEXT_GROWTH_TOKENS,
            min_calls: CONTEXT_GROWTH_MIN_CALLS,
        }
    }
}

impl AnomalyDetector for ContextGrowthDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::TokenWaste
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.estimated_input_tokens < self.max_tokens
            || ctx.tool_sequence.len() < self.min_calls
        {
            return None;
        }
        Some(AnomalyFinding::steer(
            AnomalyKind::TokenWaste,
            format!(
                "Context growth: ~{} input tokens after {} tool calls",
                ctx.estimated_input_tokens,
                ctx.tool_sequence.len()
            ),
            0.7,
        ))
    }
}

/// Remaining budget below which the session is refused outright.
const BUDGET_FLOOR_USD: f64 = 0.0;

/// Hard budget floor. The ceiling is set once for the whole session, so every
/// hop, sub-agent and retry in a graph draws from the same pool — a per-node
/// budget would let a graph that fans out to eight workers spend eight times
/// what was capped.
#[derive(Default)]
pub struct BudgetExhaustionDetector;

impl AnomalyDetector for BudgetExhaustionDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::BudgetBreach
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.budget_remaining_usd > BUDGET_FLOOR_USD {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::BudgetBreach,
            "Budget exhausted: no headroom remaining for this session".to_string(),
        ))
    }
}

// ── Graph-wide cost and liveness ────────────────────────────────────────────

/// Multiple of the per-node budget at which a graph's total spend is a breach.
///
/// Matches the platform-wide spawn budget multiplier, so the hot path and the
/// post-hoc classifier agree on what constitutes fan-out overspend.
const SPAWN_BUDGET_MULTIPLIER: f64 = 1.5;

/// A graph spending far more than any single node was budgeted.
///
/// This is the failure a per-node budget cannot see: cap each node at $5 and a
/// graph that fans out to eight workers spends $40, with every individual node
/// still inside its limit and nothing anywhere reporting a problem.
#[derive(Default)]
pub struct SpawnBudgetBreachDetector;

impl AnomalyDetector for SpawnBudgetBreachDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::SpawnBudgetBreach
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        // Both unknown means the store cannot aggregate — no signal, so no
        // verdict. Inferring a breach from absent data would block every graph
        // running without a shared store.
        let spend = ctx.node.graph_spend_usd?;
        let budget = ctx.node.graph_budget_usd?;
        if budget <= 0.0 {
            return None;
        }

        let ceiling = budget * SPAWN_BUDGET_MULTIPLIER;
        if spend <= ceiling {
            return None;
        }

        Some(AnomalyFinding::kill(
            AnomalyKind::SpawnBudgetBreach,
            format!(
                "Fan-out overspend: this graph has cost ${:.2} against a ${:.2} per-node budget \
                 ({:.0}% of the ${:.2} ceiling)",
                spend,
                budget,
                (spend / ceiling) * 100.0,
                ceiling
            ),
        ))
    }
}

/// A node still working for a parent that is gone.
///
/// When an orchestrator dies its children do not necessarily notice, and keep
/// spending against a result nobody will collect. Detectable only because the
/// caller names its parent and the graph tracks who is live.
#[derive(Default)]
pub struct OrphanExecutionDetector;

impl AnomalyDetector for OrphanExecutionDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::Hallucination
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        // No parent means this is a root, which cannot be orphaned.
        if ctx.node.parent_session_id.is_empty() {
            return None;
        }
        // `None` is "the store has no opinion", which must not be read as
        // "dead" — that would orphan every node in every untracked graph.
        if ctx.node.parent_alive? {
            return None;
        }

        Some(AnomalyFinding::steer(
            AnomalyKind::Hallucination,
            format!(
                "Orphaned execution: parent '{}' is no longer active in graph '{}', \
                 so this work has no caller to return to",
                ctx.node.parent_session_id, ctx.node.graph_id
            ),
            0.9,
        ))
    }
}

// ── Tool policy ─────────────────────────────────────────────────────────────

/// A node reaching for a tool its own SOPs forbid.
///
/// This is the point at which an SOP stops being advice. The prose telling an
/// agent not to run something is injected into its context and can be read,
/// weighed and — as anyone who has watched a long agent loop knows —
/// eventually ignored. This runs on the request that ignores it.
///
/// Denylist rather than allowlist, deliberately. An allowlist needs a complete
/// picture of every tool a harness might legitimately use, which open core has
/// no way to obtain; getting it wrong blocks real work, and the resulting
/// pressure is to disable governance rather than to fix the list. A denylist is
/// incomplete by nature but wrong only in the safe direction.
#[derive(Default)]
pub struct UnauthorizedToolDetector;

impl AnomalyDetector for UnauthorizedToolDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::UnauthorizedTool
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.denied_tools.is_empty() || ctx.tool_calls.is_empty() {
            return None;
        }

        let mut hits: Vec<&str> = ctx
            .tool_calls
            .iter()
            .filter(|tc| {
                ctx.denied_tools
                    .iter()
                    .any(|d| d.eq_ignore_ascii_case(&tc.name))
            })
            .map(|tc| tc.name.as_str())
            .collect();
        if hits.is_empty() {
            return None;
        }
        hits.sort_unstable();
        hits.dedup();

        Some(AnomalyFinding::kill(
            AnomalyKind::UnauthorizedTool,
            format!(
                "Forbidden tool call: {} — denied by an SOP in force for this node",
                hits.join(", ")
            ),
        ))
    }
}

/// Distinct injection techniques before the request is refused rather than
/// steered.
///
/// One match is often ordinary language that happens to resemble an attack.
/// Several distinct techniques in one payload is not a coincidence.
const INJECTION_KILL_THRESHOLD: usize = 2;

/// Text attempting to override the instructions the agent is operating under.
///
/// Sharper in a graph than in a single agent: one node's output becomes the
/// next node's input, so a payload picked up from a fetched page or a file
/// arrives at the next node indistinguishable from an instruction issued by
/// the orchestrator.
///
/// Graded rather than absolute, because the false-positive cost is real —
/// people say "ignore the previous suggestion" to agents in earnest.
pub struct PromptInjectionDetector {
    kill_threshold: usize,
}

impl Default for PromptInjectionDetector {
    fn default() -> Self {
        Self {
            kill_threshold: INJECTION_KILL_THRESHOLD,
        }
    }
}

impl AnomalyDetector for PromptInjectionDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::PromptInjection
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.injection_findings.is_empty() {
            return None;
        }
        // Pattern names only. The matched span is attacker-controlled text,
        // and this reason string travels into telemetry and into sibling
        // agents' context — quoting the payload would deliver it to precisely
        // the places this detector exists to protect.
        let techniques = ctx.injection_findings.join(", ");

        if ctx.injection_findings.len() >= self.kill_threshold {
            return Some(AnomalyFinding::kill(
                AnomalyKind::PromptInjection,
                format!("Prompt injection: {} techniques present ({techniques})", ctx.injection_findings.len()),
            ));
        }
        Some(AnomalyFinding::steer(
            AnomalyKind::PromptInjection,
            format!("Possible prompt injection: {techniques}"),
            0.6,
        ))
    }
}

/// A harness advertising a different tool set part-way through a session.
///
/// Tools are declared once at the start of a normal session. A set that
/// changes mid-flight means either the harness config was rewritten underneath
/// the agent — which is what the drift watcher exists to catch — or something
/// is presenting a different surface than the one the session's policy was
/// evaluated against.
///
/// Steers rather than kills: legitimate harnesses do occasionally renegotiate
/// tools, and stopping the request outright would break them for a signal that
/// is suggestive rather than conclusive.
#[derive(Default)]
pub struct SchemaDriftDetector;

impl AnomalyDetector for SchemaDriftDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::ToolAbuse
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if !ctx.tools_changed_mid_session {
            return None;
        }
        Some(AnomalyFinding::steer(
            AnomalyKind::ToolAbuse,
            "Tool schema drift: this request advertises a different tool set than the session opened with"
                .to_string(),
            0.7,
        ))
    }
}

/// Live nodes in one graph beyond which the fan-out is treated as runaway.
///
/// Mirrors the spawn-count limit the platform taxonomy specifies alongside the
/// depth limit — a graph can run away by going wide as easily as by going deep,
/// and depth alone does not see it.
const MAX_GRAPH_NODES: u32 = 50;

/// A graph that has spawned far more nodes than any task plausibly needs.
#[derive(Default)]
pub struct FanOutExplosionDetector;

impl AnomalyDetector for FanOutExplosionDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::LoopDetected
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let count = ctx.node.graph_node_count?;
        if count <= MAX_GRAPH_NODES {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::LoopDetected,
            format!(
                "Runaway fan-out: {} live nodes in this graph exceeds the maximum of {}",
                count, MAX_GRAPH_NODES
            ),
        ))
    }
}

// ── Workflow and harness boundaries ─────────────────────────────────────────

/// A loop run past the ceiling it was started with.
///
/// Distinct from the per-session and per-graph budgets: a loop run is the unit
/// of *work*, and it can span many sessions, many nodes and many turns. It is
/// the thing a `--budget` on `intutic loop exec` names, and the only level at
/// which "this task cost too much" is a meaningful statement.
#[derive(Default)]
pub struct WorkflowBudgetBreachDetector;

impl AnomalyDetector for WorkflowBudgetBreachDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::WorkflowBudgetBreach
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        let spend = ctx.workflow_spend_usd?;
        // No ceiling means nobody budgeted this run. That is not a budget of
        // zero, and refusing an unbudgeted run would break every loop started
        // without the flag.
        let budget = ctx.workflow_budget_usd?;
        if budget <= 0.0 || spend <= budget {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::WorkflowBudgetBreach,
            format!(
                "Workflow over budget: this run has cost ${:.2} against its ${:.2} ceiling",
                spend, budget
            ),
        ))
    }
}

/// A node running under a harness its SOPs do not permit.
///
/// The case this guards is work crossing a boundary it was scoped to stay
/// inside — a policy written for a reviewed IDE session being carried into an
/// unattended CLI agent, where the human who was assumed to be watching is not.
///
/// An allowlist is workable here where it is not for tools: a workspace has a
/// handful of harnesses someone can name, not the open-ended tool surface each
/// of them exposes. Unlike the graph identity fields, the harness is resolved
/// from the route rather than asserted by the caller, so it is sound to gate on.
#[derive(Default)]
pub struct CrossHarnessViolationDetector;

impl AnomalyDetector for CrossHarnessViolationDetector {
    fn kind(&self) -> AnomalyKind {
        AnomalyKind::UnauthorizedTool
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        if ctx.allowed_harnesses.is_empty() || ctx.harness.is_empty() {
            return None;
        }
        if ctx
            .allowed_harnesses
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&ctx.harness))
        {
            return None;
        }
        Some(AnomalyFinding::kill(
            AnomalyKind::UnauthorizedTool,
            format!(
                "Cross-harness violation: this node ran under '{}', but its SOPs permit only [{}]",
                ctx.harness,
                ctx.allowed_harnesses.join(", ")
            ),
        ))
    }
}

// ── Test support ────────────────────────────────────────────────────────────

#[cfg(test)]
pub mod test_support {
    use crate::wasm::context::{DlpFinding, NodeIdentity, RequestContext, RiskLevel};

    pub fn base_ctx() -> RequestContext {
        RequestContext {
            session_id: "ses_test".into(),
            workspace_id: "ws_test".into(),
            virtual_key_prefix: "vk_test".into(),
            model: "claude-sonnet-4".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 100,
            // Positive by default, so the budget detector stays quiet unless a
            // test is specifically about budget.
            budget_remaining_usd: 10.0,
            risk_tier: RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: vec![],
            denied_tools: vec![],
            injection_findings: vec![],
            tools_changed_mid_session: false,
            harness: String::new(),
            allowed_harnesses: vec![],
            workflow_spend_usd: None,
            workflow_budget_usd: None,
            node: NodeIdentity::default(),
        }
    }

    pub fn ctx_with_sequence(seq: &[&str]) -> RequestContext {
        RequestContext {
            tool_sequence: seq.iter().map(|s| s.to_string()).collect(),
            ..base_ctx()
        }
    }

    pub fn dlp(pattern: &str, action: &str) -> DlpFinding {
        DlpFinding {
            category: "secret".into(),
            pattern_name: pattern.into(),
            action: action.into(),
            offset: 0,
            length: 8,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn consecutive_repeat_fires_at_threshold() {
        let d = ConsecutiveRepeatDetector::default();
        assert!(d.detect(&ctx_with_sequence(&["Bash"; 4])).is_none());
        let hit = d.detect(&ctx_with_sequence(&["Bash"; 5])).unwrap();
        assert_eq!(hit.kind, AnomalyKind::LoopDetected);
        assert!(hit.kill);
    }

    #[test]
    fn consecutive_repeat_ignores_interrupted_runs() {
        let d = ConsecutiveRepeatDetector::default();
        let ctx = ctx_with_sequence(&["Bash", "Bash", "View", "Bash", "Bash", "Bash"]);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn ping_pong_detects_alternation() {
        let d = PingPongCycleDetector::default();
        let ctx = ctx_with_sequence(&["plan", "review", "plan", "review", "plan", "review"]);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::LoopDetected);
    }

    #[test]
    fn ping_pong_ignores_a_spin() {
        // A run of one tool is a spin, and belongs to the repeat detector.
        let d = PingPongCycleDetector::default();
        assert!(d.detect(&ctx_with_sequence(&["plan"; 6])).is_none());
    }

    #[test]
    fn ping_pong_ignores_genuine_variety() {
        let d = PingPongCycleDetector::default();
        let ctx = ctx_with_sequence(&["a", "b", "a", "b", "a", "c"]);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn recursion_depth_respects_limit() {
        let d = RecursionDepthDetector::default();
        let mut ctx = base_ctx();
        ctx.node.depth = 7;
        assert!(d.detect(&ctx).is_none());
        ctx.node.depth = 8;
        assert!(d.detect(&ctx).unwrap().kill);
    }

    #[test]
    fn missing_predecessor_blocks_deploy_without_tests() {
        let d = MissingPredecessorDetector::default();
        let ctx = ctx_with_sequence(&["build", "deploy"]);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::ScopeViolation);
    }

    #[test]
    fn missing_predecessor_allows_deploy_after_tests() {
        let d = MissingPredecessorDetector::default();
        let ctx = ctx_with_sequence(&["run_tests", "build", "deploy"]);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn predecessor_must_come_before_not_after() {
        // Tests running *after* the deploy do not retroactively make it safe.
        let d = MissingPredecessorDetector::default();
        let ctx = ctx_with_sequence(&["deploy", "run_tests"]);
        assert!(d.detect(&ctx).is_some());
    }

    #[test]
    fn forbidden_succession_blocks_write_after_pii_export() {
        let d = ForbiddenSuccessionDetector::default();
        let ctx = ctx_with_sequence(&["pii_export", "transform", "db_write"]);
        assert!(d.detect(&ctx).unwrap().kill);
    }

    #[test]
    fn forbidden_succession_allows_reverse_order() {
        // A write *before* the export is not the hazard this guards against.
        let d = ForbiddenSuccessionDetector::default();
        let ctx = ctx_with_sequence(&["db_write", "pii_export"]);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn dlp_escalation_counts_distinct_blocking_patterns() {
        let d = DlpEscalationDetector::default();
        let mut ctx = base_ctx();
        ctx.dlp_findings = vec![
            dlp("aws_key", "block"),
            dlp("github_token", "block"),
            dlp("ssn", "block"),
        ];
        assert!(d.detect(&ctx).unwrap().kill);
    }

    #[test]
    fn dlp_escalation_ignores_redactions_and_duplicates() {
        let d = DlpEscalationDetector::default();
        let mut ctx = base_ctx();
        // Same pattern three times, plus redactions — neither is escalation.
        ctx.dlp_findings = vec![
            dlp("aws_key", "block"),
            dlp("aws_key", "block"),
            dlp("aws_key", "block"),
            dlp("ssn", "redact"),
            dlp("email", "redact"),
        ];
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn diversity_collapse_needs_a_full_window() {
        let d = ToolDiversityCollapseDetector::default();
        assert!(d.detect(&ctx_with_sequence(&["Bash"; 9])).is_none());
        assert!(d.detect(&ctx_with_sequence(&["Bash"; 10])).is_some());
    }

    #[test]
    fn diversity_collapse_ignores_mixed_work() {
        let d = ToolDiversityCollapseDetector::default();
        let seq: Vec<&str> = (0..12)
            .map(|i| if i % 2 == 0 { "View" } else { "Write" })
            .collect();
        assert!(d.detect(&ctx_with_sequence(&seq)).is_none());
    }

    #[test]
    fn context_growth_needs_both_size_and_hops() {
        let d = ContextGrowthDetector::default();
        let mut ctx = ctx_with_sequence(&["a", "b", "c", "d", "e"]);
        ctx.estimated_input_tokens = 149_000;
        assert!(d.detect(&ctx).is_none(), "under the token bar");

        ctx.estimated_input_tokens = 200_000;
        assert!(d.detect(&ctx).is_some());

        // A single huge prompt is not graph-driven context growth.
        let mut short = ctx_with_sequence(&["a"]);
        short.estimated_input_tokens = 200_000;
        assert!(d.detect(&short).is_none());
    }

    #[test]
    fn budget_exhaustion_fires_at_zero() {
        let d = BudgetExhaustionDetector;
        let mut ctx = base_ctx();
        assert!(d.detect(&ctx).is_none());
        ctx.budget_remaining_usd = 0.0;
        assert!(d.detect(&ctx).unwrap().kill);
        ctx.budget_remaining_usd = -1.5;
        assert!(d.detect(&ctx).is_some());
    }

    #[test]
    fn transition_probability_flags_low_plausibility_runs() {
        let d = TransitionProbabilityDetector::default();
        // run_command -> run_command scores 0.15.
        let ctx = ctx_with_sequence(&["run_command", "run_command", "run_command"]);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::ToolAbuse);
        assert!(!hit.kill, "drift steers rather than kills");
        assert!(hit.confidence > 0.5);
    }

    #[test]
    fn transition_probability_accepts_normal_work() {
        let d = TransitionProbabilityDetector::default();
        let ctx = ctx_with_sequence(&["list_dir", "view_file", "replace_file_content"]);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn single_call_sequences_are_never_anomalous() {
        let ctx = ctx_with_sequence(&["Bash"]);
        assert!(ConsecutiveRepeatDetector::default().detect(&ctx).is_none());
        assert!(PingPongCycleDetector::default().detect(&ctx).is_none());
        assert!(TransitionProbabilityDetector::default()
            .detect(&ctx)
            .is_none());
    }
}

#[cfg(test)]
mod graph_aggregate_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn spawn_budget_fires_past_the_multiplier() {
        let d = SpawnBudgetBreachDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_budget_usd = Some(10.0); // ceiling is 15.00

        ctx.node.graph_spend_usd = Some(14.99);
        assert!(d.detect(&ctx).is_none(), "just under the ceiling");

        ctx.node.graph_spend_usd = Some(15.01);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::SpawnBudgetBreach);
        assert!(hit.kill);
    }

    #[test]
    fn spawn_budget_is_silent_without_a_spend_signal() {
        // The whole point of Option here: an unaggregated graph must not be
        // treated as one that has spent nothing, nor as one that has breached.
        let d = SpawnBudgetBreachDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_budget_usd = Some(10.0);
        ctx.node.graph_spend_usd = None;
        assert!(d.detect(&ctx).is_none());

        ctx.node.graph_spend_usd = Some(999.0);
        ctx.node.graph_budget_usd = None;
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn spawn_budget_ignores_a_zero_budget() {
        // Zero would make every ceiling zero and every graph a breach.
        let d = SpawnBudgetBreachDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_budget_usd = Some(0.0);
        ctx.node.graph_spend_usd = Some(50.0);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn orphan_fires_when_the_parent_is_gone() {
        let d = OrphanExecutionDetector;
        let mut ctx = base_ctx();
        ctx.node.parent_session_id = "parent-1".into();
        ctx.node.graph_id = "g1".into();
        ctx.node.parent_alive = Some(false);

        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::Hallucination);
        assert!(!hit.kill, "an orphan is steered, not killed");
        assert!(hit.reason.contains("parent-1"));
    }

    #[test]
    fn orphan_is_silent_for_a_live_parent() {
        let d = OrphanExecutionDetector;
        let mut ctx = base_ctx();
        ctx.node.parent_session_id = "parent-1".into();
        ctx.node.parent_alive = Some(true);
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn orphan_never_fires_on_a_root() {
        let d = OrphanExecutionDetector;
        let mut ctx = base_ctx();
        ctx.node.parent_session_id = String::new();
        ctx.node.parent_alive = Some(false); // even so
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn orphan_treats_unknown_liveness_as_no_opinion() {
        // Reading None as "dead" would orphan every node in every graph the
        // store never tracked — which is all of them in standalone.
        let d = OrphanExecutionDetector;
        let mut ctx = base_ctx();
        ctx.node.parent_session_id = "parent-1".into();
        ctx.node.parent_alive = None;
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn a_plain_single_agent_request_trips_nothing_new() {
        // The default context has no graph aggregates at all, which is what
        // every single-agent request looks like.
        let ctx = base_ctx();
        assert!(SpawnBudgetBreachDetector.detect(&ctx).is_none());
        assert!(OrphanExecutionDetector.detect(&ctx).is_none());
    }
}

#[cfg(test)]
mod tool_policy_tests {
    use super::test_support::*;
    use super::*;
    use crate::wasm::context::ToolCall;

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: serde_json::Value::Null,
        }
    }

    #[test]
    fn a_forbidden_tool_is_blocked() {
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.denied_tools = vec!["kubectl".into()];
        ctx.tool_calls = vec![call("kubectl")];
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::UnauthorizedTool);
        assert!(hit.kill);
        assert!(hit.reason.contains("kubectl"));
    }

    #[test]
    fn permitted_tools_pass() {
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.denied_tools = vec!["kubectl".into()];
        ctx.tool_calls = vec![call("Read"), call("Write")];
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn matching_is_case_insensitive() {
        // An agent calling `Bash` must not slip past a policy written as `bash`.
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.denied_tools = vec!["bash".into()];
        ctx.tool_calls = vec![call("Bash")];
        assert!(d.detect(&ctx).is_some());
    }

    #[test]
    fn an_empty_policy_denies_nothing() {
        // Fail-open by design: no policy means no restrictions, never
        // "deny everything unlisted".
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.tool_calls = vec![call("anything"), call("at-all")];
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn a_policy_with_no_tool_calls_is_quiet() {
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.denied_tools = vec!["kubectl".into()];
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn every_forbidden_tool_is_named() {
        let d = UnauthorizedToolDetector;
        let mut ctx = base_ctx();
        ctx.denied_tools = vec!["rm".into(), "kubectl".into()];
        ctx.tool_calls = vec![call("kubectl"), call("Read"), call("rm")];
        let r = d.detect(&ctx).unwrap().reason;
        assert!(r.contains("kubectl") && r.contains("rm"));
        assert!(!r.contains("Read"));
    }
}

#[cfg(test)]
mod injection_detector_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn a_single_technique_steers() {
        // People do write "ignore the previous suggestion" in earnest, so one
        // match is a flag rather than a refusal.
        let d = PromptInjectionDetector::default();
        let mut ctx = base_ctx();
        ctx.injection_findings = vec!["override-instructions".into()];
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::PromptInjection);
        assert!(!hit.kill);
    }

    #[test]
    fn several_techniques_together_are_refused() {
        let d = PromptInjectionDetector::default();
        let mut ctx = base_ctx();
        ctx.injection_findings =
            vec!["override-instructions".into(), "role-reassignment".into()];
        assert!(d.detect(&ctx).unwrap().kill);
    }

    #[test]
    fn clean_text_is_silent() {
        assert!(PromptInjectionDetector::default().detect(&base_ctx()).is_none());
    }

    #[test]
    fn the_payload_is_never_quoted_back() {
        // The reason string reaches telemetry and sibling agents' context.
        // Echoing the matched text would deliver the payload to exactly the
        // places this detector protects.
        let d = PromptInjectionDetector::default();
        let mut ctx = base_ctx();
        ctx.injection_findings = vec!["override-instructions".into()];
        let reason = d.detect(&ctx).unwrap().reason;
        assert!(reason.contains("override-instructions"));
        assert!(!reason.contains("Ignore all previous"));
    }
}

#[cfg(test)]
mod workflow_and_harness_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn workflow_budget_fires_past_its_ceiling() {
        let d = WorkflowBudgetBreachDetector;
        let mut ctx = base_ctx();
        ctx.workflow_budget_usd = Some(5.0);
        ctx.workflow_spend_usd = Some(4.99);
        assert!(d.detect(&ctx).is_none());
        ctx.workflow_spend_usd = Some(5.01);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::WorkflowBudgetBreach);
        assert!(hit.kill);
    }

    #[test]
    fn an_unbudgeted_run_is_never_refused() {
        // No ceiling means nobody set one — not a ceiling of zero. Refusing
        // here would break every loop started without the flag.
        let d = WorkflowBudgetBreachDetector;
        let mut ctx = base_ctx();
        ctx.workflow_spend_usd = Some(999.0);
        ctx.workflow_budget_usd = None;
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn a_request_outside_any_run_is_silent() {
        assert!(WorkflowBudgetBreachDetector.detect(&base_ctx()).is_none());
    }

    #[test]
    fn a_disallowed_harness_is_refused() {
        let d = CrossHarnessViolationDetector;
        let mut ctx = base_ctx();
        ctx.harness = "cursor".into();
        ctx.allowed_harnesses = vec!["claude-code".into()];
        let hit = d.detect(&ctx).unwrap();
        assert!(hit.kill);
        assert!(hit.reason.contains("cursor"));
    }

    #[test]
    fn a_permitted_harness_passes() {
        let d = CrossHarnessViolationDetector;
        let mut ctx = base_ctx();
        ctx.harness = "Claude-Code".into();
        ctx.allowed_harnesses = vec!["claude-code".into()];
        assert!(d.detect(&ctx).is_none(), "comparison is case-insensitive");
    }

    #[test]
    fn no_harness_policy_permits_everything() {
        // The default. Adding allow_harnesses to one SOP must not implicitly
        // restrict roles no SOP mentions.
        let d = CrossHarnessViolationDetector;
        let mut ctx = base_ctx();
        ctx.harness = "anything".into();
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn an_unknown_harness_is_not_guessed_at() {
        let d = CrossHarnessViolationDetector;
        let mut ctx = base_ctx();
        ctx.harness = String::new();
        ctx.allowed_harnesses = vec!["claude-code".into()];
        assert!(d.detect(&ctx).is_none());
    }
}

#[cfg(test)]
mod fan_out_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn fan_out_fires_past_the_node_limit() {
        let d = FanOutExplosionDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_node_count = Some(50);
        assert!(d.detect(&ctx).is_none(), "at the limit is not over it");
        ctx.node.graph_node_count = Some(51);
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::LoopDetected);
        assert!(hit.kill);
    }

    #[test]
    fn an_unknown_graph_size_is_not_a_breach() {
        // Standalone cannot count nodes. Reading None as "very large" would
        // block every graph the store cannot see.
        let d = FanOutExplosionDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_node_count = None;
        assert!(d.detect(&ctx).is_none());
    }

    #[test]
    fn a_normal_graph_passes() {
        let d = FanOutExplosionDetector;
        let mut ctx = base_ctx();
        ctx.node.graph_node_count = Some(6);
        assert!(d.detect(&ctx).is_none());
    }
}

#[cfg(test)]
mod schema_drift_tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn a_changed_tool_set_is_flagged() {
        let d = SchemaDriftDetector;
        let mut ctx = base_ctx();
        ctx.tools_changed_mid_session = true;
        let hit = d.detect(&ctx).unwrap();
        assert_eq!(hit.kind, AnomalyKind::ToolAbuse);
        assert!(!hit.kill, "harnesses do renegotiate tools; this steers");
    }

    #[test]
    fn a_stable_tool_set_is_silent() {
        assert!(SchemaDriftDetector.detect(&base_ctx()).is_none());
    }
}
