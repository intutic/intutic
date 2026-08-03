//! RequestContext — the data structure passed to WASM plugins.

use serde::{Deserialize, Serialize};

/// Enforcement verdict returned by each WASM plugin.
/// Maps to shared-types EnforcementAction enum.
///
/// # The ladder
///
/// In increasing severity: `Bypass` → `Enhance` → `Hijack` → `Reask` → `Kill`.
///
/// `Reask` was added because the gap between `Hijack` (silently rewrite and
/// proceed) and `Kill` (terminate, no recourse) was doing too much work. A
/// heuristic that has never had its false-positive rate measured should not be
/// able to end someone's task, but "advise and continue" is too weak for a spin
/// loop. `Reask` is the rung in between: tell the agent exactly what it tripped
/// and let it correct itself, escalating to `Kill` only if it keeps doing it.
///
/// The shape is borrowed from Guardrails AI's `on_fail` ladder
/// (`noop | filter | fix | reask | fix_reask | refrain | exception`), which
/// arrived at the same conclusion from the validator side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Verdict {
    /// Allow the request to proceed unmodified
    Bypass,
    /// Allow but inject additional context
    Enhance { context: String },
    /// Hold the request, render a decision card for human review
    Hijack { reason: String, confidence: f64 },
    /// Refuse this attempt, tell the agent why, and let it try again.
    ///
    /// `attempts_remaining` is how many further tries this agent has on this
    /// finding before it escalates to [`Verdict::Kill`]. Zero means the next
    /// occurrence blocks — it does **not** mean this one did.
    Reask {
        reason: String,
        attempts_remaining: u32,
    },
    /// Block the request immediately
    Kill {
        reason: String,
        policy_id: Option<String>,
    },
}

/// Risk level from PCAS permission resolution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

/// Tool schema definition (subset of OpenAI/Anthropic tool format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: Option<String>,
}

/// Tool call extracted from the request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// DLP finding from the bidirectional scanner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlpFinding {
    pub category: String,     // "secret", "pii", "credential"
    pub pattern_name: String, // "aws_key", "ssn", "github_token"
    pub action: String,       // "redact", "block"
    pub offset: usize,
    pub length: usize,
}

/// Identity of a single node in a multi-agent graph.
///
/// Sourced from W3C Baggage carrying OpenTelemetry GenAI attributes, with
/// `X-Intutic-*` headers as a fallback for harnesses without OTel
/// instrumentation. See `graph::identity` for the extraction, and ADR-009 for
/// why the standard is preferred over a proprietary header namespace.
///
/// # Trust
///
/// Every field here is client-supplied and unverifiable — W3C Baggage is
/// explicitly specified as untrusted. These values are for observability and
/// self-consistency only. **Never** grant capability on the basis of
/// `agent_role`: an agent able to set a header can claim any role, which would
/// make this a privilege-escalation vector. Authorisation stays bound to the
/// virtual key.
///
/// `#[serde(default)]` is load-bearing: combined with `flatten` on the parent,
/// it lets a payload written before graph support existed still deserialise.
/// Without it serde demands every field be present and rejects the whole
/// context with "missing field `node_id`".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NodeIdentity {
    /// `gen_ai.agent.id` — stable id for this node. Defaults to the session id.
    pub node_id: String,
    /// `gen_ai.agent.name` — the node's role within the graph.
    pub agent_role: String,
    /// `gen_ai.conversation.id` — shared by every node in one graph. Defaults
    /// to the session id, so a single-agent session is a graph of one.
    pub graph_id: String,
    /// Parent span from `traceparent`, or the parent session id. Empty at root.
    pub parent_session_id: String,
    /// Distance from the graph root. No standard carries this — `traceparent`
    /// identifies the immediate parent but not depth, and deriving it needs the
    /// whole trace tree, which a stateless hot-path evaluation cannot assemble.
    pub depth: u32,

    // ── Graph aggregates ────────────────────────────────────────────────
    //
    // Read from the store on the request path and handed to detectors as
    // plain data, which is what keeps every detector a pure function of one
    // context rather than something that reaches for I/O mid-evaluation. The
    // tool sequence already works this way.
    //
    // All three are Option because "the store cannot tell us" and "the answer
    // is zero/false" are different, and conflating them produces exactly the
    // wrong verdict: a graph that has spent nothing looks identical to one
    // whose cost we never tracked.
    /// Total cost across every node in this graph, if known.
    pub graph_spend_usd: Option<f64>,
    /// The per-node budget ceiling this graph is measured against, if known.
    pub graph_budget_usd: Option<f64>,
    /// Whether this node's declared parent is still a live graph member.
    /// `None` when there is no parent, or the store cannot say.
    pub parent_alive: Option<bool>,
    /// How many nodes are live in this graph, if known.
    pub graph_node_count: Option<u32>,
}

/// Context passed to WASM plugins on each request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestContext {
    pub session_id: String,
    pub workspace_id: String,
    pub virtual_key_prefix: String,
    pub model: String,
    pub tools: Vec<ToolSchema>,
    pub tool_calls: Vec<ToolCall>,
    pub estimated_input_tokens: u32,
    pub budget_remaining_usd: f64,
    pub risk_tier: RiskLevel,
    pub dlp_findings: Vec<DlpFinding>,
    pub tool_sequence: Vec<String>,
    /// Fitted `P(to | from)` for this workspace, keyed `"from to"`.
    ///
    /// Resolved on the request path, like `denied_tools` below, so the detector stays
    /// a pure function of this struct and does no I/O of its own — the stated line for
    /// this module is about latency, and a lookup in an already-populated map costs
    /// nothing.
    ///
    /// `None` means no fitted model for this workspace: too little history, the sweep
    /// has not run, or this is a local/OSS deployment with no control plane. The
    /// detector then uses its built-in table. Absent must never read as permissive.
    #[serde(default)]
    pub transition_baseline: Option<std::collections::HashMap<String, f64>>,
    /// Tool names this node's SOPs forbid, resolved for its role.
    ///
    /// Resolved on the request path so the detector stays a pure function.
    /// Empty means nothing is forbidden, which is the default: open core has
    /// no policy service, so an empty policy must mean "no restrictions" and
    /// never "deny everything unlisted".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub denied_tools: Vec<String>,
    /// The steps this node's SOPs declare its task should consist of.
    ///
    /// Resolved on the request path like `denied_tools`, so the detector stays a pure
    /// function. Empty means no plan was declared — which must read as "nothing to
    /// check", never as "deny everything unlisted". Plan adherence is opt-in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan_steps: Vec<String>,
    /// Repo paths this node's SOPs allow it to change. Empty means unrestricted —
    /// the same fail-open default as `denied_tools`, for the same reason.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scope_paths: Vec<String>,
    /// Actions this node's SOPs require a human to approve before the run
    /// continues. Empty means none, and nothing about the hold exists until an
    /// operator declares one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_before: Vec<String>,
    /// What this request's tool calls actually touched.
    ///
    /// Derived on the request path from the same per-turn delta the sequence
    /// comes from, so a detector reading it stays a pure function of this struct.
    /// This is *effect*; `tool_sequence` above is behaviour.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<crate::manifest::ChangeEntry>,
    /// This turn's new tool calls only, expanded into the action vocabulary.
    ///
    /// Deliberately separate from `tool_sequence`, which is the cumulative
    /// rolling window. A check that must fire *once* per action — the review
    /// hold — has to read the delta: scoring the window would re-fire on every
    /// request until it rolled over, which after a human approves means the run
    /// re-holds itself forever.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub new_tool_calls: Vec<String>,
    /// Prompt-injection patterns matched in this request's text.
    ///
    /// Pattern names, not the matched text — the matched span is attacker
    /// input, and copying it into telemetry, notifications and sibling agent
    /// context would propagate the payload to exactly the places the detector
    /// exists to protect.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub injection_findings: Vec<String>,
    /// True when the advertised tool definitions no longer match the pin
    /// recorded for this workspace on first use.
    ///
    /// Trust-on-first-use over name, description and input schema. Workspace-
    /// scoped and durable rather than per-session: a rug pull arrives with a
    /// server update between sessions, and a per-session baseline would adopt
    /// the poisoned definition instead of flagging it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tool_contract_changed: bool,
    /// The harness this request came through, e.g. `claude-code`, `cursor`.
    ///
    /// Derived from the upstream route the proxy resolved, not from anything
    /// the caller asserts, so unlike the graph identity fields this one is
    /// trustworthy enough to gate on.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub harness: String,
    /// Harnesses the SOPs in force permit for this node's role. Empty means
    /// unrestricted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_harnesses: Vec<String>,
    /// Cost of the loop run this request belongs to, and the ceiling it was
    /// started with. `None` when there is no run, or nobody set a budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_spend_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_budget_usd: Option<f64>,
    /// Graph position. Flattened onto the wire so existing guest rules that
    /// index fields by name keep working and simply gain new keys.
    #[serde(flatten)]
    pub node: NodeIdentity,
}

/// Context passed to WASM plugins on each response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseContext {
    pub session_id: String,
    pub workspace_id: String,
    pub model: String,
    pub output_tokens: u32,
    pub actual_cost_usd: f64,
    pub response_tool_calls: Vec<ToolCall>,
    pub dlp_findings: Vec<DlpFinding>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> RequestContext {
        RequestContext {
            session_id: "ses_1".into(),
            plan_steps: Vec::new(),
            scope_paths: Vec::new(),
            review_before: Vec::new(),
            changes: Vec::new(),
            new_tool_calls: Vec::new(),
            transition_baseline: None,
            workspace_id: "ws_1".into(),
            virtual_key_prefix: "vk_1".into(),
            model: "claude-sonnet-4".into(),
            tools: vec![],
            tool_calls: vec![],
            estimated_input_tokens: 42,
            budget_remaining_usd: 1.5,
            risk_tier: RiskLevel::Low,
            dlp_findings: vec![],
            tool_sequence: vec!["Glob".into(), "View".into()],
            denied_tools: vec![],
            injection_findings: vec![],
            tool_contract_changed: false,
            harness: String::new(),
            allowed_harnesses: vec![],
            workflow_spend_usd: None,
            workflow_budget_usd: None,
            node: NodeIdentity {
                node_id: "planner-1".into(),
                agent_role: "planner".into(),
                graph_id: "graph-42".into(),
                parent_session_id: "00f067aa0ba902b7".into(),
                depth: 2,
                graph_spend_usd: Some(3.25),
                graph_budget_usd: Some(10.0),
                parent_alive: Some(true),
                graph_node_count: Some(3),
            },
        }
    }

    /// The guest contract. `#[serde(flatten)]` must put the node fields at the
    /// top level — the AssemblyScript SDK reads `node_id`, not `node.node_id`,
    /// and a nested object would leave every graph-aware rule silently reading
    /// defaults.
    #[test]
    fn node_identity_serialises_flat() {
        let v: serde_json::Value = serde_json::to_value(ctx()).unwrap();
        let obj = v.as_object().unwrap();

        assert_eq!(obj["node_id"], "planner-1");
        assert_eq!(obj["agent_role"], "planner");
        assert_eq!(obj["graph_id"], "graph-42");
        assert_eq!(obj["parent_session_id"], "00f067aa0ba902b7");
        assert_eq!(obj["depth"], 2);

        assert!(
            obj.get("node").is_none(),
            "node must be flattened, not nested"
        );
    }

    /// Existing keys must keep their names and snake_case form. Renaming one
    /// silently breaks every rule already deployed against it.
    #[test]
    fn existing_wire_keys_are_unchanged() {
        let v: serde_json::Value = serde_json::to_value(ctx()).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "session_id",
            "workspace_id",
            "virtual_key_prefix",
            "model",
            "tools",
            "tool_calls",
            "estimated_input_tokens",
            "budget_remaining_usd",
            "risk_tier",
            "dlp_findings",
            "tool_sequence",
        ] {
            assert!(obj.contains_key(key), "missing wire key: {key}");
        }
    }

    /// A context serialised before graph support must still deserialise, so a
    /// stored or replayed payload does not become unreadable.
    #[test]
    fn deserialises_payload_without_graph_fields() {
        let legacy = serde_json::json!({
            "session_id": "ses_1",
            "workspace_id": "ws_1",
            "virtual_key_prefix": "vk_1",
            "model": "claude-sonnet-4",
            "tools": [],
            "tool_calls": [],
            "estimated_input_tokens": 10,
            "budget_remaining_usd": 1.0,
            "risk_tier": "Low",
            "dlp_findings": [],
            "tool_sequence": []
        });
        let parsed: RequestContext = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.node.depth, 0);
        assert!(parsed.node.node_id.is_empty());
    }
}
