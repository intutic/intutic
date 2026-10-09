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
    let (name, secret) = match auth::azure_header(client, &cfg.auth).await {
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

    #[tokio::test]
    async fn the_anthropic_wire_is_refused_before_any_call() {
        let server = MockServer::start().await;
        let resp = run(&server, Protocol::Anthropic, json!({"messages": []})).await;
        assert_eq!(resp.status(), 400);
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
