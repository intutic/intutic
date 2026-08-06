//! Semantic and exact response cache plugin.
//!
//! Handles exact-match cache hits via SHA-256 prompt hashing and
//! semantic-match cache hits via TurboVec cosine-similarity.
//!
//! LLD #26 §4.2 — Semantic Cache Filter

use crate::protocol::Protocol;
use crate::store::LocalStore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Re-exported from the store layer, which owns the on-the-wire shape.
pub use crate::store::CachedResponse;

/// Exact-cache entry lifetime.
const RESPONSE_CACHE_TTL_SECS: u64 = 86_400;

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

/// Query TurboVec nearest neighbor
async fn query_turbovec(
    http_client: &reqwest::Client,
    vector: &[f32],
    workspace_id: &str,
) -> Result<Option<(String, f64)>, anyhow::Error> {
    let turbovec_url = std::env::var("TURBOVEC_URL")
        .unwrap_or_else(|_| "http://localhost:8083/vectors/query".to_string());

    let body = json!({
        "vector": vector,
        "workspaceId": workspace_id,
        "topK": 1
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
    if let Some(arr) = results.as_array() {
        if let Some(first) = arr.first() {
            let score = first.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let hash = first
                .get("metadata")
                .and_then(|m| m.get("hash"))
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .to_string();
            return Ok(Some((hash, score)));
        }
    }

    Ok(None)
}

/// Checks the exact/semantic response cache.
/// Returns Option<CachedResponse> on hit.
pub async fn check_cache(
    store: &Arc<dyn LocalStore>,
    http_client: &reqwest::Client,
    workspace_id: &str,
    body_json: &Value,
    ff_exact: bool,
    ff_semantic: bool,
) -> Option<CachedResponse> {
    if !ff_exact && !ff_semantic {
        return None;
    }

    let prompt_text = extract_prompt_text(body_json);
    if prompt_text.is_empty() {
        return None;
    }

    // Salted with the workspace: the response cache key was a pure content
    // hash, so two tenants sending the same prompt shared cache entries —
    // including responses generated with the other tenant's injected SOPs.
    // The semantic index was already per-workspace (query_turbovec takes
    // workspace_id); this closes the exact-match path to match.
    let sha256_hash = compute_sha256(&format!("{workspace_id}\n{prompt_text}"));

    // 1. Exact Match Path
    if ff_exact {
        if let Some(cached) = store.cached_response(&sha256_hash).await {
            store.incr_cache_counter(workspace_id, "exact_hits", 1).await;
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
    if ff_semantic {
        let embedding = match generate_embedding(http_client, &prompt_text).await {
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

        if let Some((exact_hash, score)) = nearest {
            if score >= 0.95 {
                if let Some(cached) = store.cached_response(&exact_hash).await {
                    store
                        .incr_cache_counter(workspace_id, "semantic_hits", 1)
                        .await;
                    let raw_cost: f64 = body_json.get("model").map(|_| 0.0015).unwrap_or(0.0);
                    store.add_cache_savings(workspace_id, raw_cost).await;
                    return Some(cached);
                }
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

pub async fn write_cache(
    provenance: ResponseProvenance,
    store: &Arc<dyn LocalStore>,
    http_client: &reqwest::Client,
    workspace_id: &str,
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

    let prompt_text = extract_prompt_text(body_json);
    if prompt_text.is_empty() {
        return Ok(());
    }

    // Salted with the workspace: the response cache key was a pure content
    // hash, so two tenants sending the same prompt shared cache entries —
    // including responses generated with the other tenant's injected SOPs.
    // The semantic index was already per-workspace (query_turbovec takes
    // workspace_id); this closes the exact-match path to match.
    let sha256_hash = compute_sha256(&format!("{workspace_id}\n{prompt_text}"));
    let cached_resp = CachedResponse {
        prompt: prompt_text.clone(),
        response: completion_text.to_string(),
        model: model_name.to_string(),
        prompt_tokens,
        completion_tokens,
        cached_at: chrono::Utc::now().to_rfc3339(),
    };

    // Save exact cache (TTL 24 hours)
    store
        .store_response(&sha256_hash, &cached_resp, RESPONSE_CACHE_TTL_SECS)
        .await?;

    // Increment cache size metric
    store.incr_cache_counter(workspace_id, "cache_size", 1).await;

    // Write to TurboVec for semantic cache if enabled
    if ff_semantic {
        match generate_embedding(http_client, &prompt_text).await {
            Ok(embedding) => {
                let turbovec_url = std::env::var("TURBOVEC_URL")
                    .unwrap_or_else(|_| "http://localhost:8083/vectors/insert".to_string());

                let body = json!({
                    "vector": embedding,
                    "metadata": {
                        "hash": sha256_hash,
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
        Protocol::OpenAIResponses => json!({
            "id": format!("resp-cached-{}", nanoid::nanoid!(16)),
            "object": "response",
            "created": chrono::Utc::now().timestamp(),
            "model": requested_model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": cached.response
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": cached.prompt_tokens,
                "completion_tokens": cached.completion_tokens,
                "total_tokens": cached.prompt_tokens + cached.completion_tokens
            }
        }),
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

#[cfg(test)]
mod tests {
    use super::ResponseProvenance;

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
        assert!(calls > 0, "no call sites found — this test asserted nothing");
        assert_eq!(
            calls, stated,
            "{calls} write_cache call(s) but {stated} stated provenance"
        );
    }

    use super::*;
    use serde_json::json;

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
