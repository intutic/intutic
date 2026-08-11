//! End-to-end proof that per-workspace SOP resolution genuinely isolates
//! tenants (LLD #64 §6 increment 4, TD-334): two workspaces on the same
//! gateway process get two different, non-leaking SOP sets, fetched from a
//! real HTTP server (not a mock trait) standing in for the control plane.

use intutic_proxy::gateway::{init_gateway_config, GatewayConfig};
use intutic_proxy::sops::all_sops_for_workspace;
use std::net::SocketAddr;

use axum::extract::Query;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use serde_json::json;
use std::collections::HashMap;

/// A tiny stand-in control plane: `GET /api/v1/workspace/sops-policy` returns
/// a DIFFERENT SOP depending on the `Authorization` bearer, simulating two
/// distinct tenants' virtual keys resolving to two distinct workspaces — the
/// real control plane resolves this from the token via its auth middleware;
/// here the token IS the workspace, which is enough to prove the proxy-side
/// contract (cache keyed correctly, no cross-workspace bleed) without a real
/// Postgres.
async fn sops_policy_handler(
    headers: axum::http::HeaderMap,
    Query(_params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if auth.contains("vk_alpha") {
        Json(json!({
            "workspaceId": "ws_alpha",
            "sops": [{"title": "alpha-policy", "markdownContent": "---\ndeny_tools: alpha-secret-tool\n---\nAlpha's policy."}]
        }))
    } else if auth.contains("vk_beta") {
        Json(json!({
            "workspaceId": "ws_beta",
            "sops": [{"title": "beta-policy", "markdownContent": "---\ndeny_tools: beta-secret-tool\n---\nBeta's policy."}]
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
    // Give the listener a moment to accept connections.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    addr
}

#[tokio::test]
async fn two_workspaces_on_one_gateway_process_get_isolated_sop_sets() {
    init_gateway_config(GatewayConfig { require_vk: true, ..Default::default() });
    let addr = spawn_stand_in().await;
    let control_plane_url = format!("http://{addr}");
    let client = reqwest::Client::new();

    let alpha = all_sops_for_workspace(
        &client,
        Some(&control_plane_url),
        Some("ws_alpha"),
        Some("vk_alpha_deadbeef"),
    )
    .await;
    let beta = all_sops_for_workspace(
        &client,
        Some(&control_plane_url),
        Some("ws_beta"),
        Some("vk_beta_deadbeef"),
    )
    .await;

    assert_eq!(alpha.len(), 1, "alpha should see exactly its own SOP");
    assert_eq!(alpha[0].title, "alpha-policy");
    assert_eq!(alpha[0].deny_tools, vec!["alpha-secret-tool".to_string()]);

    assert_eq!(beta.len(), 1, "beta should see exactly its own SOP");
    assert_eq!(beta[0].title, "beta-policy");
    assert_eq!(beta[0].deny_tools, vec!["beta-secret-tool".to_string()]);

    // The load-bearing assertion: neither workspace's resolved set contains
    // ANY trace of the other's policy — not the title, not the tool name.
    // This is what "cross-tenant SOP leak" would look like if the cache were
    // keyed wrong (e.g. by a shared key instead of workspace_id).
    assert!(
        !alpha.iter().any(|s| s.title == "beta-policy"),
        "alpha's resolved SOPs must not contain beta's policy"
    );
    assert!(
        !alpha.iter().any(|s| s.deny_tools.contains(&"beta-secret-tool".to_string())),
        "alpha's resolved deny_tools must not contain beta's secret tool"
    );
    assert!(
        !beta.iter().any(|s| s.title == "alpha-policy"),
        "beta's resolved SOPs must not contain alpha's policy"
    );
    assert!(
        !beta.iter().any(|s| s.deny_tools.contains(&"alpha-secret-tool".to_string())),
        "beta's resolved deny_tools must not contain alpha's secret tool"
    );

    // Re-fetching within the cache TTL for the SAME workspace must still
    // return that workspace's own set (cache hit path), not drift or empty.
    let alpha_again = all_sops_for_workspace(
        &client,
        Some(&control_plane_url),
        Some("ws_alpha"),
        Some("vk_alpha_deadbeef"),
    )
    .await;
    assert_eq!(alpha_again.len(), 1);
    assert_eq!(alpha_again[0].title, "alpha-policy");
}

// A companion "gateway mode OFF returns the process-global set" test is
// deliberately NOT here: gateway config is a set-once, process-global
// OnceLock (matching egress_policy's own discipline), and #[tokio::test]
// functions in one binary do not run in a guaranteed order — a second test in
// this file flipping it would race the one above. That direction is already
// covered without the race: `all_sops_for_workspace`'s off-mode branch is a
// single, directly-readable guard clause (`if !requires_vk_only() { return
// all_sops() }`), `gateway::tests::off_by_default_accepts_everything` proves
// the flag itself defaults off, and every one of `sops.rs`'s 66+ existing
// tests exercises the process-global `*_for_role` path unmodified.
