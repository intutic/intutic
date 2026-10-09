//! SSO-group tool clearance for the response gate.
//!
//! A workspace's `sso_group_policy` names high-risk tools, the identity-provider
//! groups that clear them, and tools only an on-behalf-of token may call. The
//! control plane's hook gate, the MCP proxy and every harness gate decide a
//! tool call against it with `evaluateSsoGroupClearance`
//! (`packages/shared-types/src/ssoGroupClearance.ts`). This is the Rust port
//! of that function, so the response gate refuses exactly the calls the other
//! gates refuse. `fixtures/sso-group-clearance-vectors.json` in shared-types
//! holds every implementation, this one included, to the same answers.
//!
//! The algorithm, in order:
//!   1. no policy                       → `Granted`
//!   2. tool on `requireOboFor`         → `RequiresObo` (a gate has no OBO token,
//!                                        so every gate refuses it)
//!   3. tool not on `highRiskTools`     → `Granted`
//!   4. member's groups unknown         → `Denied` (never granted)
//!   5. member holds a `requiredGroups` → `Granted`
//!   6. otherwise                       → `Denied`
//!
//! Names and groups match exactly — no case folding — unlike the response
//! gate's `deny_tools` match. A looser match here would refuse calls the hook
//! gate allows. The one widening every gate shares is MCP's two names for one
//! tool ([`tool_matches`]): an entry naming the tool as its server declares it
//! (`run_query`) also matches the name a harness gives it
//! (`mcp__postgres__run_query`).
//!
//! # Where the policy and the groups come from
//!
//! `GET /api/v1/auth/key-context`, the per-key route the proxy already calls
//! to validate a virtual key, carries an `ssoGroups` object: the workspace's
//! policy and the groups of the member the key belongs to. [`resolve`] fetches
//! it per key through `crate::key_context`, which caches the answer for
//! [`crate::key_context::CACHE_TTL`]. A standalone proxy has no control plane
//! and therefore no group policy, so nothing here runs.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

/// A workspace's `sso_group_policy`, as `parseSsoGroupPolicy` reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SsoGroupPolicy {
    pub high_risk_tools: Vec<String>,
    pub required_groups: Vec<String>,
    pub require_obo_for: Vec<String>,
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Reads a stored policy. `None` only when there is no policy object at all; a
/// wrong-typed list reads as empty and non-string entries are dropped, so a
/// malformed `requiredGroups` leaves every high-risk tool denied rather than
/// the whole policy silently gone. Mirrors `parseSsoGroupPolicy`.
pub fn parse_policy(value: &Value) -> Option<SsoGroupPolicy> {
    let obj = value.as_object()?;
    Some(SsoGroupPolicy {
        high_risk_tools: string_list(obj.get("highRiskTools")),
        required_groups: string_list(obj.get("requiredGroups")),
        require_obo_for: string_list(obj.get("requireOboFor")),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Clearance {
    Granted,
    Denied,
    RequiresObo,
}

impl Clearance {
    /// The wire spelling every other implementation uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "GRANTED",
            Self::Denied => "DENIED",
            Self::RequiresObo => "REQUIRES_OBO",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoGroupDecision {
    pub clearance: Clearance,
    /// `sso_group.<require_obo|high_risk>.<tool>` when the call is refused.
    pub rule_id: Option<String>,
    /// Why the call is refused; empty when it is granted.
    pub reason: String,
}

impl SsoGroupDecision {
    fn granted() -> Self {
        Self {
            clearance: Clearance::Granted,
            rule_id: None,
            reason: String::new(),
        }
    }

    /// The refusal as every gate words it: the reason, then the rule id in
    /// brackets, which is where the control plane's `ruleIdFromReason` and the
    /// SIEM export read the deciding rule from.
    pub fn refusal_reason(&self) -> String {
        match &self.rule_id {
            Some(id) => format!("{} [{id}]", self.reason),
            None => self.reason.clone(),
        }
    }
}

/// A rule id that survives `ruleIdFromReason` (`[A-Za-z0-9_.:-]`).
pub fn rule_id(kind: &str, tool_name: &str) -> String {
    crate::refusal::tool_rule_id(&format!("sso_group.{kind}"), tool_name)
}

/// Whether a call named `name` is the tool a policy entry names: exactly, or,
/// for an entry that is an MCP tool's own name (not starting with `mcp__`), as
/// the name a harness gives it on any server, `mcp__<server>__<entry>`.
pub fn tool_matches(entry: &str, name: &str) -> bool {
    if name == entry {
        return true;
    }
    if entry.starts_with("mcp__") || !name.starts_with("mcp__") {
        return false;
    }
    let suffix_len = entry.len() + 2;
    name.len() > "mcp__".len() + suffix_len
        && name.ends_with(entry)
        && name[..name.len() - entry.len()].ends_with("__")
}

/// The first entry of `list` a call matches: an exact match on any of its
/// names first, then an MCP tool's own name matching a harness name.
fn matching_entry<'a>(list: &'a [String], tool_names: &[&str]) -> Option<&'a str> {
    for n in tool_names {
        if let Some(e) = list.iter().find(|e| e.as_str() == *n) {
            return Some(e);
        }
    }
    tool_names
        .iter()
        .find_map(|n| list.iter().find(|e| tool_matches(e, n)))
        .map(String::as_str)
}

/// Decides one tool call. `tool_names` is every name the call goes by; a
/// policy entry naming any of them applies ([`tool_matches`]), and the rule id
/// and reason name the entry. `member_groups` `None` means the gate does not
/// know the member's groups.
pub fn evaluate(
    policy: Option<&SsoGroupPolicy>,
    tool_names: &[&str],
    member_groups: Option<&[String]>,
) -> SsoGroupDecision {
    let Some(policy) = policy else {
        return SsoGroupDecision::granted();
    };

    if let Some(obo) = matching_entry(&policy.require_obo_for, tool_names) {
        return SsoGroupDecision {
            clearance: Clearance::RequiresObo,
            rule_id: Some(rule_id("require_obo", obo)),
            reason: format!(
                "SSO group policy: {obo} is on-behalf-of only, and a tool-call gate has no OBO token to present"
            ),
        };
    }

    let Some(risky) = matching_entry(&policy.high_risk_tools, tool_names) else {
        return SsoGroupDecision::granted();
    };
    if let Some(groups) = member_groups {
        if policy.required_groups.iter().any(|g| groups.contains(g)) {
            return SsoGroupDecision::granted();
        }
    }

    let required = if policy.required_groups.is_empty() {
        "(none configured)".to_string()
    } else {
        policy.required_groups.join(", ")
    };
    let why = if member_groups.is_some() {
        "this member holds none of them"
    } else {
        "this gate does not know the member's groups"
    };
    SsoGroupDecision {
        clearance: Clearance::Denied,
        rule_id: Some(rule_id("high_risk", risky)),
        reason: format!(
            "SSO group policy: {risky} requires one of the SSO groups {required}, and {why}"
        ),
    }
}

/// What the response gate applies for one key: the workspace's policy and the
/// member's groups. Only built when the workspace has a policy — without one
/// every call is granted, so there is nothing to carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoGroupGate {
    pub policy: SsoGroupPolicy,
    /// `None` when the key has no member, so the groups are unknown.
    pub member_groups: Option<Vec<String>>,
}

impl SsoGroupGate {
    pub fn decide(&self, tool_name: &str) -> SsoGroupDecision {
        evaluate(
            Some(&self.policy),
            &[tool_name],
            self.member_groups.as_deref(),
        )
    }

    /// Whether any tool could be refused. A policy that lists no tools refuses
    /// nothing, so an unparseable body cannot be hiding a refusal under it.
    pub fn can_refuse(&self) -> bool {
        !self.policy.high_risk_tools.is_empty() || !self.policy.require_obo_for.is_empty()
    }
}

/// Reads the `ssoGroups` field of a `/auth/key-context` body.
///
/// - absent: a control plane older than the field. It has no answer, which is
///   the state before this existed, so `Ok(None)` and no group rules.
/// - `null`: the control plane could not read the policy or the groups. That
///   is a failure, and the caller applies the proxy's policy fail mode.
/// - an object whose `policy` is null: the workspace has no group policy.
pub fn parse_key_context(body: &Value) -> Result<Option<SsoGroupGate>, String> {
    let Some(field) = body.get("ssoGroups") else {
        return Ok(None);
    };
    if field.is_null() {
        return Err("the control plane could not read the SSO group policy".to_string());
    }
    let Some(policy) = field.get("policy").and_then(parse_policy) else {
        return Ok(None);
    };
    let member_groups = field
        .get("memberGroups")
        .filter(|v| v.is_array())
        .map(|v| string_list(Some(v)));
    Ok(Some(SsoGroupGate {
        policy,
        member_groups,
    }))
}

/// The answer last parsed for each key, kept for one use only: when the
/// control plane later refuses the key, the policy last seen for it is applied
/// with the groups unknown. Bounds the map to the keys active in [`RETAIN`].
struct LastSeen {
    gate: Option<SsoGroupGate>,
    read_at: Instant,
}

/// How long an answer is kept for that one use.
const RETAIN: Duration = Duration::from_secs(3600);

/// Keyed by the SHA-256 of the virtual key, never the key itself.
fn last_seen() -> &'static Mutex<HashMap<String, LastSeen>> {
    static LAST_SEEN: OnceLock<Mutex<HashMap<String, LastSeen>>> = OnceLock::new();
    LAST_SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The group gate for one virtual key, from the key's
/// `/api/v1/auth/key-context` answer (`crate::key_context`, which caches it
/// for [`crate::key_context::CACHE_TTL`] and refetches early when `policy_version` moves).
///
/// `policy_version` is `v2:sync:config_version:{ws}`, read by the caller
/// before this runs. The control plane bumps it on every change that moves a
/// member's groups — a SCIM push, a SCIM token issued or revoked — so such a
/// change is fetched on the key's next request rather than up to a TTL later.
///
/// `Ok(None)` means there are no group rules to apply. `Err` means the control
/// plane could not answer; a failed answer is not cached and a stale one is
/// not served, the same discipline as the workspace SOP fetch, so a policy an
/// operator just tightened is never masked by an old copy.
///
/// A 401 or 403 is an answer about the key — revoked, or its member
/// deactivated — and not a failure: the member's groups are no longer known,
/// so the policy last seen for the key applies with the groups unknown and
/// every high-risk tool is refused, as the MCP proxy and the sync daemon do.
pub async fn resolve(
    client: &reqwest::Client,
    control_plane_url: &str,
    virtual_key: &crate::credential::VirtualKey,
    timeout: Duration,
    policy_version: Option<u64>,
) -> Result<Option<SsoGroupGate>, String> {
    let answer = crate::key_context::fetch(
        client,
        control_plane_url,
        virtual_key,
        timeout,
        policy_version,
    )
    .await
    .map_err(|e| format!("SSO group policy fetch failed: {e}"))?;
    let key = crate::store::valkey::sha256_hex(virtual_key.as_str());
    match answer {
        crate::key_context::Answer::Refused(status) => {
            let guard = last_seen().lock().unwrap_or_else(|p| p.into_inner());
            match guard.get(&key) {
                Some(seen) => Ok(seen.gate.clone().map(|g| SsoGroupGate {
                    member_groups: None,
                    ..g
                })),
                None => Err(format!(
                    "the control plane refused the key ({status}) before its SSO group policy was known"
                )),
            }
        }
        crate::key_context::Answer::Body(body) => {
            let gate = parse_key_context(&body)?;
            let mut guard = last_seen().lock().unwrap_or_else(|p| p.into_inner());
            guard.retain(|_, s| s.read_at.elapsed() < RETAIN);
            guard.insert(
                key,
                LastSeen {
                    gate: gate.clone(),
                    read_at: Instant::now(),
                },
            );
            Ok(gate)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared vectors, read from the repository rather than copied, so one
    /// file drives every implementation.
    #[test]
    fn conforms_to_the_shared_sso_group_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared-types/fixtures/sso-group-clearance-vectors.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let vectors: Value = serde_json::from_str(&raw).expect("vectors parse");
        let cases = vectors["cases"].as_array().expect("cases");
        assert!(cases.len() >= 20, "the vector file lost its cases");

        let mut seen = std::collections::HashSet::new();
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let policy = parse_policy(&vectors["policies"][c["policy"].as_str().unwrap()]);
            let groups: Option<Vec<String>> = c["memberGroups"]
                .as_array()
                .map(|a| a.iter().map(|g| g.as_str().unwrap().to_string()).collect());
            let d = evaluate(
                policy.as_ref(),
                &[c["toolName"].as_str().unwrap()],
                groups.as_deref(),
            );
            assert_eq!(d.clearance.as_str(), c["clearance"], "{name}");
            assert_eq!(d.rule_id.as_deref(), c["ruleId"].as_str(), "{name}");
            seen.insert(d.clearance);

            // The same case through the gate the response path uses. A case
            // with no policy has no gate at all, which is a grant.
            if let Some(p) = policy {
                let gate = SsoGroupGate {
                    policy: p,
                    member_groups: groups.clone(),
                };
                assert_eq!(
                    gate.decide(c["toolName"].as_str().unwrap()),
                    d,
                    "{name} (gate)"
                );
            }
        }
        assert_eq!(seen.len(), 3, "the vectors must cover all three clearances");
    }

    #[test]
    fn reasons_match_the_shared_evaluator_word_for_word() {
        let p = parse_policy(&serde_json::json!({
            "highRiskTools": ["create_issue"],
            "requiredGroups": ["sre"],
            "requireOboFor": ["mcp__gh__deploy"]
        }))
        .unwrap();
        let groups = vec!["eng".to_string()];
        assert_eq!(
            evaluate(Some(&p), &["create_issue"], Some(&groups)).reason,
            "SSO group policy: create_issue requires one of the SSO groups sre, and this member holds none of them"
        );
        assert_eq!(
            evaluate(Some(&p), &["create_issue"], None).reason,
            "SSO group policy: create_issue requires one of the SSO groups sre, and this gate does not know the member's groups"
        );
        let obo = evaluate(Some(&p), &["mcp__gh__deploy"], Some(&groups));
        assert_eq!(
            obo.reason,
            "SSO group policy: mcp__gh__deploy is on-behalf-of only, and a tool-call gate has no OBO token to present"
        );
        assert_eq!(
            obo.refusal_reason(),
            "SSO group policy: mcp__gh__deploy is on-behalf-of only, and a tool-call gate has no OBO token to present [sso_group.require_obo.mcp__gh__deploy]"
        );
        assert_eq!(evaluate(Some(&p), &["Read"], None).reason, "");
    }

    #[test]
    fn rule_ids_keep_only_the_characters_a_rule_id_may_carry() {
        assert_eq!(
            rule_id("high_risk", "mcp__git-hub__create.issue:v2"),
            "sso_group.high_risk.mcp__git-hub__create.issue:v2"
        );
        assert_eq!(
            rule_id("require_obo", "run cmd/x"),
            "sso_group.require_obo.run_cmd_x"
        );
    }

    #[test]
    fn key_context_field_reads_absent_null_and_present_apart() {
        // An older control plane: no field, no group rules, not a failure.
        assert_eq!(
            parse_key_context(&serde_json::json!({"workspaceId": "ws"})),
            Ok(None)
        );
        // The control plane said it could not read them: a failure.
        assert!(parse_key_context(&serde_json::json!({"ssoGroups": null})).is_err());
        // No policy in the workspace.
        assert_eq!(
            parse_key_context(
                &serde_json::json!({"ssoGroups": {"policy": null, "memberGroups": null}})
            ),
            Ok(None)
        );
        // A policy, and a key with no member: groups unknown.
        let gate = parse_key_context(&serde_json::json!({
            "ssoGroups": {"policy": {"highRiskTools": ["Bash"]}, "memberGroups": null}
        }))
        .unwrap()
        .unwrap();
        assert_eq!(gate.member_groups, None);
        assert_eq!(gate.decide("Bash").clearance, Clearance::Denied);
        // A member with groups.
        let gate = parse_key_context(&serde_json::json!({
            "ssoGroups": {
                "policy": {"highRiskTools": ["Bash"], "requiredGroups": ["sre"]},
                "memberGroups": ["sre", 7]
            }
        }))
        .unwrap()
        .unwrap();
        assert_eq!(gate.member_groups, Some(vec!["sre".to_string()]));
        assert_eq!(gate.decide("Bash").clearance, Clearance::Granted);
    }

    #[test]
    fn a_policy_naming_no_tools_cannot_refuse() {
        let gate = SsoGroupGate {
            policy: SsoGroupPolicy::default(),
            member_groups: None,
        };
        assert!(!gate.can_refuse());
        assert_eq!(gate.decide("Bash").clearance, Clearance::Granted);
    }

    mod fetch {
        use super::super::*;
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        fn key(token: &str) -> crate::credential::VirtualKey {
            crate::credential::RequestCredential::classify(token)
                .virtual_key()
                .cloned()
                .expect("a virtual key")
        }

        fn body() -> Value {
            serde_json::json!({
                "workspaceId": "ws_a",
                "ssoGroups": {
                    "policy": {"highRiskTools": ["Bash"], "requiredGroups": ["sre"]},
                    "memberGroups": ["eng"]
                }
            })
        }

        /// The key is sent as the bearer, the answer is cached per key, and a
        /// second key is fetched on its own.
        #[tokio::test]
        async fn fetches_per_key_and_caches_within_the_ttl() {
            let server = MockServer::start().await;
            let token_a = format!("vk_{}", "a".repeat(32));
            let token_b = format!("vk_{}", "b".repeat(32));
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .and(header(
                    "authorization",
                    format!("Bearer {token_a}").as_str(),
                ))
                .respond_with(ResponseTemplate::new(200).set_body_json(body()))
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .and(header(
                    "authorization",
                    format!("Bearer {token_b}").as_str(),
                ))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "workspaceId": "ws_b",
                    "ssoGroups": {"policy": null, "memberGroups": null}
                })))
                .expect(1)
                .mount(&server)
                .await;

            let client = reqwest::Client::new();
            let t = Duration::from_secs(2);
            for _ in 0..3 {
                let gate = resolve(&client, &server.uri(), &key(&token_a), t, Some(1))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(gate.decide("Bash").clearance, Clearance::Denied);
            }
            assert_eq!(
                resolve(&client, &server.uri(), &key(&token_b), t, None).await,
                Ok(None)
            );
            // `expect(1)` on each mock is verified when the server drops.
        }

        #[tokio::test]
        async fn a_failed_fetch_is_an_error_and_is_not_cached() {
            let server = MockServer::start().await;
            let token = format!("vk_{}", "c".repeat(32));
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .respond_with(ResponseTemplate::new(503))
                .expect(2)
                .mount(&server)
                .await;
            let client = reqwest::Client::new();
            let t = Duration::from_secs(2);
            assert!(resolve(&client, &server.uri(), &key(&token), t, None)
                .await
                .is_err());
            assert!(resolve(&client, &server.uri(), &key(&token), t, None)
                .await
                .is_err());
        }

        /// A moved config version (a SCIM push, say) refetches inside the TTL.
        #[tokio::test]
        async fn a_moved_config_version_refetches_within_the_ttl() {
            let server = MockServer::start().await;
            let token = format!("vk_{}", "d".repeat(32));
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body()))
                .expect(2)
                .mount(&server)
                .await;
            let client = reqwest::Client::new();
            let t = Duration::from_secs(2);
            for version in [Some(4), Some(4), Some(5), Some(5)] {
                assert!(resolve(&client, &server.uri(), &key(&token), t, version)
                    .await
                    .unwrap()
                    .is_some());
            }
        }

        /// A key the control plane refuses keeps the policy last seen for it
        /// with the groups unknown — a member who was cleared is not any more.
        #[tokio::test]
        async fn a_refused_key_keeps_the_policy_with_the_groups_unknown() {
            let server = MockServer::start().await;
            let token = format!("vk_{}", "e".repeat(32));
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "workspaceId": "ws_a",
                    "ssoGroups": {
                        "policy": {"highRiskTools": ["Bash"], "requiredGroups": ["sre"]},
                        "memberGroups": ["sre"]
                    }
                })))
                .up_to_n_times(1)
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .respond_with(ResponseTemplate::new(401))
                .mount(&server)
                .await;
            let client = reqwest::Client::new();
            let t = Duration::from_secs(2);
            let cleared = resolve(&client, &server.uri(), &key(&token), t, Some(1))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cleared.decide("Bash").clearance, Clearance::Granted);
            let refused = resolve(&client, &server.uri(), &key(&token), t, Some(2))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(refused.member_groups, None);
            assert_eq!(refused.decide("Bash").clearance, Clearance::Denied);

            // A key refused before any policy was seen for it is a failure,
            // which the proxy's fail mode decides.
            let unseen = format!("vk_{}", "f".repeat(32));
            assert!(resolve(&client, &server.uri(), &key(&unseen), t, None)
                .await
                .is_err());
        }
    }
}
