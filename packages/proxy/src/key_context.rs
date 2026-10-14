//! The proxy's per-key read of `GET /api/v1/auth/key-context`.
//!
//! Workspace policy reaches the proxy on that route, which it already calls
//! to validate a virtual key: the SSO group policy for the response gate
//! (`sso_groups`), the workspace's PII detector actions (`dlp::workspace`),
//! its intervention mode ([`intervention_mode`]), whether its plan includes
//! LLM judging ([`llm_judge_enabled`]) and whether it stores tool-call
//! arguments in replay contexts ([`store_tool_arguments`]). All read the same
//! answer, fetched once per key and cached here for [`CACHE_TTL`], so adding
//! a field to the route never adds a request.
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

/// The workspace's intervention mode from a key-context body
/// (`interventionMode`). Absent — a control plane older than the field — or
/// null (it could not be read) is TRANSPARENT, so such a control plane
/// changes nothing about what agents are told.
pub fn intervention_mode(body: &Value) -> crate::refusal::InterventionMode {
    crate::refusal::InterventionMode::parse(body.get("interventionMode").and_then(Value::as_str))
}

/// Whether the workspace's plan includes server-side LLM judging, from a
/// key-context body (`llmJudgeEnabled`). Only an explicit `false` turns the
/// judge off: absent (a control plane older than the field) or null (the plan
/// could not be read) keeps judging exactly as before the field existed.
pub fn llm_judge_enabled(body: &Value) -> bool {
    body.get("llmJudgeEnabled").and_then(Value::as_bool) != Some(false)
}

/// The workspace role of the member a key belongs to (`role`: `OWNER`,
/// `ADMIN`, `EM`, `DEVELOPER` or `VIEWER`), from a key-context body. `None`
/// when absent, null or blank: the role is then not known.
pub fn member_role(body: &Value) -> Option<String> {
    body.get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
}

/// The member role behind one virtual key, through the cached [`fetch`].
/// `None` whenever it cannot be shown — the control plane did not answer, or
/// refused the key — and a hook rule scoped to roles then applies
/// (`plugins::hook_rules`): a role that cannot be read never exempts anyone.
pub async fn fetch_member_role(
    client: &reqwest::Client,
    control_plane_url: &str,
    virtual_key: &crate::credential::VirtualKey,
    timeout: Duration,
    policy_version: Option<u64>,
) -> Option<String> {
    match fetch(
        client,
        control_plane_url,
        virtual_key,
        timeout,
        policy_version,
    )
    .await
    {
        Ok(Answer::Body(body)) => member_role(&body),
        Ok(Answer::Refused(status)) => {
            tracing::debug!(%status, "key-context refused the key; its member role is unknown");
            None
        }
        Err(reason) => {
            tracing::warn!(reason = %reason, "member role unavailable; role-scoped hook rules apply to this request");
            None
        }
    }
}

/// Whether the workspace keeps tool-call argument values in its sampled
/// replay contexts, from a key-context body (`storeToolArguments`). Only an
/// explicit `true` stores them: absent (a control plane older than the
/// field) or null (unreadable) keeps argument keys and sizes only, the
/// default since the setting existed.
pub fn store_tool_arguments(body: &Value) -> bool {
    body.get("storeToolArguments").and_then(Value::as_bool) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// A key-context answer with every field set
    /// (`packages/shared-types/fixtures/responses/key-context.json`, which the
    /// shared-types tests hold to `KeyContextResponse`, the schema the control
    /// plane's route is held to), read through every reader of the route. A
    /// field renamed or retyped on either side reads as its default here.
    #[test]
    fn every_reader_reads_the_key_context_fixture() {
        let body: Value = serde_json::from_str(include_str!(
            "../../shared-types/fixtures/responses/key-context.json"
        ))
        .expect("the key-context fixture is JSON");

        let record = crate::proxy::key_record_from_context(&body, "vk_fixture")
            .expect("the fixture names a workspace");
        assert_eq!(record.team_id.as_deref(), Some("ws_fixture"));
        assert_eq!(record.user_id.as_deref(), Some("mbr_fixture"));
        assert_eq!(record.org_id.as_deref(), Some("org_fixture"));
        assert_eq!(record.models, ["gpt-4o"]);
        assert_eq!(record.byok_required, Some(true));
        assert_eq!(record.key_id.as_deref(), Some("key_fixture"));
        assert_eq!(record.max_budget, Some(50.0));
        let budgets = record.hard_budgets.expect("hardBudgets");
        assert_eq!(budgets.len(), 1);
        assert_eq!(budgets[0].scope, crate::key_limits::BudgetScope::Key);
        assert_eq!(budgets[0].period, crate::key_limits::BudgetPeriod::Day);
        assert_eq!(budgets[0].limit_usd, 25.0);
        let rate = record.rate_limit.expect("rateLimit");
        assert_eq!((rate.rpm, rate.tpm), (Some(60), Some(100_000)));

        assert_eq!(member_role(&body).as_deref(), Some("DEVELOPER"));
        assert_eq!(
            intervention_mode(&body),
            crate::refusal::InterventionMode::Opaque
        );
        assert!(!llm_judge_enabled(&body));
        assert!(store_tool_arguments(&body));

        let gate = crate::sso_groups::parse_key_context(&body)
            .expect("ssoGroups reads")
            .expect("the fixture sets a policy");
        assert_eq!(gate.policy.high_risk_tools, ["bash"]);
        assert_eq!(gate.policy.required_groups, ["eng-prod"]);
        assert_eq!(gate.policy.require_obo_for, ["database_write"]);
        assert_eq!(gate.member_groups, Some(vec!["eng-prod".to_string()]));

        let pii = crate::dlp::workspace::parse_key_context(&body)
            .expect("piiDetectors reads")
            .expect("the fixture sets an action");
        assert_eq!(pii.get("pii.email").map(String::as_str), Some("redact"));

        let retry = crate::routing::retry::parse_key_context(&body).expect("upstreamRetry reads");
        assert_eq!(retry.enabled, Some(true));
        assert_eq!(retry.max_attempts, Some(3));
        assert_eq!(retry.on_status, Some(vec![503]));
        assert!(retry.fallbacks.is_some());
    }

    #[test]
    fn member_role_reads_the_role_and_nothing_else() {
        assert_eq!(
            member_role(&serde_json::json!({"role": "DEVELOPER"})).as_deref(),
            Some("DEVELOPER")
        );
        assert_eq!(member_role(&serde_json::json!({"role": null})), None);
        assert_eq!(member_role(&serde_json::json!({"role": "  "})), None);
        assert_eq!(member_role(&serde_json::json!({"workspaceId": "ws"})), None);
    }

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

    #[test]
    fn the_intervention_mode_defaults_to_transparent() {
        use crate::refusal::InterventionMode;
        let mode = |v: Value| intervention_mode(&v);
        assert_eq!(
            mode(serde_json::json!({"interventionMode": "OPAQUE"})),
            InterventionMode::Opaque
        );
        assert_eq!(
            mode(serde_json::json!({"interventionMode": "SILENT_LOG"})),
            InterventionMode::SilentLog
        );
        assert_eq!(
            mode(serde_json::json!({"workspaceId": "ws_old"})),
            InterventionMode::Transparent
        );
        assert_eq!(
            mode(serde_json::json!({"interventionMode": null})),
            InterventionMode::Transparent
        );
    }

    #[test]
    fn only_an_explicit_false_turns_the_llm_judge_off() {
        let judge = |v: Value| llm_judge_enabled(&v);
        assert!(!judge(serde_json::json!({"llmJudgeEnabled": false})));
        assert!(judge(serde_json::json!({"llmJudgeEnabled": true})));
        // A control plane older than the field, and one that could not read
        // the plan: today's behaviour.
        assert!(judge(serde_json::json!({"workspaceId": "ws_old"})));
        assert!(judge(serde_json::json!({"llmJudgeEnabled": null})));
        assert!(judge(serde_json::json!({"llmJudgeEnabled": "false"})));
    }

    #[test]
    fn only_an_explicit_true_stores_tool_arguments() {
        let stored = |v: Value| store_tool_arguments(&v);
        assert!(stored(serde_json::json!({"storeToolArguments": true})));
        assert!(!stored(serde_json::json!({"storeToolArguments": false})));
        assert!(!stored(serde_json::json!({"workspaceId": "ws_old"})));
        assert!(!stored(serde_json::json!({"storeToolArguments": null})));
        assert!(!stored(serde_json::json!({"storeToolArguments": "true"})));
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
