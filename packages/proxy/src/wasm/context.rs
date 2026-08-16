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
        /// Which rule or detector asked for the retry.
        ///
        /// The reask counter is keyed on this, for the reason `proxy.rs`
        /// documents at the anomaly path: a shared allowance blocks an agent on
        /// its second *distinct* correction rather than on a repeated failure
        /// to correct, which is the opposite of what the ladder is for. A WASM
        /// rule reaching this rung therefore has to be attributable, and only
        /// the registry knows the rule id — the runner does not.
        policy_id: Option<String>,
    },
    /// Block the request immediately
    Kill {
        reason: String,
        policy_id: Option<String>,
    },
}

/// Risk level from PCAS permission resolution.
///
/// `Ord` is derived and the variant order is the severity order, so
/// `sops::risk_tier_for_role` can take a `max()` across every SOP applying to a
/// role — two SOPs, one HIGH and one LOW, describe work that is HIGH, and
/// taking either arbitrarily would make the answer depend on directory order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
    /// `(tool, count)` — how many times each distinct tool/action appears in
    /// `tool_sequence` above.
    ///
    /// A pure fold of that field, not a fetch — no new store. It exists
    /// because AssemblyScript has no map type to fold `tool_sequence` into
    /// itself, so a rule wanting "has Bash run more than N times in this
    /// window" would otherwise have to walk the raw sequence by hand.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_call_counts: Vec<(String, i32)>,
    /// Tool calls in the last 60 seconds, across the whole session.
    ///
    /// Not derivable from `tool_sequence`/`tool_call_counts` above: that
    /// window is capped at a fixed entry count and carries no timestamps, so
    /// a burst that fills it in ten seconds and one spread over an hour look
    /// identical there. This is resolved from a dedicated Valkey sorted set
    /// scored by call time, scoped the same way `tool_sequence` is (see
    /// `tool_history_scope` in `proxy.rs`).
    ///
    /// Always a real count, never "unknown" — a session with no calls yet in
    /// the window reads `0`, not a sentinel.
    #[serde(default)]
    pub calls_last_60s: i32,
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
    /// Ordering rules this node's SOPs declare: `(before, after, adjacent)` — `after` must
    /// not run unless `before` ran first.
    ///
    /// Resolved on the request path like `review_before` above, so the detector
    /// stays a pure function. **Empty means "use the built-in table", not "check
    /// nothing"** — which is the opposite of every other declaration field here,
    /// and deliberate: the built-ins are the floor, and a workspace that declares
    /// nothing must not end up with less enforcement than before this field
    /// existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires_before: Vec<(String, String, bool)>,
    /// Ordering rules this node's SOPs forbid: `(first, then, adjacent)` —
    /// `then` must not run after `first`, or immediately after it when
    /// `adjacent`. Same built-ins-as-floor rule as `requires_before`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbid_after: Vec<(String, String, bool)>,
    /// `(token, max)` — at most `max` calls to `token` in this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub max_calls: Vec<(String, usize)>,
    /// `(taint, token)` — a DLP category and a tool/action that must not appear
    /// in the same request.
    ///
    /// Co-occurrence rather than succession, deliberately: `dlp_findings` is a
    /// scan of the whole body and says a secret is *present*, not which call
    /// carried it. Expressing this as an ordering rule would imply a sequence
    /// position nothing in the data supports.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forbid_with: Vec<(String, String)>,
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
    ///
    /// Deduplicated by pattern name across the whole body, same as the old
    /// whole-body `injection::scan` this now derives from —
    /// `PromptInjectionDetector`'s reask threshold counts this list's
    /// length, so adding source attribution (below) must never inflate it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub injection_findings: Vec<String>,
    /// Which parts of the request contributed at least one injection match:
    /// `"user_prompt"`, `"system_prompt"`, `"tool_result"`, or
    /// `"tool_description"`. Deduplicated by source, not paired 1:1 with
    /// `injection_findings` above.
    ///
    /// The distinction this exists for: a match in `tool_result` arrived via
    /// content the agent fetched, not something the user typed — the
    /// multi-agent-graph case `injection.rs`'s own module doc describes,
    /// where one node's output becomes the next node's input and looks like
    /// instructions from the orchestrator. `PromptInjectionDetector` reads
    /// this field to escalate untrusted-content matches past plain `steer`
    /// without waiting on the pattern-count threshold; a WASM rule wanting
    /// its own, different treatment of source can read it too.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub injection_sources: Vec<String>,
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
    /// Whether this session's sandbox has proven it resolves the proxy as its
    /// only egress path — see [`crate::store::ControlPlaneCache::is_sandbox_attested`].
    ///
    /// Server-derived, like `harness` above, not from anything the caller
    /// asserts — trustworthy enough to gate on. But it is a session-scoped
    /// fact, not a node-scoped one: every node claiming membership in an
    /// attested session's graph reads `true` identically, regardless of its
    /// claimed `node_id`/`agent_role`. It does NOT verify agent identity — a
    /// compromised node inside an already-attested session can still claim
    /// any `node_id`/`agent_role` string it wants. Combining this with
    /// `agent_role` in a rule still trusts an unverifiable role claim.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sandbox_attested: bool,
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
            requires_before: Vec::new(),
            forbid_after: Vec::new(),
            max_calls: Vec::new(),
            forbid_with: Vec::new(),
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
            tool_call_counts: vec![("Glob".into(), 1), ("View".into(), 1)],
            calls_last_60s: 2,
            denied_tools: vec![],
            injection_findings: vec![],
            injection_sources: vec![],
            tool_contract_changed: false,
            harness: String::new(),
            allowed_harnesses: vec![],
            sandbox_attested: false,
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
        // A payload from before sandbox attestation existed must default to
        // unattested, not fail to parse — the same fail-closed shape
        // `ControlPlaneCache::is_sandbox_attested` uses for a cache miss.
        assert!(!parsed.sandbox_attested);
    }

    /// An attested session must reach the guest as `true`, and the field must
    /// keep its exact wire name — a rename here would silently strand every
    /// rule already deployed against it.
    #[test]
    fn sandbox_attested_round_trips_on_the_wire() {
        let mut attested = ctx();
        attested.sandbox_attested = true;
        let v: serde_json::Value = serde_json::to_value(&attested).unwrap();
        assert_eq!(v["sandbox_attested"], true);

        let mut unattested = ctx();
        unattested.sandbox_attested = false;
        let v: serde_json::Value = serde_json::to_value(&unattested).unwrap();
        // `skip_serializing_if` omits it at `false`, same as `tool_contract_changed` —
        // a guest reading a missing key must still see the fail-closed default.
        assert!(v.as_object().unwrap().get("sandbox_attested").is_none());
    }

    /// `(tool, count)` tuples serialise as two-element JSON arrays — that is
    /// what the AssemblyScript parser walks positionally, same convention as
    /// `max_calls`.
    #[test]
    fn tool_call_counts_round_trips_as_pairs() {
        let v: serde_json::Value = serde_json::to_value(ctx()).unwrap();
        assert_eq!(v["tool_call_counts"], serde_json::json!([["Glob", 1], ["View", 1]]));
    }

    /// `calls_last_60s` is always present, unlike the `skip_serializing_if`
    /// fields above — zero is a real, meaningful count here, not an absent
    /// value, so it must never be optimised off the wire the way `false`/
    /// empty-list defaults are elsewhere on this struct.
    #[test]
    fn calls_last_60s_is_never_omitted_even_at_zero() {
        let mut c = ctx();
        c.calls_last_60s = 0;
        let v: serde_json::Value = serde_json::to_value(&c).unwrap();
        assert_eq!(v["calls_last_60s"], 0);
    }

    /// A payload from before this field existed must still deserialise, with
    /// the count read as zero — the honest answer for a session the ZSET has
    /// no history for, same reasoning as `deserialises_payload_without_graph_fields`.
    #[test]
    fn deserialises_payload_without_temporal_fields() {
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
        assert!(parsed.tool_call_counts.is_empty());
        assert_eq!(parsed.calls_last_60s, 0);
    }
}
