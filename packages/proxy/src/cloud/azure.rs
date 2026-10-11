//! Azure OpenAI and Azure AI Foundry, through the OpenAI v1 API.
//!
//! `POST {endpoint}/openai/v1/chat/completions` and `/openai/v1/responses`,
//! with the deployment name as `model` and no `api-version` — the v1 API
//! Azure made generally available in August 2025, served on both
//! `<resource>.openai.azure.com` and Foundry's
//! `<resource>.services.ai.azure.com`. Requests and answers, streaming and
//! errors included, are OpenAI's, so nothing is translated: the endpoint,
//! the deployment and the credential are what change.
//! <https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle>
//!
//! Authentication is an `api-key` header or an Entra ID bearer token
//! (`super::auth::azure_header`). Streams can carry chunks OpenAI's do not —
//! a first chunk with empty `choices` and `prompt_filter_results`, and
//! annotation-only chunks — which every OpenAI-wire reader in the proxy
//! already passes over: none has a delta to read.
//!
//! # Claude on Foundry
//!
//! A Claude deployment on a Foundry resource is called through the Messages
//! API Foundry serves at `{endpoint}/anthropic/v1/messages`: the Anthropic
//! request unchanged, with the deployment name as `model`, `api-key` (or an
//! Entra token for `https://ai.azure.com`) and `anthropic-version`; answers
//! and streams are the Messages API's own ([`send_claude`]).
//! <https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry>

use serde_json::{json, Value};

use super::errors;
use super::{auth, CloudCall, Wire};
use crate::protocol::Protocol;

pub fn path_for(protocol: &Protocol) -> Option<&'static str> {
    match protocol {
        Protocol::OpenAIChatCompletions | Protocol::Unknown => Some("/openai/v1/chat/completions"),
        Protocol::OpenAIResponses => Some("/openai/v1/responses"),
        Protocol::Anthropic | Protocol::Gemini => None,
    }
}

pub async fn send(
    client: &reqwest::Client,
    call: &CloudCall<'_>,
    cfg: &super::config::AzureConfig,
    mut body: Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let Some(path) = path_for(call.protocol) else {
        return Ok(errors::synthesize(
            Wire::OpenAI,
            400,
            "invalid_request_error",
            "Azure OpenAI deployments are served on /v1/chat/completions and /v1/responses",
        ));
    };
    let (name, secret) =
        match auth::azure_header(client, &cfg.auth, auth::AZURE_OPENAI_RESOURCE).await {
            Ok(h) => h,
            Err(e) => {
                return Ok(errors::synthesize(
                    Wire::OpenAI,
                    e.status,
                    e.kind,
                    &format!("Azure OpenAI: {}", e.message),
                ))
            }
        };
    let mut value = match reqwest::header::HeaderValue::from_str(secret.expose()) {
        Ok(v) => v,
        Err(_) => {
            return Ok(errors::synthesize(
                Wire::OpenAI,
                401,
                "authentication_error",
                "Azure OpenAI: the credential is not a valid header value",
            ))
        }
    };
    value.set_sensitive(true);
    body["model"] = json!(call.model.model);
    let mut req = client
        .post(format!("{}{path}", cfg.endpoint))
        .header(name, value)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .timeout(call.timeout);
    for (k, v) in super::trace_headers(call.client_headers) {
        req = req.header(k, v);
    }
    req.send().await
}

/// A Claude deployment on an Azure AI Foundry resource: the Messages API at
/// `/anthropic/v1/messages`, the body as the client sent it.
pub async fn send_claude(
    client: &reqwest::Client,
    call: &CloudCall<'_>,
    cfg: &super::config::AzureConfig,
    mut body: Value,
) -> Result<reqwest::Response, reqwest::Error> {
    // Claude is deployed on Foundry resources (`*.services.ai.azure.com`), not
    // on Azure OpenAI ones; say so rather than forward to a path that
    // resource does not have.
    let host = reqwest::Url::parse(&cfg.endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    if host.ends_with(".openai.azure.com") {
        return Ok(errors::synthesize(
            Wire::Anthropic,
            400,
            "invalid_request_error",
            "Azure AI Foundry: Claude deployments are served on a Foundry resource \
             (https://<resource>.services.ai.azure.com); this workspace's Azure endpoint is an \
             Azure OpenAI resource, which serves /v1/chat/completions and /v1/responses only",
        ));
    }
    let (name, secret) = match auth::azure_header(client, &cfg.auth, auth::AZURE_AI_RESOURCE).await
    {
        Ok(h) => h,
        Err(e) => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                e.status,
                e.kind,
                &format!("Azure AI Foundry: {}", e.message),
            ))
        }
    };
    let mut value = match reqwest::header::HeaderValue::from_str(secret.expose()) {
        Ok(v) => v,
        Err(_) => {
            return Ok(errors::synthesize(
                Wire::Anthropic,
                401,
                "authentication_error",
                "Azure AI Foundry: the credential is not a valid header value",
            ))
        }
    };
    value.set_sensitive(true);
    body["model"] = json!(call.model.model);
    let mut req = client
        .post(format!("{}/anthropic/v1/messages", cfg.endpoint))
        .header(name, value)
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .timeout(call.timeout);
    let betas = super::anthropic_betas(call.client_headers);
    if !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    for (k, v) in super::trace_headers(call.client_headers) {
        req = req.header(k, v);
    }
    req.send().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::config::{AzureAuth, AzureConfig, CloudConfig, Secret};
    use crate::cloud::{CloudModel, CloudProvider};
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn run(server: &MockServer, protocol: Protocol, body: Value) -> reqwest::Response {
        let cm = CloudModel {
            provider: CloudProvider::Azure,
            model: "gpt4o-prod".into(),
        };
        let cfg = CloudConfig::Azure(AzureConfig {
            endpoint: server.uri(),
            auth: AzureAuth::ApiKey(Secret::new("azure-key-1")),
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        crate::cloud::send(
            &reqwest::Client::new(),
            crate::cloud::CloudCall {
                model: &cm,
                config: &cfg,
                protocol: &protocol,
                body: &bytes,
                client_headers: &axum::http::HeaderMap::new(),
                timeout: std::time::Duration::from_secs(10),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn chat_completions_go_to_the_v1_api_with_the_deployment_as_model() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/openai/v1/chat/completions"))
            .and(header("api-key", "azure-key-1"))
            .and(body_json(json!({"model": "gpt4o-prod", "messages": [{"role": "user", "content": "hi"}], "stream": false})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-4o-2024-08-06",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}
            })))
            .mount(&server)
            .await;
        let resp = run(
            &server,
            Protocol::OpenAIChatCompletions,
            json!({"model": "azure/gpt4o-prod", "messages": [{"role": "user", "content": "hi"}], "stream": false}),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
            "hello"
        );
    }

    #[tokio::test]
    async fn responses_go_to_the_v1_responses_path() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/openai/v1/responses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"object": "response", "output": []})),
            )
            .mount(&server)
            .await;
        let resp = run(
            &server,
            Protocol::OpenAIResponses,
            json!({"model": "azure/gpt4o-prod", "input": "hi"}),
        )
        .await;
        assert_eq!(resp.status(), 200);
    }

    #[tokio::test]
    async fn azure_errors_pass_through_in_openai_shape_with_retry_hints() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("retry-after-ms", "1200")
                    .set_body_json(json!({"error": {"code": "429", "message": "Requests to the deployment have exceeded the rate limit."}})),
            )
            .mount(&server)
            .await;
        let resp = run(
            &server,
            Protocol::OpenAIChatCompletions,
            json!({"messages": []}),
        )
        .await;
        assert_eq!(resp.status(), 429);
        assert_eq!(resp.headers()["retry-after-ms"], "1200");
    }

    async fn run_claude(
        server_uri: &str,
        model: &str,
        body: Value,
        betas: Option<&str>,
    ) -> reqwest::Response {
        let cm = CloudModel {
            provider: CloudProvider::AzureClaude,
            model: model.into(),
        };
        let cfg = CloudConfig::Azure(AzureConfig {
            endpoint: server_uri.into(),
            auth: AzureAuth::ApiKey(Secret::new("foundry-key-1")),
        });
        let mut h = axum::http::HeaderMap::new();
        if let Some(b) = betas {
            h.insert("anthropic-beta", b.parse().unwrap());
        }
        let bytes = serde_json::to_vec(&body).unwrap();
        crate::cloud::send(
            &reqwest::Client::new(),
            crate::cloud::CloudCall {
                model: &cm,
                config: &cfg,
                protocol: &Protocol::Anthropic,
                body: &bytes,
                client_headers: &h,
                timeout: std::time::Duration::from_secs(10),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_foundry_claude_deployment_takes_the_messages_body_unchanged() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/anthropic/v1/messages"))
            .and(header("api-key", "foundry-key-1"))
            .and(header("anthropic-version", "2023-06-01"))
            .and(header("anthropic-beta", "context-1m-2025-08-07"))
            .and(body_json(
                json!({"model": "claude-opus-5-5", "max_tokens": 9, "stream": true,
                                   "messages": [{"role": "user", "content": "hi"}]}),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let resp = run_claude(
            &server.uri(),
            "claude-opus-5-5",
            json!({"model": "azure/claude-opus-5-5", "max_tokens": 9, "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]}),
            Some("context-1m-2025-08-07"),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert!(resp.text().await.unwrap().contains("message_stop"));
    }

    #[tokio::test]
    async fn claude_on_an_azure_openai_resource_is_refused_with_the_reason() {
        let resp = run_claude(
            "https://corp.openai.azure.com",
            "claude-opus-5-5",
            json!({"max_tokens": 1, "messages": []}),
            None,
        )
        .await;
        assert_eq!(resp.status(), 400);
        let v: Value = resp.json().await.unwrap();
        assert_eq!(v["type"], "error");
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("services.ai.azure.com"));
    }

    #[tokio::test]
    async fn the_anthropic_wire_is_refused_before_any_call() {
        let server = MockServer::start().await;
        let resp = run(&server, Protocol::Anthropic, json!({"messages": []})).await;
        assert_eq!(resp.status(), 400);
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
