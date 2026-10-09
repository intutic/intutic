//! Upstream retries: when to try a provider call again, and how long to wait.
//!
//! Provider-agnostic on purpose. Nothing here knows what an Anthropic or an
//! OpenAI request looks like: [`send_with_retry`] takes a closure that builds
//! and sends ONE attempt, so a provider whose requests must be re-signed per
//! attempt (a timestamped signature) builds a fresh one each time, and the
//! fallback chain in `proxy.rs` reuses the same loop for every target.
//!
//! ## The retry boundary
//!
//! A request is retried only while nothing has reached the client. The proxy
//! forwards nothing until the upstream's response head arrives, so the
//! boundary is that head: a retryable status or a transport failure before it
//! is retried, and a 2xx head commits the request. A stream that later dies,
//! or an SSE `error` event inside a 200 stream, is never retried — the client
//! may already hold half an answer, and a second one would be spliced onto it.
//!
//! ## What is safe to send twice
//!
//! Only inference calls (`is_retry_safe_endpoint`): a Messages, Chat
//! Completions, Responses or Gemini `generateContent` POST creates nothing the
//! caller can address later, so a duplicate costs tokens and changes no state.
//! That is the same judgement the official Anthropic and OpenAI SDKs make when
//! they retry these calls by default. Everything else the proxy passes through
//! — batches, files, Gemini cached contents — creates a resource, and is sent
//! exactly once.

use std::time::{Duration, Instant};

use rand::Rng;
use serde::{Deserialize, Serialize};

/// Retry settings, `intutic_settings.routing.retry` in config.yaml.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default)]
pub struct RetryConfig {
    /// On by default: without it every provider overload surfaces as the
    /// proxy's failure the moment it is inline.
    pub enabled: bool,
    /// Calls per target, the first one included. `1` disables retries while
    /// leaving fallbacks on.
    pub max_attempts: u32,
    /// Upper bound of the first backoff window. Attempt `n` waits a uniformly
    /// random time in `[0, min(max_backoff_ms, initial_backoff_ms * 2^(n-1))]`
    /// — "full jitter", which spreads a burst of clients that all failed at
    /// the same instant instead of having them retry in lockstep.
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    /// Wall-clock budget for the whole request — every target, every attempt
    /// and every wait. A retry or fallback that could not START inside the
    /// budget is not made. A call already in flight keeps its own timeout:
    /// cutting it would truncate a long generation that was going to succeed.
    pub budget_ms: u64,
    /// Statuses that are retried. Anything else is the provider's answer.
    pub on_status: Vec<u16>,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            // One call plus two retries — the official Anthropic and OpenAI
            // SDKs' own default. Clients that also retry multiply this, so it
            // stays small.
            max_attempts: 3,
            initial_backoff_ms: 500,
            max_backoff_ms: 8_000,
            budget_ms: 30_000,
            on_status: DEFAULT_RETRY_STATUSES.to_vec(),
        }
    }
}

impl RetryConfig {
    /// The same ceilings the workspace setting's schema enforces, applied to
    /// config.yaml too, so neither source can configure a retry storm: at most
    /// five calls per target (Portkey's ceiling as well), a one-minute
    /// backoff cap and a two-minute budget.
    pub fn bounded(mut self) -> Self {
        self.max_attempts = self.max_attempts.clamp(1, MAX_ATTEMPTS_CEILING);
        self.max_backoff_ms = self.max_backoff_ms.min(MAX_BACKOFF_CEILING_MS);
        self.initial_backoff_ms = self.initial_backoff_ms.min(self.max_backoff_ms);
        self.budget_ms = self.budget_ms.min(BUDGET_CEILING_MS);
        self
    }
}

pub const MAX_ATTEMPTS_CEILING: u32 = 5;
pub const MAX_BACKOFF_CEILING_MS: u64 = 60_000;
pub const BUDGET_CEILING_MS: u64 = 120_000;

/// One fallback target. `model` alone switches model on the provider that
/// model's id resolves to; `provider` alone sends the SAME model to another
/// provider; both pin the pair. At least one is required.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FallbackTarget {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
}

impl FallbackTarget {
    /// The model this target asks for, given the model that failed.
    pub fn model_for(&self, primary_model: &str) -> String {
        self.model
            .clone()
            .unwrap_or_else(|| primary_model.to_string())
    }
}

/// Ordered fallback targets per served model, `intutic_settings.routing.fallbacks`.
/// Keyed by the model that was actually sent upstream (after routing), since
/// that is the model whose retries ran out.
pub type FallbackMap = std::collections::BTreeMap<String, Vec<FallbackTarget>>;

/// Fallback chains are short on purpose: every target can spend the whole
/// retry budget's remainder.
pub const MAX_FALLBACK_TARGETS: usize = 5;

/// Drop the entries no request could use, loudly: a target naming neither a
/// model nor a provider, and anything past [`MAX_FALLBACK_TARGETS`].
pub fn sanitize_fallbacks(mut map: FallbackMap) -> FallbackMap {
    for (model, targets) in map.iter_mut() {
        targets.retain(|t| {
            let usable = t.model.as_deref().is_some_and(|m| !m.trim().is_empty())
                || t.provider.as_deref().is_some_and(|p| !p.trim().is_empty());
            if !usable {
                tracing::error!(model = %model, "routing.fallbacks target names neither a model nor a provider — dropped");
            }
            usable
        });
        if targets.len() > MAX_FALLBACK_TARGETS {
            tracing::error!(model = %model, kept = MAX_FALLBACK_TARGETS, "routing.fallbacks lists too many targets — the rest are dropped");
            targets.truncate(MAX_FALLBACK_TARGETS);
        }
    }
    map.retain(|_, targets| !targets.is_empty());
    map
}

/// The workspace's `upstreamRetry` setting, as `/api/v1/auth/key-context`
/// carries it. Every field is optional and overrides the proxy's config.yaml
/// value when present, so a workspace can change one knob without restating
/// the rest.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRetry {
    pub enabled: Option<bool>,
    pub max_attempts: Option<u32>,
    pub initial_backoff_ms: Option<u64>,
    pub max_backoff_ms: Option<u64>,
    pub budget_ms: Option<u64>,
    pub on_status: Option<Vec<u16>>,
    pub fallbacks: Option<FallbackMap>,
}

impl WorkspaceRetry {
    /// Lay this setting over the proxy's own config.
    pub fn apply(
        &self,
        base: &RetryConfig,
        base_fallbacks: &FallbackMap,
    ) -> (RetryConfig, FallbackMap) {
        let cfg = RetryConfig {
            enabled: self.enabled.unwrap_or(base.enabled),
            max_attempts: self.max_attempts.unwrap_or(base.max_attempts),
            initial_backoff_ms: self.initial_backoff_ms.unwrap_or(base.initial_backoff_ms),
            max_backoff_ms: self.max_backoff_ms.unwrap_or(base.max_backoff_ms),
            budget_ms: self.budget_ms.unwrap_or(base.budget_ms),
            on_status: self
                .on_status
                .clone()
                .unwrap_or_else(|| base.on_status.clone()),
        }
        .bounded();
        let fallbacks = match &self.fallbacks {
            Some(f) => sanitize_fallbacks(f.clone()),
            None => base_fallbacks.clone(),
        };
        (cfg, fallbacks)
    }
}

/// Reads the `upstreamRetry` field of a `/auth/key-context` body. Absent (an
/// older control plane) and `null` (no setting, or one the control plane
/// could not read) both mean the proxy's config applies alone. A value that
/// does not parse is logged and ignored for the same reason: retries are an
/// availability feature, and a bad setting must not stop requests.
pub fn parse_key_context(body: &serde_json::Value) -> Option<WorkspaceRetry> {
    let field = body.get("upstreamRetry")?;
    if field.is_null() {
        return None;
    }
    match serde_json::from_value::<WorkspaceRetry>(field.clone()) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!(error = %e, "workspace upstreamRetry setting did not parse; using this proxy's config");
            None
        }
    }
}

/// Rate limited (429), provider error (500), bad gateway (502), unavailable
/// (503), gateway timeout (504) and Anthropic's overloaded (529). 4xx other
/// than 429 describe the request itself and would fail the same way again.
pub const DEFAULT_RETRY_STATUSES: [u16; 6] = [429, 500, 502, 503, 504, 529];

/// Error codes that mean a 429 will not clear by waiting: a spend cap or an
/// exhausted quota, which lasts until a billing period or an operator changes
/// it. Anthropic answers a reached spend cap with a 429 and
/// `enforced_spend_limit_reached`; OpenAI uses the rest. Retrying them burns
/// the budget for nothing, and falling back to another paid provider would
/// route around a limit someone set on purpose — so they are final.
const QUOTA_EXHAUSTED_CODES: [&str; 6] = [
    "enforced_spend_limit_reached",
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
];

/// Every call the proxy makes to a target is capped by this, matching the
/// timeout the single-attempt send always had.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// One upstream call, as recorded on the execution trace.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpstreamAttempt {
    /// The model this call asked for.
    pub model: String,
    /// The provider it went to ("anthropic", "openai", ...).
    pub provider: String,
    /// What came back: `ok`, `http_<status>`, `timeout`, `connect_error`,
    /// `transport_error`, or `skipped` for a fallback target that was not
    /// called (`stopped` says why).
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub latency_ms: u32,
    /// How long the proxy waited before the NEXT call, when there was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backoff_ms: Option<u32>,
    /// True when that wait came from the provider (`retry-after`,
    /// `retry-after-ms`, `x-ratelimit-reset-*`) rather than the backoff curve.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub server_delay: bool,
    /// Why no further call was made on this target: `max_attempts`, `budget`,
    /// `retry_after_exceeds_budget`, `provider_declined` (`x-should-retry:
    /// false`) or `quota_exhausted` (a spend cap or quota 429). For a skipped
    /// fallback target: `same_target`, `wire_mismatch`, `model_not_allowed`,
    /// `no_credential`, `unknown_provider` or `budget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
}

impl UpstreamAttempt {
    /// A fallback target that was not called, and why.
    pub fn skipped(model: &str, provider: &str, reason: &str) -> Self {
        Self {
            model: model.to_string(),
            provider: provider.to_string(),
            outcome: "skipped".to_string(),
            status: None,
            latency_ms: 0,
            backoff_ms: None,
            server_delay: false,
            stopped: Some(reason.to_string()),
        }
    }
}

/// How many upstream calls `attempts` records — skipped fallback targets are
/// listed but were never called.
pub fn calls_made(attempts: &[UpstreamAttempt]) -> usize {
    attempts.iter().filter(|a| a.outcome != "skipped").count()
}

/// The attempts worth putting on the trace: every one, unless the request was
/// the ordinary single call that nothing stopped, which the rest of the trace
/// already describes. Keeps the wire shape of every untroubled request as it
/// was.
pub fn for_trace(attempts: Vec<UpstreamAttempt>) -> Vec<UpstreamAttempt> {
    if attempts.len() == 1 && attempts[0].stopped.is_none() {
        Vec::new()
    } else {
        attempts
    }
}

/// The fallback that served a request, as recorded on the execution trace.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpstreamFallback {
    /// The model whose retries were exhausted.
    pub from_model: String,
    /// The fallback target that answered.
    pub to_model: String,
    pub to_provider: String,
    /// True when the session's prompt cache was warm on `from_model` and the
    /// fallback is a different model family, so this turn paid full price for
    /// a prefix the primary had cached. The session lock is never moved, so
    /// the next turn goes back to the primary and its cache.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cache_affinity_broken: bool,
}

/// Why an attempt failed in a way worth trying again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retryable {
    Status(u16),
    Timeout,
    Connect,
    Transport,
}

impl Retryable {
    pub fn outcome(self) -> String {
        match self {
            Retryable::Status(s) => format!("http_{s}"),
            Retryable::Timeout => "timeout".to_string(),
            Retryable::Connect => "connect_error".to_string(),
            Retryable::Transport => "transport_error".to_string(),
        }
    }
}

/// Whether a call to `path` can be sent twice without creating anything twice.
/// See the module docs for the rule.
pub fn is_retry_safe_endpoint(method: &str, path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    matches!(
        path,
        "/v1/messages" | "/v1/chat/completions" | "/v1/responses"
    ) || (path.starts_with("/v1beta/models/")
        && (path.ends_with(":generateContent") || path.ends_with(":streamGenerateContent")))
}

/// The provider's own verdict, when it gave one. Anthropic and OpenAI both
/// send `x-should-retry`, and their SDKs obey it over the status code.
fn provider_says_retry(headers: &reqwest::header::HeaderMap) -> Option<bool> {
    match headers.get("x-should-retry")?.to_str().ok()?.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Classify a response head. `None` means the response is final.
pub fn classify_status(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    cfg: &RetryConfig,
) -> Option<Retryable> {
    if (200..300).contains(&status) {
        return None;
    }
    match provider_says_retry(headers) {
        Some(false) => None,
        Some(true) => Some(Retryable::Status(status)),
        None => cfg
            .on_status
            .contains(&status)
            .then_some(Retryable::Status(status)),
    }
}

/// Classify a failed send. Builder errors (a malformed request) and redirect
/// loops are deterministic and are never retried.
pub fn classify_error(err: &reqwest::Error) -> Option<Retryable> {
    if err.is_builder() || err.is_redirect() {
        None
    } else if err.is_timeout() {
        Some(Retryable::Timeout)
    } else if err.is_connect() {
        Some(Retryable::Connect)
    } else {
        Some(Retryable::Transport)
    }
}

/// How long the provider asked us to wait, if it said.
///
/// Read in precedence order: `retry-after-ms` (milliseconds, Anthropic and
/// OpenAI), `retry-after` (RFC 9110: delay-seconds or an HTTP-date), then the
/// OpenAI `x-ratelimit-reset-requests` / `-tokens` durations (`"1s"`,
/// `"6m0s"`, `"20ms"`) for whichever budget the matching
/// `x-ratelimit-remaining-*` header says is spent.
pub fn server_delay(
    headers: &reqwest::header::HeaderMap,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Duration> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());

    if let Some(ms) = header("retry-after-ms").and_then(|v| v.trim().parse::<f64>().ok()) {
        if ms.is_finite() && ms >= 0.0 {
            return Some(Duration::from_secs_f64(ms / 1000.0));
        }
    }
    if let Some(v) = header("retry-after") {
        let v = v.trim();
        if let Ok(secs) = v.parse::<f64>() {
            if secs.is_finite() && secs >= 0.0 {
                return Some(Duration::from_secs_f64(secs));
            }
        } else if let Ok(at) = chrono::DateTime::parse_from_rfc2822(v) {
            let wait = at.with_timezone(&chrono::Utc) - now;
            return Some(wait.to_std().unwrap_or(Duration::ZERO));
        }
    }
    ["requests", "tokens"]
        .iter()
        .filter(|kind| header(&format!("x-ratelimit-remaining-{kind}")).map(str::trim) == Some("0"))
        .filter_map(|kind| header(&format!("x-ratelimit-reset-{kind}")).and_then(parse_go_duration))
        .max()
}

/// Parse the Go-style durations OpenAI's rate-limit reset headers use:
/// a sequence of `<number><unit>` with units `h`, `m`, `s`, `ms`.
fn parse_go_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut total = 0f64;
    let mut rest = s;
    while !rest.is_empty() {
        let num_end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        let value: f64 = rest[..num_end].parse().ok()?;
        rest = &rest[num_end..];
        let (unit_secs, unit_len) = if rest.starts_with("ms") {
            (0.001, 2)
        } else if rest.starts_with('h') {
            (3600.0, 1)
        } else if rest.starts_with('m') {
            (60.0, 1)
        } else if rest.starts_with('s') {
            (1.0, 1)
        } else {
            return None;
        };
        total += value * unit_secs;
        rest = &rest[unit_len..];
    }
    Some(Duration::from_secs_f64(total))
}

/// The full-jitter backoff for the wait after attempt `attempt` (1-based).
pub fn backoff(attempt: u32, cfg: &RetryConfig, rng: &mut impl Rng) -> Duration {
    let exp = attempt.saturating_sub(1).min(32);
    let ceiling = cfg
        .initial_backoff_ms
        .saturating_mul(1u64 << exp)
        .min(cfg.max_backoff_ms);
    Duration::from_millis(rng.gen_range(0..=ceiling))
}

/// Why the loop stopped retrying a target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    MaxAttempts,
    Budget,
    RetryAfterExceedsBudget,
    ProviderDeclined,
    QuotaExhausted,
}

impl Stop {
    fn as_str(self) -> &'static str {
        match self {
            Stop::MaxAttempts => "max_attempts",
            Stop::Budget => "budget",
            Stop::RetryAfterExceedsBudget => "retry_after_exceeds_budget",
            Stop::ProviderDeclined => "provider_declined",
            Stop::QuotaExhausted => "quota_exhausted",
        }
    }
}

/// The wait before the next attempt, or why there is none.
///
/// A provider-requested delay is honoured exactly (no jitter: the provider
/// already knows when capacity returns) when it fits the remaining budget;
/// otherwise the response goes back to the caller with that header intact, so
/// its own client can wait. Without one, the full-jitter backoff applies, and
/// a wait that would outlast the budget is not made.
pub fn plan_wait(
    attempt: u32,
    cfg: &RetryConfig,
    server: Option<Duration>,
    remaining: Duration,
    rng: &mut impl Rng,
) -> Result<(Duration, bool), Stop> {
    if attempt >= cfg.max_attempts {
        return Err(Stop::MaxAttempts);
    }
    if let Some(wait) = server {
        if wait >= remaining {
            return Err(Stop::RetryAfterExceedsBudget);
        }
        return Ok((wait, true));
    }
    let wait = backoff(attempt, cfg, rng);
    if wait >= remaining {
        return Err(Stop::Budget);
    }
    Ok((wait, false))
}

/// The result of trying one target until it answered or the policy gave up.
pub struct TargetOutcome {
    pub result: Result<reqwest::Response, reqwest::Error>,
    /// Set when the final result is a retryable failure — the condition for
    /// moving on to a fallback target.
    pub retryable: Option<Retryable>,
}

/// Call one target, retrying per `cfg`, and append every call to `attempts`.
///
/// `send` builds and sends one attempt. `deadline` is the whole request's
/// budget, shared with any fallback targets that follow.
pub async fn send_with_retry<F, Fut>(
    cfg: &RetryConfig,
    deadline: Instant,
    model: &str,
    provider: &str,
    attempts: &mut Vec<UpstreamAttempt>,
    mut send: F,
) -> TargetOutcome
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    let max_attempts = if cfg.enabled {
        cfg.max_attempts.max(1)
    } else {
        1
    };
    let policy = RetryConfig {
        max_attempts,
        ..cfg.clone()
    };
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let started = Instant::now();
        let (result, quota_exhausted) = match send().await {
            Ok(resp) if resp.status().as_u16() == 429 => buffer_rate_limited(resp).await,
            other => (other, false),
        };
        let latency_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;

        let (classified, status, server) = match &result {
            Ok(resp) => {
                let status = resp.status().as_u16();
                (
                    classify_status(status, resp.headers(), &policy),
                    Some(status),
                    server_delay(resp.headers(), chrono::Utc::now()),
                )
            }
            Err(e) => (classify_error(e), None, None),
        };
        let declined = match &result {
            Ok(resp) => {
                classified.is_none()
                    && policy.on_status.contains(&resp.status().as_u16())
                    && provider_says_retry(resp.headers()) == Some(false)
            }
            Err(_) => false,
        };
        let retryable = classified.filter(|_| !quota_exhausted);
        let outcome = match (classified, status) {
            (Some(r), _) => r.outcome(),
            (None, Some(s)) if (200..300).contains(&s) => "ok".to_string(),
            (None, Some(s)) => format!("http_{s}"),
            (None, None) => "request_error".to_string(),
        };
        let stopped = if quota_exhausted {
            Some(Stop::QuotaExhausted)
        } else if declined {
            Some(Stop::ProviderDeclined)
        } else {
            None
        };
        let mut record = UpstreamAttempt {
            model: model.to_string(),
            provider: provider.to_string(),
            outcome,
            status,
            latency_ms,
            backoff_ms: None,
            server_delay: false,
            stopped: stopped.map(|s| s.as_str().to_string()),
        };

        let Some(reason) = retryable else {
            attempts.push(record);
            return TargetOutcome {
                result,
                retryable: None,
            };
        };

        let remaining = deadline.saturating_duration_since(Instant::now());
        // Bound to a `let`, not matched in place: a temporary in the match
        // scrutinee would hold the thread-local RNG (not `Send`) across the
        // sleep below, and the proxy's handler future must be `Send`.
        let plan = plan_wait(attempt, &policy, server, remaining, &mut rand::thread_rng());
        match plan {
            Err(stop) => {
                record.stopped = Some(stop.as_str().to_string());
                attempts.push(record);
                return TargetOutcome {
                    result,
                    retryable: Some(reason),
                };
            }
            Ok((wait, from_server)) => {
                record.backoff_ms = Some(wait.as_millis().min(u32::MAX as u128) as u32);
                record.server_delay = from_server;
                attempts.push(record);
                // Dropped before the wait, so the failed response's connection
                // is released rather than held across the sleep.
                drop(result);
                tracing::warn!(
                    model = %model,
                    provider = %provider,
                    attempt,
                    reason = %reason.outcome(),
                    wait_ms = wait.as_millis() as u64,
                    "Upstream call failed before any response reached the client; retrying"
                );
                tokio::time::sleep(wait).await;
            }
        }
    }
}

/// Read a 429's body to tell a spend cap from a rate limit, then hand back an
/// equivalent response so the caller's error path reads it as if untouched.
/// A body that cannot be read is a transport failure like any other.
async fn buffer_rate_limited(
    resp: reqwest::Response,
) -> (Result<reqwest::Response, reqwest::Error>, bool) {
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return (Err(e), false),
    };
    let text = String::from_utf8_lossy(&body);
    let quota = QUOTA_EXHAUSTED_CODES.iter().any(|c| text.contains(c));
    let mut rebuilt = axum::http::Response::new(body);
    *rebuilt.status_mut() = status;
    *rebuilt.headers_mut() = headers;
    (Ok(reqwest::Response::from(rebuilt)), quota)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use reqwest::header::{HeaderMap, HeaderValue};

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn default_statuses_are_retried_and_others_are_final() {
        let cfg = RetryConfig::default();
        for s in DEFAULT_RETRY_STATUSES {
            assert_eq!(
                classify_status(s, &HeaderMap::new(), &cfg),
                Some(Retryable::Status(s))
            );
        }
        for s in [200, 201, 400, 401, 403, 404, 408, 409, 413, 422] {
            assert_eq!(classify_status(s, &HeaderMap::new(), &cfg), None, "{s}");
        }
    }

    #[test]
    fn x_should_retry_overrides_the_status_list() {
        let cfg = RetryConfig::default();
        let no = headers(&[("x-should-retry", "false")]);
        let yes = headers(&[("x-should-retry", "true")]);
        assert_eq!(classify_status(529, &no, &cfg), None);
        assert_eq!(
            classify_status(409, &yes, &cfg),
            Some(Retryable::Status(409))
        );
        // A success is final whatever the header says.
        assert_eq!(classify_status(200, &yes, &cfg), None);
    }

    #[test]
    fn retry_after_ms_wins_over_retry_after() {
        let h = headers(&[("retry-after-ms", "250"), ("retry-after", "7")]);
        assert_eq!(
            server_delay(&h, chrono::Utc::now()),
            Some(Duration::from_millis(250))
        );
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-09T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            server_delay(&headers(&[("retry-after", "3")]), now),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            server_delay(
                &headers(&[("retry-after", "Fri, 09 Oct 2026 12:00:05 GMT")]),
                now
            ),
            Some(Duration::from_secs(5))
        );
        // A date in the past means "now", not a negative wait.
        assert_eq!(
            server_delay(
                &headers(&[("retry-after", "Fri, 09 Oct 2026 11:00:00 GMT")]),
                now
            ),
            Some(Duration::ZERO)
        );
        assert_eq!(
            server_delay(&headers(&[("retry-after", "soon")]), now),
            None
        );
    }

    #[test]
    fn ratelimit_reset_is_read_only_for_the_spent_budget() {
        let now = chrono::Utc::now();
        let spent_tokens = headers(&[
            ("x-ratelimit-remaining-requests", "40"),
            ("x-ratelimit-reset-requests", "6m0s"),
            ("x-ratelimit-remaining-tokens", "0"),
            ("x-ratelimit-reset-tokens", "1.5s"),
        ]);
        assert_eq!(
            server_delay(&spent_tokens, now),
            Some(Duration::from_millis(1500))
        );
        let nothing_spent = headers(&[
            ("x-ratelimit-remaining-requests", "40"),
            ("x-ratelimit-reset-requests", "6m0s"),
        ]);
        assert_eq!(server_delay(&nothing_spent, now), None);
    }

    #[test]
    fn go_durations_parse() {
        assert_eq!(parse_go_duration("20ms"), Some(Duration::from_millis(20)));
        assert_eq!(parse_go_duration("1m30s"), Some(Duration::from_secs(90)));
        assert_eq!(parse_go_duration("1h"), Some(Duration::from_secs(3600)));
        assert_eq!(parse_go_duration("abc"), None);
        assert_eq!(parse_go_duration("5"), None);
    }

    #[test]
    fn backoff_is_full_jitter_under_a_doubling_cap() {
        let cfg = RetryConfig {
            initial_backoff_ms: 100,
            max_backoff_ms: 1_000,
            ..RetryConfig::default()
        };
        let mut rng = StdRng::seed_from_u64(7);
        for (attempt, cap) in [
            (1, 100),
            (2, 200),
            (3, 400),
            (4, 800),
            (5, 1_000),
            (40, 1_000),
        ] {
            for _ in 0..200 {
                let d = backoff(attempt, &cfg, &mut rng);
                assert!(d <= Duration::from_millis(cap), "attempt {attempt}: {d:?}");
            }
        }
    }

    #[test]
    fn plan_wait_honours_the_server_and_the_budget() {
        let cfg = RetryConfig::default();
        let mut rng = StdRng::seed_from_u64(1);
        let budget = Duration::from_secs(10);
        assert_eq!(
            plan_wait(1, &cfg, Some(Duration::from_secs(2)), budget, &mut rng),
            Ok((Duration::from_secs(2), true))
        );
        assert_eq!(
            plan_wait(1, &cfg, Some(Duration::from_secs(20)), budget, &mut rng),
            Err(Stop::RetryAfterExceedsBudget)
        );
        assert_eq!(
            plan_wait(3, &cfg, None, budget, &mut rng),
            Err(Stop::MaxAttempts)
        );
        assert_eq!(
            plan_wait(1, &cfg, None, Duration::ZERO, &mut rng),
            Err(Stop::Budget)
        );
    }

    #[test]
    fn only_inference_posts_are_retry_safe() {
        for p in [
            "/v1/messages",
            "/v1/chat/completions",
            "/v1/responses",
            "/v1beta/models/gemini-2.0-flash:generateContent",
            "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        ] {
            assert!(is_retry_safe_endpoint("POST", p), "{p}");
        }
        for p in [
            "/v1/messages/batches",
            "/v1/messages/count_tokens",
            "/v1/files",
            "/v1/threads/t/runs",
            "/v1beta/cachedContents",
        ] {
            assert!(!is_retry_safe_endpoint("POST", p), "{p}");
        }
        assert!(!is_retry_safe_endpoint("GET", "/v1/messages"));
    }

    /// `packages/shared-types/fixtures/upstream-retry-vectors.json`, which the
    /// control plane's `UpstreamRetrySettingsSchema` test reads too: what each
    /// workspace setting becomes once this proxy lays it over its defaults.
    #[test]
    fn workspace_setting_vectors_shared_with_the_control_plane() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/fixtures/upstream-retry-vectors.json");
        let body = std::fs::read_to_string(&path).expect("upstream-retry-vectors.json is readable");
        let file: serde_json::Value = serde_json::from_str(&body).expect("vectors parse");
        let cases = file["cases"].as_array().expect("cases");
        assert!(cases.len() >= 8, "the vector file lost its cases");
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let (cfg, fallbacks) =
                parse_key_context(&serde_json::json!({ "upstreamRetry": case["setting"] }))
                    .map(|w| w.apply(&RetryConfig::default(), &FallbackMap::new()))
                    .unwrap_or_else(|| (RetryConfig::default(), FallbackMap::new()));
            let want = &case["effective"];
            assert_eq!(cfg.enabled, want["enabled"].as_bool().unwrap(), "{name}");
            assert_eq!(
                cfg.max_attempts as u64,
                want["maxAttempts"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                cfg.initial_backoff_ms,
                want["initialBackoffMs"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                cfg.max_backoff_ms,
                want["maxBackoffMs"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(cfg.budget_ms, want["budgetMs"].as_u64().unwrap(), "{name}");
            let on_status: Vec<u16> = serde_json::from_value(want["onStatus"].clone()).unwrap();
            assert_eq!(cfg.on_status, on_status, "{name}");
            let want_fallbacks: FallbackMap =
                serde_json::from_value(want["fallbacks"].clone()).unwrap();
            assert_eq!(fallbacks, want_fallbacks, "{name}");
        }
    }

    #[test]
    fn absent_and_null_settings_leave_the_proxy_config_alone() {
        assert_eq!(
            parse_key_context(&serde_json::json!({"workspaceId": "ws"})),
            None
        );
        assert_eq!(
            parse_key_context(&serde_json::json!({"upstreamRetry": null})),
            None
        );
    }

    #[test]
    fn only_the_ordinary_single_call_is_left_off_the_trace() {
        let ok = UpstreamAttempt {
            model: "m".into(),
            provider: "anthropic".into(),
            outcome: "ok".into(),
            status: Some(200),
            latency_ms: 5,
            backoff_ms: None,
            server_delay: false,
            stopped: None,
        };
        assert!(for_trace(vec![ok.clone()]).is_empty());
        let stopped = UpstreamAttempt {
            outcome: "http_529".into(),
            status: Some(529),
            stopped: Some("retry_after_exceeds_budget".into()),
            ..ok.clone()
        };
        assert_eq!(for_trace(vec![stopped.clone()]).len(), 1);
        assert_eq!(for_trace(vec![stopped, ok]).len(), 2);
        assert_eq!(
            calls_made(&[UpstreamAttempt::skipped("m", "openai", "wire_mismatch")]),
            0
        );
    }

    #[test]
    fn config_defaults_apply_to_a_partial_block() {
        let cfg: RetryConfig = serde_yaml::from_str("max_attempts: 5").unwrap();
        assert_eq!(cfg.max_attempts, 5);
        assert!(cfg.enabled);
        assert_eq!(cfg.on_status, DEFAULT_RETRY_STATUSES.to_vec());
    }
}
