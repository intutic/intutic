//! End-to-end proof that the org-level SOP ceiling (migration 139) applies
//! through the full fetch -> parse -> `governance_fields_from` pipeline, not
//! just at the unit-level collectors in `sops.rs`. Mirrors
//! `workspace_sops_isolation_test.rs`'s stand-in-server pattern: a tiny axum
//! server plays `GET /api/v1/workspace/sops-policy`, returning a real HTTP
//! response (not a mock trait) so the wire-format contract (the `scope`
//! field, `#[serde(default)]`) is exercised too.

use intutic_proxy::gateway::{init_gateway_config, GatewayConfig};
use intutic_proxy::sops::{all_sops_for_workspace, governance_fields_from};
use std::net::SocketAddr;

use axum::extract::Query;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use serde_json::json;
use std::collections::HashMap;

/// One workspace SOP (broad allowlists) plus one org SOP (a narrower
/// ceiling, deliberately declared with different case on `plan_steps` to
/// prove the ceiling matches case-insensitively while the surviving text
/// keeps the workspace's own casing).
async fn sops_policy_handler(
    headers: axum::http::HeaderMap,
    Query(_params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if auth.contains("vk_ceiling") {
        Json(json!({
            "workspaceId": "ws_ceiling",
            "sops": [
                {
                    "title": "workspace-policy",
                    "markdownContent": "---\nallow_harnesses: claude-code, cursor\nscope_paths: infra/k8s, docs\nplan_steps: Read, Edit, action:deploy\n---\nWorkspace's own policy.",
                    "scope": "workspace"
                },
                {
                    "title": "org-floor",
                    "markdownContent": "---\nallow_harnesses: claude-code\nscope_paths: infra\nplan_steps: read, action:deploy\n---\nOrg-wide floor.",
                    "scope": "org"
                }
            ]
        }))
    } else if auth.contains("vk_no_ceiling") {
        // A workspace with only its own SOP and no org row at all -- the
        // ceiling logic must be a strict no-op here, not an accidental
        // empty-set narrowing.
        Json(json!({
            "workspaceId": "ws_no_ceiling",
            "sops": [{
                "title": "workspace-only-policy",
                "markdownContent": "---\nallow_harnesses: claude-code, cursor\nscope_paths: infra/k8s, docs\n---\nWorkspace's own policy, no org floor exists.",
                "scope": "workspace"
            }]
        }))
    } else {
        Json(json!({ "workspaceId": "unknown", "sops": [] }))
    }
}

async fn spawn_stand_in() -> SocketAddr {
    let app = Router::new().route("/api/v1/workspace/sops-policy", get(sops_policy_handler));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    addr
}

#[tokio::test]
async fn org_sop_applies_as_a_ceiling_through_the_full_fetch_parse_resolve_pipeline() {
    init_gateway_config(GatewayConfig { require_vk: true, ..Default::default() });
    let addr = spawn_stand_in().await;
    let control_plane_url = format!("http://{addr}");
    let client = reqwest::Client::new();

    let sops = all_sops_for_workspace(
        &client,
        Some(&control_plane_url),
        Some("ws_ceiling"),
        Some("vk_ceiling_deadbeef"),
    )
    .await;
    assert_eq!(sops.len(), 2, "both the workspace row and the org row must be fetched");

    let gov = governance_fields_from(&sops, "anyone");

    assert_eq!(
        gov.allowed_harnesses,
        vec!["claude-code".to_string()],
        "cursor is in the workspace's own allowlist but not the org's -- the ceiling must drop it"
    );
    assert_eq!(
        gov.scope_paths,
        vec!["infra/k8s".to_string()],
        "infra/k8s survives (contained within the org's infra ceiling); docs does not"
    );
    assert_eq!(
        gov.plan_steps,
        vec!["Read".to_string(), "action:deploy".to_string()],
        "Edit is outside the org's plan ceiling and must be dropped; the surviving steps \
         keep the workspace's own casing (\"Read\", not the org's \"read\") and order"
    );
}

#[tokio::test]
async fn a_workspace_with_no_org_sop_at_all_is_unaffected_by_the_ceiling_logic() {
    init_gateway_config(GatewayConfig { require_vk: true, ..Default::default() });
    let addr = spawn_stand_in().await;
    let control_plane_url = format!("http://{addr}");
    let client = reqwest::Client::new();

    let sops = all_sops_for_workspace(
        &client,
        Some(&control_plane_url),
        Some("ws_no_ceiling"),
        Some("vk_no_ceiling_deadbeef"),
    )
    .await;
    assert_eq!(sops.len(), 1);

    let gov = governance_fields_from(&sops, "anyone");
    assert_eq!(
        gov.allowed_harnesses,
        vec!["claude-code".to_string(), "cursor".to_string()],
        "no org SOP exists at all -- an empty org set must never be read as an empty ceiling"
    );
    assert_eq!(gov.scope_paths, vec!["docs".to_string(), "infra/k8s".to_string()]);
}
