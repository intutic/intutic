//! Semantic and exact response cache plugin.
//!
//! Handles exact-match cache hits via SHA-256 prompt hashing and
//! semantic-match cache hits via TurboVec cosine-similarity.

use crate::protocol::Protocol;
use crate::store::LocalStore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Re-exported from the store layer, which owns the on-the-wire shape.
pub use crate::store::CachedResponse;

/// Exact-cache entry lifetime.
const RESPONSE_CACHE_TTL_SECS: u64 = 86_400;

/// Hashed into every key. Bump it whenever what a key covers changes: entries
/// written under an older scheme are then never looked up again and expire
/// within `RESPONSE_CACHE_TTL_SECS`.
///
/// v1 keyed on the workspace plus the plain text of the user/system messages
/// only, so an agent loop's turn 2 (prompt, assistant tool call, tool result)
/// hashed like turn 1 and was answered with turn 1's reply. v1 keys were
/// `sha256("{workspace}\n{text}")`, a preimage no v2 key can share, and v1
/// semantic-index entries carry no context, so the semantic path rejects them.
const CACHE_KEY_VERSION: &str = "response-cache/v2";

/// Top-level request fields that cannot change the answer, and so are left
/// out of the key. **Every other field is in it** — model, `messages` /
/// `input` / `contents` in full (assistant turns, `tool_use`, `tool_result`,
/// `function_call`, `function_call_output` and every other part type, not just
/// text), top-level `system` / `instructions`, `tools`, `tool_choice`,
/// `response_format` / `text`, `thinking` / `reasoning`, and every sampling
/// parameter (`temperature`, `top_p`, `top_k`, `max_tokens`, `stop`, `seed`,
/// ...). A field this list misses costs a cache miss; a field the key missed
/// cost a wrong answer, which is why the key is everything-but rather than a
/// list of what matters.
///
/// `store` is here because only `store: false` Responses requests are cached
/// at all (see `cache_keys`); on chat completions it only asks the provider to
/// keep a copy.
const KEY_IGNORED_FIELDS: &[&str] = &[
    "stream",
    "stream_options",
    "metadata",
    "user",
    "store",
    "safety_identifier",
    "prompt_cache_key",
];

/// The cache addresses for one request, derived once by `cache_keys` and used
/// for both the lookup and the write, so the two cannot disagree about which
/// entry a request owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheKeys {
    /// The store key of this request's exact-match entry.
    exact: String,
    /// Present only when a similar request may answer this one.
    semantic: Option<SemanticKey>,
}

/// What the semantic cache compares: the user's question by embedding, and
/// everything else about the request by exact hash.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticKey {
    /// The user-message text, which is all that is embedded.
    question: String,
    /// Hash of the request with the user-message text removed. A similarity
    /// hit is served only when this matches exactly.
    context: String,
}

/// Derive the cache keys for a request, or `None` when the request must not
/// use the response cache at all:
///
/// - `Protocol::Unknown`: there is no wire shape to replay a hit in.
/// - `n` other than 1: a cached entry holds one answer.
/// - A Responses request without `store: false`: the provider keeps that
///   response so the client can continue from it with `previous_response_id`,
///   and a replayed reply carries an id the provider never issued.
///
/// `model` is the model the client asked for (Gemini names it in the URL, not
/// the body), and is part of the key.
pub fn cache_keys(
    workspace_id: &str,
    model: &str,
    protocol: &Protocol,
    body: &Value,
) -> Option<CacheKeys> {
    let obj = body.as_object()?;
    if *protocol == Protocol::Unknown {
        return None;
    }
    if obj.get("n").is_some_and(|n| n.as_u64() != Some(1)) {
        return None;
    }
    if *protocol == Protocol::OpenAIResponses && obj.get("store") != Some(&Value::Bool(false)) {
        return None;
    }

    let mut keyed = obj.clone();
    for field in KEY_IGNORED_FIELDS {
        keyed.remove(*field);
    }
    let keyed = Value::Object(keyed);
    Some(CacheKeys {
        exact: hash_request("exact", workspace_id, model, &keyed),
        semantic: semantic_key(workspace_id, model, keyed),
    })
}

/// The semantic half of the key, for a request a similar one may answer.
///
/// The rule: **only a single exchange of plain text, with no tools declared**
/// — every message is system/developer/user and every content part is text.
/// Assistant turns, tool calls and tool results are context an embedding of
/// the question cannot see, so a request carrying any of them is exact-only.
///
/// Within that, only the user's text is embedded; the rest (model, system
/// prompt, sampling parameters) must match exactly through `context`. Embedding
/// the system prompt with the question let a long shared system prompt
/// dominate the vector, so two different short questions scored as near
/// duplicates.
fn semantic_key(workspace_id: &str, model: &str, mut keyed: Value) -> Option<SemanticKey> {
    for tools_field in ["tools", "tool_choice", "functions", "function_call"] {
        if keyed.get(tools_field).is_some_and(|v| !v.is_null()) {
            return None;
        }
    }
    let list_field = if keyed.get("messages").is_some() {
        "messages"
    } else {
        "input"
    };
    let mut question = String::new();
    match keyed.get_mut(list_field)? {
        // Responses `input` as a bare string is one user message.
        Value::String(text) => question = std::mem::take(text),
        Value::Array(messages) => {
            for msg in messages {
                // Responses items without `type` are messages; any other
                // type (function_call, reasoning, ...) is not plain text.
                if msg.get("type").is_some_and(|t| t != "message") {
                    return None;
                }
                let is_user = match msg.get("role").and_then(Value::as_str)? {
                    "user" => true,
                    "system" | "developer" => false,
                    _ => return None,
                };
                let text = plain_text(msg.get("content")?)?;
                if is_user {
                    if !question.is_empty() {
                        question.push('\n');
                    }
                    question.push_str(&text);
                    msg["content"] = Value::Null;
                }
            }
        }
        _ => return None,
    }
    if question.is_empty() {
        return None;
    }
    Some(SemanticKey {
        question,
        context: hash_request("semantic-context", workspace_id, model, &keyed),
    })
}

/// A message's content when it is nothing but text, in any of the shapes the
/// three message APIs use; `None` when it holds anything else.
fn plain_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let mut text = String::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text") => text.push_str(part.get("text")?.as_str()?),
                    _ => return None,
                }
            }
            Some(text)
        }
        _ => None,
    }
}

fn hash_request(kind: &str, workspace_id: &str, model: &str, keyed: &Value) -> String {
    let mut canonical = String::new();
    write_canonical_json(keyed, &mut canonical);
    // Salted with the workspace: two tenants sending the same request must
    // never share an entry — including responses generated with the other
    // tenant's injected SOPs.
    compute_sha256(&format!(
        "{CACHE_KEY_VERSION}\n{kind}\n{workspace_id}\n{model}\n{canonical}"
    ))
}

/// JSON with object keys sorted, so two clients that order fields differently
/// share an entry. Needed explicitly: serde_json's `preserve_order` feature is
/// on in this build, so `to_string` keeps insertion order.
fn write_canonical_json(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                write_canonical_json(&map[k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical_json(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// The reference a semantic-index entry stores in TurboVec's `hash` field:
/// the request's context, then the exact key of the entry it answers. The
/// context travels with the vector because TurboVec keeps no other metadata.
fn semantic_ref(semantic: &SemanticKey, exact: &str) -> String {
    format!("{}:{exact}", semantic.context)
}

/// The exact key a semantic-index entry points at, if that entry was written
/// for the same context. v1 entries (a bare hash, no context) never match.
fn exact_key_for_context<'a>(stored_ref: &'a str, context: &str) -> Option<&'a str> {
    let (ctx, exact) = stored_ref.split_once(':')?;
    (ctx == context).then_some(exact)
}

/// Whether a complete response body is plain assistant text and nothing else.
///
/// A `CachedResponse` holds one text string, and a hit is replayed as a plain
/// text reply. A response that called a tool (or carried thinking, a second
/// choice, or any other non-text output) replayed that way would lose the very
/// part the client acts on, so it is not cached.
pub fn is_text_only_response(body: &Value) -> bool {
    let is_type = |v: &Value, t: &str| v.get("type").and_then(Value::as_str) == Some(t);
    if let Some(blocks) = body.get("content").and_then(Value::as_array) {
        return blocks.iter().all(|b| is_type(b, "text"));
    }
    if let Some(choices) = body.get("choices").and_then(Value::as_array) {
        let absent = |v: Option<&Value>| match v {
            None | Some(Value::Null) => true,
            Some(Value::Array(a)) => a.is_empty(),
            Some(_) => false,
        };
        return choices.len() == 1
            && absent(choices[0]["message"].get("tool_calls"))
            && absent(choices[0]["message"].get("function_call"));
    }
    if let Some(output) = body.get("output").and_then(Value::as_array) {
        return output.iter().all(|item| is_type(item, "message"));
    }
    if let Some(candidates) = body.get("candidates").and_then(Value::as_array) {
        return candidates.len() == 1
            && candidates[0]["content"]["parts"]
                .as_array()
                .is_some_and(|parts| {
                    parts.iter().all(|p| {
                        p.as_object()
                            .is_some_and(|o| o.len() == 1 && o.contains_key("text"))
                    })
                });
    }
    false
}

/// Whether one SSE line shows its stream carries more than plain assistant
/// text — the streaming half of `is_text_only_response`. Reads all three
/// stream shapes whatever the request's protocol, because a cross-provider
/// stream arrives in the upstream's shape.
pub fn sse_line_is_beyond_text(line: &str) -> bool {
    let Some(data) = line.strip_prefix("data:") else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(data.trim()) else {
        return false;
    };
    match v.get("type").and_then(Value::as_str) {
        // Anthropic: any content block but text (tool_use, thinking, ...).
        Some("content_block_start") => v["content_block"]["type"] != "text",
        // Responses: any output item but a message (function_call, reasoning, ...).
        Some("response.output_item.added") => v["item"]["type"] != "message",
        _ => v
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|c| {
                    c["index"].as_u64().unwrap_or(0) > 0
                        || !c["delta"]["tool_calls"].is_null()
                        || !c["delta"]["function_call"].is_null()
                })
            }),
    }
}

/// Helper to extract text from prompts across OpenAI, Anthropic, and Gemini payloads.
pub fn extract_prompt_text(body: &Value) -> String {
    let mut prompt = String::new();

    if let Some(messages) = body.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" || role == "system" || role == "developer" {
                if let Some(content) = msg.get("content") {
                    if let Some(txt) = content.as_str() {
                        if !prompt.is_empty() {
                            prompt.push('\n');
                        }
                        prompt.push_str(txt);
                    } else if let Some(arr) = content.as_array() {
                        for part in arr {
                            if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                                if let Some(txt) = part.get("text").and_then(|v| v.as_str()) {
                                    if !prompt.is_empty() {
                                        prompt.push('\n');
                                    }
                                    prompt.push_str(txt);
                                }
                            }
                        }
                    }
                }
            }
        }
    } else if let Some(input) = body.get("input").and_then(|v| v.as_array()) {
        for msg in input {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" || role == "developer" || role == "system" {
                if let Some(content) = msg.get("content") {
                    if let Some(txt) = content.as_str() {
                        if !prompt.is_empty() {
                            prompt.push('\n');
                        }
                        prompt.push_str(txt);
                    }
                }
            }
        }
    } else if let Some(contents) = body.get("contents").and_then(|v| v.as_array()) {
        for content in contents {
            if let Some(parts) = content.get("parts").and_then(|p| p.as_array()) {
                for part in parts {
                    if let Some(txt) = part.get("text").and_then(|t| t.as_str()) {
                        if !prompt.is_empty() {
                            prompt.push('\n');
                        }
                        prompt.push_str(txt);
                    }
                }
            }
        }
    }

    if let Some(system) = body.get("system").and_then(|v| v.as_str()) {
        let mut full_prompt = system.to_string();
        if !prompt.is_empty() {
            full_prompt.push('\n');
            full_prompt.push_str(&prompt);
        }
        return full_prompt;
    }

    prompt
}

/// Compute SHA-256 hex string of prompt
pub fn compute_sha256(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// Generate prompt embedding using configured embedding generator
async fn generate_embedding(
    http_client: &reqwest::Client,
    prompt: &str,
) -> Result<Vec<f32>, anyhow::Error> {
    let embed_url = std::env::var("EMBEDDING_GENERATOR_URL")
        .unwrap_or_else(|_| "http://localhost:8085/v1/embeddings".to_string());

    // Check if we need to call standard OpenAI-style /v1/embeddings
    let body = json!({
        "input": prompt,
        "model": "text-embedding-3-small"
    });

    let resp = http_client
        .post(&embed_url)
        .timeout(std::time::Duration::from_millis(1500))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow::anyhow!(
            "Embedding generator returned status {}",
            resp.status()
        ));
    }

    let res_json: Value = resp.json().await?;
    let embedding = res_json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("embedding"))
        .and_then(|emb| emb.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect::<Vec<f32>>()
        })
        .ok_or_else(|| anyhow::anyhow!("Failed to parse embedding from response"))?;

    Ok(embedding)
}

/// Default base URL of the TurboVec wrapper when `TURBOVEC_URL` is unset.
const TURBOVEC_DEFAULT_BASE: &str = "http://localhost:8083";

/// Resolve a TurboVec endpoint from the `TURBOVEC_URL` **base** URL.
///
/// `TURBOVEC_URL` is the service's base (`http://turbovec:8080`, what the
/// enterprise compose file sets); the two routes hang off it. Until
/// 2026-09-26 the query and the insert path each read the same variable
/// and each defaulted to its own full route, so any single value an
/// operator set — the compose one included — sent inserts to the query
/// route or queries to the insert route. A value that already ends in one
/// of the two routes is accepted and normalised so an older deployment's
/// setting keeps working.
fn turbovec_endpoint(route: &str) -> String {
    let raw = std::env::var("TURBOVEC_URL").unwrap_or_else(|_| TURBOVEC_DEFAULT_BASE.to_string());
    turbovec_endpoint_from(&raw, route)
}

pub(crate) fn turbovec_endpoint_from(raw: &str, route: &str) -> String {
    let mut base = raw.trim().trim_end_matches('/').to_string();
    for legacy in ["/vectors/query", "/vectors/insert"] {
        if let Some(stripped) = base.strip_suffix(legacy) {
            base = stripped.trim_end_matches('/').to_string();
        }
    }
    if base.is_empty() {
        base = TURBOVEC_DEFAULT_BASE.to_string();
    }
    format!("{base}{route}")
}

/// How many nearest neighbours to ask TurboVec for. The index is shared by
/// every context in a workspace, so the nearest vector can be the same
/// question asked of another model; looking a little further keeps those from
/// hiding a same-context match.
const SEMANTIC_CANDIDATES: u32 = 5;

/// Minimum cosine similarity for a semantic hit.
const SEMANTIC_MIN_SCORE: f64 = 0.95;

/// Query TurboVec for the nearest neighbours, best first, as (stored ref, score).
async fn query_turbovec(
    http_client: &reqwest::Client,
    vector: &[f32],
    workspace_id: &str,
) -> Result<Vec<(String, f64)>, anyhow::Error> {
    let turbovec_url = turbovec_endpoint("/vectors/query");

    let body = json!({
        "vector": vector,
        "workspaceId": workspace_id,
        "topK": SEMANTIC_CANDIDATES
    });

    let resp = http_client
        .post(&turbovec_url)
        .timeout(std::time::Duration::from_millis(1500))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow::anyhow!(
            "TurboVec returned status {}",
            resp.status()
        ));
    }

    let results: Value = resp.json().await?;
    Ok(results
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let score = r.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let stored_ref = r
                .get("metadata")
                .and_then(|m| m.get("hash"))
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .to_string();
            (stored_ref, score)
        })
        .collect())
}

/// Checks the exact/semantic response cache.
/// Returns Option<CachedResponse> on hit.
pub async fn check_cache(
    store: &Arc<dyn LocalStore>,
    http_client: &reqwest::Client,
    workspace_id: &str,
    keys: &CacheKeys,
    body_json: &Value,
    ff_exact: bool,
    ff_semantic: bool,
) -> Option<CachedResponse> {
    if !ff_exact && !ff_semantic {
        return None;
    }

    // 1. Exact Match Path
    if ff_exact {
        if let Some(cached) = store.cached_response(&keys.exact).await {
            store
                .incr_cache_counter(workspace_id, "exact_hits", 1)
                .await;
            // Calculate savings
            let raw_cost: f64 = body_json
                .get("model")
                .map(|_| 0.0015) // Mock cost calculation fallback if prices not parsed
                .unwrap_or(0.0);
            store.add_cache_savings(workspace_id, raw_cost).await;
            return Some(cached);
        }
    }

    // 2. Semantic Match Path
    if let (true, Some(semantic)) = (ff_semantic, &keys.semantic) {
        let embedding = match generate_embedding(http_client, &semantic.question).await {
            Ok(emb) => emb,
            Err(e) => {
                let desc = format!("Embedding generator unreachable or slow: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                store.publish_system_anomaly(workspace_id, &desc).await;
                return None; // Fail-open
            }
        };

        let nearest = match query_turbovec(http_client, &embedding, workspace_id).await {
            Ok(n) => n,
            Err(e) => {
                let desc = format!("TurboVec sidecar unreachable or slow: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                store.publish_system_anomaly(workspace_id, &desc).await;
                return None; // Fail-open
            }
        };

        // Similar enough AND written for the same context: the score only
        // compares the questions.
        let matched = nearest.iter().find_map(|(stored_ref, score)| {
            (*score >= SEMANTIC_MIN_SCORE)
                .then(|| exact_key_for_context(stored_ref, &semantic.context))
                .flatten()
        });
        if let Some(exact_key) = matched {
            if let Some(cached) = store.cached_response(exact_key).await {
                store
                    .incr_cache_counter(workspace_id, "semantic_hits", 1)
                    .await;
                let raw_cost: f64 = body_json.get("model").map(|_| 0.0015).unwrap_or(0.0);
                store.add_cache_savings(workspace_id, raw_cost).await;
                return Some(cached);
            }
        }
    }

    // Cache Miss
    store.incr_cache_counter(workspace_id, "misses", 1).await;
    None
}

/// Writes a response to exact and semantic cache.
#[allow(clippy::too_many_arguments)]
/// Where a response came from, and therefore whether it may be cached.
///
/// A parameter rather than a convention, because "remember not to cache the
/// mirrored one" is exactly the kind of rule that holds until someone adds a
/// third call site. A mirrored response is one the caller **discarded** — it was
/// produced by a model the user did not ask for and never received. Caching it
/// would later serve a discarded model's output to a real user as though they
/// had asked for it, and nothing downstream would show that had happened.
///
/// This is the sharpest hazard in the routing plan, so it is enforced here at
/// the one place that writes, not at each place that calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseProvenance {
    /// Returned to the caller. Cacheable.
    Served,
    /// Produced by a mirrored request and thrown away. Never cacheable.
    Mirrored,
}

// Eleven request-scoped values from the two call sites in proxy.rs; a struct
// would exist only to satisfy the argument-count threshold.
#[allow(clippy::too_many_arguments)]
pub async fn write_cache(
    provenance: ResponseProvenance,
    store: &Arc<dyn LocalStore>,
    http_client: &reqwest::Client,
    workspace_id: &str,
    keys: &CacheKeys,
    body_json: &Value,
    completion_text: &str,
    model_name: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    ff_semantic: bool,
) -> Result<(), anyhow::Error> {
    if provenance == ResponseProvenance::Mirrored {
        // Not an error: mirroring is expected to reach here and be refused.
        // Refusing at the write is what makes the guarantee structural — a new
        // call site inherits it without knowing it exists.
        tracing::debug!(
            workspace_id = %workspace_id,
            model = %model_name,
            "Refusing to cache a mirrored response"
        );
        return Ok(());
    }

    let cached_resp = CachedResponse {
        prompt: extract_prompt_text(body_json),
        response: completion_text.to_string(),
        model: model_name.to_string(),
        prompt_tokens,
        completion_tokens,
        cached_at: chrono::Utc::now().to_rfc3339(),
    };

    // Save exact cache (TTL 24 hours)
    store
        .store_response(&keys.exact, &cached_resp, RESPONSE_CACHE_TTL_SECS)
        .await?;

    // Increment cache size metric
    store
        .incr_cache_counter(workspace_id, "cache_size", 1)
        .await;

    // Write to TurboVec for semantic cache if enabled
    if let (true, Some(semantic)) = (ff_semantic, &keys.semantic) {
        match generate_embedding(http_client, &semantic.question).await {
            Ok(embedding) => {
                let turbovec_url = turbovec_endpoint("/vectors/insert");

                let body = json!({
                    "vector": embedding,
                    "metadata": {
                        "hash": semantic_ref(semantic, &keys.exact),
                        "workspaceId": workspace_id
                    }
                });

                let resp = http_client
                    .post(&turbovec_url)
                    .timeout(std::time::Duration::from_millis(1500))
                    .json(&body)
                    .send()
                    .await;

                if let Err(e) = resp {
                    let desc = format!("Failed to insert vector into TurboVec: {}", e);
                    tracing::warn!(%workspace_id, "{}", desc);
                    store.publish_system_anomaly(workspace_id, &desc).await;
                }
            }
            Err(e) => {
                let desc = format!("Failed to generate embedding for cache insert: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                store.publish_system_anomaly(workspace_id, &desc).await;
            }
        }
    }

    Ok(())
}

/// Constructs a provider-specific mock response JSON from a CachedResponse.
pub fn construct_mock_response(
    protocol: &Protocol,
    cached: &CachedResponse,
    requested_model: &str,
) -> Value {
    match protocol {
        Protocol::Anthropic => json!({
            "id": format!("msg_cached_{}", nanoid::nanoid!(16)),
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": cached.response
                }
            ],
            "model": requested_model,
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": {
                "input_tokens": cached.prompt_tokens,
                "output_tokens": cached.completion_tokens
            }
        }),
        Protocol::OpenAIChatCompletions => json!({
            "id": format!("chatcmpl-cached-{}", nanoid::nanoid!(16)),
            "object": "chat.completion",
            "created": chrono::Utc::now().timestamp(),
            "model": requested_model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": cached.response
                    },
                    "logprobs": null,
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": cached.prompt_tokens,
                "completion_tokens": cached.completion_tokens,
                "total_tokens": cached.prompt_tokens + cached.completion_tokens
            }
        }),
        // The Responses API answers with `output[]` items, not `choices[]`; a
        // Codex CLI client cannot read a chat-completions body.
        Protocol::OpenAIResponses => responses_object(cached, requested_model),
        Protocol::Gemini => json!({
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": cached.response
                            }
                        ],
                        "role": "model"
                    },
                    "finishReason": "STOP",
                    "index": 0
                }
            ],
            "usageMetadata": {
                "promptTokenCount": cached.prompt_tokens,
                "candidatesTokenCount": cached.completion_tokens,
                "totalTokenCount": cached.prompt_tokens + cached.completion_tokens
            }
        }),
        _ => json!({
            "response": cached.response,
            "model": requested_model
        }),
    }
}

/// A completed Responses API `response` object carrying the cached text: the
/// whole non-streaming body, and the payload of a stream's `response.completed`.
fn responses_object(cached: &CachedResponse, requested_model: &str) -> Value {
    json!({
        "id": format!("resp_cached_{}", nanoid::nanoid!(16)),
        "object": "response",
        "created_at": chrono::Utc::now().timestamp(),
        "status": "completed",
        "model": requested_model,
        "output": [{
            "id": format!("msg_cached_{}", nanoid::nanoid!(16)),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": cached.response, "annotations": [] }]
        }],
        "usage": {
            "input_tokens": cached.prompt_tokens,
            "output_tokens": cached.completion_tokens,
            "total_tokens": cached.prompt_tokens + cached.completion_tokens
        }
    })
}

/// The `text/event-stream` body a cache hit is served as when the request
/// asked for `"stream": true`: the cached text as one complete stream in the
/// request's protocol, ending with that protocol's terminal event.
///
/// A hit used to be one JSON body whatever the request asked for, so every
/// streaming client — Claude Code, Codex CLI and Cursor all stream by default —
/// got a body it could not parse as a stream.
pub fn construct_mock_stream(
    protocol: &Protocol,
    cached: &CachedResponse,
    requested_model: &str,
) -> String {
    let text = cached.response.as_str();
    match protocol {
        Protocol::Anthropic => {
            let start = json!({
                "type": "message_start",
                "message": {
                    "id": format!("msg_cached_{}", nanoid::nanoid!(16)),
                    "type": "message", "role": "assistant", "content": [],
                    "model": requested_model, "stop_reason": null, "stop_sequence": null,
                    "usage": { "input_tokens": cached.prompt_tokens, "output_tokens": 0 }
                }
            });
            let block_start = json!({ "type": "content_block_start", "index": 0,
                "content_block": { "type": "text", "text": "" } });
            let delta = json!({ "type": "content_block_delta", "index": 0,
                "delta": { "type": "text_delta", "text": text } });
            let block_stop = json!({ "type": "content_block_stop", "index": 0 });
            let msg_delta = json!({ "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": cached.completion_tokens } });
            let stop = json!({ "type": "message_stop" });
            format!(
                "event: message_start\ndata: {start}\n\n\
                 event: content_block_start\ndata: {block_start}\n\n\
                 event: content_block_delta\ndata: {delta}\n\n\
                 event: content_block_stop\ndata: {block_stop}\n\n\
                 event: message_delta\ndata: {msg_delta}\n\n\
                 event: message_stop\ndata: {stop}\n\n"
            )
        }
        Protocol::OpenAIChatCompletions => {
            let id = format!("chatcmpl-cached-{}", nanoid::nanoid!(16));
            let created = chrono::Utc::now().timestamp();
            let chunk = |delta: Value, finish: Value| {
                json!({
                    "id": id, "object": "chat.completion.chunk", "created": created,
                    "model": requested_model,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }]
                })
            };
            let content = chunk(json!({ "role": "assistant", "content": text }), Value::Null);
            let finish = chunk(json!({}), json!("stop"));
            format!("data: {content}\n\ndata: {finish}\n\ndata: [DONE]\n\n")
        }
        Protocol::OpenAIResponses => {
            let completed = responses_object(cached, requested_model);
            let item_id = completed["output"][0]["id"].as_str().unwrap_or_default();
            let created = json!({ "type": "response.created", "response": {
                "id": completed["id"], "object": "response", "status": "in_progress",
                "model": requested_model, "output": [] } });
            let done = json!({ "type": "response.completed", "response": completed });
            format!(
                "event: response.created\ndata: {created}\n\n{}\
                 event: response.completed\ndata: {done}\n\n",
                crate::commands::responses_message_events(text, 0, item_id),
            )
        }
        // Gemini's `alt=sse` stream is the non-streaming response object as
        // `data:` events; one carries the whole answer. `cache_keys` keeps
        // `Unknown` out of the cache, so nothing else reaches this arm.
        _ => format!(
            "data: {}\n\n",
            construct_mock_response(protocol, cached, requested_model)
        ),
    }
}

#[cfg(test)]
mod tests {
    // No `use super::ResponseProvenance` here: the two source-text tests below
    // name it only inside string literals, and `use super::*` further down
    // covers every test that uses it as a type. Importing it explicitly was an
    // unused import, and this crate is held to zero warnings.

    /// The sharpest hazard in the routing plan, asserted at the source.
    ///
    /// A mirrored response was produced by a model the user did not ask for and
    /// never received. Caching it would later serve a discarded model's output
    /// to a real user as though they had asked for it — and nothing downstream
    /// would show that had happened, because a cache hit looks identical
    /// whichever model filled the entry.
    ///
    /// The guarantee is structural: `write_cache` takes the provenance, so a new
    /// call site inherits the refusal without knowing it exists. That is the
    /// difference between this and a comment saying "do not cache mirrored
    /// responses", which holds until someone adds the third caller.
    #[test]
    fn turbovec_url_is_a_base_and_both_routes_hang_off_it() {
        assert_eq!(
            turbovec_endpoint_from("http://turbovec:8080", "/vectors/query"),
            "http://turbovec:8080/vectors/query"
        );
        assert_eq!(
            turbovec_endpoint_from("http://turbovec:8080/", "/vectors/insert"),
            "http://turbovec:8080/vectors/insert"
        );
    }

    #[test]
    fn a_legacy_full_route_in_turbovec_url_still_reaches_both_routes() {
        // The pre-2026-09-26 shape: the whole query route in the variable.
        assert_eq!(
            turbovec_endpoint_from("http://localhost:8083/vectors/query", "/vectors/insert"),
            "http://localhost:8083/vectors/insert"
        );
        assert_eq!(
            turbovec_endpoint_from("http://localhost:8083/vectors/insert/", "/vectors/query"),
            "http://localhost:8083/vectors/query"
        );
    }

    #[test]
    fn an_empty_turbovec_url_falls_back_to_the_default_base() {
        assert_eq!(
            turbovec_endpoint_from("  ", "/vectors/query"),
            "http://localhost:8083/vectors/query"
        );
    }

    #[test]
    fn write_cache_takes_provenance_so_the_guard_cannot_be_forgotten() {
        let src = include_str!("semantic_cache.rs");

        // The parameter is FIRST, so a call site cannot omit it and compile.
        assert!(
            src.contains("pub async fn write_cache(\n    provenance: ResponseProvenance,"),
            "provenance must be the first parameter of write_cache; moving it later \
             lets a new call site default it by position"
        );

        // And it must actually refuse, not merely record.
        assert!(
            src.contains("if provenance == ResponseProvenance::Mirrored {"),
            "write_cache accepts a provenance it does not act on"
        );
        let refusal = src
            .split("if provenance == ResponseProvenance::Mirrored {")
            .nth(1)
            .expect("guard present");
        let body = &refusal[..refusal.find('}').unwrap_or(refusal.len())];
        assert!(
            body.contains("return Ok(())"),
            "the mirrored branch must return before writing, got: {body}"
        );
    }

    /// Every caller says which it is, explicitly.
    #[test]
    fn every_call_site_states_its_provenance() {
        let proxy = include_str!("../proxy.rs");
        let calls = proxy.matches("semantic_cache::write_cache(").count();
        let stated = proxy.matches("ResponseProvenance::Served").count()
            + proxy.matches("ResponseProvenance::Mirrored").count();
        assert!(
            calls > 0,
            "no call sites found — this test asserted nothing"
        );
        assert_eq!(
            calls, stated,
            "{calls} write_cache call(s) but {stated} stated provenance"
        );
    }

    use super::*;
    use serde_json::json;

    fn anthropic(messages: Value) -> Value {
        json!({ "model": "claude-sonnet-4-5", "max_tokens": 64, "messages": messages })
    }

    fn keys(body: &Value) -> CacheKeys {
        cache_keys("ws_alpha", "claude-sonnet-4-5", &Protocol::Anthropic, body)
            .expect("cacheable request")
    }

    /// Two tenants sending a byte-identical request must land on two
    /// different entries — exact and semantic — and never read each other's
    /// cached completions, including responses generated with the other
    /// tenant's injected SOPs.
    #[test]
    fn response_cache_keys_are_salted_per_workspace_not_shared() {
        let body = anthropic(json!([{ "role": "user", "content": "delete the records" }]));
        let a = cache_keys("ws_alpha", "m", &Protocol::Anthropic, &body).unwrap();
        let b = cache_keys("ws_beta", "m", &Protocol::Anthropic, &body).unwrap();
        assert_ne!(a.exact, b.exact);
        assert_ne!(
            a.semantic.unwrap().context,
            b.semantic.unwrap().context,
            "the semantic context must be per-workspace too"
        );
    }

    /// The bug this key exists to prevent: an agent loop's turn 2 adds only
    /// an assistant tool call and a tool result, no new user text.
    #[test]
    fn an_anthropic_tool_loop_turn_has_its_own_key() {
        let user = json!({ "role": "user", "content": "What does README.md say?" });
        let turn1 = anthropic(json!([user]));
        let turn2 = anthropic(json!([
            user,
            { "role": "assistant", "content": [
                { "type": "tool_use", "id": "toolu_1", "name": "read_file",
                  "input": { "path": "README.md" } }] },
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "hello" }] }
        ]));
        let mut turn2_other_result = turn2.clone();
        turn2_other_result["messages"][2]["content"][0]["content"] = json!("goodbye");
        assert_ne!(keys(&turn1).exact, keys(&turn2).exact);
        assert_ne!(keys(&turn2).exact, keys(&turn2_other_result).exact);
    }

    #[test]
    fn an_openai_chat_tool_loop_turn_has_its_own_key() {
        let user = json!({ "role": "user", "content": "What does README.md say?" });
        let body = |messages: Value| json!({ "model": "gpt-4o", "messages": messages });
        let k = |b: &Value| {
            cache_keys("ws", "gpt-4o", &Protocol::OpenAIChatCompletions, b)
                .unwrap()
                .exact
        };
        let turn1 = body(json!([user]));
        let turn2 = body(json!([
            user,
            { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_1",
              "type": "function", "function": { "name": "read_file",
              "arguments": "{\"path\":\"README.md\"}" } }] },
            { "role": "tool", "tool_call_id": "call_1", "content": "hello" }
        ]));
        assert_ne!(k(&turn1), k(&turn2));
    }

    #[test]
    fn a_responses_tool_loop_turn_has_its_own_key() {
        let user = json!({ "role": "user", "content": "What does README.md say?" });
        let body = |input: Value| json!({ "model": "gpt-5", "store": false, "input": input });
        let k = |b: &Value| {
            cache_keys("ws", "gpt-5", &Protocol::OpenAIResponses, b)
                .unwrap()
                .exact
        };
        let turn1 = body(json!([user]));
        let turn2 = body(json!([
            user,
            { "type": "function_call", "call_id": "call_1", "name": "read_file",
              "arguments": "{}" },
            { "type": "function_call_output", "call_id": "call_1", "output": "hello" }
        ]));
        assert_ne!(k(&turn1), k(&turn2));
    }

    /// Every field that decides the answer is in the key.
    #[test]
    fn same_prompt_with_a_different_answer_deciding_field_has_its_own_key() {
        let base = anthropic(json!([{ "role": "user", "content": "Name a colour." }]));
        let base_key = keys(&base).exact;
        for (field, value) in [
            (
                "tools",
                json!([{ "name": "read_file", "input_schema": {} }]),
            ),
            ("tool_choice", json!({ "type": "any" })),
            ("system", json!("Answer in French.")),
            ("temperature", json!(0.2)),
            ("top_p", json!(0.5)),
            ("top_k", json!(5)),
            ("max_tokens", json!(8)),
            ("stop_sequences", json!(["\n"])),
            ("stop", json!(["\n"])),
            ("seed", json!(7)),
            ("response_format", json!({ "type": "json_object" })),
            (
                "thinking",
                json!({ "type": "enabled", "budget_tokens": 1024 }),
            ),
        ] {
            let mut changed = base.clone();
            changed[field] = value;
            assert_ne!(keys(&changed).exact, base_key, "{field} is not in the key");
        }
        // The model the client asked for, which is passed in rather than read
        // from the body (Gemini names it in the URL).
        let other_model =
            cache_keys("ws_alpha", "claude-haiku-4-5", &Protocol::Anthropic, &base).unwrap();
        assert_ne!(other_model.exact, base_key, "model is not in the key");
    }

    /// And the fields that cannot change it are not, so the same request
    /// streamed or not, or tagged for a different end user, shares an entry.
    #[test]
    fn fields_that_cannot_change_the_answer_are_not_in_the_key() {
        let base = anthropic(json!([{ "role": "user", "content": "Name a colour." }]));
        for (field, value) in [
            ("stream", json!(true)),
            ("stream_options", json!({ "include_usage": true })),
            ("metadata", json!({ "user_id": "u_2" })),
            ("user", json!("u_2")),
            ("safety_identifier", json!("u_2")),
            ("prompt_cache_key", json!("k")),
        ] {
            let mut changed = base.clone();
            changed[field] = value;
            assert_eq!(keys(&changed), keys(&base), "{field} changed the key");
        }
    }

    #[test]
    fn field_order_does_not_change_the_key() {
        let a: Value = serde_json::from_str(
            r#"{"model":"m","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .unwrap();
        let b: Value = serde_json::from_str(
            r#"{"messages":[{"content":"hi","role":"user"}],"max_tokens":5,"model":"m"}"#,
        )
        .unwrap();
        assert_eq!(keys(&a), keys(&b));
    }

    #[test]
    fn requests_the_cache_cannot_answer_get_no_keys() {
        let body = json!({ "model": "gpt-4o", "messages": [{ "role": "user", "content": "hi" }] });
        // No wire shape to replay a hit in.
        assert!(cache_keys("ws", "m", &Protocol::Unknown, &body).is_none());
        // More than one choice; a cached entry holds one answer.
        let mut n2 = body.clone();
        n2["n"] = json!(2);
        assert!(cache_keys("ws", "m", &Protocol::OpenAIChatCompletions, &n2).is_none());
        let mut n1 = body.clone();
        n1["n"] = json!(1);
        assert!(cache_keys("ws", "m", &Protocol::OpenAIChatCompletions, &n1).is_some());
        // A Responses request the provider stores (the default) can be chained
        // with `previous_response_id`; only `store: false` is cacheable.
        let responses = json!({ "model": "gpt-5", "input": "hi" });
        assert!(cache_keys("ws", "m", &Protocol::OpenAIResponses, &responses).is_none());
        let mut stateless = responses.clone();
        stateless["store"] = json!(false);
        assert!(cache_keys("ws", "m", &Protocol::OpenAIResponses, &stateless).is_some());
    }

    /// v1 keys were `sha256("{workspace}\n{text}")`; no v2 key may equal one,
    /// or an entry cached under the old scheme would answer a request it was
    /// never generated for.
    #[test]
    fn old_scheme_entries_are_never_looked_up() {
        let body = anthropic(json!([{ "role": "user", "content": "Name a colour." }]));
        let k = keys(&body);
        assert_ne!(k.exact, compute_sha256("ws_alpha\nName a colour."));
        // A v1 semantic-index entry stored the bare exact hash, no context.
        let semantic = k.semantic.unwrap();
        assert_eq!(exact_key_for_context(&k.exact, &semantic.context), None);
        assert_eq!(
            exact_key_for_context(&semantic_ref(&semantic, &k.exact), &semantic.context),
            Some(k.exact.as_str())
        );
        assert_eq!(
            exact_key_for_context(&semantic_ref(&semantic, &k.exact), "another-context"),
            None
        );
    }

    #[test]
    fn only_a_plain_text_exchange_without_tools_is_semantically_cacheable() {
        let user = json!({ "role": "user", "content": "Name a colour." });
        let plain = anthropic(json!([user]));
        assert!(keys(&plain).semantic.is_some());

        let mut with_tools = plain.clone();
        with_tools["tools"] = json!([{ "name": "read_file", "input_schema": {} }]);
        assert!(keys(&with_tools).semantic.is_none(), "tools declared");

        let assistant_turn = anthropic(json!([
            user,
            { "role": "assistant", "content": "Which shade?" },
            { "role": "user", "content": "Any." }
        ]));
        assert!(keys(&assistant_turn).semantic.is_none(), "assistant turn");

        let tool_result = anthropic(json!([{ "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "t", "content": "x" }] }]));
        assert!(keys(&tool_result).semantic.is_none(), "tool result");

        let image = anthropic(json!([{ "role": "user", "content": [
            { "type": "text", "text": "What is this?" },
            { "type": "image", "source": { "type": "base64", "data": "AAAA" } }] }]));
        assert!(keys(&image).semantic.is_none(), "non-text part");

        let responses_call = json!({ "model": "gpt-5", "store": false, "input": [
            { "role": "user", "content": "hi" },
            { "type": "function_call_output", "call_id": "c", "output": "x" }] });
        assert!(
            cache_keys("ws", "m", &Protocol::OpenAIResponses, &responses_call)
                .unwrap()
                .semantic
                .is_none(),
            "Responses function_call_output"
        );
    }

    /// Only the user's question is embedded; everything else must match
    /// exactly, so a long shared system prompt cannot make two different
    /// questions look alike and a different system prompt or model cannot
    /// borrow an answer.
    #[test]
    fn the_semantic_context_is_everything_but_the_question() {
        let ask = |q: &str| {
            let mut b = anthropic(json!([{ "role": "user", "content": q }]));
            b["system"] = json!("You are a terse assistant.");
            b
        };
        let a = keys(&ask("Name a colour.")).semantic.unwrap();
        let b = keys(&ask("Tell me one colour.")).semantic.unwrap();
        assert_eq!(a.question, "Name a colour.");
        assert_eq!(
            a.context, b.context,
            "rewording the question changes the context"
        );

        let mut other_system = ask("Name a colour.");
        other_system["system"] = json!("Answer in French.");
        assert_ne!(keys(&other_system).semantic.unwrap().context, a.context);

        let other_model = cache_keys(
            "ws_alpha",
            "claude-haiku-4-5",
            &Protocol::Anthropic,
            &ask("Name a colour."),
        )
        .unwrap();
        assert_ne!(other_model.semantic.unwrap().context, a.context);

        let mut other_temp = ask("Name a colour.");
        other_temp["temperature"] = json!(1.0);
        assert_ne!(keys(&other_temp).semantic.unwrap().context, a.context);
    }

    #[test]
    fn only_a_text_only_response_is_cacheable() {
        assert!(is_text_only_response(
            &json!({ "content": [{ "type": "text", "text": "hi" }] })
        ));
        assert!(!is_text_only_response(&json!({ "content": [
            { "type": "text", "text": "Reading." },
            { "type": "tool_use", "id": "t", "name": "read_file", "input": {} }] })));
        assert!(!is_text_only_response(&json!({ "content": [
            { "type": "thinking", "thinking": "..." }, { "type": "text", "text": "hi" }] })));

        assert!(is_text_only_response(&json!({ "choices": [
            { "message": { "role": "assistant", "content": "hi", "tool_calls": null } }] })));
        assert!(!is_text_only_response(&json!({ "choices": [{ "message": {
            "role": "assistant", "content": "Reading.",
            "tool_calls": [{ "id": "c", "type": "function",
                             "function": { "name": "read_file", "arguments": "{}" } }] } }] })));
        assert!(!is_text_only_response(&json!({ "choices": [
            { "message": { "content": "a" } }, { "message": { "content": "b" } }] })));

        assert!(is_text_only_response(
            &json!({ "output": [{ "type": "message", "content": [] }] })
        ));
        assert!(!is_text_only_response(&json!({ "output": [
            { "type": "message", "content": [] },
            { "type": "function_call", "name": "read_file", "arguments": "{}" }] })));
        assert!(!is_text_only_response(
            &json!({ "output": [{ "type": "reasoning" }] })
        ));

        assert!(is_text_only_response(&json!({ "candidates": [
            { "content": { "parts": [{ "text": "hi" }] } }] })));
        assert!(!is_text_only_response(&json!({ "candidates": [
            { "content": { "parts": [{ "functionCall": { "name": "f" } }] } }] })));

        assert!(!is_text_only_response(
            &json!({ "error": { "message": "x" } })
        ));
    }

    #[test]
    fn a_stream_carrying_more_than_text_is_detected_line_by_line() {
        let beyond = |data: Value| sse_line_is_beyond_text(&format!("data: {data}"));
        assert!(beyond(json!({ "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_use", "name": "read_file" } })));
        assert!(!beyond(json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "text", "text": "" } })));
        assert!(beyond(json!({ "type": "response.output_item.added",
            "item": { "type": "function_call" } })));
        assert!(!beyond(json!({ "type": "response.output_item.added",
            "item": { "type": "message" } })));
        assert!(beyond(json!({ "choices": [{ "index": 0, "delta": {
            "tool_calls": [{ "index": 0, "function": { "name": "read_file" } }] } }] })));
        assert!(beyond(
            json!({ "choices": [{ "index": 1, "delta": { "content": "b" } }] })
        ));
        assert!(!beyond(
            json!({ "choices": [{ "index": 0, "delta": { "content": "a" } }] })
        ));
        assert!(!sse_line_is_beyond_text("event: content_block_start"));
        assert!(!sse_line_is_beyond_text("data: [DONE]"));
    }

    fn cached(text: &str) -> CachedResponse {
        CachedResponse {
            prompt: String::new(),
            response: text.to_string(),
            model: "m".to_string(),
            prompt_tokens: 5,
            completion_tokens: 6,
            cached_at: String::new(),
        }
    }

    fn sse_payloads(stream: &str) -> Vec<Value> {
        stream
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str(d).ok())
            .collect()
    }

    /// A streamed hit is a complete stream a client of that protocol can
    /// reassemble: the text, then the terminal event.
    #[test]
    fn a_streamed_cache_hit_is_a_complete_stream_per_protocol() {
        let hit = cached("The sun is a star.");

        let anthropic = construct_mock_stream(&Protocol::Anthropic, &hit, "claude");
        let events = sse_payloads(&anthropic);
        let text: String = events
            .iter()
            .filter(|e| e["type"] == "content_block_delta")
            .filter_map(|e| e["delta"]["text"].as_str())
            .collect();
        assert_eq!(text, "The sun is a star.");
        assert_eq!(events.first().unwrap()["type"], "message_start");
        assert_eq!(events.last().unwrap()["type"], "message_stop");
        assert!(anthropic.contains(
            "event: message_stop
"
        ));

        let chat = construct_mock_stream(&Protocol::OpenAIChatCompletions, &hit, "gpt-4o");
        let chunks = sse_payloads(&chat);
        let text: String = chunks
            .iter()
            .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
            .collect();
        assert_eq!(text, "The sun is a star.");
        assert_eq!(
            chunks.last().unwrap()["choices"][0]["finish_reason"],
            "stop"
        );
        assert!(chat.ends_with(
            "data: [DONE]

"
        ));

        let responses = construct_mock_stream(&Protocol::OpenAIResponses, &hit, "gpt-5");
        let events = sse_payloads(&responses);
        let text: String = events
            .iter()
            .filter(|e| e["type"] == "response.output_text.delta")
            .filter_map(|e| e["delta"].as_str())
            .collect();
        assert_eq!(text, "The sun is a star.");
        let done = events.last().unwrap();
        assert_eq!(done["type"], "response.completed");
        assert_eq!(
            done["response"]["output"][0]["content"][0]["text"],
            "The sun is a star."
        );
        assert_eq!(done["response"]["usage"]["output_tokens"], 6);
    }

    #[test]
    fn a_responses_cache_hit_is_a_responses_body() {
        let body = construct_mock_response(&Protocol::OpenAIResponses, &cached("hi"), "gpt-5");
        assert_eq!(body["object"], "response");
        assert_eq!(body["status"], "completed");
        assert!(body.get("choices").is_none());
        assert_eq!(body["output"][0]["type"], "message");
        assert_eq!(body["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(body["output"][0]["content"][0]["text"], "hi");
        assert_eq!(body["usage"]["input_tokens"], 5);
    }

    #[test]
    fn test_compute_sha256() {
        let text = "hello";
        let hash = compute_sha256(text);
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_extract_prompt_text_openai() {
        let body = json!({
            "model": "gpt-4o",
            "messages": [
                { "role": "system", "content": "You are a helpful assistant." },
                { "role": "user", "content": "Explain relativity." }
            ]
        });
        let prompt = extract_prompt_text(&body);
        assert_eq!(prompt, "You are a helpful assistant.\nExplain relativity.");
    }

    #[test]
    fn test_extract_prompt_text_anthropic() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "system": "You are a chef.",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "How do I make pasta?" }
                    ]
                }
            ]
        });
        let prompt = extract_prompt_text(&body);
        assert_eq!(prompt, "You are a chef.\nHow do I make pasta?");
    }

    #[test]
    fn test_extract_prompt_text_gemini() {
        let body = json!({
            "contents": [
                {
                    "parts": [
                        { "text": "Describe the sun." }
                    ]
                }
            ]
        });
        let prompt = extract_prompt_text(&body);
        assert_eq!(prompt, "Describe the sun.");
    }

    #[test]
    fn test_construct_mock_response() {
        let cached = CachedResponse {
            prompt: "Describe the sun.".to_string(),
            response: "The sun is a star.".to_string(),
            model: "gpt-4o".to_string(),
            prompt_tokens: 5,
            completion_tokens: 6,
            cached_at: "2026-06-20T12:00:00Z".to_string(),
        };

        // Test OpenAI Chat Completions Mock
        let openai_resp =
            construct_mock_response(&Protocol::OpenAIChatCompletions, &cached, "gpt-4o");
        assert_eq!(
            openai_resp["choices"][0]["message"]["content"],
            "The sun is a star."
        );
        assert_eq!(openai_resp["usage"]["prompt_tokens"], 5);

        // Test Anthropic Mock
        let anthropic_resp =
            construct_mock_response(&Protocol::Anthropic, &cached, "claude-3-5-sonnet");
        assert_eq!(anthropic_resp["content"][0]["text"], "The sun is a star.");
        assert_eq!(anthropic_resp["usage"]["input_tokens"], 5);
    }
}
