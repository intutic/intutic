//! Google's first-party Gemini API, for a request that did not arrive on its
//! own `/v1beta` route.
//!
//! `POST {base}/v1beta/models/{model}:generateContent`
//! (`:streamGenerateContent?alt=sse` when streaming), authenticated with
//! `x-goog-api-key`. The body is the same `generateContent` request Vertex AI
//! takes, so the translation is `super::gemini`'s, and the answer comes back
//! as an Anthropic message or Anthropic SSE.
//! <https://ai.google.dev/api/generate-content>
//!
//! A request on `/v1beta/models/…:generateContent` itself is not routed here:
//! the proxy passes it to the Gemini API untouched, as it always has.

use serde_json::Value;

use super::config::GoogleAiConfig;
use super::errors;
use super::sse;
use super::vertex::GeminiStream;
use super::{CloudCall, Wire};

pub async fn send(
    client: &reqwest::Client,
    call: &CloudCall<'_>,
    cfg: &GoogleAiConfig,
    body: Value,
    stream: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let model = call.model.model.as_str();
    // The model name is a URL path segment.
    if model.is_empty()
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
    {
        return Ok(errors::synthesize(
            Wire::Anthropic,
            400,
            "invalid_request_error",
            "Gemini model name is not valid",
        ));
    }
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
    let url = format!(
        "{}/v1beta/models/{model}:{verb}",
        cfg.base_url.trim_end_matches('/')
    );
    let mut key = match reqwest::header::HeaderValue::from_str(cfg.api_key.expose()) {
        Ok(v) => v,
        Err(_) => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                401,
                "authentication_error",
                "Gemini: the API key is not a valid header value",
            ))
        }
    };
    key.set_sensitive(true);
    let mut req = client
        .post(&url)
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&translated).unwrap_or_default())
        .timeout(call.timeout);
    for (k, v) in super::trace_headers(call.client_headers) {
        req = req.header(k, v);
    }
    let resp = req.send().await?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let h = resp.headers().clone();
        let text = resp.text().await.unwrap_or_default();
        return Ok(errors::from_google(status, &h, &text, "Gemini"));
    }
    Ok(if stream {
        sse::response(
            200,
            sse::translate(Box::pin(resp.bytes_stream()), GeminiStream::new(model)),
        )
    } else {
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        errors::build(200, &[], super::gemini::response(&v, model).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::config::{CloudConfig, Secret};
    use crate::cloud::{CloudModel, CloudProvider};
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn run(server: &MockServer, model: &str, body: Value) -> reqwest::Response {
        let cm = CloudModel {
            provider: CloudProvider::GoogleAi,
            model: model.into(),
        };
        let cfg = CloudConfig::GoogleAi(GoogleAiConfig {
            base_url: server.uri(),
            api_key: Secret::new(["gemini", "-test-", "key"].concat()),
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        crate::cloud::send(
            &reqwest::Client::new(),
            crate::cloud::CloudCall {
                model: &cm,
                config: &cfg,
                protocol: &crate::protocol::Protocol::Anthropic,
                body: &bytes,
                client_headers: &axum::http::HeaderMap::new(),
                timeout: std::time::Duration::from_secs(10),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn generate_content_with_the_requested_model_and_the_key_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-2.5-flash:generateContent"))
            .and(header("x-goog-api-key", "gemini-test-key"))
            .and(body_json(json!({
                "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                "generationConfig": {"maxOutputTokens": 8}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{"content": {"role": "model", "parts": [{"text": "hello"}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 2, "candidatesTokenCount": 1}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let v: Value = run(
            &server,
            "gemini-2.5-flash",
            json!({"model": "gemini-2.5-flash", "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await
        .json()
        .await
        .unwrap();
        assert_eq!(v["content"], json!([{"type": "text", "text": "hello"}]));
        assert_eq!(v["usage"], json!({"input_tokens": 2, "output_tokens": 1}));
        assert!(v["id"].as_str().unwrap().starts_with("msg_"));
    }

    #[tokio::test]
    async fn streams_become_anthropic_sse_and_errors_anthropic_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-2.5-pro:streamGenerateContent"))
            .and(query_param("alt", "sse"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"streamed\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1}}\r\n\r\n",
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-bad:generateContent"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}
            })))
            .mount(&server)
            .await;
        let text = run(
            &server,
            "gemini-2.5-pro",
            json!({"max_tokens": 8, "stream": true, "messages": [{"role": "user", "content": "x"}]}),
        )
        .await
        .text()
        .await
        .unwrap();
        assert!(text.starts_with("event: message_start\n"), "{text}");
        assert!(text.contains("\"text\":\"streamed\""));
        assert!(text
            .trim_end()
            .ends_with("data: {\"type\":\"message_stop\"}"));

        let resp = run(
            &server,
            "gemini-bad",
            json!({"max_tokens": 1, "messages": [{"role": "user", "content": "x"}]}),
        )
        .await;
        assert_eq!(resp.status(), 400);
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["error"]["type"], "invalid_request_error");
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("Gemini: "));

        let resp = run(
            &server,
            "../models/x",
            json!({"max_tokens": 1, "messages": []}),
        )
        .await;
        assert_eq!(resp.status(), 400);
    }
}
