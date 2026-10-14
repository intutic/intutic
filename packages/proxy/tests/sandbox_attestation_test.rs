//! `ControlPlaneCache::is_sandbox_attested` against a real Valkey.
//!
//! Skips when `VALKEY_URL` is unset or unreachable, matching the pattern
//! `reward_test.rs` already uses — `cargo test` stays green on machines
//! without Valkey while still covering the path that ships.

use intutic_proxy::store::{ControlPlaneCache, ValkeyControlPlaneCache};
use redis::AsyncCommands;

async fn valkey_conn() -> Option<redis::aio::ConnectionManager> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    redis::aio::ConnectionManager::new(client).await.ok()
}

fn unique_session(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("ses_attest_{tag}_{nanos}")
}

#[tokio::test]
async fn a_session_with_no_attestation_key_reads_as_unattested() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let cp = ValkeyControlPlaneCache::new(std::sync::Arc::new(conn));
    let session_id = unique_session("miss");

    assert!(
        !cp.is_sandbox_attested("ws_attest_a", &session_id).await,
        "a cache miss must fail closed, not be mistaken for a confirmed attestation"
    );
}

#[tokio::test]
async fn a_session_the_control_plane_wrote_reads_as_attested() {
    let Some(mut conn) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let session_id = unique_session("hit");

    // Mirrors the control plane's own write:
    // `session:sandbox_attested:{workspace}:{session}`, 24h TTL. Written
    // directly rather than through the proxy's attest-sandbox route, since that
    // route lives in the control plane, not this crate — this test only needs
    // to prove the READ side of the contract.
    let key = format!("session:sandbox_attested:ws_attest_a:{session_id}");
    let _: () = conn
        .set_ex(&key, "1", 86_400)
        .await
        .expect("SET must succeed against a live Valkey");

    let cp = ValkeyControlPlaneCache::new(std::sync::Arc::new(conn));
    assert!(
        cp.is_sandbox_attested("ws_attest_a", &session_id).await,
        "a key the control plane wrote must read back as attested"
    );
}

/// The session id on a request is the caller's claim. Another workspace naming
/// an attested session must not read it as attested — including through the
/// unscoped key an older control plane wrote.
#[tokio::test]
async fn another_workspace_naming_an_attested_session_reads_unattested() {
    let Some(mut conn) = valkey_conn().await else {
        eprintln!("skipping: VALKEY_URL not set or Valkey unreachable");
        return;
    };
    let session_id = unique_session("foreign");
    for key in [
        format!("session:sandbox_attested:ws_attest_a:{session_id}"),
        format!("session:sandbox_attested:{session_id}"),
    ] {
        let _: () = conn.set_ex(&key, "1", 60).await.expect("SET");
    }

    let cp = ValkeyControlPlaneCache::new(std::sync::Arc::new(conn));
    assert!(cp.is_sandbox_attested("ws_attest_a", &session_id).await);
    assert!(
        !cp.is_sandbox_attested("ws_attest_b", &session_id).await,
        "workspace B must not inherit workspace A's attestation"
    );
}
