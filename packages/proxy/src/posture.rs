//! Agent security-posture scoring — deterministic rubric (open core).
//!
//! Mirror of the control-plane rubric in
//! `services/control-plane/src/lib/agentPosture.ts`. Scores how much of the
//! available guardrail surface is switched on against a published
//! categorisation: each Intutic primitive maps to the OWASP LLM Top 10 (2025)
//! risk it mitigates and, for the agent-to-agent surface, the OWASP Agentic-AI
//! threat classes. Intutic's own guardrail framework is the scale.
//!
//! Used by the inline `/fix` and `/draw` commands (`commands.rs`) to score the
//! primitives configured for the current request, entirely on the developer's
//! machine — no control plane required. Keep the facet set in sync with the TS
//! mirror; `posture_facets_match_ts_mirror` guards the list.

pub const RUBRIC_VERSION: &str = "owasp-llm-2025.1";

/// The nine facets that make up an agent's posture, in weight order.
pub const FACETS: [&str; 9] = [
    "guardrails",
    "sops",
    "budgets",
    "mcp_tools",
    "loops",
    "graphs",
    "harness",
    "skills",
    "memory",
];

/// Relative weight of each facet (sums to 100). Mirrors the TS `FACET_WEIGHTS`.
fn weight(facet: &str) -> u32 {
    match facet {
        "guardrails" => 24,
        "sops" => 18,
        "budgets" => 12,
        "mcp_tools" => 14,
        "loops" => 10,
        "graphs" => 8,
        "harness" => 6,
        "skills" => 4,
        "memory" => 4,
        _ => 0,
    }
}

/// The OWASP categories a facet is scored against — surfaced in `/fix`/`/draw`.
pub fn rubric_for(facet: &str) -> (&'static str, &'static str) {
    match facet {
        "guardrails" => ("LLM01/LLM02/LLM06", "T2 Tool Misuse, T6 Intent Breaking"),
        "sops" => ("LLM01/LLM06", "T6 Intent Breaking, T7 Misaligned Behaviour"),
        "budgets" => ("LLM10 Unbounded Consumption", "T4 Resource Overload"),
        "mcp_tools" => ("LLM06/LLM03", "T2 Tool Misuse, T3 Privilege Compromise"),
        "skills" => ("LLM03 Supply Chain", "T3 Privilege Compromise"),
        "loops" => ("LLM10 Unbounded Consumption", "T4/T5 Overload & Cascades"),
        "graphs" => ("LLM06 Excessive Agency", "T5/T12 Cascades & Poisoning"),
        "harness" => ("LLM03 Supply Chain", "T3 Privilege Compromise"),
        "memory" => ("LLM08/LLM04", "T1 Memory Poisoning"),
        _ => ("", ""),
    }
}

/// Facet inputs for the current request. Booleans/counts kept deliberately
/// coarse — this is a pre-flight self-assessment, not an audit.
#[derive(Debug, Default, Clone)]
pub struct Facets {
    // guardrails
    pub dlp: bool,
    pub wasm_rules: u32,
    pub hook_gate: bool,
    pub pcas: bool,
    // sops
    pub sops_total: u32,
    pub sops_enforced: u32,
    // budgets
    pub budget_hard_cap: bool,
    pub budget_session_cap: bool,
    // mcp tools (None = surface not used)
    pub mcp_total: Option<u32>,
    pub mcp_scoped: u32,
    // skills
    pub skills_total: Option<u32>,
    pub skills_sourced: u32,
    // loops
    pub loops_configured: bool,
    pub loops_bounded: bool,
    // graphs (None = single agent)
    pub graph_present: Option<bool>,
    pub graph_workspace_scoped: bool,
    // harness
    pub harness_known: bool,
    pub harness_config_synced: bool,
    // memory (None = no provider connected)
    pub memory_total: Option<u32>,
    pub memory_governed: u32,
}

/// One facet's contribution to the score.
#[derive(Debug, Clone)]
pub struct FacetScore {
    pub facet: &'static str,
    pub score: u32,   // 0..100
    pub weight: u32,
    pub applies: bool,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct PostureResult {
    pub overall: u32, // 0..100
    pub band: &'static str,
    pub facets: Vec<FacetScore>,
}

/// Map a 0..100 score to the ring colour the dashboard draws.
pub fn band(score: u32) -> &'static str {
    match score {
        s if s < 40 => "red",
        s if s < 65 => "orange",
        s if s < 85 => "yellow",
        _ => "green",
    }
}

fn ratio(part: u32, whole: u32) -> u32 {
    if whole == 0 {
        0
    } else {
        ((part as f64 / whole as f64) * 100.0).round() as u32
    }
}

fn score_facet(facet: &str, f: &Facets) -> (u32, bool, String) {
    match facet {
        "guardrails" => {
            let on = [f.dlp, f.wasm_rules > 0, f.hook_gate, f.pcas]
                .iter()
                .filter(|b| **b)
                .count() as u32;
            (ratio(on, 4), true, format!("{on}/4 guardrail layers enforcing (DLP, WASM, hook gate, PCAS)"))
        }
        "sops" => {
            if f.sops_total == 0 {
                (0, true, "no SOPs bound to this agent".into())
            } else {
                (ratio(f.sops_enforced, f.sops_total), true, format!("{}/{} SOPs enforced", f.sops_enforced, f.sops_total))
            }
        }
        "budgets" => {
            let s = if f.budget_hard_cap { 60 } else { 0 } + if f.budget_session_cap { 40 } else { 0 };
            (s, true, format!(
                "{}, {}",
                if f.budget_hard_cap { "workspace cap" } else { "no workspace cap" },
                if f.budget_session_cap { "session cap" } else { "no session cap" },
            ))
        }
        "mcp_tools" => match f.mcp_total {
            None | Some(0) => (100, false, "no MCP tools connected — nothing to scope".into()),
            Some(total) => (ratio(f.mcp_scoped, total), true, format!("{}/{} MCP tools have explicit scopes", f.mcp_scoped, total)),
        },
        "skills" => match f.skills_total {
            None | Some(0) => (100, false, "no skills declared".into()),
            Some(total) => (ratio(f.skills_sourced, total), true, format!("{}/{} skills have a known source", f.skills_sourced, total)),
        },
        "loops" => {
            if !f.loops_configured {
                (0, true, "no loop / turn cap configured".into())
            } else if f.loops_bounded {
                (100, true, "bounded turn budget".into())
            } else {
                (60, true, "configured but unbounded turns".into())
            }
        }
        "graphs" => match f.graph_present {
            None | Some(false) => (100, false, "single agent — no graph".into()),
            Some(true) => {
                if f.graph_workspace_scoped {
                    (100, true, "graph keys workspace-scoped".into())
                } else {
                    (40, true, "graph not workspace-scoped".into())
                }
            }
        },
        "harness" => {
            if !f.harness_known {
                (0, true, "unknown harness".into())
            } else if f.harness_config_synced {
                (100, true, "known harness, config synced".into())
            } else {
                (50, true, "known harness, config drift not watched".into())
            }
        }
        "memory" => match f.memory_total {
            None | Some(0) => (100, false, "no memory provider connected".into()),
            Some(total) => (ratio(f.memory_governed, total), true, format!("{}/{} memory providers governed", f.memory_governed, total)),
        },
        _ => (0, false, String::new()),
    }
}

/// Deterministic posture score from the request's configured primitives.
///
/// Facets that do not apply (no MCP tools, single agent so no graph) are
/// excluded from the weighting rather than scored zero — an agent is not
/// insecure for lacking a surface it never uses.
pub fn score(f: &Facets) -> PostureResult {
    let facets: Vec<FacetScore> = FACETS
        .iter()
        .map(|&facet| {
            let (s, applies, reason) = score_facet(facet, f);
            FacetScore { facet, score: s.min(100), weight: weight(facet), applies, reason }
        })
        .collect();

    let applicable: Vec<&FacetScore> = facets.iter().filter(|s| s.applies).collect();
    let total_weight: u32 = applicable.iter().map(|s| s.weight).sum::<u32>().max(1);
    let weighted: f64 = applicable.iter().map(|s| s.score as f64 * s.weight as f64).sum();
    let overall = (weighted / total_weight as f64).round() as u32;

    PostureResult { overall: overall.min(100), band: band(overall), facets }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fully_guarded_agent_scores_green() {
        let f = Facets {
            dlp: true, wasm_rules: 3, hook_gate: true, pcas: true,
            sops_total: 2, sops_enforced: 2,
            budget_hard_cap: true, budget_session_cap: true,
            loops_configured: true, loops_bounded: true,
            harness_known: true, harness_config_synced: true,
            ..Default::default()
        };
        let r = score(&f);
        assert_eq!(r.band, "green", "overall was {}", r.overall);
        assert!(r.overall >= 85);
    }

    #[test]
    fn a_bare_agent_scores_red() {
        let f = Facets { harness_known: true, ..Default::default() };
        let r = score(&f);
        assert_eq!(r.band, "red", "overall was {}", r.overall);
        assert!(r.overall < 40);
    }

    #[test]
    fn unused_surfaces_do_not_penalise() {
        // Strong guardrails, no MCP/graph/skill/memory surface at all.
        let f = Facets {
            dlp: true, wasm_rules: 1, hook_gate: true, pcas: true,
            sops_total: 1, sops_enforced: 1,
            budget_hard_cap: true, budget_session_cap: true,
            loops_configured: true, loops_bounded: true,
            harness_known: true, harness_config_synced: true,
            ..Default::default()
        };
        assert!(score(&f).overall >= 85);
    }

    #[test]
    fn posture_facets_match_ts_mirror() {
        // The TS rubric (agentPosture.ts) declares these nine, same names.
        assert_eq!(FACETS.len(), 9);
        for f in FACETS {
            assert!(weight(f) > 0, "{f} has no weight");
        }
        assert_eq!(FACETS.iter().map(|f| weight(f)).sum::<u32>(), 100);
    }
}
