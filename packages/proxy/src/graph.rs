//! Graph position — extracting a node's identity from request headers.
//!
//! Multi-agent systems ("graph engineering") route every node's traffic through
//! this proxy. To reason about the graph rather than a single turn, the proxy
//! needs to know *which* node is calling and where it sits. This module derives
//! that from the request headers.
//!
//! # Why standards rather than `X-Intutic-*`
//!
//! `gen_ai.agent.id`, `gen_ai.agent.name` and `gen_ai.conversation.id` are real
//! attributes in the OpenTelemetry GenAI semantic-conventions registry, and W3C
//! Trace Context (`traceparent`) plus W3C Baggage (`baggage`) are Recommendations
//! that every OpenTelemetry SDK implements. A harness with OTel instrumentation
//! therefore supplies most of this for free, and the values line up with whatever
//! the operator already records in their tracing backend — so a governance
//! verdict joins to their existing traces with no bridging layer.
//!
//! `X-Intutic-*` headers remain as a fallback for harnesses with no
//! instrumentation.
//!
//! # Why a path prefix as well
//!
//! Headers only work if the harness can be told to send them, and almost none
//! can: Claude Code has `ANTHROPIC_CUSTOM_HEADERS`, and the rest of the
//! ecosystem — Cursor, Aider, Codex, Goose, CrewAI, every LangChain app — offers
//! no equivalent. What every one of them *does* accept is a base URL, which they
//! append their own path to. So identity also rides in an optional
//! `/_i/{graph}/{node}/{parent}/{depth}` prefix, which `intutic exec` bakes into
//! the base URL it hands each child process. The prefix is stripped before
//! anything else looks at the path, so provider detection, protocol detection
//! and upstream forwarding never see it.
//!
//! This matters because without *some* carrier, `graph_id` always defaulted to
//! `session_id` and the entire membership/spend/node-count block in `proxy.rs`
//! was unreachable — taking `HALLUCINATION`, `SPAWN_BUDGET_BREACH` and the
//! fan-out and recursion inputs to `LOOP_DETECTED` with it.
//!
//! # Trust
//!
//! Everything here is client-supplied and unverifiable; the W3C Baggage spec is
//! explicit that baggage must not carry data requiring integrity. These values
//! are for observability and self-consistency only, never authorisation. See
//! [`NodeIdentity`] for the full statement.

use crate::wasm::context::NodeIdentity;
use axum::http::HeaderMap;

/// OTel GenAI attribute keys, as they appear inside the `baggage` header.
const BAGGAGE_AGENT_ID: &str = "gen_ai.agent.id";
const BAGGAGE_AGENT_NAME: &str = "gen_ai.agent.name";
const BAGGAGE_CONVERSATION_ID: &str = "gen_ai.conversation.id";
/// Depth has no standard carrier, so it stays in our own namespace.
const BAGGAGE_DEPTH: &str = "intutic.graph.depth";

/// Guard against a hostile or accidentally huge `baggage` header. The W3C spec
/// suggests implementations may cap total baggage around 8KB; we only ever read
/// a handful of short keys, so anything past this is not for us.
const MAX_BAGGAGE_LEN: usize = 8192;

/// Cap on individual values written into telemetry and notifications, so a long
/// header cannot bloat every downstream record.
const MAX_VALUE_LEN: usize = 128;

/// Parse a W3C `baggage` header into a single requested key's value.
///
/// Format is `key1=value1,key2=value2;prop=x`. Values may be percent-encoded,
/// and each entry may carry `;`-delimited properties which we discard.
fn baggage_value(header: &str, want: &str) -> Option<String> {
    if header.len() > MAX_BAGGAGE_LEN {
        return None;
    }
    for entry in header.split(',') {
        // Strip any `;`-delimited properties before splitting on `=`.
        let pair = entry.split(';').next()?.trim();
        let (key, value) = pair.split_once('=')?;
        if key.trim() != want {
            continue;
        }
        let decoded = percent_decode(value.trim());
        if decoded.is_empty() {
            return None;
        }
        return Some(truncate(decoded));
    }
    None
}

/// Minimal percent-decoding. Baggage values are usually plain, but the spec
/// permits encoding, and pulling in a dependency for this would be excessive.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Trim to [`MAX_VALUE_LEN`] on a character boundary.
fn truncate(mut s: String) -> String {
    if s.len() > MAX_VALUE_LEN {
        let end = (0..=MAX_VALUE_LEN)
            .rev()
            .find(|&i| s.is_char_boundary(i))
            .unwrap_or(0);
        s.truncate(end);
    }
    s
}

/// Extract the parent span id from a W3C `traceparent`.
///
/// Format: `version-traceid-parentid-flags`, e.g.
/// `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
/// The third field identifies the caller's span, which is exactly "who handed
/// this to me" — the parent edge in the graph.
fn traceparent_parent_id(header: &str) -> Option<String> {
    let parts: Vec<&str> = header.trim().split('-').collect();
    if parts.len() < 4 {
        return None;
    }
    let parent = parts[2];
    // 16 hex chars, and all-zero means "no parent".
    if parent.len() != 16 || !parent.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if parent.chars().all(|c| c == '0') {
        return None;
    }
    Some(parent.to_string())
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

/// Discard empty strings so a blank path segment falls through to the next source.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// Resolve a value from baggage first, then a fallback header.
fn resolve(headers: &HeaderMap, baggage: Option<&str>, key: &str, fallback: &str) -> Option<String> {
    baggage
        .and_then(|b| baggage_value(b, key))
        .or_else(|| header_str(headers, fallback).filter(|s| !s.is_empty()).map(|s| truncate(s.to_string())))
}

/// The identity segments carried in a request path, if any.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PathIdentity {
    pub graph_id: String,
    pub node_id: String,
    pub parent_session_id: String,
    pub depth: u32,
}

/// Path prefix that carries graph identity for harnesses that cannot set headers.
const IDENTITY_PREFIX: &str = "/_i/";

/// Segment standing in for "no value", since an empty path segment collapses.
const EMPTY_SEGMENT: &str = "-";

/// Split an incoming path into its identity prefix and the real request path.
///
/// `/_i/g1/n2/n1/3/v1/messages` becomes the identity plus `/v1/messages`. A path
/// without the prefix is returned unchanged with no identity, so an uninstrumented
/// harness behaves exactly as before.
///
/// A malformed prefix is treated as *not* an identity prefix and left in the path,
/// rather than being silently dropped: quietly swallowing path segments would send
/// the request upstream to a URL the caller never asked for.
pub fn split_identity_path(path: &str) -> (Option<PathIdentity>, String) {
    let Some(rest) = path.strip_prefix(IDENTITY_PREFIX) else {
        return (None, path.to_string());
    };

    let mut segments = rest.splitn(5, '/');
    let (Some(graph), Some(node), Some(parent), Some(depth)) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return (None, path.to_string());
    };

    // The depth segment must be a number. If it is not, this is some other path
    // that merely starts with `/_i/` and must be passed through untouched.
    let Ok(depth) = depth.parse::<u32>() else {
        return (None, path.to_string());
    };

    let unwrap_segment = |s: &str| {
        if s == EMPTY_SEGMENT {
            String::new()
        } else {
            truncate(s.to_string())
        }
    };

    let identity = PathIdentity {
        graph_id: unwrap_segment(graph),
        node_id: unwrap_segment(node),
        parent_session_id: unwrap_segment(parent),
        // Clamped for the same reason the header path clamps: a caller must not
        // be able to fake a recursion breach.
        depth: depth.min(1024),
    };

    let tail = segments.next().unwrap_or("");
    (Some(identity), format!("/{}", tail))
}

/// Derive this request's position in the graph.
///
/// Every field falls back to a value that makes a single-agent session behave
/// exactly as it did before graph support existed: the node *is* the session,
/// the graph is a graph of one, and depth is zero. Nothing about an
/// uninstrumented harness changes.
pub fn identity_from_headers(headers: &HeaderMap, session_id: &str) -> NodeIdentity {
    identity_from_request(headers, None, session_id)
}

/// As [`identity_from_headers`], but also consulting identity carried in the
/// request path.
///
/// Headers win where both are present: a harness that went to the trouble of
/// emitting OTel baggage is describing itself more precisely than a wrapper
/// process guessing from its environment.
pub fn identity_from_request(
    headers: &HeaderMap,
    path_identity: Option<&PathIdentity>,
    session_id: &str,
) -> NodeIdentity {
    let baggage = header_str(headers, "baggage");

    let node_id = resolve(headers, baggage, BAGGAGE_AGENT_ID, "x-intutic-node-id")
        .or_else(|| non_empty(path_identity.map(|p| p.node_id.clone())))
        .unwrap_or_else(|| session_id.to_string());

    let agent_role =
        resolve(headers, baggage, BAGGAGE_AGENT_NAME, "x-intutic-agent-role").unwrap_or_default();

    let graph_id = resolve(
        headers,
        baggage,
        BAGGAGE_CONVERSATION_ID,
        "x-intutic-graph-id",
    )
    .or_else(|| non_empty(path_identity.map(|p| p.graph_id.clone())))
    .unwrap_or_else(|| session_id.to_string());

    // traceparent is the standard source; the explicit header is the fallback.
    let parent_session_id = header_str(headers, "traceparent")
        .and_then(traceparent_parent_id)
        .or_else(|| {
            header_str(headers, "x-intutic-parent-session")
                .filter(|s| !s.is_empty())
                .map(|s| truncate(s.to_string()))
        })
        .or_else(|| non_empty(path_identity.map(|p| p.parent_session_id.clone())))
        .unwrap_or_default();

    let depth = resolve(headers, baggage, BAGGAGE_DEPTH, "x-intutic-depth")
        .and_then(|d| d.parse::<u32>().ok())
        .or_else(|| path_identity.map(|p| p.depth))
        // A hostile depth would let a caller fake a recursion breach, so clamp
        // it to something no legitimate graph reaches.
        .map(|d| d.min(1024))
        .unwrap_or(0);

    NodeIdentity {
        node_id,
        agent_role,
        graph_id,
        parent_session_id,
        depth,
        // Aggregates come from the store, not the caller. Leaving them unset
        // here is deliberate: a client that could declare its own graph spend
        // could declare it low and walk past the budget detector.
        ..NodeIdentity::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn no_headers_yields_single_node_graph() {
        let id = identity_from_headers(&HeaderMap::new(), "ses_1");
        assert_eq!(id.node_id, "ses_1");
        assert_eq!(id.graph_id, "ses_1");
        assert_eq!(id.depth, 0);
        assert!(id.parent_session_id.is_empty());
        assert!(id.agent_role.is_empty());
    }

    #[test]
    fn reads_otel_genai_attributes_from_baggage() {
        let h = headers(&[(
            "baggage",
            "gen_ai.agent.id=planner-1,gen_ai.agent.name=planner,gen_ai.conversation.id=graph-42,intutic.graph.depth=3",
        )]);
        let id = identity_from_headers(&h, "ses_1");
        assert_eq!(id.node_id, "planner-1");
        assert_eq!(id.agent_role, "planner");
        assert_eq!(id.graph_id, "graph-42");
        assert_eq!(id.depth, 3);
    }

    #[test]
    fn baggage_tolerates_properties_and_whitespace() {
        let h = headers(&[("baggage", " gen_ai.agent.id = a1 ;meta=1, other=x")]);
        assert_eq!(identity_from_headers(&h, "ses_1").node_id, "a1");
    }

    #[test]
    fn baggage_percent_decoding() {
        let h = headers(&[("baggage", "gen_ai.agent.name=code%20reviewer")]);
        assert_eq!(identity_from_headers(&h, "ses_1").agent_role, "code reviewer");
    }

    #[test]
    fn traceparent_supplies_parent_span() {
        let h = headers(&[(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )]);
        assert_eq!(
            identity_from_headers(&h, "ses_1").parent_session_id,
            "00f067aa0ba902b7"
        );
    }

    #[test]
    fn all_zero_parent_span_means_root() {
        let h = headers(&[(
            "traceparent",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        )]);
        assert!(identity_from_headers(&h, "ses_1")
            .parent_session_id
            .is_empty());
    }

    #[test]
    fn malformed_traceparent_falls_back_to_header() {
        let h = headers(&[
            ("traceparent", "garbage"),
            ("x-intutic-parent-session", "ses_parent"),
        ]);
        assert_eq!(
            identity_from_headers(&h, "ses_1").parent_session_id,
            "ses_parent"
        );
    }

    #[test]
    fn custom_headers_are_the_fallback() {
        let h = headers(&[
            ("x-intutic-node-id", "n1"),
            ("x-intutic-agent-role", "reviewer"),
            ("x-intutic-graph-id", "g1"),
            ("x-intutic-depth", "2"),
        ]);
        let id = identity_from_headers(&h, "ses_1");
        assert_eq!(id.node_id, "n1");
        assert_eq!(id.agent_role, "reviewer");
        assert_eq!(id.graph_id, "g1");
        assert_eq!(id.depth, 2);
    }

    #[test]
    fn baggage_wins_over_fallback_header() {
        let h = headers(&[
            ("baggage", "gen_ai.agent.id=from-baggage"),
            ("x-intutic-node-id", "from-header"),
        ]);
        assert_eq!(identity_from_headers(&h, "ses_1").node_id, "from-baggage");
    }

    #[test]
    fn oversized_baggage_is_ignored() {
        let big = format!("gen_ai.agent.id={}", "x".repeat(MAX_BAGGAGE_LEN));
        let h = headers(&[("baggage", big.as_str())]);
        // Falls back to the session id rather than trusting a huge header.
        assert_eq!(identity_from_headers(&h, "ses_1").node_id, "ses_1");
    }

    #[test]
    fn long_values_are_truncated() {
        let h = headers(&[("x-intutic-node-id", "n".repeat(500).as_str())]);
        assert_eq!(
            identity_from_headers(&h, "ses_1").node_id.len(),
            MAX_VALUE_LEN
        );
    }

    #[test]
    fn absurd_depth_is_clamped() {
        let h = headers(&[("x-intutic-depth", "999999")]);
        assert_eq!(identity_from_headers(&h, "ses_1").depth, 1024);
    }

    #[test]
    fn non_numeric_depth_is_zero() {
        let h = headers(&[("x-intutic-depth", "deep")]);
        assert_eq!(identity_from_headers(&h, "ses_1").depth, 0);
    }

    // ── Path-carried identity ────────────────────────────────────────
    //
    // The mechanism that finally makes graph identity reachable: almost no
    // harness can be told to send a header, but every one of them accepts a
    // base URL.

    #[test]
    fn path_identity_is_parsed_and_stripped() {
        let (id, path) = split_identity_path("/_i/g1/n2/n1/3/v1/messages");
        let id = id.expect("prefix should parse");
        assert_eq!(id.graph_id, "g1");
        assert_eq!(id.node_id, "n2");
        assert_eq!(id.parent_session_id, "n1");
        assert_eq!(id.depth, 3);
        // Upstream must see the path the caller meant.
        assert_eq!(path, "/v1/messages");
    }

    #[test]
    fn root_node_uses_the_empty_segment() {
        let (id, path) = split_identity_path("/_i/g1/n1/-/0/v1/chat/completions");
        let id = id.expect("prefix should parse");
        assert_eq!(id.parent_session_id, "");
        assert_eq!(id.depth, 0);
        assert_eq!(path, "/v1/chat/completions");
    }

    #[test]
    fn a_path_without_the_prefix_is_untouched() {
        let (id, path) = split_identity_path("/v1/messages");
        assert!(id.is_none());
        assert_eq!(path, "/v1/messages");
    }

    #[test]
    fn a_malformed_prefix_is_left_in_the_path() {
        // Silently swallowing segments would forward the request to a URL the
        // caller never asked for, which is worse than ignoring the identity.
        for path in [
            "/_i/g1/n1/v1/messages",        // depth segment is not a number
            "/_i/g1/n1",                    // too few segments
            "/_intutic-predict",            // merely starts with the same letters
        ] {
            let (id, out) = split_identity_path(path);
            assert!(id.is_none(), "{path} should not parse as identity");
            assert_eq!(out, path, "{path} must pass through unchanged");
        }
    }

    #[test]
    fn path_depth_is_clamped_like_the_header() {
        let (id, _) = split_identity_path("/_i/g/n/p/999999/v1/messages");
        assert_eq!(id.unwrap().depth, 1024);
    }

    #[test]
    fn headers_win_over_the_path() {
        // A harness emitting OTel baggage is describing itself more precisely
        // than a wrapper process inferring from its environment.
        let h = headers(&[("baggage", "gen_ai.conversation.id=from-baggage")]);
        let path_id = PathIdentity {
            graph_id: "from-path".into(),
            node_id: "n".into(),
            parent_session_id: String::new(),
            depth: 0,
        };
        let node = identity_from_request(&h, Some(&path_id), "sess");
        assert_eq!(node.graph_id, "from-baggage");
    }

    #[test]
    fn the_path_makes_a_graph_of_more_than_one() {
        // The whole point: `graph_id != session_id` is the gate at proxy.rs
        // that guards membership, graph spend and node counts. Without a
        // carrier it was never true, so that entire block was unreachable.
        let path_id = PathIdentity {
            graph_id: "fleet-1".into(),
            node_id: "worker-3".into(),
            parent_session_id: "lead".into(),
            depth: 1,
        };
        let node = identity_from_request(&HeaderMap::new(), Some(&path_id), "sess-abc");
        assert_ne!(node.graph_id, "sess-abc");
        assert_eq!(node.graph_id, "fleet-1");
        assert_eq!(node.node_id, "worker-3");
        assert_eq!(node.parent_session_id, "lead");
        assert_eq!(node.depth, 1);
    }

    #[test]
    fn no_identity_anywhere_still_means_a_graph_of_one() {
        let node = identity_from_request(&HeaderMap::new(), None, "sess-abc");
        assert_eq!(node.graph_id, "sess-abc");
        assert_eq!(node.node_id, "sess-abc");
        assert_eq!(node.depth, 0);
    }
}
