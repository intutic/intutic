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

#[cfg(feature = "control-plane")]
use std::collections::HashMap;
use std::sync::Arc;
#[cfg(feature = "control-plane")]
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
#[cfg(feature = "control-plane")]
use std::time::Instant;

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

#[cfg(feature = "control-plane")]
struct Cached {
    answer: Answer,
    read_at: Instant,
    /// The workspace's config version when this was fetched; `None` when no
    /// version was readable, and then only the TTL applies.
    version: Option<u64>,
}

/// Keyed by the SHA-256 of the virtual key, never the key itself.
#[cfg(feature = "control-plane")]
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
#[cfg(feature = "control-plane")]
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

/// A build without the `control-plane` feature has no client to ask with, and
/// is never configured with a control plane to ask (`main.rs` refuses to
/// start), so no caller reaches this.
#[cfg(not(feature = "control-plane"))]
pub async fn fetch(
    _client: &reqwest::Client,
    _control_plane_url: &str,
    _virtual_key: &crate::credential::VirtualKey,
    _timeout: Duration,
    _policy_version: Option<u64>,
) -> Result<Answer, String> {
    Err("this build has no control-plane client".to_string())
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

/// Whether the workspace uploads its decide log (`decideLogUploadEnabled`),
/// and whether with the arguments excerpt (`decideLogUploadArgs`), from a
/// key-context body. Only an explicit `true` turns either on: absent (a
/// control plane older than the fields) or null (unreadable) sends nothing.
pub fn decide_log_upload(body: &Value) -> (bool, bool) {
    let on = |k: &str| body.get(k).and_then(Value::as_bool) == Some(true);
    (on("decideLogUploadEnabled"), on("decideLogUploadArgs"))
}

/// The workspace's closed reversibility lanes (`closedLanes`),
/// from a key-context body: they hold their action tokens for every role.
/// Absent, null or empty closes nothing; an entry this proxy does not know is
/// skipped (the control plane validates the setting on write).
pub fn closed_lanes(body: &Value) -> Vec<crate::plugins::anomaly::actions::LaneClass> {
    let mut out: Vec<_> = body
        .get("closedLanes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(crate::plugins::anomaly::actions::LaneClass::parse_closable)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `revertLane.mode`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RevertLaneMode {
    /// The default: rates are computed and shown, nothing is held.
    #[default]
    Off,
    /// A would-be hold is recorded as a shadowed finding.
    Shadow,
    /// Reversible-wide tokens over the threshold join `review_before`.
    Enforce,
}

/// The workspace's `revertLane` setting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RevertLane {
    pub mode: RevertLaneMode,
    /// `max(revert_rate, rejection_rate)` at or above which a subject is held.
    pub threshold: f64,
}

/// The default threshold when `revertLane.threshold` is absent.
pub const REVERT_LANE_DEFAULT_THRESHOLD: f64 = 0.25;

impl Default for RevertLane {
    fn default() -> Self {
        Self {
            mode: RevertLaneMode::Off,
            threshold: REVERT_LANE_DEFAULT_THRESHOLD,
        }
    }
}

/// `revertLane` from a key-context body. Absent, null or an unknown mode is
/// `off`, the default: the setting holds nothing until a person turns it on.
/// A threshold outside `(0, 1]` falls back to the default.
pub fn revert_lane(body: &Value) -> RevertLane {
    let Some(v) = body.get("revertLane").filter(|v| v.is_object()) else {
        return RevertLane::default();
    };
    let mode = match v.get("mode").and_then(Value::as_str) {
        Some("shadow") => RevertLaneMode::Shadow,
        Some("enforce") => RevertLaneMode::Enforce,
        _ => RevertLaneMode::Off,
    };
    let threshold = v
        .get("threshold")
        .and_then(Value::as_f64)
        .filter(|t| *t > 0.0 && *t <= 1.0)
        .unwrap_or(REVERT_LANE_DEFAULT_THRESHOLD);
    RevertLane { mode, threshold }
}

/// The reversible-wide action tokens a revert-rate map holds for `role`:
/// every subject that is a reversible-wide token, for `role`
/// or for all roles (`''`), whose `max(r, j)` reaches `threshold`. Tool-name
/// subjects and irreversible tokens are never held here — the second are
/// closed lanes' job. `rates` is the raw `v2:revert:{workspace}` value; an
/// unreadable one holds nothing.
pub fn revert_hold_tokens(rates: &str, role: &str, threshold: f64) -> Vec<String> {
    use crate::plugins::anomaly::actions::{token_class, LaneClass};
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(rates) else {
        return Vec::new();
    };
    let role = role.to_ascii_lowercase();
    let mut out: Vec<String> = map
        .iter()
        .filter_map(|(key, v)| {
            let (r, subject) = key.split_once('|')?;
            if !(r.is_empty() || r.eq_ignore_ascii_case(&role)) {
                return None;
            }
            let subject = subject.to_ascii_lowercase();
            if token_class(&subject) != Some(LaneClass::ReversibleWide) {
                return None;
            }
            let rate = |k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            (rate("r").max(rate("j")) >= threshold).then_some(subject)
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The highest role-level revert or rejection rate the map records for one
/// subject (`role`, else `''`), for the decide log's `revertRate`. `None`
/// when neither rate is published (both null: under their floors).
pub fn revert_rate_of(rates: &str, role: &str, subject: &str) -> Option<f64> {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(rates) else {
        return None;
    };
    // A rate below its floor is published as null: no rate, not zero.
    let pick = |r: &str| {
        map.get(&format!("{r}|{subject}")).and_then(|v| {
            let rate = |k: &str| v.get(k).and_then(Value::as_f64);
            match (rate("r"), rate("j")) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            }
        })
    };
    pick(role).or_else(|| pick(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "control-plane")]
    use wiremock::matchers::{method, path};
    #[cfg(feature = "control-plane")]
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn closed_lanes_and_revert_lane_read_their_defaults_and_values() {
        use crate::plugins::anomaly::actions::LaneClass;
        assert!(closed_lanes(&serde_json::json!({})).is_empty());
        assert_eq!(
            closed_lanes(
                &serde_json::json!({"closedLanes": ["reversible_wide", "irreversible", "bogus"]})
            ),
            vec![LaneClass::ReversibleWide, LaneClass::Irreversible]
        );
        assert_eq!(revert_lane(&serde_json::json!({})), RevertLane::default());
        let on =
            revert_lane(&serde_json::json!({"revertLane": {"mode": "enforce", "threshold": 0.5}}));
        assert_eq!(on.mode, RevertLaneMode::Enforce);
        assert_eq!(on.threshold, 0.5);
        let bad = revert_lane(&serde_json::json!({"revertLane": {"mode": "loud", "threshold": 7}}));
        assert_eq!(bad, RevertLane::default());
    }

    #[test]
    fn revert_holds_take_only_reversible_wide_tokens_over_the_threshold() {
        let rates = r#"{"|action:deploy": {"r": 0.3, "j": 0.0},
                        "deployer|action:migrate": {"r": 0.0, "j": 0.4},
                        "reviewer|action:release": {"r": 0.9},
                        "|action:publish": {"r": 0.9},
                        "|Bash": {"r": 0.9},
                        "|action:http_post": {"r": 0.1, "j": 0.2}}"#;
        assert_eq!(
            revert_hold_tokens(rates, "deployer", 0.25),
            vec!["action:deploy", "action:migrate"]
        );
        assert_eq!(revert_hold_tokens(rates, "", 0.25), vec!["action:deploy"]);
        assert!(revert_hold_tokens("not json", "", 0.25).is_empty());
        assert_eq!(
            revert_rate_of(rates, "deployer", "action:migrate"),
            Some(0.4)
        );
        assert_eq!(
            revert_rate_of(rates, "deployer", "action:deploy"),
            Some(0.3)
        );
        assert_eq!(revert_rate_of(rates, "", "action:destroy"), None);
        // A rate under its floor is null: it holds nothing and records none.
        let floored = r#"{"|action:deploy": {"r": null, "j": null}, "|action:release": {"r": null, "j": 0.5}}"#;
        assert_eq!(
            revert_hold_tokens(floored, "", 0.25),
            vec!["action:release"]
        );
        assert_eq!(revert_rate_of(floored, "", "action:deploy"), None);
        assert_eq!(revert_rate_of(floored, "", "action:release"), Some(0.5));
    }

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
        assert_eq!(decide_log_upload(&body), (true, false));
        assert_eq!(decide_log_upload(&serde_json::json!({})), (false, false));

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

    #[cfg(feature = "control-plane")]
    fn key(token: &str) -> crate::credential::VirtualKey {
        crate::credential::RequestCredential::classify(token)
            .virtual_key()
            .cloned()
            .expect("a virtual key")
    }

    /// The SSO group gate and the PII detector actions read one answer: two
    /// readers of the same key within the TTL make one request.
    #[cfg(feature = "control-plane")]
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

    #[cfg(feature = "control-plane")]
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
