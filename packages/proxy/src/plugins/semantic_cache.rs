//! Semantic and exact response cache plugin.
//!
//! Handles exact-match cache hits via SHA-256 prompt hashing and
//! semantic-match cache hits via TurboVec cosine-similarity.
//!
//! LLD #26 §4.2 — Semantic Cache Filter

use crate::protocol::Protocol;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedResponse {
    pub prompt: String,
    pub response: String,
    pub model: String,
    #[serde(rename = "promptTokens")]
    pub prompt_tokens: u32,
    #[serde(rename = "completionTokens")]
    pub completion_tokens: u32,
    #[serde(rename = "cachedAt")]
    pub cached_at: String,
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

/// Publishes a system anomaly event to Valkey on infrastructure issues.
pub async fn publish_system_anomaly(
    valkey: &Arc<redis::aio::ConnectionManager>,
    workspace_id: &str,
    description: &str,
) {
    let mut conn = valkey.as_ref().clone();
    let payload = json!({
        "workspace_id": workspace_id,
        "description": description,
        "severity": "HIGH",
        "timestamp": chrono::Utc::now().to_rfc3339()
    });
    if let Ok(payload_str) = serde_json::to_string(&payload) {
        let _: Result<(), _> = conn.publish("intutic:system_anomalies", &payload_str).await;
    }
}

/// Checks the exact/semantic response cache.
/// Returns Option<CachedResponse> on hit.
pub async fn check_cache(
    valkey: &Arc<redis::aio::ConnectionManager>,
    http_client: &reqwest::Client,
    workspace_id: &str,
    body_json: &Value,
    ff_exact: bool,
    ff_semantic: bool,
) -> Option<CachedResponse> {
    if !ff_exact && !ff_semantic {
        return None;
    }

    let mut conn = valkey.as_ref().clone();
    let prompt_text = extract_prompt_text(body_json);
    if prompt_text.is_empty() {
        return None;
    }

    let sha256_hash = compute_sha256(&prompt_text);

    // 1. Exact Match Path
    if ff_exact {
        let cache_key = format!("cache:response:{}", sha256_hash);
        let cached_val: Option<String> = conn.get(&cache_key).await.unwrap_or(None);
        if let Some(val_str) = cached_val {
            if let Ok(cached) = serde_json::from_str::<CachedResponse>(&val_str) {
                // Increment exact hit counter
                let metrics_key = format!("cache:metrics:{}", workspace_id);
                let _: Result<(), _> = conn.hincr(&metrics_key, "exact_hits", 1).await;
                // Calculate savings
                let raw_cost: f64 = body_json
                    .get("model")
                    .map(|_| 0.0015) // Mock cost calculation fallback if prices not parsed
                    .unwrap_or(0.0);
                let _: Result<(), _> = conn
                    .hincr(&metrics_key, "estimated_savings_usd", raw_cost)
                    .await;
                return Some(cached);
            }
        }
    }

    // 2. Semantic Match Path
    if ff_semantic {
        let embedding = match generate_embedding(http_client, &prompt_text).await {
            Ok(emb) => emb,
            Err(e) => {
                let desc = format!("Embedding generator unreachable or slow: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                publish_system_anomaly(valkey, workspace_id, &desc).await;
                return None; // Fail-open
            }
        };

        let nearest = match query_turbovec(http_client, &embedding, workspace_id).await {
            Ok(n) => n,
            Err(e) => {
                let desc = format!("TurboVec sidecar unreachable or slow: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                publish_system_anomaly(valkey, workspace_id, &desc).await;
                return None; // Fail-open
            }
        };

        if let Some((exact_hash, score)) = nearest {
            if score >= 0.95 {
                // Fetch matched exact hit from Valkey
                let cache_key = format!("cache:response:{}", exact_hash);
                let cached_val: Option<String> = conn.get(&cache_key).await.unwrap_or(None);
                if let Some(val_str) = cached_val {
                    if let Ok(cached) = serde_json::from_str::<CachedResponse>(&val_str) {
                        // Increment semantic hit counter
                        let metrics_key = format!("cache:metrics:{}", workspace_id);
                        let _: Result<(), _> = conn.hincr(&metrics_key, "semantic_hits", 1).await;
                        let raw_cost: f64 = body_json.get("model").map(|_| 0.0015).unwrap_or(0.0);
                        let _: Result<(), _> = conn
                            .hincr(&metrics_key, "estimated_savings_usd", raw_cost)
                            .await;
                        return Some(cached);
                    }
                }
            }
        }
    }

    // Cache Miss
    let metrics_key = format!("cache:metrics:{}", workspace_id);
    let _: Result<(), _> = conn.hincr(&metrics_key, "misses", 1).await;
    None
}

/// Writes a response to exact and semantic cache.
#[allow(clippy::too_many_arguments)]
pub async fn write_cache(
    valkey: &Arc<redis::aio::ConnectionManager>,
    http_client: &reqwest::Client,
    workspace_id: &str,
    body_json: &Value,
    completion_text: &str,
    model_name: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    ff_semantic: bool,
) -> Result<(), anyhow::Error> {
    let mut conn = valkey.as_ref().clone();
    let prompt_text = extract_prompt_text(body_json);
    if prompt_text.is_empty() {
        return Ok(());
    }

    let sha256_hash = compute_sha256(&prompt_text);
    let cached_resp = CachedResponse {
        prompt: prompt_text.clone(),
        response: completion_text.to_string(),
        model: model_name.to_string(),
        prompt_tokens,
        completion_tokens,
        cached_at: chrono::Utc::now().to_rfc3339(),
    };

    let cache_val = serde_json::to_string(&cached_resp)?;
    let cache_key = format!("cache:response:{}", sha256_hash);

    // Save exact cache (TTL 24 hours)
    let _: () = conn.set_ex(&cache_key, cache_val, 86400).await?;

    // Increment cache size metric
    let metrics_key = format!("cache:metrics:{}", workspace_id);
    let _: Result<(), _> = conn.hincr(&metrics_key, "cache_size", 1).await;

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
                    publish_system_anomaly(valkey, workspace_id, &desc).await;
                }
            }
            Err(e) => {
                let desc = format!("Failed to generate embedding for cache insert: {}", e);
                tracing::warn!(%workspace_id, "{}", desc);
                publish_system_anomaly(valkey, workspace_id, &desc).await;
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
