//! AWS Bedrock.
//!
//! Three APIs, chosen per model by [`super::bedrock_api`]:
//!
//! - **Mantle** — `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`,
//!   the Messages API itself (Claude Opus 4.7 and later). The body goes as is,
//!   `model` included; streaming is ordinary SSE. Signed for service
//!   `bedrock-mantle`, or a bearer token in `x-api-key`.
//!   <https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock>
//! - **InvokeModel** — `POST /model/{id}/invoke` and
//!   `/invoke-with-response-stream` on `bedrock-runtime.{region}.amazonaws.com`
//!   (earlier Claude models). The body loses `model` and `stream`, gains
//!   `anthropic_version: "bedrock-2023-05-31"`, and carries the beta flags in
//!   `anthropic_beta` instead of a header. A streamed answer is an AWS
//!   event-stream whose `chunk` events wrap Anthropic stream events in base64;
//!   it is unwrapped back into SSE here.
//!   <https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html>
//! - **Converse** — `POST /model/{id}/converse` and `/converse-stream`, every
//!   other model, translated in `super::converse`.
//!
//! Runtime calls are signed for service `bedrock`, or carry a Bedrock API key
//! as `Authorization: Bearer`. The model id is percent-encoded into the path
//! (`:` → `%3A`, an ARN's `/` → `%2F`), and SigV4 encodes that path again.

use serde_json::{json, Value};

use super::auth::{self, AwsSigner};
use super::config::BedrockConfig;
use super::errors;
use super::eventstream::Decoder;
use super::sse::{self, Translate};
use super::{bedrock_api, BedrockApi, CloudCall, Wire};

/// The beta flags Bedrock documents for Claude on InvokeModel. Bedrock
/// refuses a request naming any other flag (`invalid beta flag`), and an
/// Anthropic client sends first-party flags Bedrock has never heard of, so the
/// rest are dropped. Sources: the Bedrock Claude request/response page and
/// Anthropic's legacy-Bedrock page.
pub const INVOKE_MODEL_BETAS: &[&str] = &[
    "computer-use-2024-10-22",
    "computer-use-2025-01-24",
    "token-efficient-tools-2025-02-19",
    "interleaved-thinking-2025-05-14",
    "output-128k-2025-02-19",
    "dev-full-thinking-2025-05-14",
    "context-1m-2025-08-07",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "tool-search-tool-2025-10-19",
    "tool-examples-2025-10-29",
    "mid-conversation-output-config-2026-07-01",
];

/// The InvokeModel body for an Anthropic Messages body.
///
/// `metadata` is removed as well: it is telemetry for Anthropic's API, and
/// Bedrock's documented Claude request schema does not include it.
pub fn invoke_body(mut body: Value, header_betas: &[String]) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.remove("model");
        o.remove("stream");
        o.remove("metadata");
        o.insert("anthropic_version".into(), json!("bedrock-2023-05-31"));
        let mut betas: Vec<String> = o
            .get("anthropic_beta")
            .and_then(|b| b.as_array())
            .into_iter()
            .flatten()
            .filter_map(|b| b.as_str().map(str::to_string))
            .chain(header_betas.iter().cloned())
            .collect();
        betas.sort();
        betas.dedup();
        let (kept, dropped): (Vec<String>, Vec<String>) = betas
            .into_iter()
            .partition(|b| INVOKE_MODEL_BETAS.contains(&b.as_str()));
        if !dropped.is_empty() {
            tracing::debug!(dropped = ?dropped, "beta flags Bedrock does not support were not forwarded");
        }
        if kept.is_empty() {
            o.remove("anthropic_beta");
        } else {
            o.insert("anthropic_beta".into(), json!(kept));
        }
    }
    body
}

fn runtime_base(cfg: &BedrockConfig) -> String {
    cfg.runtime_endpoint
        .clone()
        .unwrap_or_else(|| format!("https://bedrock-runtime.{}.amazonaws.com", cfg.region))
}

fn mantle_base(cfg: &BedrockConfig) -> String {
    cfg.mantle_endpoint
        .clone()
        .unwrap_or_else(|| format!("https://bedrock-mantle.{}.api.aws", cfg.region))
}

pub async fn send(
    client: &reqwest::Client,
    call: &CloudCall<'_>,
    cfg: &BedrockConfig,
    body: Value,
    stream: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let signer = match auth::aws(client, &cfg.auth, &cfg.region).await {
        Ok(s) => s,
        Err(e) => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                e.status,
                e.kind,
                &format!("AWS Bedrock: {}", e.message),
            ))
        }
    };
    let model = call.model.model.as_str();
    let betas = super::anthropic_betas(call.client_headers);
    let enc = super::sigv4::uri_encode(model);

    let (url, service, payload, accept_stream) = match bedrock_api(model) {
        BedrockApi::Mantle => {
            let mut b = body;
            b["model"] = json!(model);
            (
                format!("{}/anthropic/v1/messages", mantle_base(cfg)),
                "bedrock-mantle",
                b,
                false,
            )
        }
        BedrockApi::InvokeModel => {
            let op = if stream {
                "invoke-with-response-stream"
            } else {
                "invoke"
            };
            (
                format!("{}/model/{enc}/{op}", runtime_base(cfg)),
                "bedrock",
                invoke_body(body, &betas),
                stream,
            )
        }
        BedrockApi::Converse => {
            let translated = match super::converse::request(&body) {
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
            let op = if stream {
                "converse-stream"
            } else {
                "converse"
            };
            (
                format!("{}/model/{enc}/{op}", runtime_base(cfg)),
                "bedrock",
                translated,
                stream,
            )
        }
    };
    let api = bedrock_api(model);
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();

    let mut headers: Vec<(&str, String)> = vec![("content-type", "application/json".into())];
    if api == BedrockApi::Mantle {
        headers.push(("anthropic-version", "2023-06-01".into()));
        if !betas.is_empty() {
            headers.push(("anthropic-beta", betas.join(",")));
        }
    }
    if accept_stream {
        headers.push(("accept", "application/vnd.amazon.eventstream".into()));
        headers.push(("x-amzn-bedrock-accept", "application/json".into()));
    } else {
        headers.push((
            "accept",
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            }
            .into(),
        ));
    }

    let req = match signed(
        client,
        &url,
        &headers,
        &bytes,
        &signer,
        &cfg.region,
        service,
        api == BedrockApi::Mantle,
    ) {
        Some(r) => r,
        None => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                500,
                "api_error",
                "AWS Bedrock endpoint URL is invalid",
            ))
        }
    };
    let mut req = req.body(bytes).timeout(call.timeout);
    for (k, v) in super::trace_headers(call.client_headers) {
        req = req.header(k, v);
    }
    let resp = req.send().await?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let h = resp.headers().clone();
        let text = resp.text().await.unwrap_or_default();
        return Ok(errors::from_bedrock(status, &h, &text));
    }
    Ok(match (api, stream) {
        // Mantle answers in the Messages API already, SSE and all.
        (BedrockApi::Mantle, _) | (BedrockApi::InvokeModel, false) => resp,
        (BedrockApi::InvokeModel, true) => sse::response(
            200,
            sse::translate(Box::pin(resp.bytes_stream()), InvokeStream::default()),
        ),
        (BedrockApi::Converse, true) => sse::response(
            200,
            sse::translate(
                Box::pin(resp.bytes_stream()),
                ConverseStream {
                    dec: Decoder::new(),
                    t: super::converse::StreamTranslator::new(model),
                    failed: false,
                },
            ),
        ),
        (BedrockApi::Converse, false) => {
            let v: Value = resp.json().await.unwrap_or(Value::Null);
            errors::build(200, &[], super::converse::response(&v, model).to_string())
        }
    })
}

/// A request with Bedrock authentication applied: SigV4 over the exact
/// headers and body sent, or the API key. `None` for an unparseable URL.
#[allow(clippy::too_many_arguments)]
fn signed(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, String)],
    body: &[u8],
    signer: &AwsSigner,
    region: &str,
    service: &str,
    mantle: bool,
) -> Option<reqwest::RequestBuilder> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = match (parsed.host_str()?, parsed.port()) {
        (h, Some(p)) => format!("{h}:{p}"),
        (h, None) => h.to_string(),
    };
    let mut req = client.post(parsed.clone());
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    match signer {
        AwsSigner::SigV4(creds) => {
            let to_sign: Vec<(&str, &str)> = headers
                .iter()
                .filter(|(k, _)| *k == "content-type")
                .map(|(k, v)| (*k, v.as_str()))
                .collect();
            let signed = super::sigv4::sign(
                &super::sigv4::Request {
                    method: "POST",
                    host: &host,
                    path: parsed.path(),
                    query: &[],
                    headers: &to_sign,
                    payload: body,
                },
                creds,
                region,
                service,
                chrono::Utc::now(),
            );
            for (k, v) in signed {
                let mut value = reqwest::header::HeaderValue::from_str(&v).ok()?;
                if k != "x-amz-date" {
                    value.set_sensitive(true);
                }
                req = req.header(k, value);
            }
        }
        AwsSigner::Bearer(key) => {
            let (name, raw) = if mantle {
                ("x-api-key", key.expose().to_string())
            } else {
                ("authorization", format!("Bearer {}", key.expose()))
            };
            let mut value = reqwest::header::HeaderValue::from_str(&raw).ok()?;
            value.set_sensitive(true);
            req = req.header(name, value);
        }
    }
    Some(req)
}

/// InvokeModelWithResponseStream → Anthropic SSE.
#[derive(Default)]
struct InvokeStream {
    dec: Decoder,
    failed: bool,
}

impl Translate for InvokeStream {
    fn feed(&mut self, bytes: &[u8]) -> String {
        self.dec.push(bytes);
        let mut out = String::new();
        while !self.failed {
            match self.dec.next_message() {
                None => break,
                Some(Err(e)) => {
                    self.failed = true;
                    out.push_str(&errors::sse_error(
                        "api_error",
                        &format!("AWS Bedrock: {e}"),
                    ));
                }
                Some(Ok(m)) => match exception(&m) {
                    Some(err) => {
                        self.failed = true;
                        out.push_str(&err);
                    }
                    None if m.header(":event-type") == Some("chunk") => {
                        if let Some(ev) = chunk_event(&m.payload) {
                            out.push_str(&ev);
                        }
                    }
                    None => {}
                },
            }
        }
        out
    }

    fn finish(&mut self) -> String {
        if !self.failed && self.dec.pending() > 0 {
            self.failed = true;
            return errors::sse_error("api_error", "AWS Bedrock: the stream ended inside a frame");
        }
        String::new()
    }

    fn done(&self) -> bool {
        self.failed
    }
}

/// One `chunk` payload — `{"bytes": "<base64 Anthropic event>"}` — as SSE.
fn chunk_event(payload: &[u8]) -> Option<String> {
    use base64::Engine;
    let wrapper: Value = serde_json::from_slice(payload).ok()?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(wrapper.get("bytes")?.as_str()?)
        .ok()?;
    let mut ev: Value = serde_json::from_slice(&raw).ok()?;
    // Bedrock appends its own metrics to the last event; the Messages
    // stream's `message_delta.usage` already carries the same counts.
    if let Some(o) = ev.as_object_mut() {
        o.remove("amazon-bedrock-invocationMetrics");
    }
    let name = ev.get("type")?.as_str()?.to_string();
    Some(sse::event(&name, &ev))
}

/// An exception or error frame as an Anthropic SSE `error` event.
fn exception(m: &super::eventstream::Message) -> Option<String> {
    let (name, message) = match m.header(":message-type") {
        Some("exception") => {
            let name = m.header(":exception-type").unwrap_or("").to_string();
            let payload: Value = serde_json::from_slice(&m.payload).unwrap_or(Value::Null);
            let message = payload
                .get("message")
                .or_else(|| payload.get("Message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (name, message)
        }
        Some("error") => (
            m.header(":error-code").unwrap_or("").to_string(),
            m.header(":error-message").unwrap_or("").to_string(),
        ),
        _ => return None,
    };
    let (_, kind) = errors::bedrock_mapping(&name, 500);
    Some(errors::sse_error(
        kind,
        &format!("AWS Bedrock {name}: {message}"),
    ))
}

/// ConverseStream → Anthropic SSE.
struct ConverseStream {
    dec: Decoder,
    t: super::converse::StreamTranslator,
    failed: bool,
}

impl Translate for ConverseStream {
    fn feed(&mut self, bytes: &[u8]) -> String {
        self.dec.push(bytes);
        let mut out = String::new();
        while !self.failed {
            match self.dec.next_message() {
                None => break,
                Some(Err(e)) => {
                    self.failed = true;
                    out.push_str(&errors::sse_error(
                        "api_error",
                        &format!("AWS Bedrock: {e}"),
                    ));
                }
                Some(Ok(m)) => match exception(&m) {
                    Some(err) => {
                        self.failed = true;
                        out.push_str(&err);
                    }
                    None => {
                        let kind = m.header(":event-type").unwrap_or("").to_string();
                        let payload: Value =
                            serde_json::from_slice(&m.payload).unwrap_or(Value::Null);
                        out.push_str(&self.t.on_event(&kind, &payload));
                    }
                },
            }
        }
        out
    }

    fn finish(&mut self) -> String {
        if self.failed {
            return String::new();
        }
        self.t.finish()
    }

    fn done(&self) -> bool {
        self.failed || self.t.closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::config::{AwsAuth, CloudConfig};
    use crate::cloud::eventstream::encode;
    use crate::cloud::sigv4::AwsCredentials;
    use crate::cloud::{CloudModel, CloudProvider};
    use base64::Engine;
    use wiremock::matchers::{body_json, header, header_exists, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn chunk(ev: Value) -> Vec<u8> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(ev.to_string());
        encode(
            &[
                (":event-type", "chunk"),
                (":content-type", "application/json"),
                (":message-type", "event"),
            ],
            json!({"bytes": b64, "p": "abcdefgh"})
                .to_string()
                .as_bytes(),
        )
    }

    #[test]
    fn the_invoke_model_body_follows_the_bedrock_claude_schema() {
        let body = json!({
            "model": "claude-sonnet-4-5",
            "stream": true,
            "metadata": {"user_id": "u"},
            "max_tokens": 100,
            "messages": [{"role": "user", "content": "hi"}],
            "anthropic_beta": ["context-1m-2025-08-07"]
        });
        let header = vec![
            "interleaved-thinking-2025-05-14".to_string(),
            "claude-code-20250219".to_string(),
            "oauth-2025-04-20".to_string(),
        ];
        assert_eq!(
            invoke_body(body, &header),
            json!({
                "anthropic_version": "bedrock-2023-05-31",
                "anthropic_beta": ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],
                "max_tokens": 100,
                "messages": [{"role": "user", "content": "hi"}]
            })
        );
        let plain = invoke_body(
            json!({"model": "m", "max_tokens": 1, "messages": []}),
            &["claude-code-20250219".into()],
        );
        assert!(plain.get("anthropic_beta").is_none());
    }

    #[test]
    fn invoke_stream_unwraps_chunks_into_sse_and_maps_exceptions() {
        let mut t = InvokeStream::default();
        let mut bytes = chunk(
            json!({"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 9, "output_tokens": 1}}}),
        );
        bytes.extend(chunk(json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}})));
        bytes.extend(chunk(json!({"type": "message_stop", "amazon-bedrock-invocationMetrics": {"inputTokenCount": 9}})));
        // Split mid-frame: the decoder must reassemble.
        let (a, b) = bytes.split_at(37);
        let out = format!("{}{}", t.feed(a), t.feed(b));
        assert_eq!(
            out,
            "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}},\"type\":\"message_start\"}\n\n\
             event: content_block_delta\ndata: {\"delta\":{\"text\":\"Hi\",\"type\":\"text_delta\"},\"index\":0,\"type\":\"content_block_delta\"}\n\n\
             event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
        );
        assert!(!t.done());

        let mut t = InvokeStream::default();
        let exc = encode(
            &[
                (":message-type", "exception"),
                (":exception-type", "throttlingException"),
            ],
            br#"{"message":"Too many tokens"}"#,
        );
        let out = t.feed(&exc);
        assert!(out.starts_with("event: error\n"), "{out}");
        assert!(out.contains("\"rate_limit_error\""), "{out}");
        assert!(t.done());
    }

    fn call_cfg(server: &MockServer) -> CloudConfig {
        CloudConfig::Bedrock(BedrockConfig {
            region: "us-east-1".into(),
            auth: AwsAuth::Static(AwsCredentials {
                access_key_id: "AKIDTEST".into(),
                secret_access_key: ["test", "secret"].concat(),
                session_token: None,
            }),
            runtime_endpoint: Some(server.uri()),
            mantle_endpoint: Some(server.uri()),
        })
    }

    async fn run(server: &MockServer, model: &str, body: Value) -> reqwest::Response {
        let cm = CloudModel {
            provider: CloudProvider::Bedrock,
            model: model.into(),
        };
        let cfg = call_cfg(server);
        let mut h = axum::http::HeaderMap::new();
        h.insert(
            "anthropic-beta",
            "interleaved-thinking-2025-05-14,claude-code-20250219"
                .parse()
                .unwrap(),
        );
        h.insert(
            "traceparent",
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
                .parse()
                .unwrap(),
        );
        let bytes = serde_json::to_vec(&body).unwrap();
        crate::cloud::send(
            &reqwest::Client::new(),
            crate::cloud::CloudCall {
                model: &cm,
                config: &cfg,
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
    async fn invoke_model_is_signed_for_bedrock_with_the_model_id_encoded_once_on_the_wire() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke"))
            .and(header("content-type", "application/json"))
            .and(header_exists("x-amz-date"))
            .and(header("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"))
            .and(body_json(json!({
                "anthropic_version": "bedrock-2023-05-31",
                "anthropic_beta": ["interleaved-thinking-2025-05-14"],
                "max_tokens": 50,
                "messages": [{"role": "user", "content": "hi"}]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5-20250929",
                "content": [{"type": "text", "text": "Hello"}], "stop_reason": "end_turn", "stop_sequence": null,
                "usage": {"input_tokens": 8, "output_tokens": 2}
            })))
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            json!({"model": "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", "max_tokens": 50, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await;
        assert_eq!(resp.status(), 200);
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["content"][0]["text"], "Hello");

        let req: &Request = &server.received_requests().await.unwrap()[0];
        let auth = req.headers.get("authorization").unwrap().to_str().unwrap();
        assert!(
            auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDTEST/"),
            "{auth}"
        );
        assert!(auth.contains("/us-east-1/bedrock/aws4_request"), "{auth}");
        assert!(
            auth.contains("SignedHeaders=content-type;host;x-amz-date,"),
            "{auth}"
        );
    }

    #[tokio::test]
    async fn mantle_takes_the_messages_body_unchanged_and_signs_for_bedrock_mantle() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/anthropic/v1/messages"))
            .and(header("anthropic-version", "2023-06-01"))
            .and(body_json(json!({"model": "anthropic.claude-opus-4-7", "max_tokens": 5, "stream": true, "messages": [{"role": "user", "content": "x"}]})))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"),
            )
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "anthropic.claude-opus-4-7",
            json!({"model": "bedrock/anthropic.claude-opus-4-7", "max_tokens": 5, "stream": true, "messages": [{"role": "user", "content": "x"}]}),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert!(resp.text().await.unwrap().contains("message_stop"));
        let req = &server.received_requests().await.unwrap()[0];
        let auth = req.headers.get("authorization").unwrap().to_str().unwrap();
        assert!(
            auth.contains("/us-east-1/bedrock-mantle/aws4_request"),
            "{auth}"
        );
        // Mantle is the Messages API: every beta goes through as a header.
        assert_eq!(
            req.headers["anthropic-beta"],
            "interleaved-thinking-2025-05-14,claude-code-20250219"
        );
    }

    #[tokio::test]
    async fn a_streamed_invoke_model_answer_reaches_the_proxy_as_anthropic_sse() {
        let server = MockServer::start().await;
        let mut frames = chunk(
            json!({"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "content": [], "usage": {"input_tokens": 3, "output_tokens": 1}}}),
        );
        frames.extend(chunk(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})));
        frames.extend(chunk(json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "streamed"}})));
        frames.extend(chunk(json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 4}})));
        frames.extend(chunk(json!({"type": "message_stop"})));
        Mock::given(method("POST"))
            .and(path(
                "/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke-with-response-stream",
            ))
            .and(header("accept", "application/vnd.amazon.eventstream"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/vnd.amazon.eventstream")
                    .set_body_bytes(frames),
            )
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "anthropic.claude-3-5-haiku-20241022-v1:0",
            json!({"max_tokens": 5, "stream": true, "messages": [{"role": "user", "content": "x"}]}),
        )
        .await;
        assert_eq!(resp.headers()["content-type"], "text/event-stream");
        let text = resp.text().await.unwrap();
        let usage_line = text
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(|d| serde_json::from_str::<Value>(d).unwrap())
            .fold(crate::usage::TokenUsage::default(), |mut acc, v| {
                // What the proxy's stream reader does with each event.
                acc.merge_from(crate::usage::TokenUsage::from_anthropic(
                    v.get("message").unwrap_or(&v),
                ));
                acc
            });
        assert!(text.contains("\"text\":\"streamed\""));
        assert_eq!(usage_line.uncached_input, Some(3));
        assert_eq!(usage_line.output, Some(4));
    }

    #[tokio::test]
    async fn converse_round_trips_a_non_anthropic_model() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/model/meta.llama3-1-70b-instruct-v1%3A0/converse"))
            .and(body_json(json!({
                "messages": [{"role": "user", "content": [{"text": "hi"}]}],
                "inferenceConfig": {"maxTokens": 20}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": {"message": {"role": "assistant", "content": [{"text": "hey"}]}},
                "stopReason": "end_turn",
                "usage": {"inputTokens": 4, "outputTokens": 1, "totalTokens": 5}
            })))
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "meta.llama3-1-70b-instruct-v1:0",
            json!({"max_tokens": 20, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await;
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["content"], json!([{"type": "text", "text": "hey"}]));
        assert_eq!(v["usage"]["input_tokens"], 4);
    }

    #[tokio::test]
    async fn converse_stream_frames_become_anthropic_sse() {
        let server = MockServer::start().await;
        let ev = |t: &str, p: Value| {
            encode(
                &[(":event-type", t), (":message-type", "event")],
                p.to_string().as_bytes(),
            )
        };
        let mut frames = ev("messageStart", json!({"role": "assistant"}));
        frames.extend(ev(
            "contentBlockDelta",
            json!({"contentBlockIndex": 0, "delta": {"text": "nova"}}),
        ));
        frames.extend(ev("contentBlockStop", json!({"contentBlockIndex": 0})));
        frames.extend(ev("messageStop", json!({"stopReason": "end_turn"})));
        frames.extend(ev(
            "metadata",
            json!({"usage": {"inputTokens": 2, "outputTokens": 1}}),
        ));
        Mock::given(method("POST"))
            .and(path("/model/amazon.nova-pro-v1%3A0/converse-stream"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(frames))
            .mount(&server)
            .await;
        let resp = run(&server, "amazon.nova-pro-v1:0", json!({"max_tokens": 5, "stream": true, "messages": [{"role": "user", "content": "x"}]})).await;
        let text = resp.text().await.unwrap();
        assert!(text.starts_with("event: message_start\n"), "{text}");
        assert!(text.contains("\"text\":\"nova\""));
        assert!(
            text.trim_end()
                .ends_with("data: {\"type\":\"message_stop\"}"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn bedrock_errors_reach_the_client_as_anthropic_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("x-amzn-errortype", "ThrottlingException")
                    .set_body_json(json!({"message": "Rate exceeded"})),
            )
            .mount(&server)
            .await;
        let resp = run(
            &server,
            "anthropic.claude-3-haiku-20240307-v1:0",
            json!({"max_tokens": 1, "messages": []}),
        )
        .await;
        assert_eq!(resp.status(), 429);
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["error"]["type"], "rate_limit_error");
    }

    #[tokio::test]
    async fn an_api_key_is_a_bearer_token_on_runtime_and_x_api_key_on_mantle() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"type": "message", "content": []})),
            )
            .mount(&server)
            .await;
        let client = reqwest::Client::new();
        let signer = AwsSigner::Bearer(crate::cloud::config::Secret::new("bedrock-api-key"));
        let url = format!("{}/model/x/invoke", server.uri());
        signed(
            &client,
            &url,
            &[],
            b"{}",
            &signer,
            "us-east-1",
            "bedrock",
            false,
        )
        .unwrap()
        .send()
        .await
        .unwrap();
        signed(
            &client,
            &url,
            &[],
            b"{}",
            &signer,
            "us-east-1",
            "bedrock-mantle",
            true,
        )
        .unwrap()
        .send()
        .await
        .unwrap();
        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs[0].headers["authorization"], "Bearer bedrock-api-key");
        assert_eq!(reqs[1].headers["x-api-key"], "bedrock-api-key");
        assert!(reqs[1].headers.get("authorization").is_none());
    }
}
