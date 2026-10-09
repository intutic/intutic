//! The workspace's PII detector actions, from the control plane.
//!
//! A workspace owner or admin sets `piiDetectors` in the workspace settings:
//! an action (`off`, `redact`, `block`) for each detector they want to govern
//! centrally. `/api/v1/auth/key-context`, the per-key route the proxy already
//! calls, carries it (read through `crate::key_context`), and each request is
//! scanned with that setting as the baseline and this machine's
//! `dlp.detectors` allowed only to tighten it ([`super::workspace_pii_policy`]).
//!
//! A standalone proxy, or a request made without a virtual key, has no
//! workspace setting: its machine's config applies alone, as before.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::PiiPolicy;

/// Reads the `piiDetectors` field of a `/auth/key-context` body.
///
/// - absent: a control plane older than the field, so no workspace setting.
/// - `null`: the control plane could not read the setting. That is a failure,
///   and the caller applies the proxy's policy fail mode.
/// - an object: detector id → action. Empty when the workspace sets none.
///
/// An id this proxy does not know is left out (a newer control plane can name
/// a detector an older proxy does not have, and the proxy cannot run it); an
/// action that is not a string is a failure.
pub fn parse_key_context(body: &Value) -> Result<Option<BTreeMap<String, String>>, String> {
    let Some(field) = body.get("piiDetectors") else {
        return Ok(None);
    };
    let Some(obj) = field.as_object() else {
        return Err(if field.is_null() {
            "the control plane could not read the workspace's PII detector actions".to_string()
        } else {
            format!("the workspace's PII detector actions are not an object: {field}")
        });
    };
    let mut actions = BTreeMap::new();
    for (id, action) in obj {
        if !super::pii::detectors().iter().any(|d| &d.id == id) {
            tracing::warn!(detector = %id, "workspace PII setting names a detector this proxy does not have; ignored");
            continue;
        }
        let Some(action) = action.as_str() else {
            return Err(format!(
                "the workspace's PII detector action for '{id}' is not a string: {action}"
            ));
        };
        actions.insert(id.clone(), action.to_string());
    }
    Ok((!actions.is_empty()).then_some(actions))
}

/// The PII policy for one virtual key's requests, `None` when its workspace
/// sets no detector action and this machine's config applies alone.
///
/// `Err` means the control plane could not answer, refused the key, or sent
/// an action that does not exist; the caller applies the proxy's policy fail
/// mode. Freshness is `crate::key_context::fetch`'s: cached per key for its
/// TTL and refetched when `policy_version` moves, which the control plane
/// bumps when the setting changes.
pub async fn resolve(
    client: &reqwest::Client,
    control_plane_url: &str,
    virtual_key: &crate::credential::VirtualKey,
    timeout: Duration,
    policy_version: Option<u64>,
) -> Result<Option<Arc<PiiPolicy>>, String> {
    let answer = crate::key_context::fetch(
        client,
        control_plane_url,
        virtual_key,
        timeout,
        policy_version,
    )
    .await
    .map_err(|e| format!("workspace PII detector actions unavailable: {e}"))?;
    let body = match answer {
        crate::key_context::Answer::Body(body) => body,
        crate::key_context::Answer::Refused(status) => {
            return Err(format!(
                "the control plane refused the key ({status}), so its workspace's PII detector actions are unknown"
            ))
        }
    };
    match parse_key_context(&body)? {
        None => Ok(None),
        Some(actions) => super::workspace_pii_policy(&actions).map(|p| Some(Arc::new(p))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_context_field_reads_absent_null_empty_and_present_apart() {
        assert_eq!(
            parse_key_context(&serde_json::json!({"workspaceId": "ws"})),
            Ok(None)
        );
        assert!(parse_key_context(&serde_json::json!({"piiDetectors": null})).is_err());
        assert!(parse_key_context(&serde_json::json!({"piiDetectors": ["pii.card"]})).is_err());
        assert_eq!(
            parse_key_context(&serde_json::json!({"piiDetectors": {}})),
            Ok(None)
        );
        assert!(parse_key_context(&serde_json::json!({"piiDetectors": {"pii.card": 2}})).is_err());
        let got = parse_key_context(&serde_json::json!({
            "piiDetectors": {"pii.card": "block", "pii.passport": "redact"}
        }))
        .unwrap()
        .unwrap();
        assert_eq!(
            got,
            BTreeMap::from([("pii.card".to_string(), "block".to_string())]),
            "an unknown detector is left out, the known one kept"
        );
    }

    mod fetch {
        use super::super::*;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        fn key(token: &str) -> crate::credential::VirtualKey {
            crate::credential::RequestCredential::classify(token)
                .virtual_key()
                .cloned()
                .expect("a virtual key")
        }

        async fn serve(body: Value) -> MockServer {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/api/v1/auth/key-context"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            server
        }

        #[tokio::test]
        async fn the_workspace_setting_reaches_the_scan() {
            let server = serve(serde_json::json!({
                "workspaceId": "ws_pii",
                "piiDetectors": {"pii.email": "redact", "pii.card": "block"}
            }))
            .await;
            let policy = resolve(
                &reqwest::Client::new(),
                &server.uri(),
                &key(&format!("vk_{}", "p".repeat(32))),
                Duration::from_secs(2),
                None,
            )
            .await
            .unwrap()
            .expect("the workspace names detectors");
            let mail = format!("write to {}@{}", "jane.doe", "corp.io");
            let findings = crate::dlp::scan_with(&mail, Some(&policy));
            assert_eq!(findings.len(), 1, "{findings:?}");
            assert_eq!(findings[0].pattern_name, "pii.email");
            assert!(
                crate::dlp::scan(&mail).is_empty(),
                "the machine's own scan is unchanged"
            );
        }

        #[tokio::test]
        async fn no_setting_and_an_unreadable_one_are_told_apart() {
            let none = serve(serde_json::json!({"workspaceId": "ws", "piiDetectors": {}})).await;
            let t = Duration::from_secs(2);
            let client = reqwest::Client::new();
            assert!(resolve(
                &client,
                &none.uri(),
                &key(&format!("vk_{}", "q".repeat(32))),
                t,
                None
            )
            .await
            .unwrap()
            .is_none());

            let unreadable =
                serve(serde_json::json!({"workspaceId": "ws", "piiDetectors": null})).await;
            assert!(resolve(
                &client,
                &unreadable.uri(),
                &key(&format!("vk_{}", "r".repeat(32))),
                t,
                None
            )
            .await
            .is_err());

            let bad_action = serve(serde_json::json!({
                "workspaceId": "ws",
                "piiDetectors": {"pii.card": "warn"}
            }))
            .await;
            let err = resolve(
                &client,
                &bad_action.uri(),
                &key(&format!("vk_{}", "s".repeat(32))),
                t,
                None,
            )
            .await
            .err()
            .unwrap();
            assert!(
                err.contains("warn") && err.contains("piiDetectors"),
                "{err}"
            );
        }
    }
}
