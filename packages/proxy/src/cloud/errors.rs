//! Cloud error responses, re-expressed in the wire the proxy presents.
//!
//! Bedrock answers `{"message": …}` with the error name in `x-amzn-ErrorType`;
//! Vertex answers Google's `{"error": {"code", "message", "status"}}`. The
//! client, the proxy's unservable-model recovery
//! (`routing::bandit::is_unservable_model_error`) and an upstream retry layer
//! all read the Anthropic error contract instead, so each cloud error becomes
//! the Anthropic status and `error.type` that means the same thing:
//!
//! | Upstream | Status | `error.type` |
//! |---|---|---|
//! | Throttling / quota / `RESOURCE_EXHAUSTED` | 429 | `rate_limit_error` |
//! | `ServiceUnavailable`, `ModelNotReady`, `UNAVAILABLE` | 529 | `overloaded_error` |
//! | Validation / `INVALID_ARGUMENT` | 400 | `invalid_request_error` |
//! | Bad or expired credentials / `UNAUTHENTICATED` | 401 | `authentication_error` |
//! | `AccessDenied` / `PERMISSION_DENIED` | 403 | `permission_error` |
//! | `ResourceNotFound` / `NOT_FOUND` | 404 | `not_found_error` |
//! | Model timeout / `DEADLINE_EXCEEDED` | 504 | `api_error` |
//! | Anything else 5xx | as sent | `api_error` |
//!
//! 529 is Anthropic's own overloaded status, which Anthropic clients retry
//! with backoff; a 503 would be retried too, but would read as a proxy fault.
//! `retry-after` / `retry-after-ms` headers are kept.

use super::Wire;
use serde_json::{json, Value};

/// An error response in `wire`'s shape.
pub fn synthesize(wire: Wire, status: u16, error_type: &str, message: &str) -> reqwest::Response {
    let body = error_body(wire, error_type, message);
    build(status, &[], body.to_string())
}

pub fn error_body(wire: Wire, error_type: &str, message: &str) -> Value {
    match wire {
        Wire::Anthropic => json!({
            "type": "error",
            "error": {"type": error_type, "message": message}
        }),
        Wire::OpenAI => json!({
            "error": {"message": message, "type": error_type, "code": null}
        }),
    }
}

/// A JSON response with `status`, the kept upstream headers and `body`.
pub(crate) fn build(status: u16, keep: &[(String, String)], body: String) -> reqwest::Response {
    let mut b = axum::http::Response::builder()
        .status(status)
        .header("content-type", "application/json");
    for (k, v) in keep {
        b = b.header(k.as_str(), v.as_str());
    }
    reqwest::Response::from(
        b.body(reqwest::Body::from(body))
            .expect("status and header names are static and valid"),
    )
}

/// The upstream headers a client's retry logic reads.
pub(crate) fn retry_headers(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    ["retry-after", "retry-after-ms"]
        .into_iter()
        .filter_map(|n| {
            headers
                .get(n)
                .and_then(|v| v.to_str().ok())
                .map(|v| (n.to_string(), v.to_string()))
        })
        .collect()
}

/// Anthropic status and error type for a Bedrock error name
/// (`ThrottlingException`, or the camel-case `throttlingException` an
/// in-stream exception frame carries). `status` is the HTTP status it arrived
/// with, used only when the name is unknown.
pub fn bedrock_mapping(error_name: &str, status: u16) -> (u16, &'static str) {
    // restJson1: keep the text before the first ':' and after the first '#'.
    let name = error_name.split(':').next().unwrap_or(error_name);
    let name = name.rsplit('#').next().unwrap_or(name);
    match name.to_ascii_lowercase().as_str() {
        "throttlingexception" | "servicequotaexceededexception" | "toomanyrequestsexception" => {
            (429, "rate_limit_error")
        }
        "serviceunavailableexception" | "modelnotreadyexception" => (529, "overloaded_error"),
        "validationexception" => (400, "invalid_request_error"),
        "unrecognizedclientexception"
        | "invalidsignatureexception"
        | "incompletesignatureexception"
        | "expiredtokenexception"
        | "missingauthenticationtokenexception" => (401, "authentication_error"),
        "accessdeniedexception" => (403, "permission_error"),
        "resourcenotfoundexception" => (404, "not_found_error"),
        "modeltimeoutexception" => (504, "api_error"),
        "modelerrorexception" | "modelstreamerrorexception" => (502, "api_error"),
        "internalserverexception" => (500, "api_error"),
        _ => by_status(status),
    }
}

/// Anthropic status and error type for a Google RPC status name.
pub fn google_mapping(rpc_status: &str, status: u16) -> (u16, &'static str) {
    match rpc_status {
        "RESOURCE_EXHAUSTED" => (429, "rate_limit_error"),
        "UNAVAILABLE" => (529, "overloaded_error"),
        "INVALID_ARGUMENT" | "FAILED_PRECONDITION" | "OUT_OF_RANGE" => {
            (400, "invalid_request_error")
        }
        "UNAUTHENTICATED" => (401, "authentication_error"),
        "PERMISSION_DENIED" => (403, "permission_error"),
        "NOT_FOUND" => (404, "not_found_error"),
        "DEADLINE_EXCEEDED" => (504, "api_error"),
        _ => by_status(status),
    }
}

fn by_status(status: u16) -> (u16, &'static str) {
    match status {
        400 => (400, "invalid_request_error"),
        401 => (401, "authentication_error"),
        403 => (403, "permission_error"),
        404 => (404, "not_found_error"),
        413 => (413, "request_too_large"),
        429 => (429, "rate_limit_error"),
        503 | 529 => (529, "overloaded_error"),
        s if (400..500).contains(&s) => (s, "invalid_request_error"),
        s if (500..600).contains(&s) => (s, "api_error"),
        _ => (502, "api_error"),
    }
}

/// Re-express a non-2xx Bedrock response as an Anthropic error.
pub fn from_bedrock(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    body: &str,
) -> reqwest::Response {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    // Mantle speaks the Messages API, errors included.
    if parsed.get("type").and_then(|t| t.as_str()) == Some("error") {
        return build(status, &retry_headers(headers), body.to_string());
    }
    let name = headers
        .get("x-amzn-errortype")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            ["__type", "code"]
                .iter()
                .find_map(|k| parsed.get(*k).and_then(|v| v.as_str()).map(str::to_string))
        })
        .unwrap_or_default();
    let message = parsed
        .get("message")
        .or_else(|| parsed.get("Message"))
        .and_then(|m| m.as_str())
        .unwrap_or(body);
    let (mapped, kind) = bedrock_mapping(&name, status);
    let short = name
        .split(':')
        .next()
        .unwrap_or("")
        .rsplit('#')
        .next()
        .unwrap_or("");
    let message = if short.is_empty() {
        format!("Bedrock: {message}")
    } else {
        format!("Bedrock {short}: {message}")
    };
    build(
        mapped,
        &retry_headers(headers),
        error_body(Wire::Anthropic, kind, &message).to_string(),
    )
}

/// Re-express a non-2xx Vertex AI response as an Anthropic error. Claude on
/// Vertex already answers in Anthropic's shape; that passes through.
pub fn from_vertex(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    body: &str,
) -> reqwest::Response {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if parsed.get("type").and_then(|t| t.as_str()) == Some("error") {
        return build(status, &retry_headers(headers), body.to_string());
    }
    // Google answers either `{error: {...}}` or, from streamGenerateContent,
    // `[{error: {...}}]`.
    let err = parsed
        .get("error")
        .or_else(|| parsed.get(0).and_then(|e| e.get("error")))
        .cloned()
        .unwrap_or(Value::Null);
    let rpc = err.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let message = err.get("message").and_then(|m| m.as_str()).unwrap_or(body);
    let (mapped, kind) = google_mapping(rpc, status);
    build(
        mapped,
        &retry_headers(headers),
        error_body(Wire::Anthropic, kind, &format!("Vertex AI: {message}")).to_string(),
    )
}

/// An Anthropic SSE `error` event, for a failure after the stream started.
pub fn sse_error(kind: &str, message: &str) -> String {
    super::sse::event("error", &error_body(Wire::Anthropic, kind, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read(resp: reqwest::Response) -> (u16, Value, Vec<(String, String)>) {
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        let body = resp.json::<Value>().await.unwrap();
        (status, body, headers)
    }

    fn headers(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[tokio::test]
    async fn bedrock_throttling_is_a_429_rate_limit_error_with_retry_after_kept() {
        let resp = from_bedrock(
            429,
            &headers(&[
                (
                    "x-amzn-errortype",
                    "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/",
                ),
                ("retry-after", "3"),
            ]),
            r#"{"message":"Too many requests, please wait before trying again."}"#,
        );
        let (status, body, hdrs) = read(resp).await;
        assert_eq!(status, 429);
        assert_eq!(body["type"], "error");
        assert_eq!(body["error"]["type"], "rate_limit_error");
        assert_eq!(
            body["error"]["message"],
            "Bedrock ThrottlingException: Too many requests, please wait before trying again."
        );
        assert!(hdrs.contains(&("retry-after".into(), "3".into())));
    }

    #[tokio::test]
    async fn bedrock_quota_is_a_rate_limit_even_though_bedrock_sends_400() {
        let resp = from_bedrock(
            400,
            &headers(&[]),
            r#"{"__type":"com.amazon.coral#ServiceQuotaExceededException","message":"quota"}"#,
        );
        let (status, body, _) = read(resp).await;
        assert_eq!(status, 429);
        assert_eq!(body["error"]["type"], "rate_limit_error");
    }

    #[tokio::test]
    async fn an_unknown_bedrock_model_reads_as_unservable_to_the_router() {
        let resp = from_bedrock(
            404,
            &headers(&[("x-amzn-errortype", "ResourceNotFoundException")]),
            r#"{"message":"Could not resolve the foundation model from the provided model identifier."}"#,
        );
        let (status, body, _) = read(resp).await;
        assert_eq!(status, 404);
        assert!(crate::routing::bandit::is_unservable_model_error(
            status,
            &body.to_string()
        ));
    }

    #[test]
    fn bedrock_names_map_per_the_table() {
        assert_eq!(
            bedrock_mapping("ServiceUnavailableException", 503),
            (529, "overloaded_error")
        );
        assert_eq!(
            bedrock_mapping("modelNotReadyException", 429),
            (529, "overloaded_error")
        );
        assert_eq!(
            bedrock_mapping("ValidationException", 400),
            (400, "invalid_request_error")
        );
        assert_eq!(
            bedrock_mapping("AccessDeniedException", 403),
            (403, "permission_error")
        );
        assert_eq!(
            bedrock_mapping("UnrecognizedClientException", 403),
            (401, "authentication_error")
        );
        assert_eq!(
            bedrock_mapping("ExpiredTokenException", 403),
            (401, "authentication_error")
        );
        assert_eq!(
            bedrock_mapping("ModelTimeoutException", 408),
            (504, "api_error")
        );
        assert_eq!(
            bedrock_mapping("ModelErrorException", 424),
            (502, "api_error")
        );
        assert_eq!(
            bedrock_mapping("InternalServerException", 500),
            (500, "api_error")
        );
        assert_eq!(bedrock_mapping("", 418), (418, "invalid_request_error"));
        assert_eq!(bedrock_mapping("", 502), (502, "api_error"));
    }

    /// What each provider documents as transient is retried by the upstream
    /// retry layer's default policy; what describes the request is not.
    #[test]
    fn transient_cloud_errors_are_retryable_and_request_errors_are_final() {
        use crate::routing::retry::{classify_status, RetryConfig};
        let cfg = RetryConfig::default();
        let h = reqwest::header::HeaderMap::new();
        for name in [
            "ThrottlingException",
            "ServiceQuotaExceededException",
            "ModelNotReadyException",
            "ServiceUnavailableException",
            "ModelTimeoutException",
            "ModelErrorException",
            "InternalServerException",
            "modelStreamErrorException",
        ] {
            let (status, _) = bedrock_mapping(name, 400);
            assert!(
                classify_status(status, &h, &cfg).is_some(),
                "{name} -> {status}"
            );
        }
        for name in [
            "ValidationException",
            "AccessDeniedException",
            "ResourceNotFoundException",
            "UnrecognizedClientException",
        ] {
            let (status, _) = bedrock_mapping(name, 400);
            assert!(
                classify_status(status, &h, &cfg).is_none(),
                "{name} -> {status}"
            );
        }
        for rpc in [
            "RESOURCE_EXHAUSTED",
            "UNAVAILABLE",
            "DEADLINE_EXCEEDED",
            "INTERNAL",
        ] {
            let (status, _) = google_mapping(rpc, 500);
            assert!(
                classify_status(status, &h, &cfg).is_some(),
                "{rpc} -> {status}"
            );
        }
        for rpc in [
            "INVALID_ARGUMENT",
            "PERMISSION_DENIED",
            "NOT_FOUND",
            "UNAUTHENTICATED",
        ] {
            let (status, _) = google_mapping(rpc, 400);
            assert!(
                classify_status(status, &h, &cfg).is_none(),
                "{rpc} -> {status}"
            );
        }
    }

    #[tokio::test]
    async fn vertex_resource_exhausted_is_a_429() {
        let resp = from_vertex(
            429,
            &headers(&[]),
            r#"{"error":{"code":429,"message":"Resource exhausted, please try again later.","status":"RESOURCE_EXHAUSTED"}}"#,
        );
        let (status, body, _) = read(resp).await;
        assert_eq!(status, 429);
        assert_eq!(body["error"]["type"], "rate_limit_error");
        assert_eq!(
            body["error"]["message"],
            "Vertex AI: Resource exhausted, please try again later."
        );
    }

    #[tokio::test]
    async fn vertex_stream_errors_arrive_as_an_array_and_still_map() {
        let resp = from_vertex(
            503,
            &headers(&[]),
            r#"[{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}]"#,
        );
        let (status, body, _) = read(resp).await;
        assert_eq!(status, 529);
        assert_eq!(body["error"]["type"], "overloaded_error");
    }

    #[tokio::test]
    async fn an_anthropic_shaped_error_from_claude_on_vertex_passes_through() {
        let raw = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let (status, body, _) = read(from_vertex(529, &headers(&[]), raw)).await;
        assert_eq!(status, 529);
        assert_eq!(body, serde_json::from_str::<Value>(raw).unwrap());
    }

    #[tokio::test]
    async fn openai_wire_errors_use_the_openai_shape() {
        let (status, body, _) = read(synthesize(
            Wire::OpenAI,
            400,
            "invalid_request_error",
            "bad",
        ))
        .await;
        assert_eq!(status, 400);
        assert_eq!(body["error"]["message"], "bad");
        assert_eq!(body["error"]["type"], "invalid_request_error");
    }
}
