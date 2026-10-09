//! Google Vertex AI.
//!
//! - **Claude**: `POST {base}/v1/projects/{p}/locations/{l}/publishers/anthropic/models/{model}:rawPredict`
//!   (`:streamRawPredict` when streaming). The Messages body goes without
//!   `model` and with `anthropic_version: "vertex-2023-10-16"`; `stream`
//!   stays in the body. Beta flags travel as the `anthropic-beta` header, as
//!   Anthropic's own Vertex clients send them. Answers are the Messages API's,
//!   SSE included.
//!   <https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai>
//! - **Gemini**: `…/publishers/google/models/{model}:generateContent`
//!   (`:streamGenerateContent?alt=sse`), translated in `super::gemini`.
//!
//! Hosts: `aiplatform.googleapis.com` for `global`,
//! `aiplatform.{us,eu}.rep.googleapis.com` for the multi-region locations, and
//! `{location}-aiplatform.googleapis.com` otherwise. Every call carries an
//! OAuth access token (`super::auth::gcp_token`).

use serde_json::{json, Value};

use super::config::VertexConfig;
use super::errors;
use super::sse::{self, DataLines, Translate};
use super::{auth, CloudCall, Wire};

pub fn base_url(cfg: &VertexConfig) -> String {
    if let Some(e) = &cfg.endpoint {
        return e.clone();
    }
    match cfg.location.as_str() {
        "global" => "https://aiplatform.googleapis.com".into(),
        "us" | "eu" => format!("https://aiplatform.{}.rep.googleapis.com", cfg.location),
        loc => format!("https://{loc}-aiplatform.googleapis.com"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    Claude,
    Gemini,
}

fn family(model: &str) -> Option<Family> {
    let m = model.to_ascii_lowercase();
    if m.starts_with("claude") {
        Some(Family::Claude)
    } else if m.starts_with("gemini") {
        Some(Family::Gemini)
    } else {
        None
    }
}

/// The Vertex body for a Claude request.
pub fn claude_body(mut body: Value) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.remove("model");
        o.insert("anthropic_version".into(), json!("vertex-2023-10-16"));
    }
    body
}

pub async fn send(
    client: &reqwest::Client,
    call: &CloudCall<'_>,
    cfg: &VertexConfig,
    body: Value,
    stream: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let model = call.model.model.as_str();
    // The model name is a URL path segment.
    if model.is_empty()
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '@'))
    {
        return Ok(errors::synthesize(
            Wire::Anthropic,
            400,
            "invalid_request_error",
            "Vertex AI model name is not valid",
        ));
    }
    let Some(fam) = family(model) else {
        return Ok(errors::synthesize(
            Wire::Anthropic,
            400,
            "invalid_request_error",
            "Vertex AI models are served for the Claude and Gemini families (vertex/claude-…, vertex/gemini-…)",
        ));
    };
    let token = match auth::gcp_token(client, &cfg.auth).await {
        Ok(t) => t,
        Err(e) => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                e.status,
                e.kind,
                &format!("Google Vertex AI: {}", e.message),
            ))
        }
    };
    let prefix = format!(
        "{}/v1/projects/{}/locations/{}/publishers",
        base_url(cfg),
        cfg.project,
        cfg.location
    );
    let (url, payload) = match fam {
        Family::Claude => {
            let verb = if stream {
                "streamRawPredict"
            } else {
                "rawPredict"
            };
            (
                format!("{prefix}/anthropic/models/{model}:{verb}"),
                claude_body(body),
            )
        }
        Family::Gemini => {
            let translated = match super::gemini::request(&body, model) {
                Ok(t) => t,
                Err(reason) => {
                    return Ok(errors::synthesize(
                        Wire::Anthropic,
                        400,
                        "invalid_request_error",
                        &reason,
                    ))
                }
            };
            let verb = if stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            (format!("{prefix}/google/models/{model}:{verb}"), translated)
        }
    };
    let mut auth_value =
        match reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token.expose())) {
            Ok(v) => v,
            Err(_) => {
                return Ok(errors::synthesize(
                    Wire::Anthropic,
                    401,
                    "authentication_error",
                    "Google Vertex AI: the access token is not a valid header value",
                ))
            }
        };
    auth_value.set_sensitive(true);
    let mut req = client
        .post(&url)
        .header("authorization", auth_value)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&payload).unwrap_or_default())
        .timeout(call.timeout);
    if fam == Family::Claude {
        let betas = super::anthropic_betas(call.client_headers);
        if !betas.is_empty() {
            req = req.header("anthropic-beta", betas.join(","));
        }
    }
    for (k, v) in super::trace_headers(call.client_headers) {
        req = req.header(k, v);
    }
    let resp = req.send().await?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let h = resp.headers().clone();
        let text = resp.text().await.unwrap_or_default();
        return Ok(errors::from_vertex(status, &h, &text));
    }
    Ok(match (fam, stream) {
        (Family::Claude, _) => resp,
        (Family::Gemini, false) => {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            errors::build(200, &[], super::gemini::response(&v, model).to_string())
        }
        (Family::Gemini, true) => sse::response(
            200,
            sse::translate(
                Box::pin(resp.bytes_stream()),
                GeminiStream {
                    lines: DataLines::default(),
                    t: super::gemini::StreamTranslator::new(model),
                },
            ),
        ),
    })
}

struct GeminiStream {
    lines: DataLines,
    t: super::gemini::StreamTranslator,
}

impl GeminiStream {
    fn chunk(&mut self, data: &str) -> String {
        match serde_json::from_str::<Value>(data) {
            Ok(v) => self.t.on_chunk(&v),
            Err(_) => String::new(),
        }
    }
}

impl Translate for GeminiStream {
    fn feed(&mut self, bytes: &[u8]) -> String {
        let mut out = String::new();
        for data in self.lines.push(bytes) {
            out.push_str(&self.chunk(&data));
        }
        out
    }

    fn finish(&mut self) -> String {
        let mut out = String::new();
        if let Some(data) = self.lines.finish() {
            out.push_str(&self.chunk(&data));
        }
        out.push_str(&self.t.finish());
        out
    }

    fn done(&self) -> bool {
        self.t.failed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::config::{CloudConfig, GcpAuth};
    use crate::cloud::{CloudModel, CloudProvider};
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg(location: &str, endpoint: Option<String>) -> VertexConfig {
        VertexConfig {
            project: "proj-1".into(),
            location: location.into(),
            auth: GcpAuth::Json(crate::cloud::config::Secret::new("{}")),
            endpoint,
        }
    }

    #[test]
    fn the_host_follows_the_location() {
        assert_eq!(
            base_url(&cfg("global", None)),
            "https://aiplatform.googleapis.com"
        );
        assert_eq!(
            base_url(&cfg("us-east5", None)),
            "https://us-east5-aiplatform.googleapis.com"
        );
        assert_eq!(
            base_url(&cfg("eu", None)),
            "https://aiplatform.eu.rep.googleapis.com"
        );
    }

    #[test]
    fn the_claude_body_follows_the_vertex_schema() {
        assert_eq!(
            claude_body(
                json!({"model": "vertex/claude-sonnet-4-5@20250929", "stream": true, "max_tokens": 9, "messages": []})
            ),
            json!({"anthropic_version": "vertex-2023-10-16", "stream": true, "max_tokens": 9, "messages": []})
        );
    }

    /// The token comes from a pre-seeded cache entry, so no test here can
    /// reach a real Google endpoint or read this machine's gcloud login.
    async fn run(server: &MockServer, model: &str, body: Value) -> reqwest::Response {
        let doc = json!({"type": "service_account", "client_email": "vertex-test@p.iam.gserviceaccount.com", "private_key": "unused"}).to_string();
        crate::cloud::auth::seed_gcp_token(&doc, "ya29.test");
        let mut c = cfg("us-east5", Some(server.uri()));
        c.auth = GcpAuth::Json(crate::cloud::config::Secret::new(doc));
        let cm = CloudModel {
            provider: CloudProvider::Vertex,
            model: model.into(),
        };
        let config = CloudConfig::Vertex(c);
        let mut h = axum::http::HeaderMap::new();
        h.insert("anthropic-beta", "context-1m-2025-08-07".parse().unwrap());
        let bytes = serde_json::to_vec(&body).unwrap();
        crate::cloud::send(
            &reqwest::Client::new(),
            crate::cloud::CloudCall {
                model: &cm,
                config: &config,
                protocol: &crate::protocol::Protocol::Anthropic,
                body: &bytes,
                client_headers: &h,
                timeout: std::time::Duration::from_secs(10),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn claude_and_gemini_on_vertex_end_to_end() {
        // Claude: rawPredict with the Vertex body and a bearer token.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/projects/proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict"))
            .and(header("authorization", "Bearer ya29.test"))
            .and(header("anthropic-beta", "context-1m-2025-08-07"))
            .and(body_json(json!({"anthropic_version": "vertex-2023-10-16", "stream": true, "max_tokens": 4, "messages": [{"role": "user", "content": "hi"}]})))
            .respond_with(ResponseTemplate::new(200).set_body_string("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
            .mount(&server)
            .await;
        let resp = run(&server, "claude-sonnet-4-5@20250929", json!({"model": "vertex/claude-sonnet-4-5@20250929", "stream": true, "max_tokens": 4, "messages": [{"role": "user", "content": "hi"}]})).await;
        assert_eq!(resp.status(), 200);
        assert!(resp.text().await.unwrap().contains("message_stop"));

        // Gemini: generateContent, answered as an Anthropic message.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/projects/proj-1/locations/us-east5/publishers/google/models/gemini-2.5-pro:generateContent"))
            .and(body_json(json!({"contents": [{"role": "user", "parts": [{"text": "hi"}]}], "generationConfig": {"maxOutputTokens": 8}})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{"content": {"role": "model", "parts": [{"text": "hello"}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 1}
            })))
            .mount(&server)
            .await;
        let v: Value = run(
            &server,
            "gemini-2.5-pro",
            json!({"max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(v["content"], json!([{"type": "text", "text": "hello"}]));
        assert_eq!(v["usage"], json!({"input_tokens": 2, "output_tokens": 1}));

        // Gemini streaming: alt=sse chunks become Anthropic SSE.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/projects/proj-1/locations/us-east5/publishers/google/models/gemini-2.5-flash:streamGenerateContent"))
            .and(query_param("alt", "sse"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Hel\"}]}}]}\r\n\r\n\
                 data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"lo\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2}}\r\n\r\n",
            ))
            .mount(&server)
            .await;
        let text = run(&server, "gemini-2.5-flash", json!({"max_tokens": 8, "stream": true, "messages": [{"role": "user", "content": "hi"}]})).await.text().await.unwrap();
        assert!(text.contains("\"text\":\"Hel\""), "{text}");
        assert!(text.contains("\"stop_reason\":\"end_turn\""), "{text}");
        assert!(text
            .trim_end()
            .ends_with("data: {\"type\":\"message_stop\"}"));

        // Errors arrive in Anthropic's shape.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/projects/proj-1/locations/us-east5/publishers/google/models/gemini-2.5-pro:generateContent"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({"error": {"code": 403, "message": "Permission denied on resource project proj-1.", "status": "PERMISSION_DENIED"}})))
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "gemini-2.5-pro",
            json!({"max_tokens": 1, "messages": [{"role": "user", "content": "x"}]}),
        )
        .await;
        assert_eq!(resp.status(), 403);
        assert_eq!(
            resp.json::<Value>().await.unwrap()["error"]["type"],
            "permission_error"
        );

        // Other model families are refused before any network call.
        let resp = run(
            &server,
            "llama-3-70b",
            json!({"max_tokens": 1, "messages": []}),
        )
        .await;
        assert_eq!(resp.status(), 400);
        let resp = run(
            &server,
            "claude/../../x",
            json!({"max_tokens": 1, "messages": []}),
        )
        .await;
        assert_eq!(resp.status(), 400);
    }
}
