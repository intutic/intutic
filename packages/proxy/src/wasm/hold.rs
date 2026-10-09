//! A rule's `hold` verdict as a real hold, through the decisions API.
//!
//! The same flow the MCP governance proxy runs for `require_approval` rules
//! (`packages/mcp-proxy/src/approvalHold.ts`), and the harness hook gates for
//! review holds:
//!
//! 1. The held call is looked up in the workspace's approved bypasses
//!    (`GET /api/v1/decisions/approved-bypasses`). An unexpired entry for the
//!    same rule, tool and arguments lets it through.
//! 2. Otherwise a hold is recorded (`POST /api/v1/decisions`): it lands in the
//!    review queue, notifies the workspace, and the refusal names its id.
//! 3. An approver approves it (`intutic decision approve <holdId>`, the review
//!    API or the Slack card). With the workspace's review-hold bypass on, that
//!    writes the bypass step 1 finds, so the identical retry goes through.
//!
//! A hold needs the control plane both ways, so without one, or when it does
//! not answer, the call stays held: a rule that says a person must approve is
//! not satisfied by nobody being reachable to ask. The same holds for a request
//! made with a provider key: the control plane is asked only with a virtual
//! key, so that request's hold is not recorded either.

use crate::credential::VirtualKey;
use serde_json::{json, Value};
use std::time::Duration;

/// Per request to the control plane. A hold is already a refusal, so this
/// only bounds how long the refusal takes to arrive.
const TIMEOUT: Duration = Duration::from_secs(3);

/// The hold-record version `POST /api/v1/decisions` accepts.
const HOLD_RECORD_VERSION: u64 = 1;

/// What one held call came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldOutcome {
    /// An approver approved this exact call; it may run.
    Bypassed { hold_id: String, decided_by: String },
    /// Held. `recorded` is false when the control plane could not be told,
    /// so there is nothing to approve yet.
    Held { hold_id: String, recorded: bool },
}

/// The held call, as the decisions API keys it.
#[derive(Debug, Clone)]
pub struct HeldCall<'a> {
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub rule_id: &'a str,
    pub reason: &'a str,
    pub risk_tier: Option<&'a str>,
    pub tool: &'a str,
    pub target_hash: &'a str,
}

impl HeldCall<'_> {
    /// The bypass key's tool: lower-cased, as every hold producer writes it.
    fn tool_normalized(&self) -> String {
        self.tool.trim().to_lowercase()
    }
}

fn new_hold_id() -> String {
    format!(
        "hold_{:x}_{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    )
}

/// Let the call through on an approved bypass, or record a hold. Never fails:
/// every error leaves the call held.
pub async fn request(
    client: &reqwest::Client,
    control_plane_url: Option<&str>,
    virtual_key: Option<&VirtualKey>,
    call: &HeldCall<'_>,
) -> HoldOutcome {
    let hold_id = new_hold_id();
    let Some((base, virtual_key)) = control_plane_url
        .map(|u| u.trim_end_matches('/'))
        .filter(|u| !u.is_empty())
        .zip(virtual_key)
    else {
        return HoldOutcome::Held {
            hold_id,
            recorded: false,
        };
    };

    if let Some(bypass) = find_bypass(client, base, virtual_key, call).await {
        return bypass;
    }

    let tool = call.tool_normalized();
    let body = json!({
        "holds": [{
            "v": HOLD_RECORD_VERSION,
            "holdId": hold_id,
            "reason": call.rule_id,
            "tool": tool,
            // Empty, with the session in the context instead: the record's
            // session id must name a session the control plane already has,
            // and this request's may not have reached it yet. A hold refused
            // for that would leave nothing to approve.
            "sessionId": "",
            "at": chrono::Utc::now().to_rfc3339(),
            "toolNameNormalized": tool,
            "targetHash": call.target_hash,
            "context": {
                "source": "proxy",
                "tool": call.tool,
                "rule": call.reason,
                "riskTier": call.risk_tier,
                "session": call.session_id,
            },
        }]
    });
    let recorded = match virtual_key
        .authorize(client.post(format!("{base}/api/v1/decisions")))
        .timeout(TIMEOUT)
        .json(&body)
        .send()
        .await
    {
        // The endpoint answers 200 for a batch it partly dropped, so the count
        // is what says this hold is in the review queue.
        Ok(resp) if resp.status().is_success() => resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|b| b.get("accepted").and_then(Value::as_u64))
            .is_some_and(|n| n >= 1),
        Ok(resp) => {
            tracing::warn!(status = %resp.status(), rule_id = call.rule_id, "control plane refused the hold record");
            false
        }
        Err(e) => {
            tracing::warn!(error = %e, rule_id = call.rule_id, "could not record the hold");
            false
        }
    };
    HoldOutcome::Held { hold_id, recorded }
}

async fn find_bypass(
    client: &reqwest::Client,
    base: &str,
    virtual_key: &VirtualKey,
    call: &HeldCall<'_>,
) -> Option<HoldOutcome> {
    let body: Value = match virtual_key
        .authorize(client.get(format!("{base}/api/v1/decisions/approved-bypasses")))
        .timeout(TIMEOUT)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp.json().await.ok()?,
        Ok(resp) => {
            tracing::warn!(status = %resp.status(), "approved-bypass lookup refused; the call stays held");
            return None;
        }
        Err(e) => {
            tracing::warn!(error = %e, "approved-bypass lookup failed; the call stays held");
            return None;
        }
    };
    let tool = call.tool_normalized();
    let now = chrono::Utc::now();
    body.get("bypasses")?.as_array()?.iter().find_map(|entry| {
        let field = |name: &str| entry.get(name).and_then(Value::as_str);
        let matches = field("workspaceId") == Some(call.workspace_id)
            && field("sopRuleId") == Some(call.rule_id)
            && field("toolNameNormalized") == Some(tool.as_str())
            && field("targetHash") == Some(call.target_hash);
        let unexpired = field("expiresAt")
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t > now);
        (matches && unexpired).then(|| HoldOutcome::Bypassed {
            hold_id: field("holdId").unwrap_or_default().to_string(),
            decided_by: field("decidedBy").unwrap_or_default().to_string(),
        })
    })
}

/// What the agent is told about a hold.
pub fn refusal(outcome: &HoldOutcome, rule_id: &str, reason: &str) -> String {
    match outcome {
        HoldOutcome::Held {
            hold_id,
            recorded: true,
        } => format!(
            "HELD for approval: {reason} [{rule_id}]. Hold id: {hold_id}. An approver can run: \
             intutic decision approve {hold_id} (or reject it). Retry this exact call after it \
             is approved."
        ),
        HoldOutcome::Held { .. } => format!(
            "HELD for approval: {reason} [{rule_id}], but the hold could not be recorded (no \
             Intutic control plane reachable, or the request was not made with an Intutic \
             virtual key), so there is nothing to approve yet."
        ),
        HoldOutcome::Bypassed { .. } => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const HASH: &str = "ab12";

    fn vk_test() -> VirtualKey {
        crate::credential::RequestCredential::classify("vk_test")
            .virtual_key()
            .cloned()
            .expect("a virtual key")
    }

    fn call() -> HeldCall<'static> {
        HeldCall {
            workspace_id: "ws_1",
            session_id: "ses_1",
            rule_id: "local:20_deploys.wasm",
            reason: "production deploy needs approval",
            risk_tier: Some("high"),
            tool: "Bash",
            target_hash: HASH,
        }
    }

    fn bypass(expires: &str, hash: &str) -> Value {
        json!({ "bypasses": [{
            "workspaceId": "ws_1", "sopRuleId": "local:20_deploys.wasm",
            "toolNameNormalized": "bash", "targetHash": hash,
            "holdId": "hold_x", "decidedBy": "ana@example.com", "expiresAt": expires
        }]})
    }

    async fn server(bypasses: Value) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/decisions/approved-bypasses"))
            .and(header("authorization", "Bearer vk_test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bypasses))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v1/decisions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"accepted": 1})))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn a_held_call_is_recorded_with_its_bypass_key() {
        let server = server(json!({ "bypasses": [] })).await;
        let outcome = request(
            &reqwest::Client::new(),
            Some(&server.uri()),
            Some(&vk_test()),
            &call(),
        )
        .await;
        let HoldOutcome::Held {
            hold_id,
            recorded: true,
        } = &outcome
        else {
            panic!("{outcome:?}");
        };
        let posted = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.method.as_str() == "POST")
            .expect("hold posted");
        let body: Value = serde_json::from_slice(&posted.body).unwrap();
        let hold = &body["holds"][0];
        assert_eq!(hold["holdId"], hold_id.as_str());
        assert_eq!(hold["reason"], "local:20_deploys.wasm");
        assert_eq!(hold["toolNameNormalized"], "bash");
        assert_eq!(hold["targetHash"], HASH);
        assert_eq!(hold["context"]["source"], "proxy");
        assert_eq!(hold["context"]["riskTier"], "high");
        assert_eq!(hold["context"]["session"], "ses_1");
        assert_eq!(hold["sessionId"], "");
        assert!(refusal(&outcome, "r", "why").contains(hold_id.as_str()));
    }

    #[tokio::test]
    async fn an_approved_identical_call_goes_through() {
        let future = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        let server = server(bypass(&future, HASH)).await;
        assert_eq!(
            request(
                &reqwest::Client::new(),
                Some(&server.uri()),
                Some(&vk_test()),
                &call()
            )
            .await,
            HoldOutcome::Bypassed {
                hold_id: "hold_x".into(),
                decided_by: "ana@example.com".into()
            }
        );
    }

    #[tokio::test]
    async fn an_expired_or_different_approval_does_not() {
        let past = (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
        let future = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        for bypasses in [bypass(&past, HASH), bypass(&future, "other-args")] {
            let server = server(bypasses).await;
            let outcome = request(
                &reqwest::Client::new(),
                Some(&server.uri()),
                Some(&vk_test()),
                &call(),
            )
            .await;
            assert!(
                matches!(outcome, HoldOutcome::Held { recorded: true, .. }),
                "{outcome:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_hold_the_control_plane_dropped_is_not_reported_as_recorded() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/decisions/approved-bypasses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "bypasses": [] })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v1/decisions"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"accepted": 0, "dropped": 1})),
            )
            .mount(&server)
            .await;
        let outcome = request(
            &reqwest::Client::new(),
            Some(&server.uri()),
            Some(&vk_test()),
            &call(),
        )
        .await;
        assert!(matches!(
            outcome,
            HoldOutcome::Held {
                recorded: false,
                ..
            }
        ));
    }

    /// A request made with a provider key has no virtual key to ask with. The
    /// call stays held and the control plane is not contacted at all, so the
    /// provider key never reaches it.
    #[tokio::test]
    async fn without_a_virtual_key_the_call_stays_held_and_nothing_is_sent() {
        let server = server(json!({ "bypasses": [] })).await;
        let outcome = request(&reqwest::Client::new(), Some(&server.uri()), None, &call()).await;
        assert!(matches!(
            outcome,
            HoldOutcome::Held {
                recorded: false,
                ..
            }
        ));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn without_a_control_plane_the_call_stays_held() {
        let outcome = request(&reqwest::Client::new(), None, Some(&vk_test()), &call()).await;
        assert!(matches!(
            outcome,
            HoldOutcome::Held {
                recorded: false,
                ..
            }
        ));
        assert!(refusal(&outcome, "r", "why").contains("could not be recorded"));
        // Unreachable: the same.
        let outcome = request(
            &reqwest::Client::new(),
            Some("http://127.0.0.1:9"),
            Some(&vk_test()),
            &call(),
        )
        .await;
        assert!(matches!(
            outcome,
            HoldOutcome::Held {
                recorded: false,
                ..
            }
        ));
    }
}
