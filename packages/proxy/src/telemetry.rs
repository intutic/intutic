//! Telemetry — the execution-trace record, and Valkey connection setup.
//!
//! Publishing moved to `store::LocalStore::publish_trace` during the storage
//! port. The Valkey impl publishes to `intutic:traces:{workspace_id}`, where
//! the Node control plane's subscriber batch-inserts into PostgreSQL; the
//! standalone impl has no subscriber and logs instead.

use serde::Serialize;
use std::sync::Arc;

/// Connect to Valkey (Redis-compatible)
pub async fn connect_valkey(url: &str) -> anyhow::Result<Arc<redis::aio::ConnectionManager>> {
    let client = redis::Client::open(url)?;
    let manager = redis::aio::ConnectionManager::new(client).await?;
    Ok(Arc::new(manager))
}

/// Execution trace published after each proxied request
#[derive(Debug, Serialize)]
pub struct ExecutionTrace {
    pub trace_id: String,
    pub session_id: String,
    /// The proxy process that emitted this trace — see `proxy::proxy_instance_id`.
    ///
    /// Always present. `session_id` above comes from `x-session-id`, which nothing
    /// sets, so it is "unknown" for effectively all traffic and the control plane's
    /// session grouping degenerated into a permanent workspace+harness bucket. A
    /// proxy process is in practice one developer's working session, so this is the
    /// grouping key that actually separates one run from the next.
    pub proxy_instance_id: String,
    pub workspace_id: String,
    pub virtual_key_id: String,
    pub model: String,
    pub provider: String,
    pub raw_input_tokens: u32,
    pub compressed_input_tokens: u32,
    /// Bytes the SnipCompactor removed from this **response** body.
    ///
    /// Separate from `compressed_input_tokens` on purpose. Compaction runs after
    /// the model replies, so its benefit lands in the next turn's prompt and is
    /// already inside that turn's `raw_input_tokens` — reporting it as an
    /// input-side delta here would double-count. The pair above are written
    /// equal on every trace path, which is why the dashboard's "Context
    /// Redundancy" slice was structurally always zero; this is the field that
    /// actually carries a measured saving.
    #[serde(default)]
    pub tool_result_bytes_saved: u64,
    /// What each shadowed WASM rule would have done on this request.
    ///
    /// Empty on nearly every trace, which is why it is `skip_serializing_if`:
    /// a workspace with no shadowed rule should not pay for the field on every
    /// request. Promotion out of shadow is gated on a counted false-positive
    /// rate, and this is the only place that count can come from — a log line
    /// is not a denominator.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wasm_shadow_reports: Vec<crate::wasm::registry::ShadowReport>,
    /// What each shadow-mode SOP (`mode: shadow` in front matter) would have
    /// done on this request — the SOP-declaration analogue of
    /// `wasm_shadow_reports` above, one entry per applicable shadow SOP rather
    /// than per rule. Empty on nearly every trace, for the same reason.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sop_shadow_reports: Vec<crate::sops::SopShadowReport>,
    /// Response Integrity Score, 0–100. 100 is clean.
    ///
    /// The router's only quality signal. Before it, `upstream_ok` plus latency
    /// plus a token *metering* discrepancy was the whole view — so a cheap model
    /// returning a confidently wrong answer, quickly, scored a perfect reward,
    /// and the session lock made that sample persist for the session's life.
    ///
    /// It detects malformed, truncated and unusable responses. It does NOT
    /// detect wrong-but-well-formed ones, which is most of the real harm from
    /// downgrading — no copy may claim routing preserves quality.
    ///
    /// No serde default here: `ExecutionTrace` is serialise-only, so one would
    /// be decoration. The "absent means not measured, which reads as clean"
    /// rule belongs on the consumer, and defaulting it to 0 there would make
    /// every historical trace look like a total failure and drag every arm's
    /// reward to the floor.
    /// What the router WOULD have selected, when routing is in shadow mode.
    ///
    /// `None` in every other mode, and when shadow picked the requested model
    /// anyway. Recorded rather than only logged: shadow's whole output is reach
    /// and counterfactual cost, and neither is computable from a log line.
    ///
    /// Carries the real model name, not a sentinel — the same reasoning
    /// `FindingWire.shadowed` documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_shadow_model: Option<String>,
    /// The Response Integrity Score, or `None` when nothing was measured.
    ///
    /// Optional rather than defaulting to 100, because "checked and clean" and
    /// "never checked" are different claims and the reward cron distinguishes
    /// them: it counts measured traces and skips an arm it never scored. While
    /// this was `u8` the error and early-return paths wrote a hardcoded
    /// `RIS_MAX`, the column was `NOT NULL DEFAULT 100`, and `COUNT(...)` could
    /// therefore never be less than the row count — so the skip could not fire
    /// and every arm was credited with perfection nobody observed.
    ///
    /// `skip_serializing_if`, like `routing_shadow_model` and `quality_fault`
    /// above and below it. Without it serde emits `"response_integrity": null`,
    /// and the sync-back route's zod schema had this field as `.optional()` —
    /// which accepts `undefined` and **rejects `null`**. A rejected trace is
    /// skipped with a warning and the route still answers 200, so every
    /// unmeasured trace would have been dropped at ingest while the sync
    /// reported success. `loop_run_id` below emits null deliberately and its
    /// schema says `.nullish()`; this one did not follow that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_integrity: Option<u8>,
    /// The first failing check, named. A bare score is not auditable: an
    /// operator seeing 40 cannot tell a truncation from a bad tool call, and the
    /// two have opposite remedies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_fault: Option<String>,
    /// Why the upstream provider call itself did not produce a usable
    /// response — distinct from `quality_fault`, which grades a response
    /// that WAS received.
    ///
    /// `None` on every trace where the request never failed at the transport
    /// or provider-error level, which is the overwhelming majority. Before
    /// this field existed, a 5xx from the provider wrote `verdict: "allowed"`
    /// — indistinguishable from a cheap, legitimately-bypassed request in
    /// every downstream analytic — and a transport-level failure (the
    /// provider unreachable, or the connection dying mid-response) wrote no
    /// trace at all, so it was invisible rather than merely mislabeled. The
    /// in-memory `RewardSignals.upstream_ok` already knew both of these; it
    /// fed the bandit and then the request's own knowledge of its failure
    /// died with it. This field is that knowledge, made durable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_error: Option<UpstreamError>,
    pub output_tokens: u32,
    pub raw_cost_usd: f64,
    pub actual_cost_usd: f64,
    /// The proxy's OWN semantic/exact-match response cache — whether this
    /// request's response was served from that cache instead of calling the
    /// model. Unrelated to the two fields below: this describes whether a
    /// model call happened at all, they describe the PROVIDER's prompt cache
    /// on a model call that did.
    pub cache_hit: bool,
    /// Input tokens the provider itself read from ITS OWN prompt cache
    /// (TD-347) — Anthropic's `usage.cache_read_input_tokens`, OpenAI's
    /// `prompt_tokens_details.cached_tokens`, or Gemini's
    /// `cachedContentTokenCount`, whichever the routed model's provider
    /// reported.
    ///
    /// Explicitly distinct from `cache_hit`/`cache_savings_usd` above: those
    /// describe the proxy's own semantic response cache (a full response
    /// served with no model call at all), a completely different feature.
    /// This field is meaningful only when a model call DID happen — it is the
    /// provider crediting part of that call's input as a cheaper cache read
    /// rather than a full-price input token.
    ///
    /// `None` when the provider did not report this bucket at all (most
    /// providers, most requests) — distinct from `Some(0)`, which means the
    /// provider reported caching support and this call simply had no cache
    /// hit. `skip_serializing_if` is mandatory, not stylistic, same reasoning
    /// as `response_integrity` above: the control-plane's ingest zod schema
    /// uses `.optional()`, which accepts an absent key but REJECTS an
    /// explicit `null`. Emitting `null` here would silently drop the trace at
    /// ingest — the route still answers HTTP 200 — with no error surfaced
    /// anywhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
    /// Input tokens the provider itself wrote into ITS OWN prompt cache
    /// (TD-347) — Anthropic's `usage.cache_creation_input_tokens`. No other
    /// provider parsed by this proxy reports a cache-write bucket today, so
    /// this is `None` for OpenAI/Gemini traces even when `cache_read_input_tokens`
    /// is populated. Same `cache_hit` distinction and same mandatory
    /// `skip_serializing_if` reasoning as `cache_read_input_tokens` above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    pub latency_ms: u32,
    pub verdict: String,
    pub harness_type: String,
    pub created_at: String,
    pub requested_model: String,
    pub actual_model_routed: String,
    pub task_type: String,
    /// Tool calls newly observed on THIS request — the per-turn delta, not the
    /// cumulative history the request body carries. Empty for requests with no
    /// tool activity, and skipped on the wire so the trace shape is unchanged
    /// for them. Mirrors the OTel GenAI model: the inference span carries its
    /// own 0..N tool_call parts; it never re-lists the conversation's history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    /// Carries the synthesised `action:` vocabulary alongside the raw names, so one
    /// tool call can contribute more than one entry and `len()` is not a tool-call
    /// count. That is deliberate: it is the same expansion the anomaly detectors
    /// score, so a baseline fitted from stored traces applies to the live sequence.
    pub tools: Vec<String>,
    /// What this request touched — the files, URLs and commands its tool calls
    /// named, derived from argument keys the manifest recognises.
    ///
    /// Distinct from `tools` above, which is *behaviour* (which tool, in what
    /// order). This is *effect*. A reviewer asking "what changed" cannot answer
    /// it from a list of tool names.
    ///
    /// Empty is skipped on the wire, and the Node side turns that back into a
    /// SQL NULL, preserving the "no tool activity" vs "nothing recognisable"
    /// distinction the column comment describes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub change_manifest: Vec<crate::manifest::ChangeEntry>,
    pub reconstruction_quality: u8,
    pub token_anomaly: bool,
    pub loop_run_id: Option<String>,

    /// Every detector finding raised on this request, attributed.
    ///
    /// Distinct from `graph.anomalies`, which is a `Vec<String>` of taxonomy
    /// kinds and cannot answer *which detector* fired — sixteen of twenty-two
    /// detectors share a kind with a sibling. That column is kept as-is because
    /// the control plane already reads it and the wire shape must not move.
    ///
    /// **Carried on the allowed path as well as the blocked one**, which is the
    /// whole point. A blocked request is one the system already judged; the
    /// findings that need their false-positive rate measured are the advisory
    /// and reask ones on requests that *proceeded*. Recording only blocked
    /// findings would build a corpus of exactly the detectors `anomaly/mod.rs`
    /// says have no FPR to measure, and none of the ones it says do.
    ///
    /// Empty is skipped, so a clean request's wire shape is unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<FindingWire>,

    /// Injection-pattern echoes in the MODEL'S OWN OUTPUT — advisory only.
    ///
    /// Each entry (`injection::ResponseInjectionEcho`) is a firing pattern
    /// name from `injection::scan_response_body`/`injection::scan` PLUS a
    /// bounded, DLP-scrubbed window of surrounding text
    /// (`injection::extract_scrubbed_snippet`) — narrower than "the matched
    /// text broadly": not the matched phrase alone, not the response, never
    /// before DLP-scrubbing. This is a deliberate, narrow exception to this
    /// codebase's otherwise-universal never-quote-matched-content discipline
    /// (see TD-344), made only so an operator can adjudicate a
    /// `response_injection:*` finding as TRUE_POSITIVE/FALSE_POSITIVE without
    /// reopening the no-full-response-text-stored discipline this codebase
    /// otherwise holds everywhere: there is still no full response body
    /// anywhere on this struct, and still nothing beyond the configured
    /// window around an already-fired match.
    ///
    /// This never influences a disposition and never will without an output
    /// corpus first: model output legitimately quotes injection phrasing, so
    /// the FP rate is structurally unmeasured (NotInject gates prompts, not
    /// outputs — the scan's own doc comment carries the full argument).
    /// Present on the success paths where a response body exists
    /// (non-streaming and streamed); empty on blocked/error paths (no
    /// response) and on cache hits (the cached body was scanned on the turn
    /// that produced it).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub response_injection_findings: Vec<crate::injection::ResponseInjectionEcho>,

    /// A sampled copy of this request's full `RequestContext`, for the
    /// replay corpus.
    ///
    /// `None` on the overwhelming majority of traces — see
    /// `AppState::context_snapshot_rate` (`WASM_CONTEXT_SNAPSHOT_RATE`,
    /// default 5%). A new WASM rule candidate needs `historical_replay`
    /// evidence before it is ever installed, and that evidence has to be
    /// *real* requests, not a synthetic block/allow pair — this is where
    /// that corpus comes from. Sampled, not universal: capturing the full
    /// context on every trace would write a governance-relevant payload
    /// (tool sequences, DLP findings, SOP declarations) onto every single
    /// row in the busiest table in the system for a corpus that only needs
    /// to clear `MIN_REPLAY_CONTEXTS` (50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_snapshot: Option<serde_json::Value>,

    /// Where in the graph this request happened. Flattened onto the wire.
    #[serde(flatten)]
    pub graph: GraphTrace,
}

/// One detector finding, on the wire.
///
/// The fields a consumer needs to route, rank and later adjudicate a finding
/// without re-deriving anything: who raised it (`detector_id`), what it is
/// (`kind`), how bad (`severity`), what it did (`disposition`), how sure
/// (`confidence`) and why (`reason`).
///
/// `detector_id` is the field that makes this worth having. Without it a
/// consumer sees `LOOP_DETECTED` and cannot tell a spin loop from a runaway
/// fan-out, so it can neither attribute a false positive nor score a detector.
#[derive(Debug, Clone, Serialize)]
pub struct FindingWire {
    pub detector_id: String,
    pub kind: String,
    pub severity: String,
    pub disposition: String,
    pub confidence: f64,
    pub reason: String,
    /// True when the workspace was in shadow mode, so this finding was recorded
    /// but **did not take effect**.
    ///
    /// Separate from `disposition`, which stays truthful about what the detector
    /// decided. Encoding shadow into the disposition instead — a `WOULD_HAVE`
    /// value — would have made every consumer's match on `KILL` silently miss
    /// the shadowed kills, and would have destroyed the very thing being
    /// measured: which verdict the detector actually reached.
    #[serde(default)]
    pub shadowed: bool,
}

impl FindingWire {
    pub fn from_finding(f: &crate::plugins::anomaly::AnomalyFinding) -> Self {
        Self {
            detector_id: f.detector_id.to_string(),
            kind: f.kind.as_str().to_string(),
            severity: f.kind.severity().as_str().to_string(),
            disposition: f.disposition.as_str().to_string(),
            confidence: f.confidence,
            reason: f.reason.clone(),
            shadowed: false,
        }
    }

    /// Mark every finding as recorded-but-not-enforced.
    pub fn shadowed(mut self) -> Self {
        self.shadowed = true;
        self
    }
}

/// Why an upstream provider call failed, when it did.
///
/// Carried on `ExecutionTrace.upstream_error`. `provider` is the actual LLM
/// provider the request was routed to (`get_model_provider`/`target_provider`
/// — "anthropic", "openai", …), never the harness name that
/// `ExecutionTrace.provider` carries; a downtime record attributed to
/// "claude-code" or "cursor" would blame the wrong party for an Anthropic or
/// OpenAI outage.
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamError {
    pub provider: String,
    /// The HTTP status the provider returned, when one exists. `None` for a
    /// pure transport failure (connection refused, DNS, timeout, a body or
    /// stream that died mid-read) — there is no status to report because no
    /// complete HTTP response was ever received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub kind: UpstreamErrorKind,
}

/// The shape of an upstream failure.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamErrorKind {
    /// No complete response was ever received: the connection failed, the
    /// request timed out, or the response body / SSE stream died before it
    /// finished. `UpstreamError.status` is `None` for the "never connected"
    /// case, and may be `Some` (the response started successfully) when the
    /// failure was mid-read.
    TransportError,
    /// The provider answered with a 5xx. `status` is always `Some` here.
    Http5xx,
    /// The routed model itself was rejected by the provider as not servable
    /// (unknown, decommissioned, deprecated model id) and no same-provider
    /// retry recovered it. A router/config problem, not a provider outage —
    /// kept distinct from `Http5xx` so the two are not conflated in outage
    /// analytics.
    Unservable,
}

/// The graph coordinates of one traced request.
///
/// A trace already records what a request did. This records *where in the
/// graph* it did it, which is what turns a flat stream of requests into a
/// trajectory: who called whom, how deep, and what each node cost.
///
/// Deliberately an extension of the trace rather than a parallel event
/// stream. A second stream would need its own sink, retention and consumer,
/// and would then have to be joined back to the traces to mean anything.
/// Extending this record means every existing publish path carries it for
/// free — the Valkey channel the control plane subscribes to, and the local
/// JSONL written in standalone.
///
/// Every field is skipped when empty, so the wire shape for single-agent
/// traffic is byte-identical to what it was before graphs existed.
#[derive(Debug, Default, Serialize)]
pub struct GraphTrace {
    /// Graph this node belongs to. Absent for a single-agent session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    /// This node's id within the graph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// This node's declared role.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    /// The node that handed work to this one — the inbound edge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_node_id: Option<String>,
    /// Distance from the graph root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_depth: Option<u32>,
    /// Anomaly categories raised on this request, most severe first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub anomalies: Vec<String>,
}

impl GraphTrace {
    /// Build from a request's node identity.
    ///
    /// Returns the empty form for a graph of one, so a single-agent trace
    /// carries no graph keys at all rather than a set of self-referential
    /// ones that would imply a topology that does not exist.
    pub fn from_node(node: &crate::wasm::context::NodeIdentity, anomalies: Vec<String>) -> Self {
        if node.graph_id.is_empty() || node.graph_id == node.node_id {
            return Self {
                anomalies,
                ..Self::default()
            };
        }
        Self {
            graph_id: Some(node.graph_id.clone()),
            node_id: Some(node.node_id.clone()),
            agent_role: (!node.agent_role.is_empty()).then(|| node.agent_role.clone()),
            parent_node_id: (!node.parent_session_id.is_empty())
                .then(|| node.parent_session_id.clone()),
            graph_depth: Some(node.depth),
            anomalies,
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::wasm::context::NodeIdentity;

    /// Every field at its zero value. Test fixtures overwrite the one or two
    /// fields the test is actually about, matching `base_ctx()`-style
    /// fixtures elsewhere in this crate — `ExecutionTrace` derives no
    /// `Default` of its own, since a wire struct silently growing a
    /// zero-value field for every new column is exactly the failure mode
    /// the eight-trace-site tests above guard against in production code
    /// (five pre-existing sites, plus the three previously-silent failure
    /// sites Phase 8a adds a trace to).
    fn base_trace() -> ExecutionTrace {
        ExecutionTrace {
            trace_id: String::new(),
            session_id: String::new(),
            proxy_instance_id: String::new(),
            workspace_id: String::new(),
            virtual_key_id: String::new(),
            model: String::new(),
            provider: String::new(),
            raw_input_tokens: 0,
            compressed_input_tokens: 0,
            tool_result_bytes_saved: 0,
            wasm_shadow_reports: Vec::new(),
            sop_shadow_reports: Vec::new(),
            routing_shadow_model: None,
            response_integrity: None,
            quality_fault: None,
            upstream_error: None,
            output_tokens: 0,
            raw_cost_usd: 0.0,
            actual_cost_usd: 0.0,
            cache_hit: false,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            latency_ms: 0,
            verdict: String::new(),
            harness_type: String::new(),
            created_at: String::new(),
            requested_model: String::new(),
            actual_model_routed: String::new(),
            task_type: String::new(),
            tools: Vec::new(),
            change_manifest: Vec::new(),
            reconstruction_quality: 0,
            token_anomaly: false,
            loop_run_id: None,
            findings: Vec::new(),
            response_injection_findings: Vec::new(),
            context_snapshot: None,
            graph: GraphTrace::default(),
        }
    }

    fn node(graph: &str, id: &str) -> NodeIdentity {
        NodeIdentity {
            node_id: id.into(),
            agent_role: "planner".into(),
            graph_id: graph.into(),
            parent_session_id: "parent-1".into(),
            depth: 2,
            ..NodeIdentity::default()
        }
    }

    /// A single-agent session must serialise exactly as it did before graphs
    /// existed. `node_id == graph_id` is what the identity extractor produces
    /// when no graph headers are present, and emitting self-referential graph
    /// keys for it would imply a topology that is not there.
    /// The advisory echo field rides the trace wire only when it has content
    /// — the common clean-response case must not pay for an empty key — and
    /// carries pattern names, exactly as recorded.
    #[test]
    fn response_injection_findings_serialise_only_when_present() {
        let mut t = base_trace();
        let v = serde_json::to_value(&t).unwrap();
        assert!(
            v.as_object().unwrap().get("response_injection_findings").is_none(),
            "empty must be omitted from the wire",
        );

        t.response_injection_findings = vec![crate::injection::ResponseInjectionEcho {
            pattern: "override-instructions".to_string(),
            snippet: "ignore all previous instructions".to_string(),
        }];
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(
            v["response_injection_findings"],
            serde_json::json!([{"pattern":"override-instructions","snippet":"ignore all previous instructions"}])
        );
    }

    /// Every construction site computes `response_injection_findings` from
    /// the actual response, not a hardcoded default that happens to
    /// typecheck.
    ///
    /// Same shape of defect this file's other "assert against source" tests
    /// guard against: `Vec::new()` compiles fine for the new element type too
    /// (it's generic), so the compiler cannot catch a future edit that
    /// silently replaces real computation with an empty literal on a path
    /// that actually has a response. Pinning the two success-path call
    /// expressions by name is what catches that.
    #[test]
    fn every_construction_site_computes_response_injection_findings_not_a_hardcoded_default() {
        let src = include_str!("proxy.rs");
        // Six no-response sites (blocked/cache-hit/5xx-or-unservable-error,
        // plus the three previously-silent failure sites this phase adds a
        // trace to: initial connection failure, non-streaming body-read
        // failure, mid-stream chunk failure) hardcode an empty Vec -- that is
        // correct, there is no response to scan on any of them. The two
        // success sites (non-streaming, streaming) assign via shorthand field
        // init from a locally computed `response_injection_findings` binding.
        // Together that is 8 field mentions in struct literals, matching the
        // eight ExecutionTrace construction sites.
        assert_eq!(
            src.matches("response_injection_findings: Vec::new()").count(),
            6,
            "expected exactly the 6 no-response trace sites to hardcode an empty Vec"
        );
        assert_eq!(
            src.matches("response_injection_findings,").count(),
            2,
            "expected exactly the 2 success-path trace sites to assign via shorthand \
             field init from a computed local -- a future edit that inlines a \
             hardcoded Vec::new() here would fail this count"
        );
        assert!(
            src.contains("response_echoes_from_body("),
            "the non-streaming success site must compute real echoes, not a hardcoded default"
        );
        assert!(
            src.contains("response_echoes("),
            "the streaming success site must compute real echoes, not a hardcoded default"
        );
    }

    #[test]
    fn graph_of_one_adds_no_wire_keys() {
        let g = GraphTrace::from_node(&node("ses_1", "ses_1"), vec![]);
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(
            v.as_object().unwrap().len(),
            0,
            "a graph of one must contribute no keys at all"
        );
    }

    /// A single-agent session must still report its anomalies.
    ///
    /// `graph_of_one_adds_no_wire_keys` pins that a lone node emits no *topology*
    /// keys, and the early return that implements it is one obvious refactor away
    /// from dropping the anomaly list along with them. Most sessions are graphs of
    /// one, so that would silently discard the majority of all findings.
    #[test]
    fn a_graph_of_one_still_reports_its_anomalies() {
        let g = GraphTrace::from_node(&node("ses_1", "ses_1"), vec!["SCOPE_VIOLATION".into()]);
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(v["anomalies"][0], "SCOPE_VIOLATION");
    }

    /// Every allowed-path trace must carry the advisory findings, not a literal
    /// empty list.
    ///
    /// Only the blocked trace recorded its anomalies; all four allowed-path sites
    /// hardcoded `vec![]`, so a `steer` finding advised the agent in-band and then
    /// vanished — leaving every advisory detector unmeasurable, and unpromotable
    /// under the rule in `anomaly/mod.rs` that requires an observed false-positive
    /// rate before escalation to `kill`.
    ///
    /// Asserted against the source because the shape of the defect is a literal at
    /// a call site: a behavioural test of one path would pass while another path
    /// silently regressed.
    #[test]
    fn no_allowed_path_trace_hardcodes_an_empty_anomaly_list() {
        let src = include_str!("proxy.rs");
        assert!(
            !src.contains("GraphTrace::from_node(&node_for_trace, vec![])"),
            "an allowed-path trace is discarding its advisory findings"
        );
        assert!(
            src.contains("GraphTrace::from_node(&node_for_trace, advisory_anomalies.clone())"),
            "the allowed-path traces must publish the advisory findings"
        );
    }

    /// Every trace site must carry the change manifest.
    ///
    /// Same shape of defect as the anomalies list above: five construction
    /// sites, and one of them quietly passing an empty value means whole
    /// classes of request publish no record of what they touched — with
    /// nothing to notice, because the other four look fine.
    ///
    /// Asserted against the source because that is where the defect lives. A
    /// behavioural test of one path would pass while another regressed.
    #[test]
    fn no_trace_site_omits_the_change_manifest() {
        let src = include_str!("proxy.rs");
        // Five struct fields, one per trace site. The construction itself is
        // a `let` binding and carries no colon, so it is not counted here.
        assert!(
            src.matches("change_manifest:").count() >= 5,
            "a trace site has lost its change_manifest field"
        );
        assert!(
            !src.contains("change_manifest: Vec::new()")
                && !src.contains("change_manifest: vec![]"),
            "a trace site is discarding what the request touched"
        );
    }

    /// Every trace site must publish the process instance id, and the same one.
    ///
    /// Same shape as the two tests above: five construction sites, and one of
    /// them substituting a fresh uuid or an empty string would publish traces
    /// the control plane cannot group with the rest of the process's own
    /// traffic — which is the entire reason the field exists.
    ///
    /// Asserted against the source because that is where the defect would live.
    /// The struct field is not optional, so the compiler already catches an
    /// omitted site; what it cannot catch is a site filling it in with something
    /// per-request.
    #[test]
    fn no_trace_site_invents_its_own_instance_id() {
        let src = include_str!("proxy.rs");
        assert_eq!(
            src.matches("proxy_instance_id: proxy_instance_id()").count(),
            8,
            "every one of the eight trace sites must publish the process id \
             (the original five, plus the three failure sites this phase adds \
             a trace to: initial connection failure, non-streaming body-read \
             failure, mid-stream chunk failure)"
        );
    }

    /// Every trace site must carry the sampled context snapshot.
    ///
    /// Same shape of defect as `no_trace_site_omits_the_change_manifest` above
    /// — five construction sites, one field, and a missed site is silent: the
    /// struct still compiles because `context_snapshot` has a serde default,
    /// so an omitted field just reads `None` forever on that one path instead
    /// of failing to build. Caught once already while wiring this field in —
    /// this test is what should have caught it instead of a manual re-grep.
    #[test]
    fn no_trace_site_omits_the_context_snapshot() {
        let src = include_str!("proxy.rs");
        assert!(
            src.matches("context_snapshot: context_snapshot_for_trace.clone()").count() >= 5,
            "a trace site has lost its context_snapshot field — the replay \
             corpus silently stops sampling that path"
        );
    }

    /// `context_snapshot` round-trips when present, and is omitted (not
    /// `null`) when absent — same `skip_serializing_if` discipline as
    /// `routing_shadow_model` and `quality_fault` on this struct, so a clean
    /// trace's wire shape does not grow a key on the overwhelming majority of
    /// requests that were never sampled.
    #[test]
    fn context_snapshot_round_trips_and_is_omitted_when_absent() {
        let mut trace = base_trace();
        trace.context_snapshot = Some(serde_json::json!({"session_id": "ses_1"}));
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(v["context_snapshot"]["session_id"], "ses_1");

        trace.context_snapshot = None;
        let v = serde_json::to_value(&trace).unwrap();
        assert!(
            v.as_object().unwrap().get("context_snapshot").is_none(),
            "an unsampled trace must omit the key, not serialise it as null"
        );
    }

    /// Every trace site must carry the shadow-mode SOP reports. Same shape of
    /// defect as `no_trace_site_omits_the_context_snapshot` — five construction
    /// sites, one field, and a missed site is silent: `Vec::is_empty` means the
    /// struct still compiles and that one path just never reports a shadow SOP,
    /// forever, with nothing to notice.
    #[test]
    fn no_trace_site_omits_the_sop_shadow_reports() {
        let src = include_str!("proxy.rs");
        assert!(
            src.matches("sop_shadow_reports: sop_shadow_reports.clone()").count() >= 5,
            "a trace site has lost its sop_shadow_reports field"
        );
    }

    /// `sop_shadow_reports` round-trips when present, and is omitted (not an
    /// empty array) when there was nothing to report — same
    /// `skip_serializing_if` discipline as `wasm_shadow_reports` beside it.
    #[test]
    fn sop_shadow_reports_round_trips_and_is_omitted_when_empty() {
        let mut trace = base_trace();
        trace.sop_shadow_reports = vec![crate::sops::SopShadowReport {
            title: "Never delete prod".into(),
            would_act: true,
            findings: vec!["POLICY_VIOLATION".into()],
        }];
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(v["sop_shadow_reports"][0]["title"], "Never delete prod");
        assert_eq!(v["sop_shadow_reports"][0]["would_act"], true);

        trace.sop_shadow_reports = Vec::new();
        let v = serde_json::to_value(&trace).unwrap();
        assert!(
            v.as_object().unwrap().get("sop_shadow_reports").is_none(),
            "a trace with nothing shadowed must omit the key, not serialise an empty array"
        );
    }

    /// `upstream_error` round-trips when present, and is omitted (not `null`)
    /// when absent — same `skip_serializing_if` discipline as
    /// `routing_shadow_model` and `quality_fault` beside it, so the success
    /// path's wire shape is unchanged by this field's existence.
    #[test]
    fn upstream_error_round_trips_and_is_omitted_when_absent() {
        let mut trace = base_trace();
        let v = serde_json::to_value(&trace).unwrap();
        assert!(
            v.as_object().unwrap().get("upstream_error").is_none(),
            "a successful trace must omit the key, not serialise it as null"
        );

        trace.upstream_error = Some(UpstreamError {
            provider: "anthropic".to_string(),
            status: Some(503),
            kind: UpstreamErrorKind::Http5xx,
        });
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(v["upstream_error"]["provider"], "anthropic");
        assert_eq!(v["upstream_error"]["status"], 503);
        assert_eq!(v["upstream_error"]["kind"], "http5xx");
    }

    /// A pure transport failure (never connected) has no HTTP status to
    /// report, and that absence must itself be omitted, not serialised as
    /// `"status": null` — same discipline the field-level test above holds
    /// for `upstream_error` as a whole.
    #[test]
    fn upstream_error_status_is_omitted_for_a_pure_transport_failure() {
        let mut trace = base_trace();
        trace.upstream_error = Some(UpstreamError {
            provider: "openai".to_string(),
            status: None,
            kind: UpstreamErrorKind::TransportError,
        });
        let v = serde_json::to_value(&trace).unwrap();
        assert!(
            v["upstream_error"].as_object().unwrap().get("status").is_none(),
            "a connection failure has no status; the key must be omitted, not null"
        );
        assert_eq!(v["upstream_error"]["kind"], "transport_error");
    }

    /// Every trace site must carry the upstream-error field, either honestly
    /// populated on a failure path or `None` on a path that never failed at
    /// the transport/provider-error level.
    ///
    /// Same shape of defect this file's other "assert against source" tests
    /// guard against, and the specific documented incident (see this file's
    /// module comment on `base_trace`): a field added to the struct but
    /// missed at one of the streaming/non-streaming call-site pairs compiles
    /// fine (`upstream_error` has a serde default) and fails silently in
    /// production instead of at build time.
    #[test]
    fn every_trace_site_carries_upstream_error() {
        let src = include_str!("proxy.rs");
        assert!(
            src.matches("upstream_error:").count() >= 8,
            "expected upstream_error on all 5 pre-existing trace sites (blocked, \
             cache-hit, non-streaming success, streaming success, and the non-\
             streaming 5xx/unservable error site) plus the 3 previously-silent \
             failure sites this phase adds a trace to (initial connection \
             failure, non-streaming body-read failure, mid-stream chunk \
             failure) — found fewer than 8 mentions"
        );
    }

    #[test]
    fn a_real_graph_records_its_coordinates() {
        let g = GraphTrace::from_node(&node("graph-9", "node-a"), vec!["LOOP_DETECTED".into()]);
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(v["graph_id"], "graph-9");
        assert_eq!(v["node_id"], "node-a");
        assert_eq!(v["agent_role"], "planner");
        assert_eq!(v["parent_node_id"], "parent-1");
        assert_eq!(v["graph_depth"], 2);
        assert_eq!(v["anomalies"][0], "LOOP_DETECTED");
    }

    #[test]
    fn absent_role_and_parent_are_omitted_not_empty() {
        let mut n = node("graph-9", "node-a");
        n.agent_role = String::new();
        n.parent_session_id = String::new();
        let v = serde_json::to_value(GraphTrace::from_node(&n, vec![])).unwrap();
        let obj = v.as_object().unwrap();
        assert!(!obj.contains_key("agent_role"));
        assert!(!obj.contains_key("parent_node_id"));
        assert!(!obj.contains_key("anomalies"), "clean requests carry no list");
        assert!(obj.contains_key("graph_id"));
    }

    /// A clean request in a real graph still records where it happened —
    /// otherwise a trajectory shows only the failures and none of the path
    /// between them.
    #[test]
    fn clean_requests_in_a_graph_are_still_placed() {
        let v = serde_json::to_value(GraphTrace::from_node(&node("g", "n"), vec![])).unwrap();
        assert_eq!(v["graph_id"], "g");
        assert!(v.get("anomalies").is_none());
    }

    /// The wire finding must carry what `graph.anomalies` structurally cannot.
    ///
    /// `anomalies` is a `Vec<String>` of taxonomy kinds, and sixteen of
    /// twenty-two detectors share a kind with a sibling — so a consumer reading
    /// it sees `LOOP_DETECTED` and cannot tell a spin loop from a runaway
    /// fan-out. Without `detector_id` and `disposition` on the wire, no
    /// false-positive rate can ever be attributed to a detector, which is the
    /// measurement the promotion rule in `anomaly/mod.rs` requires before any
    /// heuristic may graduate to `kill`.
    #[test]
    fn a_wire_finding_carries_its_detector_and_disposition() {
        use crate::plugins::anomaly::{AnomalyFinding, AnomalyKind, Disposition};

        let mut f = AnomalyFinding::reask(AnomalyKind::LoopDetected, "spinning on Bash", 0.65);
        f.detector_id = "consecutive_repeat";
        let w = FindingWire::from_finding(&f);

        assert_eq!(w.detector_id, "consecutive_repeat");
        assert_eq!(w.kind, "LOOP_DETECTED");
        assert_eq!(w.disposition, "REASK");
        assert_eq!(w.severity, "HIGH");

        // A sibling detector reporting the SAME kind must be distinguishable —
        // this is the whole reason the field exists.
        let mut g = AnomalyFinding::reask(AnomalyKind::LoopDetected, "fan-out too wide", 0.7);
        g.detector_id = "fan_out_explosion";
        let w2 = FindingWire::from_finding(&g);
        assert_eq!(w2.kind, w.kind, "test premise: the kinds collide");
        assert_ne!(w2.detector_id, w.detector_id, "the detectors must not");

        // And the disposition survives, so a consumer can tell an advisory
        // firing from one that blocked — the difference between a measurable
        // false positive and an enforcement action.
        let mut k = AnomalyFinding::kill(AnomalyKind::BudgetBreach, "no headroom");
        k.detector_id = "budget_exhaustion";
        assert_eq!(FindingWire::from_finding(&k).disposition, "KILL");
        assert_eq!(Disposition::Ask.as_str(), "ASK");
    }

    /// Shadow must be OFF unless someone deliberately turned it on.
    ///
    /// This is the property that decides whether shadow mode is safe to ship at
    /// all. Every other flag defaulting wrong costs a feature; this one
    /// defaulting wrong means a proxy that governs nothing while reporting that
    /// it did — enforcement silently disabled, with findings still flowing so
    /// the dashboards look normal.
    ///
    /// `FeatureFlags::default()` is what a *present but unparseable* flag
    /// payload resolves to, and `is_some_and` is what an absent one resolves
    /// through. Both must land on false.
    #[test]
    fn shadow_enforcement_is_off_by_default_and_when_unresolvable() {
        use crate::store::FeatureFlags;

        assert!(
            !FeatureFlags::default().shadow_enforcement,
            "a malformed flag payload must not disable enforcement",
        );

        // No control plane at all — the standalone/open-core case.
        let none: Option<FeatureFlags> = None;
        assert!(
            !none.is_some_and(|f| f.shadow_enforcement),
            "an absent control plane must not disable enforcement",
        );

        // And a payload that sets the other flags but not this one.
        let partial = FeatureFlags {
            bandit_routing: true,
            response_cache_exact: true,
            response_cache_semantic: true,
            ..FeatureFlags::default()
        };
        assert!(!partial.shadow_enforcement);
    }

    /// A shadowed finding keeps its real disposition.
    ///
    /// The tempting alternative was a `WOULD_HAVE` disposition. It destroys the
    /// measurement: every consumer matching on `KILL` silently misses the
    /// shadowed kills, and the record no longer says which verdict the detector
    /// actually reached — which is the only thing shadow mode is for.
    #[test]
    fn a_shadowed_finding_still_reports_what_it_would_have_done() {
        use crate::plugins::anomaly::{AnomalyFinding, AnomalyKind};

        let mut f = AnomalyFinding::kill(AnomalyKind::BudgetBreach, "no headroom");
        f.detector_id = "budget_exhaustion";
        let w = FindingWire::from_finding(&f).shadowed();

        assert!(w.shadowed, "the finding must be marked as not-enforced");
        assert_eq!(
            w.disposition, "KILL",
            "and must still say KILL — a consumer asking 'what would enforcement \
             have cost' needs the verdict, not a placeholder",
        );
        assert_eq!(w.detector_id, "budget_exhaustion");

        // The default is enforced, not shadowed.
        assert!(!FindingWire::from_finding(&f).shadowed);
    }

    /// Findings are skipped on the wire when empty, so a clean request's trace
    /// is byte-identical to what it was before this field existed.
    #[test]
    fn an_empty_finding_list_is_omitted_from_the_wire() {
        #[derive(Serialize)]
        struct Probe {
            #[serde(default, skip_serializing_if = "Vec::is_empty")]
            findings: Vec<FindingWire>,
        }
        let v = serde_json::to_value(Probe { findings: vec![] }).unwrap();
        assert!(
            v.as_object().unwrap().get("findings").is_none(),
            "a clean request must not gain a field",
        );
    }
}
