//! Telling the rest of the graph what this node just tripped over.
//!
//! A verdict stops one request. In a multi-agent graph that is often not
//! enough: the sibling about to deploy does not know the tester already
//! failed, and will happily repeat the work that was just refused. Broadcast
//! closes that, by queueing a finding into the notification queues the
//! postprocessor already drains and injects into agent context.
//!
//! # What may be broadcast
//!
//! **Deterministic facts only** — a category, a verdict, a threshold that was
//! crossed. Never model judgement.
//!
//! This is not a stylistic preference. Feeding one agent's opinion into every
//! sibling's context is precisely the failure the graph-engineering critique
//! identifies: agents checking agents produce confident nonsense at scale,
//! because a false positive becomes every downstream node's premise and
//! compounds at each hop. A detector finding is safe to propagate because it
//! is reproducible from the request — anyone can check it. An inference is
//! not.

use super::AnomalyFinding;
use crate::store::{LocalStore, NotifyScope};
use crate::wasm::context::RequestContext;
use std::sync::Arc;

/// How long a node stays in its graph's membership set without calling again.
pub const NODE_TTL_SECS: u64 = 900;

/// Most findings broadcast from a single request.
///
/// All detectors run on every request, so a badly-behaved graph can trip
/// several at once. Siblings need the headline, not the full list — and an
/// unbounded fan-out multiplies by the number of siblings.
const MAX_BROADCAST_PER_REQUEST: usize = 2;

/// Build the notification payload for one finding.
///
/// Shaped as `GovernanceNotification` because the postprocessor already parses
/// that and renders it into the governance block. Reusing it means broadcast
/// needs no new delivery path, and a sibling sees graph findings in exactly
/// the same place as control-plane ones.
fn payload(ctx: &RequestContext, finding: &AnomalyFinding, timestamp: &str) -> Option<String> {
    let origin = if ctx.node.agent_role.is_empty() {
        ctx.node.node_id.clone()
    } else {
        format!("{} ({})", ctx.node.node_id, ctx.node.agent_role)
    };

    serde_json::to_string(&serde_json::json!({
        // Deterministic id: same graph, same node, same category within one
        // second collapses to one notification rather than N copies of the
        // same fact.
        "notification_id": format!(
            "graph-{}-{}-{}", ctx.node.graph_id, ctx.node.node_id, finding.kind.as_str()
        ),
        "session_id": ctx.session_id,
        "workspace_id": ctx.workspace_id,
        "priority": finding.kind.severity().as_str(),
        "category": finding.kind.as_str(),
        "title": format!("Graph guardrail: {}", finding.kind.as_str()),
        // The originating node is named so a sibling can tell "someone else
        // hit this" from "I hit this", which changes what it should do next.
        "body": format!("Node {origin} was stopped: {}", finding.reason),
        "action_url": serde_json::Value::Null,
        "created_at": timestamp,
    }))
    .ok()
}

/// Queue findings to every sibling in this request's graph.
///
/// Fire-and-forget by design. The enforcement decision has already been made
/// and returned to the caller; this is advisory, and a failure to deliver must
/// never turn into a failure to serve.
///
/// Does nothing when the store cannot track graph membership — standalone
/// without Valkey — rather than pretending a single-process view is the graph.
pub async fn broadcast_findings(
    store: &Arc<dyn LocalStore>,
    ctx: &RequestContext,
    findings: &[AnomalyFinding],
    timestamp: &str,
) {
    if findings.is_empty() {
        return;
    }

    // A graph of one is just a session, and telling a node about its own
    // finding is noise — it already received the verdict. Membership is
    // written on every request by the caller; this only reads it.
    let members = store.graph_members(&ctx.workspace_id, &ctx.node.graph_id).await;
    if members.len() < 2 {
        return;
    }

    // Fan out here rather than in the store, because only this layer knows
    // which node produced the finding. The originator is skipped: it already
    // received the verdict on its own request, and telling it again is noise
    // that would also make the finding look corroborated by a second source.
    let siblings: Vec<&String> = members.iter().filter(|m| **m != ctx.node.node_id).collect();

    for finding in findings.iter().take(MAX_BROADCAST_PER_REQUEST) {
        // Loop-suppression and rate ceiling. Checked once per finding, before
        // the fan-out, so a suppressed finding costs one round trip rather
        // than one per sibling.
        //
        // Without this the same fact ricochets: a finding lands in a sibling's
        // context, becomes part of that sibling's next request, and each hop
        // makes one observation look independently corroborated. That is the
        // amplification this whole feature has to avoid being an instance of.
        if !store.claim_broadcast(&ctx.workspace_id, &ctx.node.graph_id, finding.kind.as_str()).await {
            continue;
        }
        let Some(body) = payload(ctx, finding, timestamp) else {
            continue;
        };
        for sibling in &siblings {
            store
                .publish_notification(
                    NotifyScope::Graph,
                    &format!("{}:{}:{}", ctx.workspace_id, ctx.node.graph_id, sibling),
                    &body,
                )
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::anomaly::detectors::test_support::base_ctx;
    use crate::plugins::anomaly::{AnomalyFinding, AnomalyKind};

    fn ctx_in_graph() -> RequestContext {
        let mut c = base_ctx();
        c.node.graph_id = "graph-1".into();
        c.node.node_id = "node-a".into();
        c.node.agent_role = "planner".into();
        c
    }

    #[test]
    fn payload_matches_the_governance_notification_shape() {
        let f = AnomalyFinding::kill(AnomalyKind::LoopDetected, "spinning on Bash");
        let raw = payload(&ctx_in_graph(), &f, "2026-07-27T00:00:00Z").unwrap();

        // Must deserialise as the type the postprocessor already parses,
        // otherwise the notification is silently dropped at the far end.
        let parsed: crate::postprocessor::notification_client::GovernanceNotification =
            serde_json::from_str(&raw).unwrap();

        assert_eq!(parsed.category, "LOOP_DETECTED");
        assert_eq!(parsed.priority, "HIGH");
        assert!(parsed.body.contains("node-a"));
        assert!(parsed.body.contains("planner"), "role gives siblings context");
        assert!(parsed.body.contains("spinning on Bash"));
    }

    #[test]
    fn notification_id_is_stable_for_the_same_fact() {
        let f = AnomalyFinding::kill(AnomalyKind::LoopDetected, "spinning");
        let a = payload(&ctx_in_graph(), &f, "2026-07-27T00:00:00Z").unwrap();
        let b = payload(&ctx_in_graph(), &f, "2026-07-27T00:00:05Z").unwrap();

        let id = |s: &str| {
            serde_json::from_str::<serde_json::Value>(s).unwrap()["notification_id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(id(&a), id(&b), "same fact must not multiply");
    }

    #[test]
    fn payload_omits_role_when_unset() {
        let mut c = ctx_in_graph();
        c.node.agent_role = String::new();
        let f = AnomalyFinding::kill(AnomalyKind::BudgetBreach, "no headroom");
        let raw = payload(&c, &f, "2026-07-27T00:00:00Z").unwrap();
        assert!(raw.contains("Node node-a was stopped"));
        assert!(!raw.contains("()"), "no empty parenthetical");
    }

    #[tokio::test]
    async fn solo_graph_broadcasts_nothing() {
        // MemoryStore reports no membership, which must read as "no graph"
        // rather than "broadcast to myself".
        let store: Arc<dyn LocalStore> = Arc::new(crate::store::memory::MemoryStore::new());
        let f = vec![AnomalyFinding::kill(AnomalyKind::LoopDetected, "x")];
        broadcast_findings(&store, &ctx_in_graph(), &f, "2026-07-27T00:00:00Z").await;
        // Nothing to assert beyond "did not panic and did not publish" —
        // MemoryStore has no queue to inspect, which is the point.
    }

    #[tokio::test]
    async fn empty_findings_short_circuit() {
        let store: Arc<dyn LocalStore> = Arc::new(crate::store::memory::MemoryStore::new());
        broadcast_findings(&store, &ctx_in_graph(), &[], "2026-07-27T00:00:00Z").await;
    }
}

#[cfg(test)]
mod suppression_tests {
    use super::*;

    /// Standalone must not broadcast at all, and the claim is what says so.
    ///
    /// The real suppression semantics — one broadcast per category per window,
    /// and a ceiling across categories — live in the Valkey impl and are
    /// exercised against a running server rather than mocked, because what
    /// matters there is the atomicity of SET NX EX and INCR, which a fake
    /// store would assert nothing about.
    #[tokio::test]
    async fn standalone_never_claims_a_broadcast() {
        let store = crate::store::memory::MemoryStore::new();
        assert!(!store.claim_broadcast("ws", "g", "LOOP_DETECTED").await);
    }

    /// The origin is excluded from its own fan-out.
    #[test]
    fn siblings_exclude_the_originating_node() {
        let members = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let siblings: Vec<&String> = members.iter().filter(|m| **m != "a").collect();
        assert_eq!(siblings, vec!["b", "c"]);
    }
}
