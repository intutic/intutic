//! Node kinds: what a node in an agent graph is *for*.
//!
//! A graph is easier to govern when each node says which job it does. Four
//! kinds cover the shapes worth limiting:
//!
//! | Kind | Job |
//! |---|---|
//! | `splitter` | breaks a task up and hands out the pieces |
//! | `worker` | does one piece; must not fan out further |
//! | `code` | deterministic code with no business calling a model |
//! | `gate` | checks work; must not change anything or fan out |
//!
//! This module only *names* kinds and parses their carriers. What each kind may
//! not do, and the decisions built on that, live in
//! `plugins::anomaly::graph_detectors` (`NODE_KIND_LIMITS`), so the policy table
//! sits beside the other graph checks.
//!
//! # Carriers
//!
//! A kind arrives three ways: the `node_kind:` SOP key (scoped by `roles:`), the
//! `x-intutic-node-kind` header, or the `intutic.node.kind` baggage entry (read
//! by `graph::declared_node_kind`, then [`NodeKind::parse`]). Headers are
//! client-supplied and never authority, so a header kind can only *add* limits
//! to a node; it can never remove one an SOP declared.
//!
//! # Unknown values
//!
//! In an SOP an unknown kind or capability is dropped and reported as a rule
//! error, matching the "entry dropped + rule error" row of the LLD's key table.
//! Dropping is the failure direction available here: there is no "strictest
//! kind" to fall back to that would not also refuse things the operator never
//! asked to refuse.

use std::fmt;

/// Store-key suffix for the per-graph record of each node's kind, which a
/// child's request reads to learn whether its parent may spawn.
///
/// A suffix rather than a full key: the store builds graph keys with the
/// workspace segment first (`store/valkey.rs` `graph_key`), and a key without
/// it would let two tenants that chose the same graph id read each other's
/// records.
pub const NODE_KIND_KEY_SUFFIX: &str = "kind";

/// How long a node's recorded kind lives in the store.
pub const NODE_KIND_TTL_SECS: u64 = 3600;

/// What a node is for.
///
/// Declared in order of how much each kind refuses, most first. `Ord` follows
/// that order, so a sorted list of kinds names the most restrictive one first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NodeKind {
    /// Refuses every model call.
    Code,
    /// Refuses changes, shell commands and spawning.
    Gate,
    /// Refuses spawning.
    Worker,
    /// Refuses nothing.
    Splitter,
}

impl NodeKind {
    pub const ALL: [NodeKind; 4] = [
        NodeKind::Code,
        NodeKind::Gate,
        NodeKind::Worker,
        NodeKind::Splitter,
    ];

    /// Parse one kind, ignoring case, surrounding whitespace and quotes.
    pub fn parse(value: &str) -> Option<Self> {
        match clean(value).as_str() {
            "splitter" => Some(Self::Splitter),
            "worker" => Some(Self::Worker),
            "code" => Some(Self::Code),
            "gate" => Some(Self::Gate),
            _ => None,
        }
    }

    /// The wire and rule-id form: `node_kind.<as_str>`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Splitter => "splitter",
            Self::Worker => "worker",
            Self::Code => "code",
            Self::Gate => "gate",
        }
    }
}

impl fmt::Display for NodeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A capability a kind may refuse, and the vocabulary of `node_kind_allow:`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Capability {
    /// Calling a model through the gateway at all.
    Model,
    /// File-changing tools: write, edit, delete, move.
    Write,
    /// Shell tools.
    Shell,
    /// Starting a child agent.
    Spawn,
}

impl Capability {
    pub const ALL: [Capability; 4] = [
        Capability::Model,
        Capability::Write,
        Capability::Shell,
        Capability::Spawn,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        match clean(value).as_str() {
            "model" => Some(Self::Model),
            "write" => Some(Self::Write),
            "shell" => Some(Self::Shell),
            "spawn" => Some(Self::Spawn),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Write => "write",
            Self::Shell => "shell",
            Self::Spawn => "spawn",
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which capabilities are refused. `true` means refused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NodeLimits {
    pub model: bool,
    pub write: bool,
    pub shell: bool,
    pub spawn: bool,
}

impl NodeLimits {
    /// No limits: what a node with no declared kind gets.
    pub const NONE: NodeLimits = NodeLimits {
        model: false,
        write: false,
        shell: false,
        spawn: false,
    };

    /// Refused by either side. Limits only ever accumulate this way, which is
    /// what lets a header add a limit but never remove one.
    pub fn union(self, other: NodeLimits) -> NodeLimits {
        NodeLimits {
            model: self.model || other.model,
            write: self.write || other.write,
            shell: self.shell || other.shell,
            spawn: self.spawn || other.spawn,
        }
    }

    /// The same limits with `cap` allowed again (`node_kind_allow:`).
    pub fn without(self, cap: Capability) -> NodeLimits {
        let mut out = self;
        match cap {
            Capability::Model => out.model = false,
            Capability::Write => out.write = false,
            Capability::Shell => out.shell = false,
            Capability::Spawn => out.spawn = false,
        }
        out
    }

    pub fn refuses(self, cap: Capability) -> bool {
        match cap {
            Capability::Model => self.model,
            Capability::Write => self.write,
            Capability::Shell => self.shell,
            Capability::Spawn => self.spawn,
        }
    }

    pub fn is_none(self) -> bool {
        self == NodeLimits::NONE
    }
}

/// Parse a `node_kind:` value: a comma-separated list of kinds.
///
/// Returns the kinds in first-seen order without duplicates, and one rule-error
/// string per unknown entry. Unknown entries are dropped (see the module docs).
pub fn parse_kind_list(value: &str) -> (Vec<NodeKind>, Vec<String>) {
    parse_list(value, NodeKind::parse, |raw| {
        format!("node_kind: unknown kind {raw:?}; expected splitter, worker, code or gate")
    })
}

/// Parse a `node_kind_allow:` value: a comma-separated list of capabilities.
pub fn parse_allow_list(value: &str) -> (Vec<Capability>, Vec<String>) {
    parse_list(value, Capability::parse, |raw| {
        format!(
            "node_kind_allow: unknown capability {raw:?}; expected model, write, shell or spawn"
        )
    })
}

fn parse_list<T: PartialEq>(
    value: &str,
    parse: impl Fn(&str) -> Option<T>,
    error: impl Fn(&str) -> String,
) -> (Vec<T>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for raw in value.split(',') {
        let entry = clean(raw);
        if entry.is_empty() {
            continue;
        }
        match parse(&entry) {
            Some(v) if !out.contains(&v) => out.push(v),
            Some(_) => {}
            None => errors.push(error(&entry)),
        }
    }
    (out, errors)
}

/// Lowercase, trimmed, with the quote and bracket characters SOP list values
/// are written with (`[a, b]`, `"a"`) removed, as `sops.rs` strips them.
fn clean(value: &str) -> String {
    value
        .trim()
        .trim_matches(['"', '\'', '[', ']'])
        .trim()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_kind_parses_every_kind_and_round_trips() {
        for kind in NodeKind::ALL {
            assert_eq!(NodeKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(NodeKind::parse("  Worker "), Some(NodeKind::Worker));
        assert_eq!(NodeKind::parse("\"gate\""), Some(NodeKind::Gate));
        assert_eq!(NodeKind::parse("planner"), None);
        assert_eq!(NodeKind::parse(""), None);
    }

    #[test]
    fn node_kind_orders_most_restrictive_first() {
        let mut kinds = vec![
            NodeKind::Splitter,
            NodeKind::Worker,
            NodeKind::Gate,
            NodeKind::Code,
        ];
        kinds.sort();
        assert_eq!(
            kinds,
            vec![
                NodeKind::Code,
                NodeKind::Gate,
                NodeKind::Worker,
                NodeKind::Splitter
            ]
        );
    }

    #[test]
    fn node_kind_capability_parses_and_round_trips() {
        for cap in Capability::ALL {
            assert_eq!(Capability::parse(cap.as_str()), Some(cap));
        }
        assert_eq!(Capability::parse("SPAWN"), Some(Capability::Spawn));
        assert_eq!(Capability::parse("network"), None);
    }

    #[test]
    fn node_kind_list_drops_unknown_entries_and_reports_them() {
        let (kinds, errors) = parse_kind_list("[worker, Gate, wroker, worker]");
        assert_eq!(kinds, vec![NodeKind::Worker, NodeKind::Gate]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("wroker"), "{errors:?}");
    }

    #[test]
    fn node_kind_allow_list_drops_unknown_entries_and_reports_them() {
        let (caps, errors) = parse_allow_list("spawn, write, , net");
        assert_eq!(caps, vec![Capability::Spawn, Capability::Write]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("net"), "{errors:?}");
    }

    #[test]
    fn node_kind_empty_list_is_empty_without_errors() {
        assert_eq!(parse_kind_list("  "), (vec![], vec![]));
        assert_eq!(parse_allow_list(""), (vec![], vec![]));
    }

    #[test]
    fn node_kind_limits_union_and_without() {
        let a = NodeLimits {
            spawn: true,
            ..NodeLimits::NONE
        };
        let b = NodeLimits {
            write: true,
            shell: true,
            ..NodeLimits::NONE
        };
        let u = a.union(b);
        assert!(u.spawn && u.write && u.shell && !u.model);
        let w = u.without(Capability::Write);
        assert!(!w.refuses(Capability::Write));
        assert!(w.refuses(Capability::Shell) && w.refuses(Capability::Spawn));
        assert!(NodeLimits::NONE.is_none());
        assert!(!u.is_none());
    }
}
