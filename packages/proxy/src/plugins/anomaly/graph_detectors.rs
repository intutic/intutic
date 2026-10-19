//! Graph checks over a node's position.
//!
//! Two things live here:
//!
//! * [`ContextOverlapDetector`]: sibling workers that were handed nearly the
//!   same context. Advisory by default; `context_isolation: enforce` re-asks.
//! * Node-kind limits: [`NODE_KIND_LIMITS`], [`SPAWN_TOOLS`], and the pure
//!   decisions the request path and the response gate call
//!   ([`effective_node_kind`], [`request_denial`], [`withheld_tool`]).
//!
//! Everything here is a pure function of data the request path has already
//! read from the store, which keeps the detectors hot-path safe: the sibling
//! comparison arrives as `RequestContext.sibling_overlap`, computed by
//! `context_sig::best_sibling`, and a parent's recorded kind arrives as a
//! string.

use super::{AnomalyDetector, AnomalyFinding, AnomalyKind};
use crate::context_sig::SiblingOverlap;
use crate::node_kind::{Capability, NodeKind, NodeLimits};
use crate::wasm::context::RequestContext;

// ── Worker context isolation (§8) ────────────────────────────────────────

/// The detector's stable id. Also the entry `corroborating_detector_ids`
/// excludes: an advisory overlap must never push another detector's steer to a
/// re-ask.
pub const CONTEXT_OVERLAP_ID: &str = "context_overlap";

/// Estimated Jaccard at which two siblings' handed-in contexts count as the
/// same brief.
pub const CONTEXT_OVERLAP_THRESHOLD: f64 = 0.85;

/// `context_isolation:` in an SOP.
///
/// Ordered so the strongest wins with `max()` when several SOPs set it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IsolationMode {
    /// Steer: tell the node, let the request through.
    #[default]
    Advise,
    /// Re-ask; the third trip follows the exhausted re-ask path (§6).
    Enforce,
}

impl IsolationMode {
    /// Parse a `context_isolation:` value.
    ///
    /// An unknown value enforces and is reported, the direction
    /// `parse_sql_guard` fails in: a typo must never switch a guard off.
    pub fn parse(value: &str) -> (IsolationMode, Option<String>) {
        let v = value
            .trim()
            .trim_matches(['"', '\''])
            .trim()
            .to_ascii_lowercase();
        match v.as_str() {
            "advise" => (IsolationMode::Advise, None),
            "enforce" => (IsolationMode::Enforce, None),
            _ => (
                IsolationMode::Enforce,
                Some(format!(
                    "context_isolation: unknown value {v:?}; expected advise or enforce (enforcing)"
                )),
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            IsolationMode::Advise => "advise",
            IsolationMode::Enforce => "enforce",
        }
    }
}

/// Sibling nodes handed nearly the same context.
///
/// Reports `TokenWaste`: the cost of a splitter that hands every worker the
/// whole task is paid once per worker, and the workers tend to repeat each
/// other's work. A judgement, so `steer` unless the operator asked for
/// `context_isolation: enforce`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContextOverlapDetector;

impl ContextOverlapDetector {
    /// The finding for this request's best sibling match, if it crosses
    /// [`CONTEXT_OVERLAP_THRESHOLD`].
    pub fn evaluate(
        overlap: Option<&SiblingOverlap>,
        mode: IsolationMode,
    ) -> Option<AnomalyFinding> {
        let o = overlap?;
        if !o.jaccard.is_finite() || o.jaccard < CONTEXT_OVERLAP_THRESHOLD {
            return None;
        }
        let pct = (o.jaccard * 100.0).round() as u32;
        let kib = o.bytes.div_ceil(1024);
        let reason = format!(
            "This node's handed-in context is about {pct}% the same as sibling node {} \
             ({kib} KiB). Sibling workers should each get only their slice of the task: \
             hand each worker its own brief instead of the full shared context.",
            printable(&o.node)
        );
        Some(match mode {
            IsolationMode::Advise => {
                AnomalyFinding::steer(AnomalyKind::TokenWaste, reason, o.jaccard)
            }
            IsolationMode::Enforce => AnomalyFinding::reask(
                AnomalyKind::TokenWaste,
                format!("{reason} (context_isolation: enforce)"),
                o.jaccard,
            ),
        })
    }
}

impl AnomalyDetector for ContextOverlapDetector {
    fn id(&self) -> &'static str {
        CONTEXT_OVERLAP_ID
    }

    fn kind(&self) -> AnomalyKind {
        AnomalyKind::TokenWaste
    }

    fn detect(&self, ctx: &RequestContext) -> Option<AnomalyFinding> {
        Self::evaluate(ctx.sibling_overlap.as_ref(), ctx.context_isolation)
    }
}

/// A client-supplied id, made safe to put in a message: control characters
/// dropped, wrapped in backticks.
fn printable(id: &str) -> String {
    let clean: String = id
        .chars()
        .filter(|c| !c.is_control() && *c != '`')
        .collect();
    format!("`{clean}`")
}

// ── Node kinds (§9) ──────────────────────────────────────────────────────

/// The refusal code for a request a node kind forbids (403).
pub const NODE_KIND_DENIED: &str = "NODE_KIND_DENIED";

/// Tool names that start a child agent. Matched exactly, ignoring case: these
/// names are short and generic, and a suffix match would catch `create_task`.
pub const SPAWN_TOOLS: &[&str] = &["task", "agent", "spawn_agent", "subagent", "dispatch_agent"];

/// What each kind refuses by default.
///
/// | Kind | Model | Write | Shell | Spawn |
/// |---|---|---|---|---|
/// | `code` | refused | n/a | n/a | n/a |
/// | `gate` | | refused | refused | refused |
/// | `worker` | | | | refused |
/// | `splitter` | | | | |
///
/// `code` refuses only the model: with no model call, nothing else it could
/// ask for ever reaches the gateway.
pub const NODE_KIND_LIMITS: [(NodeKind, NodeLimits); 4] = [
    (
        NodeKind::Code,
        NodeLimits {
            model: true,
            write: false,
            shell: false,
            spawn: false,
        },
    ),
    (
        NodeKind::Gate,
        NodeLimits {
            model: false,
            write: true,
            shell: true,
            spawn: true,
        },
    ),
    (
        NodeKind::Worker,
        NodeLimits {
            model: false,
            write: false,
            shell: false,
            spawn: true,
        },
    ),
    (NodeKind::Splitter, NodeLimits::NONE),
];

/// A kind's default limits, from [`NODE_KIND_LIMITS`].
pub fn kind_limits(kind: NodeKind) -> NodeLimits {
    NODE_KIND_LIMITS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, l)| *l)
        .unwrap_or(NodeLimits::NONE)
}

/// Whether `name` starts a child agent.
pub fn is_spawn_tool(name: &str) -> bool {
    let name = name.trim();
    SPAWN_TOOLS.iter().any(|t| name.eq_ignore_ascii_case(t))
}

/// The kinds that apply to one request and the limits they add up to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EffectiveNodeKind {
    /// Every kind in force, most restrictive first, without duplicates.
    pub kinds: Vec<NodeKind>,
    /// The union of their limits, less `node_kind_allow:`.
    pub limits: NodeLimits,
    /// The SOPs declared more than one kind for this role. The caller logs it
    /// once; the union still applies.
    pub sop_conflict: bool,
}

impl EffectiveNodeKind {
    /// The most restrictive kind in force whose defaults refuse `cap`.
    pub fn responsible(&self, cap: Capability) -> Option<NodeKind> {
        self.kinds
            .iter()
            .copied()
            .find(|k| kind_limits(*k).refuses(cap))
    }

    /// `node_kind.<kind>` for the kind that refuses `cap`.
    pub fn rule_id(&self, cap: Capability) -> String {
        match self.responsible(cap) {
            Some(k) => format!("node_kind.{k}"),
            None => "node_kind".to_string(),
        }
    }

    /// What to record for this node in the graph's kind hash, so its children
    /// can be refused: the kind that refuses spawning, when spawning is still
    /// refused after `node_kind_allow:`. `None` means record nothing — a
    /// worker an operator allowed to spawn must not have its children refused.
    pub fn recorded_kind(&self) -> Option<NodeKind> {
        if self.limits.spawn {
            self.responsible(Capability::Spawn)
        } else {
            None
        }
    }
}

/// Combine every source of a node's kind.
///
/// * `sop_kinds`: every `node_kind:` from SOPs that apply to the role.
/// * `header_kind`: `graph::declared_node_kind`, parsed with
///   `NodeKind::parse`. A header can only add limits; it is never authority.
/// * `allow`: every top-level `node_kind_allow:`. It removes limits from the
///   union, whichever source added them.
pub fn effective_node_kind(
    sop_kinds: &[NodeKind],
    header_kind: Option<NodeKind>,
    allow: &[Capability],
) -> EffectiveNodeKind {
    let mut sop: Vec<NodeKind> = sop_kinds.to_vec();
    sop.sort();
    sop.dedup();
    let sop_conflict = sop.len() > 1;

    let mut kinds = sop;
    kinds.extend(header_kind);
    kinds.sort();
    kinds.dedup();

    let mut limits = kinds
        .iter()
        .fold(NodeLimits::NONE, |acc, k| acc.union(kind_limits(*k)));
    for cap in allow {
        limits = limits.without(*cap);
    }

    EffectiveNodeKind {
        kinds,
        limits,
        sop_conflict,
    }
}

/// A node-kind refusal: the request (403 [`NODE_KIND_DENIED`]) or one tool
/// call (withheld in band as `TOOL_DENIED`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeKindDenial {
    /// `node_kind.<kind>`.
    pub rule: String,
    pub reason: String,
    /// What was refused.
    pub capability: Capability,
}

/// Whether this request may reach a model at all.
///
/// * A `code` node is refused on every request.
/// * A child whose parent is recorded as `worker` or `gate` is refused:
///   `parent_recorded` is that parent's field in the graph's kind hash (see
///   [`EffectiveNodeKind::recorded_kind`]), `None` when absent.
pub fn request_denial(
    own: &EffectiveNodeKind,
    node_id: &str,
    parent_id: &str,
    parent_recorded: Option<&str>,
) -> Option<NodeKindDenial> {
    if own.limits.model {
        let kind = own.responsible(Capability::Model).unwrap_or(NodeKind::Code);
        return Some(NodeKindDenial {
            rule: own.rule_id(Capability::Model),
            reason: format!(
                "{} is a {kind} node and may not call a model",
                printable(node_id)
            ),
            capability: Capability::Model,
        });
    }
    if parent_id.is_empty() {
        return None;
    }
    let parent_kind = NodeKind::parse(parent_recorded?)?;
    if !kind_limits(parent_kind).spawn {
        return None;
    }
    Some(NodeKindDenial {
        rule: format!("node_kind.{parent_kind}"),
        reason: format!(
            "{} is a {parent_kind} node and may not spawn",
            printable(parent_id)
        ),
        capability: Capability::Spawn,
    })
}

/// Whether a tool call in a response must be withheld for this node's kind.
///
/// Spawn tools by [`SPAWN_TOOLS`]; file changes and shell commands by the same
/// classification the change manifest uses (`changeTargets` and
/// `SHELL_TOOLS`), so a `str_replace_editor` `view` is a read and is not
/// withheld from a gate.
pub fn withheld_tool(
    own: &EffectiveNodeKind,
    name: &str,
    input: &serde_json::Value,
) -> Option<NodeKindDenial> {
    let cap = tool_capability(name, input, own.limits)?;
    if !own.limits.refuses(cap) {
        return None;
    }
    let kind = own.responsible(cap)?;
    let what = match cap {
        Capability::Spawn => "start a child agent",
        Capability::Write => "change files",
        Capability::Shell => "run shell commands",
        Capability::Model => "call a model",
    };
    Some(NodeKindDenial {
        rule: format!("node_kind.{kind}"),
        reason: format!(
            "This is a {kind} node and may not {what}, so {} was withheld",
            printable(name)
        ),
        capability: cap,
    })
}

/// The refusable capability a tool call exercises, if any. Skips the manifest
/// work when nothing it could find is refused.
fn tool_capability(
    name: &str,
    input: &serde_json::Value,
    limits: NodeLimits,
) -> Option<Capability> {
    if is_spawn_tool(name) {
        return Some(Capability::Spawn);
    }
    if !limits.write && !limits.shell {
        return None;
    }
    use crate::manifest::{manifest_from_invocations, ChangeOp, InvocationSource, ToolInvocation};
    let call = ToolInvocation {
        name: name.to_string(),
        input: input.clone(),
        source: InvocationSource::Call,
        call_id: None,
        is_error: None,
    };
    let entries = manifest_from_invocations(std::slice::from_ref(&call));
    let op = entries.first()?.op;
    if op.is_mutation() {
        Some(Capability::Write)
    } else if op == ChangeOp::Execute {
        Some(Capability::Shell)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::anomaly::detectors::test_support::base_ctx;
    use crate::plugins::anomaly::{DetectorRegistry, Disposition};
    use serde_json::json;

    fn overlap(node: &str, jaccard: f64) -> SiblingOverlap {
        SiblingOverlap {
            node: node.into(),
            jaccard,
            bytes: 20 * 1024,
        }
    }

    // ── context_overlap ──────────────────────────────────────────────

    #[test]
    fn graph_detectors_overlap_below_threshold_is_quiet() {
        assert!(ContextOverlapDetector::evaluate(None, IsolationMode::Enforce).is_none());
        let o = overlap("w2", 0.84);
        assert!(ContextOverlapDetector::evaluate(Some(&o), IsolationMode::Enforce).is_none());
        let nan = overlap("w2", f64::NAN);
        assert!(ContextOverlapDetector::evaluate(Some(&nan), IsolationMode::Advise).is_none());
    }

    #[test]
    fn graph_detectors_overlap_steers_by_default() {
        let o = overlap("w2", 0.85);
        let f = ContextOverlapDetector::evaluate(Some(&o), IsolationMode::default()).unwrap();
        assert_eq!(f.kind, AnomalyKind::TokenWaste);
        assert_eq!(f.disposition, Disposition::Steer);
        assert!(f.reason.contains("`w2`"), "{}", f.reason);
        assert!(f.reason.contains("20 KiB"), "{}", f.reason);
        assert!(f.reason.contains("85%"), "{}", f.reason);
    }

    #[test]
    fn graph_detectors_overlap_reasks_under_enforce() {
        let o = overlap("w2", 1.0);
        let f = ContextOverlapDetector::evaluate(Some(&o), IsolationMode::Enforce).unwrap();
        assert_eq!(f.disposition, Disposition::Reask);
        assert!(f.reason.contains("context_isolation: enforce"));
    }

    #[test]
    fn graph_detectors_overlap_scrubs_the_node_id() {
        let o = overlap("w2\n\u{1b}[31m`x", 0.9);
        let f = ContextOverlapDetector::evaluate(Some(&o), IsolationMode::Advise).unwrap();
        assert!(f.reason.contains("`w2[31mx`"), "{}", f.reason);
        assert!(!f.reason.chars().any(char::is_control));
    }

    #[test]
    fn graph_detectors_overlap_reads_the_request_context() {
        let d = ContextOverlapDetector;
        assert_eq!(d.id(), CONTEXT_OVERLAP_ID);
        assert_eq!(d.kind(), AnomalyKind::TokenWaste);
        let mut ctx = base_ctx();
        assert!(d.detect(&ctx).is_none());
        ctx.sibling_overlap = Some(overlap("w2", 0.95));
        assert_eq!(d.detect(&ctx).unwrap().disposition, Disposition::Steer);
        ctx.context_isolation = IsolationMode::Enforce;
        assert_eq!(d.detect(&ctx).unwrap().disposition, Disposition::Reask);
        // Attributed through the registry like every other detector.
        let findings = DetectorRegistry::new(vec![Box::new(d)]).evaluate_all(&ctx);
        assert_eq!(findings[0].detector_id, CONTEXT_OVERLAP_ID);
    }

    #[test]
    fn graph_detectors_two_siblings_with_the_same_brief_steer() {
        use crate::context_sig::{
            best_sibling, context_signature, encode_field, CtxSigMemoryStore,
        };
        // The same ~20 KiB brief, each worker behind its own system prompt and
        // tool schema, which must not be what makes them match.
        let brief: String = (0..2600).map(|i| format!("spec{i} ")).collect();
        let body = |sys: &str| {
            json!({
                "system": sys,
                "tools": [{"name": "Read", "description": sys}],
                "messages": [{"role": "user", "content": brief.clone()}]
            })
        };
        let mut store = CtxSigMemoryStore::new();
        let key = "graph:ws:g1:ctxsig";

        // Worker 1 arrives first: nothing to compare, its signature is stored.
        let s1 = context_signature(&body("you are worker one")).unwrap();
        assert!(store.get_all(key, 0).is_empty());
        assert!(store.set_if_absent(key, "w1", encode_field(&s1, "lead"), 0));

        // Worker 2: compared against worker 1.
        let s2 = context_signature(&body("you are worker two")).unwrap();
        let fields = store.get_all(key, 1);
        let iter = fields.iter().map(|(k, v)| (k.as_str(), v.as_str()));
        let o = best_sibling("w2", "lead", &s2, iter).expect("a sibling");
        assert_eq!(o.node, "w1");
        let f = ContextOverlapDetector::evaluate(Some(&o), IsolationMode::Advise).unwrap();
        assert_eq!(f.disposition, Disposition::Steer);
        let f = ContextOverlapDetector::evaluate(Some(&o), IsolationMode::Enforce).unwrap();
        assert_eq!(f.disposition, Disposition::Reask);
    }

    #[test]
    fn graph_detectors_isolation_mode_parses_and_unknown_enforces() {
        assert_eq!(
            IsolationMode::parse("advise"),
            (IsolationMode::Advise, None)
        );
        assert_eq!(
            IsolationMode::parse(" 'Enforce' "),
            (IsolationMode::Enforce, None)
        );
        let (mode, err) = IsolationMode::parse("advice");
        assert_eq!(mode, IsolationMode::Enforce);
        assert!(err.unwrap().contains("advice"));
        // Strongest wins across SOPs.
        assert_eq!(
            [IsolationMode::Advise, IsolationMode::Enforce]
                .into_iter()
                .max(),
            Some(IsolationMode::Enforce)
        );
    }

    // ── node kinds ───────────────────────────────────────────────────

    #[test]
    fn graph_detectors_node_kind_limits_cover_every_kind_once() {
        for kind in NodeKind::ALL {
            assert_eq!(
                NODE_KIND_LIMITS.iter().filter(|(k, _)| *k == kind).count(),
                1,
                "{kind}"
            );
        }
        assert!(kind_limits(NodeKind::Code).model);
        assert!(!kind_limits(NodeKind::Worker).model && kind_limits(NodeKind::Worker).spawn);
        let gate = kind_limits(NodeKind::Gate);
        assert!(gate.write && gate.shell && gate.spawn && !gate.model);
        assert!(kind_limits(NodeKind::Splitter).is_none());
    }

    #[test]
    fn graph_detectors_spawn_tools_match_exactly_ignoring_case() {
        for t in ["Task", "agent", "SPAWN_AGENT", "subagent", "dispatch_agent"] {
            assert!(is_spawn_tool(t), "{t}");
        }
        for t in ["create_task", "task_list", "agents", "mcp__x__task", ""] {
            assert!(!is_spawn_tool(t), "{t}");
        }
    }

    #[test]
    fn graph_detectors_no_kind_means_no_limits() {
        let eff = effective_node_kind(&[], None, &[]);
        assert!(eff.kinds.is_empty());
        assert!(eff.limits.is_none());
        assert!(request_denial(&eff, "n1", "lead", None).is_none());
        assert!(withheld_tool(&eff, "Task", &json!({})).is_none());
        assert!(withheld_tool(&eff, "Bash", &json!({"command": "ls"})).is_none());
        assert_eq!(eff.recorded_kind(), None);
    }

    #[test]
    fn graph_detectors_effective_kind_is_the_union() {
        let eff = effective_node_kind(&[NodeKind::Worker], Some(NodeKind::Gate), &[]);
        assert_eq!(eff.kinds, vec![NodeKind::Gate, NodeKind::Worker]);
        assert!(eff.limits.write && eff.limits.shell && eff.limits.spawn);
        assert!(!eff.sop_conflict, "the header is not an SOP conflict");
        // Rule names the most restrictive kind that refuses the capability.
        assert_eq!(eff.rule_id(Capability::Spawn), "node_kind.gate");
        assert_eq!(eff.rule_id(Capability::Write), "node_kind.gate");
    }

    #[test]
    fn graph_detectors_header_only_adds_limits() {
        // A splitter header cannot loosen an SOP's worker.
        let eff = effective_node_kind(&[NodeKind::Worker], Some(NodeKind::Splitter), &[]);
        assert!(eff.limits.spawn);
        // A worker header tightens a node with no SOP kind.
        let eff = effective_node_kind(&[], Some(NodeKind::Worker), &[]);
        assert!(eff.limits.spawn);
    }

    #[test]
    fn graph_detectors_sop_conflict_is_flagged() {
        let eff = effective_node_kind(
            &[NodeKind::Worker, NodeKind::Splitter, NodeKind::Worker],
            None,
            &[],
        );
        assert!(eff.sop_conflict);
        assert_eq!(eff.kinds, vec![NodeKind::Worker, NodeKind::Splitter]);
        assert!(eff.limits.spawn);
        assert!(
            !effective_node_kind(&[NodeKind::Worker, NodeKind::Worker], None, &[]).sop_conflict
        );
    }

    #[test]
    fn graph_detectors_allow_removes_limits() {
        let eff = effective_node_kind(
            &[NodeKind::Gate],
            None,
            &[Capability::Shell, Capability::Spawn],
        );
        assert!(eff.limits.write);
        assert!(!eff.limits.shell && !eff.limits.spawn);
        assert!(withheld_tool(&eff, "Bash", &json!({"command": "ls"})).is_none());
        assert!(withheld_tool(&eff, "Task", &json!({})).is_none());
        assert!(withheld_tool(&eff, "Write", &json!({"file_path": "a.rs"})).is_some());
        // Allowing spawn means nothing is recorded, so children are not refused.
        assert_eq!(eff.recorded_kind(), None);
    }

    #[test]
    fn graph_detectors_code_node_is_refused_on_its_first_request() {
        let eff = effective_node_kind(&[NodeKind::Code], None, &[]);
        let d = request_denial(&eff, "fmt-1", "", None).expect("refused");
        assert_eq!(d.rule, "node_kind.code");
        assert_eq!(d.capability, Capability::Model);
        assert_eq!(d.reason, "`fmt-1` is a code node and may not call a model");
        // node_kind_allow: model lifts it.
        let eff = effective_node_kind(&[NodeKind::Code], None, &[Capability::Model]);
        assert!(request_denial(&eff, "fmt-1", "", None).is_none());
    }

    #[test]
    fn graph_detectors_worker_task_call_is_withheld() {
        let eff = effective_node_kind(&[NodeKind::Worker], None, &[]);
        let d = withheld_tool(&eff, "Task", &json!({"prompt": "go"})).expect("withheld");
        assert_eq!(d.rule, "node_kind.worker");
        assert_eq!(d.capability, Capability::Spawn);
        assert!(d.reason.contains("`Task`"), "{}", d.reason);
        // A worker may still write and run commands.
        assert!(withheld_tool(&eff, "Write", &json!({"file_path": "a.rs"})).is_none());
        assert!(withheld_tool(&eff, "Bash", &json!({"command": "ls"})).is_none());
    }

    #[test]
    fn graph_detectors_gate_node_may_read_but_not_change() {
        let eff = effective_node_kind(&[NodeKind::Gate], None, &[]);
        for (tool, input, cap) in [
            ("Write", json!({"file_path": "a.rs"}), Capability::Write),
            ("Edit", json!({"file_path": "a.rs"}), Capability::Write),
            (
                "mcp__fs__delete_file",
                json!({"path": "a.rs"}),
                Capability::Write,
            ),
            ("Bash", json!({"command": "cargo test"}), Capability::Shell),
            ("execute_command", json!({}), Capability::Shell),
            (
                "str_replace_editor",
                json!({"command": "str_replace", "path": "a.rs"}),
                Capability::Write,
            ),
            ("dispatch_agent", json!({}), Capability::Spawn),
        ] {
            let d =
                withheld_tool(&eff, tool, &input).unwrap_or_else(|| panic!("{tool} not withheld"));
            assert_eq!(d.capability, cap, "{tool}");
            assert_eq!(d.rule, "node_kind.gate", "{tool}");
        }
        for (tool, input) in [
            ("Read", json!({"file_path": "a.rs"})),
            ("Grep", json!({"pattern": "x"})),
            (
                "str_replace_editor",
                json!({"command": "view", "path": "a.rs"}),
            ),
            ("WebFetch", json!({"url": "https://example.com"})),
        ] {
            assert!(
                withheld_tool(&eff, tool, &input).is_none(),
                "{tool} withheld"
            );
        }
    }

    #[test]
    fn graph_detectors_child_of_worker_or_gate_is_refused() {
        let child = effective_node_kind(&[], None, &[]);
        for parent in ["worker", "gate"] {
            let d = request_denial(&child, "c1", "w1", Some(parent)).expect("refused");
            assert_eq!(d.rule, format!("node_kind.{parent}"));
            assert_eq!(d.capability, Capability::Spawn);
            assert_eq!(
                d.reason,
                format!("`w1` is a {parent} node and may not spawn")
            );
        }
        for parent in [None, Some("splitter"), Some("code"), Some("garbage")] {
            assert!(
                request_denial(&child, "c1", "w1", parent).is_none(),
                "{parent:?}"
            );
        }
        // A root has no parent to look up.
        assert!(request_denial(&child, "c1", "", Some("worker")).is_none());
    }

    #[test]
    fn graph_detectors_recorded_kind_is_the_one_that_refuses_spawning() {
        assert_eq!(
            effective_node_kind(&[NodeKind::Worker], None, &[]).recorded_kind(),
            Some(NodeKind::Worker)
        );
        assert_eq!(
            effective_node_kind(&[NodeKind::Worker], Some(NodeKind::Gate), &[]).recorded_kind(),
            Some(NodeKind::Gate)
        );
        assert_eq!(
            effective_node_kind(&[NodeKind::Splitter], None, &[]).recorded_kind(),
            None
        );
        assert_eq!(
            effective_node_kind(&[NodeKind::Code], None, &[]).recorded_kind(),
            None
        );
        // Round trip: what a parent records refuses its child.
        let parent = effective_node_kind(&[], Some(NodeKind::Worker), &[]);
        let recorded = parent.recorded_kind().unwrap().as_str();
        let child = effective_node_kind(&[], None, &[]);
        assert!(request_denial(&child, "c1", "p1", Some(recorded)).is_some());
    }
}
