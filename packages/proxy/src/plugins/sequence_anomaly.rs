//! Sequence Anomaly Plugin — HLD §3.5.2
//!
//! Intercepts anomalous sequences of tool calls using a transition probability
//! classifier. This acts as a lightweight sequence-based anomaly recognition engine.
//!
//! # Behaviors
//! - Repeats check: flags consecutive repetitions of a single tool (e.g. loop).
//! - Transition probability check: uses a Markov transition matrix to evaluate
//!   the likelihood of the tool sequence. Low probability indicates drift or abuse.

use crate::plugins::IntuticPlugin;
use crate::wasm::context::{RequestContext, Verdict};

/// Sequence anomaly detection plugin.
pub struct SequenceAnomalyPlugin {
    /// Consecutive repetition threshold (defaults to 5)
    repetition_threshold: usize,
    /// Minimum average transition probability before flagging (defaults to 0.35)
    min_transition_probability: f64,
}

impl SequenceAnomalyPlugin {
    pub fn new() -> Self {
        Self {
            repetition_threshold: 5,
            min_transition_probability: 0.35,
        }
    }

    /// Retrieve the transition probability between tool A and tool B.
    /// Standard operations have high probability; loops and abuse have low probability.
    fn transition_probability(&self, from: &str, to: &str) -> f64 {
        match (from, to) {
            // Normal browsing / search transitions
            ("list_dir", "view_file") => 0.90,
            ("grep_search", "view_file") => 0.90,
            ("view_file", "view_file") => 0.85,
            ("view_file", "replace_file_content") => 0.80,
            ("replace_file_content", "run_command") => 0.75,

            // Claude Code CLI transitions
            ("Write", "Write") => 0.85,
            ("Write", "Bash") => 0.80,
            ("Bash", "Bash") => 0.70,
            ("View", "View") => 0.85,
            ("View", "Write") => 0.80,
            ("Glob", "View") => 0.90,
            ("Grep", "View") => 0.90,

            // Self transitions (repetitive loops)
            ("run_command", "run_command") => 0.15, // Command looping is suspicious
            ("replace_file_content", "replace_file_content") => 0.30,
            (a, b) if a == b => 0.20, // General repetition is slightly suspicious

            // Default unknown transition
            _ => 0.50,
        }
    }
}

impl Default for SequenceAnomalyPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl IntuticPlugin for SequenceAnomalyPlugin {
    fn name(&self) -> &str {
        "sequence-anomaly"
    }

    /// Priority 10 — executes right after dlp and budget gates.
    fn priority(&self) -> u8 {
        10
    }

    fn evaluate(&self, ctx: &RequestContext) -> Verdict {
        let seq = &ctx.tool_sequence;
        if seq.is_empty() {
            return Verdict::Bypass;
        }

        // 1. Consecutive repetition check (Loop Detection)
        let mut consecutive_count = 1;
        let mut last_tool = &seq[0];
        for tool in seq.iter().skip(1) {
            if tool == last_tool {
                consecutive_count += 1;
                if consecutive_count >= self.repetition_threshold {
                    return Verdict::Kill {
                        reason: format!(
                            "Sequence anomaly detected: infinite loop on tool '{}' (repeated {} times)",
                            tool, consecutive_count
                        ),
                        policy_id: Some("loop-detected".into()),
                    };
                }
            } else {
                consecutive_count = 1;
                last_tool = tool;
            }
        }

        // 2. Markov transition probability check
        if seq.len() >= 2 {
            let mut total_prob = 0.0;
            let mut transitions = 0;
            for i in 0..seq.len() - 1 {
                let from = &seq[i];
                let to = &seq[i + 1];
                total_prob += self.transition_probability(from, to);
                transitions += 1;
            }

            let avg_prob = total_prob / (transitions as f64);
            if avg_prob < self.min_transition_probability {
                return Verdict::Hijack {
                    reason: format!(
                        "Sequence anomaly detected: anomalous tool sequence transition behavior (average transition score: {:.2})",
                        avg_prob
                    ),
                    confidence: 1.0 - avg_prob,
                };
            }
        }

        Verdict::Bypass
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::{RequestContext, RiskLevel};

    fn make_ctx(seq: Vec<&str>) -> RequestContext {
        RequestContext {
            session_id: "sess-seq".into(),
            workspace_id: "ws-1".into(),
            virtual_key_prefix: "vk-test".into(),
            model: "gpt-4".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 100,
            budget_remaining_usd: 10.0,
            risk_tier: RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: seq.into_iter().map(String::from).collect(),
        }
    }

    #[test]
    fn test_bypass_normal_sequence() {
        let plugin = SequenceAnomalyPlugin::new();
        let ctx = make_ctx(vec![
            "list_dir",
            "view_file",
            "replace_file_content",
            "run_command",
        ]);
        assert_eq!(plugin.evaluate(&ctx), Verdict::Bypass);
    }

    #[test]
    fn test_kill_consecutive_loop() {
        let plugin = SequenceAnomalyPlugin::new();
        let ctx = make_ctx(vec![
            "view_file",
            "run_command",
            "run_command",
            "run_command",
            "run_command",
            "run_command",
        ]);
        assert!(matches!(plugin.evaluate(&ctx), Verdict::Kill { .. }));
    }

    #[test]
    fn test_hijack_anomalous_transitions() {
        let plugin = SequenceAnomalyPlugin::new();
        let ctx = make_ctx(vec!["run_command", "run_command", "run_command"]);
        assert!(matches!(plugin.evaluate(&ctx), Verdict::Hijack { .. }));
    }
}
