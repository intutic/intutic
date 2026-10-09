//! The proxy's per-key read of `GET /api/v1/auth/key-context`.
//!
//! Two pieces of workspace policy reach the proxy on that route, which it
//! already calls to validate a virtual key: the SSO group policy for the
//! response gate (`sso_groups`) and the workspace's PII detector actions
//! (`dlp::workspace`). Both read the same answer, fetched once per key and
//! cached here for [`CACHE_TTL`], so adding a field to the route never adds a
//! request.
//!
//! A standalone proxy has no control plane, so nothing here runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

/// How long one key's answer is reused before the proxy asks again. The same
/// 30 seconds as the proxy's workspace SOP cache (`sops::CACHE_TTL`) and the
/// sync daemon's default refresh, so a policy read here is no staler than the
/// harness gates fed by that daemon.
pub const CACHE_TTL: Duration = Duration::from_secs(30);

/// What the control plane said about one key.
#[derive(Debug, Clone)]
pub enum Answer {
    /// A 200: the route's JSON body.
    Body(Arc<Value>),
    /// A 401 or 403: the key is revoked or its member deactivated. An answer
    /// about the key, not a failure; each reader decides what it means.
    Refused(reqwest::StatusCode),
}

struct Cached {
    answer: Answer,
    read_at: Instant,
    /// The workspace's config version when this was fetched; `None` when no
    /// version was readable, and then only the TTL applies.
    version: Option<u64>,
}

/// Keyed by the SHA-256 of the virtual key, never the key itself.
fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The key-context answer for one virtual key: from the cache within
/// [`CACHE_TTL`] while the workspace's config version has not moved, else
/// from the control plane.
///
/// `policy_version` is `v2:sync:config_version:{ws}`, read by the caller
/// before this runs. The control plane bumps it on every change to the policy
/// carried here — a SCIM push, a changed group policy, changed detector
/// actions — so such a change is fetched on the key's next request rather
/// than up to a TTL later.
///
/// `Err` means the control plane could not answer. A failed answer is not
/// cached and a stale one is not served, the same discipline as the workspace
/// SOP fetch, so a policy an operator just tightened is never masked by an
/// old copy.
pub async fn fetch(
    client: &reqwest::Client,
    control_plane_url: &str,
    virtual_key: &crate::credential::VirtualKey,
    timeout: Duration,
    policy_version: Option<u64>,
) -> Result<Answer, String> {
    let key = crate::store::valkey::sha256_hex(virtual_key.as_str());
    {
        let guard = cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = guard.get(&key) {
            let version_moved =
                matches!((policy_version, c.version), (Some(now), Some(then)) if now != then);
            if c.read_at.elapsed() < CACHE_TTL && !version_moved {
                return Ok(c.answer.clone());
            }
        }
    }

    let resp = virtual_key
        .authorize(client.get(format!("{control_plane_url}/api/v1/auth/key-context")))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("the key-context request failed: {e}"))?;
    let status = resp.status();
    let answer = if status == reqwest::StatusCode::UNAUTHORIZED
        || status == reqwest::StatusCode::FORBIDDEN
    {
        Answer::Refused(status)
    } else if !status.is_success() {
        return Err(format!("the key-context request returned {status}"));
    } else {
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("the key-context response did not parse: {e}"))?;
        Answer::Body(Arc::new(body))
    };

    let mut guard = cache().lock().unwrap_or_else(|p| p.into_inner());
    // An entry past its TTL is never served, so it is dropped rather than
    // kept: the map holds only the keys active in the last TTL.
    guard.retain(|_, c| c.read_at.elapsed() < CACHE_TTL);
    guard.insert(
        key,
        Cached {
            answer: answer.clone(),
            read_at: Instant::now(),
            version: policy_version,
        },
    );
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn key(token: &str) -> crate::credential::VirtualKey {
        crate::credential::RequestCredential::classify(token)
            .virtual_key()
            .cloned()
            .expect("a virtual key")
    }

    /// The SSO group gate and the PII detector actions read one answer: two
    /// readers of the same key within the TTL make one request.
    #[tokio::test]
    async fn every_reader_shares_one_fetch_per_key() {
        let server = MockServer::start().await;
        let token = format!("vk_{}", "k".repeat(32));
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "workspaceId": "ws_shared",
                "ssoGroups": {"policy": null, "memberGroups": null},
                "piiDetectors": {"pii.card": "block"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = reqwest::Client::new();
        let t = Duration::from_secs(2);
        let vk = key(&token);
        assert_eq!(
            crate::sso_groups::resolve(&client, &server.uri(), &vk, t, Some(3)).await,
            Ok(None)
        );
        let pii = crate::dlp::workspace::resolve(&client, &server.uri(), &vk, t, Some(3))
            .await
            .unwrap()
            .expect("the workspace names a detector");
        assert_eq!(pii.action_of("pii.card"), Some("block"));
    }

    #[tokio::test]
    async fn a_refusal_is_an_answer_and_a_server_error_is_not() {
        let server = MockServer::start().await;
        let refused = format!("vk_{}", "l".repeat(32));
        let failing = format!("vk_{}", "m".repeat(32));
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .and(wiremock::matchers::header(
                "authorization",
                format!("Bearer {refused}").as_str(),
            ))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/key-context"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        let client = reqwest::Client::new();
        let t = Duration::from_secs(2);
        assert!(matches!(
            fetch(&client, &server.uri(), &key(&refused), t, None).await,
            Ok(Answer::Refused(s)) if s == reqwest::StatusCode::FORBIDDEN
        ));
        assert!(fetch(&client, &server.uri(), &key(&failing), t, None)
            .await
            .is_err());
    }
}
