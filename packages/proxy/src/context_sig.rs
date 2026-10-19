//! Context signatures for worker context isolation.
//!
//! A splitter that hands every worker the whole task, instead of each worker
//! its slice, pays for the same context once per worker, and the workers tend
//! to duplicate each other's work. This module computes a small, fixed-size
//! signature of the context a node was *handed*, so sibling nodes can be
//! compared without storing or shipping their text.
//!
//! # What counts as handed-in context
//!
//! The user-role text of the request, concatenated. Everything else is left
//! out on purpose:
//!
//! * the system prompt and the `tools` array, because every node of one harness
//!   shares them, so they would make every pair of siblings look alike;
//! * assistant turns, which the node produced itself;
//! * tool results (`tool_result` blocks, `role: tool` messages and their Gemini,
//!   Bedrock and Responses equivalents), because siblings legitimately read the
//!   same files.
//!
//! # The signature
//!
//! 1. Lowercase and collapse whitespace; keep the first [`MAX_CONTEXT_BYTES`].
//!    Below [`MIN_CONTEXT_BYTES`] there is no signature: a small brief costs
//!    little and false-matches easily.
//! 2. Hash every [`SHINGLE_WORDS`]-word shingle with FNV-1a 64, then a 64-bit
//!    finaliser so the bin index (the top bits) is well spread.
//! 3. One-permutation MinHash: the top six bits pick one of [`SIG_BINS`] bins,
//!    and each bin keeps the smallest hash it saw.
//!
//! The Jaccard estimate between two signatures is the number of bins holding
//! the same value, over the bins that are non-empty in both. Everything is
//! deterministic and dependency-free, and the cost is linear in words: about
//! 65k words at the 512 KiB cap.
//!
//! # Bounded state
//!
//! Signatures are kept per graph in a hash: field `node_id`, value
//! [`encode_field`] (`base64(sig):parent:bytes`, about 700 bytes). A node's
//! field is written once, on its first qualifying request (the handed-in
//! context is in that request), the hash expires [`CTXSIG_TTL_SECS`] after the
//! last write, and it holds at most [`CTXSIG_MAX_FIELDS`] fields; past the cap
//! a node is compared but not stored. That is about 22 KiB per graph at the
//! cap. On Valkey this is `HGETALL`, then `HLEN` < cap → `HSETNX` + `EXPIRE`.
//! [`CtxSigMemoryStore`] is the same contract in process, bounded to
//! [`CTXSIG_MEMORY_GRAPHS`] graphs, least recently used evicted first.

use base64::Engine as _;
use std::collections::HashMap;

/// Below this many normalised bytes a request gets no signature.
pub const MIN_CONTEXT_BYTES: usize = 8 * 1024;
/// Only this many normalised bytes are read.
pub const MAX_CONTEXT_BYTES: usize = 512 * 1024;
/// Words per shingle.
pub const SHINGLE_WORDS: usize = 8;
/// MinHash bins.
pub const SIG_BINS: usize = 64;

/// Store-key suffix for a graph's signature hash. The store builds the full
/// key with the workspace segment first (`store/valkey.rs` `graph_key`), so two
/// tenants that choose the same graph id never compare against each other.
pub const CTXSIG_KEY_SUFFIX: &str = "ctxsig";
/// The hash expires this long after its last write.
pub const CTXSIG_TTL_SECS: u64 = 3600;
/// Fields kept per graph. Past this a node is compared but not stored.
pub const CTXSIG_MAX_FIELDS: usize = 32;
/// Graphs the in-process store keeps.
pub const CTXSIG_MEMORY_GRAPHS: usize = 1024;

/// Marks a bin no shingle landed in.
const EMPTY_BIN: u64 = u64::MAX;
/// Bits needed to index [`SIG_BINS`].
const BIN_BITS: u32 = SIG_BINS.trailing_zeros();

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// A node's handed-in context, reduced to [`SIG_BINS`] MinHash values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextSig {
    bins: [u64; SIG_BINS],
    /// Normalised bytes the signature covers (capped at [`MAX_CONTEXT_BYTES`]).
    bytes: u32,
}

impl ContextSig {
    /// Normalised bytes the signature covers.
    pub fn bytes(&self) -> u32 {
        self.bytes
    }

    /// Estimated Jaccard similarity of the two contexts' shingle sets.
    ///
    /// `None` when no bin is non-empty in both, which cannot happen for two
    /// signatures over the floor but is answered honestly rather than as 0.
    pub fn jaccard(&self, other: &ContextSig) -> Option<f64> {
        let mut both = 0u32;
        let mut same = 0u32;
        for (a, b) in self.bins.iter().zip(other.bins.iter()) {
            if *a == EMPTY_BIN || *b == EMPTY_BIN {
                continue;
            }
            both += 1;
            if a == b {
                same += 1;
            }
        }
        (both > 0).then(|| f64::from(same) / f64::from(both))
    }

    /// The bins, big-endian, base64 (standard alphabet, padded).
    fn bins_base64(&self) -> String {
        let mut raw = Vec::with_capacity(SIG_BINS * 8);
        for b in self.bins {
            raw.extend_from_slice(&b.to_be_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(raw)
    }

    fn from_bins_base64(encoded: &str, bytes: u32) -> Option<ContextSig> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        if raw.len() != SIG_BINS * 8 {
            return None;
        }
        let mut bins = [EMPTY_BIN; SIG_BINS];
        let (chunks, _) = raw.as_chunks::<8>();
        for (bin, chunk) in bins.iter_mut().zip(chunks) {
            *bin = u64::from_be_bytes(*chunk);
        }
        Some(ContextSig { bins, bytes })
    }
}

/// The best sibling match for this request, handed to the detector as plain
/// data (`RequestContext.sibling_overlap`).
#[derive(Debug, Clone, PartialEq)]
pub struct SiblingOverlap {
    /// The sibling's `node_id`.
    pub node: String,
    /// Estimated Jaccard similarity, 0.0–1.0.
    pub jaccard: f64,
    /// The smaller of the two contexts' normalised sizes: the shared part
    /// cannot be larger than that.
    pub bytes: u32,
}

/// A sibling's stored signature, decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredSig {
    pub sig: ContextSig,
    /// The `parent_session_id` the node had when it was stored.
    pub parent: String,
}

/// The pieces of user-role text in a request body, in order, borrowed.
///
/// Covers Anthropic Messages, OpenAI Chat Completions, OpenAI Responses,
/// Gemini `contents` and Bedrock Converse. See the module docs for what is
/// excluded and why.
pub fn handed_in_text(body: &serde_json::Value) -> Vec<&str> {
    let mut out = Vec::new();

    // Anthropic, OpenAI chat, Bedrock Converse. `system` (top level or as a
    // role), `developer`, `assistant` and `tool` messages are skipped.
    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for m in messages {
            if role(m) == Some("user") {
                push_content(m.get("content"), &mut out);
            }
        }
    }

    // OpenAI Responses: `input` is a string, or items. `instructions` is the
    // system prompt and is not read; `function_call_output` items carry no role.
    match body.get("input") {
        Some(serde_json::Value::String(s)) => out.push(s.as_str()),
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                if role(item) == Some("user") {
                    push_content(item.get("content"), &mut out);
                }
            }
        }
        _ => {}
    }

    // Gemini: `systemInstruction` is not read. A turn with no role is the
    // single-turn user form. `functionResponse` parts carry no `text`.
    if let Some(contents) = body.get("contents").and_then(|v| v.as_array()) {
        for c in contents {
            if matches!(role(c), None | Some("user")) {
                push_content(c.get("parts"), &mut out);
            }
        }
    }

    out
}

fn role(v: &serde_json::Value) -> Option<&str> {
    v.get("role").and_then(|r| r.as_str())
}

/// Text from a content value: a string, or blocks of which only text blocks
/// count (`type: text` / `input_text`, or an untyped `{text}` as Gemini parts
/// and Converse blocks are written). Tool results, images and documents are
/// skipped.
fn push_content<'a>(content: Option<&'a serde_json::Value>, out: &mut Vec<&'a str>) {
    match content {
        Some(serde_json::Value::String(s)) => out.push(s.as_str()),
        Some(serde_json::Value::Array(blocks)) => {
            for b in blocks {
                let is_text = match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") | Some("input_text") => true,
                    Some(_) => false,
                    None => true,
                };
                if !is_text {
                    continue;
                }
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    out.push(t);
                }
            }
        }
        _ => {}
    }
}

/// Lowercase, collapse every whitespace run to one space, trim, and stop at
/// [`MAX_CONTEXT_BYTES`]. Pieces are joined as if by whitespace.
pub fn normalise(pieces: &[&str]) -> String {
    let mut out = String::new();
    'outer: for piece in pieces {
        let mut pending_space = true;
        for ch in piece.chars() {
            if ch.is_whitespace() {
                pending_space = true;
                continue;
            }
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            if out.len() >= MAX_CONTEXT_BYTES {
                break 'outer;
            }
        }
    }
    if out.len() > MAX_CONTEXT_BYTES {
        let end = (0..=MAX_CONTEXT_BYTES)
            .rev()
            .find(|&i| out.is_char_boundary(i))
            .unwrap_or(0);
        out.truncate(end);
    }
    out
}

/// The signature of already-normalised text, or `None` below the floor.
pub fn signature_of_normalised(text: &str) -> Option<ContextSig> {
    if text.len() < MIN_CONTEXT_BYTES {
        return None;
    }
    let words: Vec<&str> = text.split(' ').filter(|w| !w.is_empty()).collect();
    let mut bins = [EMPTY_BIN; SIG_BINS];
    let mut add = |shingle: &[&str]| {
        let h = shingle_hash(shingle);
        let bin = (h >> (64 - BIN_BITS)) as usize;
        // EMPTY_BIN is the sentinel, so a real hash may not equal it.
        let h = h.min(EMPTY_BIN - 1);
        if h < bins[bin] {
            bins[bin] = h;
        }
    };
    if words.len() < SHINGLE_WORDS {
        // Over the floor with fewer than eight words means a few enormous
        // tokens. One shingle of all of them still compares exactly.
        add(&words);
    } else {
        for window in words.windows(SHINGLE_WORDS) {
            add(window);
        }
    }
    Some(ContextSig {
        bins,
        bytes: u32::try_from(text.len()).unwrap_or(u32::MAX),
    })
}

/// The signature of a request body's handed-in context, or `None` when it is
/// under [`MIN_CONTEXT_BYTES`] once normalised.
pub fn context_signature(body: &serde_json::Value) -> Option<ContextSig> {
    signature_of_normalised(&normalise(&handed_in_text(body)))
}

/// FNV-1a 64 over the shingle's words, each followed by a 0x20 separator so
/// `["ab","c"]` and `["a","bc"]` differ, then the murmur3 64-bit finaliser.
///
/// FNV-1a's low bits are weakly mixed and its multiply leaves the top bits
/// dependent mostly on the last bytes, so the finaliser is what makes the top
/// six bits a fair bin index.
fn shingle_hash(words: &[&str]) -> u64 {
    let mut h = FNV_OFFSET;
    for w in words {
        for b in w.bytes().chain(std::iter::once(b' ')) {
            h ^= u64::from(b);
            h = h.wrapping_mul(FNV_PRIME);
        }
    }
    fmix64(h)
}

fn fmix64(mut k: u64) -> u64 {
    k ^= k >> 33;
    k = k.wrapping_mul(0xff51_afd7_ed55_8ccd);
    k ^= k >> 33;
    k = k.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    k ^= k >> 33;
    k
}

/// The store value for a node: `base64(sig):parent:bytes`.
///
/// The parent is client-supplied and may contain `:`, so [`decode_field`]
/// splits on the first and last colon only (base64 and a number contain none).
pub fn encode_field(sig: &ContextSig, parent: &str) -> String {
    format!("{}:{}:{}", sig.bins_base64(), parent, sig.bytes)
}

/// Decode a stored value. `None` for anything damaged.
pub fn decode_field(value: &str) -> Option<StoredSig> {
    let (encoded, rest) = value.split_once(':')?;
    let (parent, bytes) = rest.rsplit_once(':')?;
    let bytes = bytes.parse::<u32>().ok()?;
    Some(StoredSig {
        sig: ContextSig::from_bins_base64(encoded, bytes)?,
        parent: parent.to_string(),
    })
}

/// Whether this node takes part in sibling comparison at all: a real graph
/// (`graph_id != node_id`), below the root (`depth >= 1`), with a parent to be
/// a sibling under.
pub fn is_sibling_candidate(graph_id: &str, node_id: &str, parent: &str, depth: u32) -> bool {
    !graph_id.is_empty() && graph_id != node_id && depth >= 1 && !parent.is_empty()
}

/// The closest sibling among a graph's stored signatures.
///
/// A sibling has the same parent and a different `node_id`; this node's own
/// field (a retry of the same node) is never a match. Damaged values are
/// skipped. Ties go to the lexicographically smallest node id, so the answer
/// does not depend on the order the store returned the fields in.
pub fn best_sibling<'a>(
    node_id: &str,
    parent: &str,
    sig: &ContextSig,
    fields: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Option<SiblingOverlap> {
    let mut best: Option<SiblingOverlap> = None;
    for (node, value) in fields {
        if node == node_id {
            continue;
        }
        let Some(stored) = decode_field(value) else {
            continue;
        };
        if stored.parent != parent {
            continue;
        }
        let Some(jaccard) = sig.jaccard(&stored.sig) else {
            continue;
        };
        let better = match &best {
            None => true,
            Some(b) => jaccard > b.jaccard || (jaccard == b.jaccard && node < b.node.as_str()),
        };
        if better {
            best = Some(SiblingOverlap {
                node: node.to_string(),
                jaccard,
                bytes: sig.bytes().min(stored.sig.bytes()),
            });
        }
    }
    best
}

/// The in-process signature store, with the same contract as the Valkey hash:
/// set-if-absent per node, a field cap per graph, a TTL refreshed on write, and
/// at most [`CTXSIG_MEMORY_GRAPHS`] graphs, least recently used evicted first.
///
/// Time is passed in (seconds, any monotonic origin), so the store is
/// deterministic under test. Not thread-safe by itself; the caller holds it
/// behind its own lock.
#[derive(Debug, Default)]
pub struct CtxSigMemoryStore {
    graphs: HashMap<String, GraphSigs>,
    /// Monotonic use counter for LRU order.
    tick: u64,
}

#[derive(Debug)]
struct GraphSigs {
    fields: HashMap<String, String>,
    expires_at: u64,
    last_used: u64,
}

impl CtxSigMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Graphs currently held (expired ones included until next touched).
    pub fn len(&self) -> usize {
        self.graphs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.graphs.is_empty()
    }

    /// `HSETNX` + `EXPIRE` under the field cap. Returns whether the field was
    /// written: `false` when the node is already stored or the graph is full.
    pub fn set_if_absent(&mut self, key: &str, node_id: &str, value: String, now: u64) -> bool {
        self.drop_if_expired(key, now);
        self.tick += 1;
        let tick = self.tick;
        if !self.graphs.contains_key(key) {
            if self.graphs.len() >= CTXSIG_MEMORY_GRAPHS {
                self.evict_lru();
            }
            self.graphs.insert(
                key.to_string(),
                GraphSigs {
                    fields: HashMap::new(),
                    expires_at: now + CTXSIG_TTL_SECS,
                    last_used: tick,
                },
            );
        }
        let Some(graph) = self.graphs.get_mut(key) else {
            return false;
        };
        graph.last_used = tick;
        if graph.fields.contains_key(node_id) || graph.fields.len() >= CTXSIG_MAX_FIELDS {
            return false;
        }
        graph.fields.insert(node_id.to_string(), value);
        graph.expires_at = now + CTXSIG_TTL_SECS;
        true
    }

    /// `HGETALL`: every live field of the graph, sorted by node id.
    pub fn get_all(&mut self, key: &str, now: u64) -> Vec<(String, String)> {
        self.drop_if_expired(key, now);
        self.tick += 1;
        let tick = self.tick;
        let Some(graph) = self.graphs.get_mut(key) else {
            return Vec::new();
        };
        graph.last_used = tick;
        let mut out: Vec<(String, String)> = graph
            .fields
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        out.sort();
        out
    }

    fn drop_if_expired(&mut self, key: &str, now: u64) {
        if self.graphs.get(key).is_some_and(|g| now >= g.expires_at) {
            self.graphs.remove(key);
        }
    }

    /// Evict the least recently used graph. The scan is over at most 1,024
    /// entries and runs only when a new graph arrives at the cap.
    fn evict_lru(&mut self) {
        let victim = self
            .graphs
            .iter()
            .min_by_key(|(_, g)| g.last_used)
            .map(|(k, _)| k.clone());
        if let Some(k) = victim {
            self.graphs.remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Deterministic filler: `n` distinct words seeded by `seed`.
    fn words(seed: &str, n: usize) -> String {
        (0..n)
            .map(|i| format!("{seed}{i}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// About 20 KiB of brief.
    fn brief(seed: &str) -> String {
        words(seed, 2600)
    }

    fn sig(text: &str) -> ContextSig {
        signature_of_normalised(&normalise(&[text])).expect("over the floor")
    }

    #[test]
    fn context_sig_reads_only_user_text_anthropic() {
        let body = json!({
            "system": "SYSTEM PROMPT",
            "tools": [{"name": "Read", "description": "TOOL SCHEMA"}],
            "messages": [
                {"role": "user", "content": "first brief"},
                {"role": "assistant", "content": [{"type": "text", "text": "ASSISTANT"}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "TOOL RESULT"},
                    {"type": "text", "text": "second brief"},
                    {"type": "image", "source": {"data": "IMAGE"}}
                ]}
            ]
        });
        assert_eq!(handed_in_text(&body), vec!["first brief", "second brief"]);
    }

    #[test]
    fn context_sig_reads_only_user_text_openai_chat() {
        let body = json!({
            "tools": [{"type": "function", "function": {"name": "x", "description": "TOOL SCHEMA"}}],
            "messages": [
                {"role": "system", "content": "SYSTEM"},
                {"role": "developer", "content": "DEVELOPER"},
                {"role": "user", "content": [{"type": "text", "text": "the brief"}]},
                {"role": "assistant", "content": "ASSISTANT", "tool_calls": []},
                {"role": "tool", "tool_call_id": "c1", "content": "TOOL RESULT"}
            ]
        });
        assert_eq!(handed_in_text(&body), vec!["the brief"]);
    }

    #[test]
    fn context_sig_reads_only_user_text_responses_gemini_converse() {
        let responses = json!({
            "instructions": "SYSTEM",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "brief"}]},
                {"type": "function_call_output", "call_id": "c", "output": "TOOL RESULT"},
                {"role": "assistant", "content": "ASSISTANT"}
            ]
        });
        assert_eq!(handed_in_text(&responses), vec!["brief"]);
        assert_eq!(handed_in_text(&json!({"input": "plain"})), vec!["plain"]);

        let gemini = json!({
            "systemInstruction": {"parts": [{"text": "SYSTEM"}]},
            "contents": [
                {"role": "user", "parts": [{"text": "brief"}]},
                {"role": "model", "parts": [{"text": "MODEL"}]},
                {"role": "user", "parts": [{"functionResponse": {"name": "f", "response": {}}}]}
            ]
        });
        assert_eq!(handed_in_text(&gemini), vec!["brief"]);

        let converse = json!({
            "system": [{"text": "SYSTEM"}],
            "messages": [
                {"role": "user", "content": [{"text": "brief"}, {"toolResult": {"content": []}}]}
            ]
        });
        assert_eq!(handed_in_text(&converse), vec!["brief"]);
    }

    #[test]
    fn context_sig_normalise_lowercases_and_collapses_whitespace() {
        assert_eq!(
            normalise(&["  Hello\n\tWORLD  ", "Again"]),
            "hello world again"
        );
        assert_eq!(normalise(&[]), "");
        assert_eq!(normalise(&["   "]), "");
        // Pieces never run together.
        assert_eq!(normalise(&["a", "b"]), "a b");
    }

    #[test]
    fn context_sig_normalise_caps_at_max_bytes() {
        let big = "word ".repeat(MAX_CONTEXT_BYTES); // 5x the cap
        let out = normalise(&[&big]);
        assert!(out.len() <= MAX_CONTEXT_BYTES);
        assert!(out.len() > MAX_CONTEXT_BYTES - 8);
        // Multi-byte characters are cut on a boundary.
        let wide = "é".repeat(MAX_CONTEXT_BYTES);
        let out = normalise(&[&wide]);
        assert!(out.len() <= MAX_CONTEXT_BYTES);
    }

    #[test]
    fn context_sig_skips_below_the_floor() {
        let small = words("w", 200); // ~1 KiB
        assert!(signature_of_normalised(&normalise(&[&small])).is_none());
        let body = json!({"messages": [{"role": "user", "content": small}]});
        assert!(context_signature(&body).is_none());
    }

    #[test]
    fn context_sig_system_prompt_and_tools_do_not_count_toward_the_floor() {
        // A huge shared system prompt and schema, a tiny brief: no signature.
        let body = json!({
            "system": brief("sys"),
            "tools": [{"name": "t", "description": brief("schema")}],
            "messages": [{"role": "user", "content": "do the thing"}]
        });
        assert!(context_signature(&body).is_none());
    }

    #[test]
    fn context_sig_is_deterministic() {
        let text = brief("alpha");
        assert_eq!(sig(&text), sig(&text));
        let body = json!({"messages": [{"role": "user", "content": text}]});
        assert_eq!(context_signature(&body), context_signature(&body));
        assert_eq!(context_signature(&body), Some(sig(&text)));
    }

    #[test]
    fn context_sig_identical_briefs_are_jaccard_one() {
        let a = sig(&brief("shared"));
        assert_eq!(a.jaccard(&a), Some(1.0));
        // Case and whitespace differences do not matter.
        let shouty = brief("shared").to_uppercase().replace(' ', "  \n");
        assert_eq!(a.jaccard(&sig(&shouty)), Some(1.0));
    }

    #[test]
    fn context_sig_unrelated_briefs_are_near_zero() {
        let j = sig(&brief("alpha")).jaccard(&sig(&brief("beta"))).unwrap();
        assert!(j < 0.1, "unrelated briefs estimated at {j}");
    }

    #[test]
    fn context_sig_mostly_shared_briefs_cross_the_threshold() {
        // The same 20 KiB spec plus a short per-worker task line.
        let spec = brief("spec");
        let a = sig(&format!("{spec} worker one: handle the parser module"));
        let b = sig(&format!("{spec} worker two: handle the renderer module"));
        let j = a.jaccard(&b).unwrap();
        assert!(j >= 0.85, "mostly shared briefs estimated at {j}");
    }

    #[test]
    fn context_sig_half_shared_briefs_stay_under_the_threshold() {
        let shared = words("common", 1300);
        let a = sig(&format!("{shared} {}", words("left", 1300)));
        let b = sig(&format!("{shared} {}", words("right", 1300)));
        let j = a.jaccard(&b).unwrap();
        // True Jaccard is about 1/3.
        assert!(
            (0.1..0.6).contains(&j),
            "half-shared briefs estimated at {j}"
        );
    }

    #[test]
    fn context_sig_field_round_trips_with_colons_in_the_parent() {
        let s = sig(&brief("x"));
        let encoded = encode_field(&s, "lead:node:1");
        let stored = decode_field(&encoded).expect("decodes");
        assert_eq!(stored.sig, s);
        assert_eq!(stored.parent, "lead:node:1");
        // About 700 bytes a field, so 32 fields stay near 22 KiB.
        assert!(encoded.len() < 720, "{}", encoded.len());
    }

    #[test]
    fn context_sig_damaged_fields_do_not_decode() {
        let s = sig(&brief("x"));
        let good = encode_field(&s, "p");
        for bad in [
            "",
            "no-colons",
            "abc:p",
            "!!!:p:10",
            "QUJD:p:10", // valid base64, wrong length
            &good.replace(":p:", ":p:x"),
        ] {
            assert!(decode_field(bad).is_none(), "{bad:?} decoded");
        }
    }

    #[test]
    fn context_sig_sibling_candidate_needs_a_real_graph_below_the_root() {
        assert!(is_sibling_candidate("g", "n1", "lead", 1));
        assert!(!is_sibling_candidate("n1", "n1", "lead", 1), "graph of one");
        assert!(!is_sibling_candidate("g", "n1", "lead", 0), "root");
        assert!(!is_sibling_candidate("g", "n1", "", 1), "no parent");
        assert!(!is_sibling_candidate("", "n1", "lead", 1));
    }

    #[test]
    fn context_sig_best_sibling_matches_same_parent_other_node() {
        let shared = sig(&brief("shared"));
        let other = sig(&brief("other"));
        let fields = [
            ("n1".to_string(), encode_field(&shared, "lead")), // self: a retry
            ("n2".to_string(), encode_field(&other, "lead")),
            ("n3".to_string(), encode_field(&shared, "lead")),
            ("n4".to_string(), encode_field(&shared, "other-lead")), // cousin
            ("n5".to_string(), "garbage".to_string()),
        ];
        let iter = fields.iter().map(|(k, v)| (k.as_str(), v.as_str()));
        let best = best_sibling("n1", "lead", &shared, iter).expect("a sibling");
        assert_eq!(best.node, "n3");
        assert_eq!(best.jaccard, 1.0);
        assert_eq!(best.bytes, shared.bytes());
    }

    #[test]
    fn context_sig_best_sibling_ignores_self_and_cousins() {
        let s = sig(&brief("shared"));
        let fields = [
            ("n1".to_string(), encode_field(&s, "lead")),
            ("n4".to_string(), encode_field(&s, "other-lead")),
        ];
        let iter = fields.iter().map(|(k, v)| (k.as_str(), v.as_str()));
        assert!(best_sibling("n1", "lead", &s, iter).is_none());
    }

    #[test]
    fn context_sig_best_sibling_tie_break_is_order_independent() {
        let s = sig(&brief("shared"));
        let mut fields = [
            ("n9".to_string(), encode_field(&s, "lead")),
            ("n2".to_string(), encode_field(&s, "lead")),
            ("n5".to_string(), encode_field(&s, "lead")),
        ];
        for _ in 0..3 {
            fields.rotate_left(1);
            let iter = fields.iter().map(|(k, v)| (k.as_str(), v.as_str()));
            assert_eq!(best_sibling("n1", "lead", &s, iter).unwrap().node, "n2");
        }
    }

    #[test]
    fn context_sig_memory_store_is_set_if_absent() {
        let mut store = CtxSigMemoryStore::new();
        assert!(store.set_if_absent("g", "n1", "first".into(), 0));
        assert!(!store.set_if_absent("g", "n1", "second".into(), 1));
        assert_eq!(
            store.get_all("g", 2),
            vec![("n1".to_string(), "first".to_string())]
        );
    }

    #[test]
    fn context_sig_memory_store_caps_fields_per_graph() {
        let mut store = CtxSigMemoryStore::new();
        for i in 0..CTXSIG_MAX_FIELDS {
            assert!(store.set_if_absent("g", &format!("n{i:02}"), "v".into(), 0));
        }
        assert!(!store.set_if_absent("g", "late", "v".into(), 0));
        assert_eq!(store.get_all("g", 0).len(), CTXSIG_MAX_FIELDS);
    }

    #[test]
    fn context_sig_memory_store_expires_after_the_ttl_from_last_write() {
        let mut store = CtxSigMemoryStore::new();
        assert!(store.set_if_absent("g", "n1", "v".into(), 0));
        assert!(store.set_if_absent("g", "n2", "v".into(), 100));
        // Refreshed by the second write.
        assert_eq!(store.get_all("g", CTXSIG_TTL_SECS + 50).len(), 2);
        assert!(store.get_all("g", CTXSIG_TTL_SECS + 100).is_empty());
        // Expired means absent, so the node can be stored again.
        assert!(store.set_if_absent("g", "n1", "v".into(), CTXSIG_TTL_SECS + 200));
    }

    #[test]
    fn context_sig_memory_store_evicts_least_recently_used_graph() {
        let mut store = CtxSigMemoryStore::new();
        for i in 0..CTXSIG_MEMORY_GRAPHS {
            store.set_if_absent(&format!("g{i}"), "n", "v".into(), 0);
        }
        // Touch g0 so g1 is now the oldest.
        assert_eq!(store.get_all("g0", 0).len(), 1);
        store.set_if_absent("new", "n", "v".into(), 0);
        assert_eq!(store.len(), CTXSIG_MEMORY_GRAPHS);
        assert_eq!(store.get_all("g0", 0).len(), 1);
        assert!(store.get_all("g1", 0).is_empty());
        assert_eq!(store.get_all("new", 0).len(), 1);
    }

    #[test]
    fn context_sig_worst_case_input_is_fast() {
        // The 512 KiB cap of distinct words: the linear worst case.
        let text = words("w", 120_000);
        let start = std::time::Instant::now();
        let s = signature_of_normalised(&normalise(&[&text])).unwrap();
        assert_eq!(s.bytes() as usize, normalise(&[&text]).len());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            start.elapsed()
        );
    }
}
