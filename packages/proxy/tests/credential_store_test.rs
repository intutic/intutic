//! The Valkey credential reader opens what the control plane sealed.
//!
//! `workspace_credential` is the read every gateway request makes for its
//! workspace's provider key (`proxy.rs` `fetch_provider_credential`). The
//! control plane stores those values encrypted (`credential_crypto.rs`), so
//! this pins the reader end to end against a real Valkey: the usable key comes
//! back, ciphertext never does.
//!
//! Runs when `VALKEY_URL` is set and reachable, and skips otherwise, like
//! `sop_pin_test.rs`, so `cargo test` stays green without Valkey.

use intutic_proxy::credential_crypto::{context, CredentialKeyring};
use intutic_proxy::store::{LocalStore, ValkeyStore};
use redis::AsyncCommands;
use std::sync::Arc;

const KEY: &str = "test-encryption-key-32-bytes-ok!";

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

fn unique_ws(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("ws_cred_{tag}_{nanos}")
}

fn hash_key(ws: &str) -> String {
    format!("workspace:credentials:{ws}")
}

#[tokio::test]
async fn reader_opens_sealed_values_and_never_returns_ciphertext() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("note: VALKEY_URL not set or unreachable — skipped");
        return;
    };
    let mut raw = conn.as_ref().clone();
    let keys = CredentialKeyring::from_secrets(KEY, &[]);
    let ws = unique_ws("read");
    let other = unique_ws("other");
    let secret = format!("test-provider-key-{}", ws.len());

    let sealed = keys.encrypt(&secret, &context(&ws, "anthropic_api_key"));
    let _: () = raw
        .hset(hash_key(&ws), "anthropic_api_key", &sealed)
        .await
        .unwrap();
    // The same ciphertext copied into another workspace's hash.
    let _: () = raw
        .hset(hash_key(&other), "anthropic_api_key", &sealed)
        .await
        .unwrap();

    let with_key = ValkeyStore::new(conn.clone())
        .with_credential_keyring(Some(CredentialKeyring::from_secrets(KEY, &[])));
    let without_key = ValkeyStore::new(conn.clone());

    assert_eq!(
        with_key
            .workspace_credential(&ws, &["anthropic_api_key"])
            .await,
        Some(secret.clone()),
        "the usable key, opened"
    );
    assert_eq!(
        without_key
            .workspace_credential(&ws, &["anthropic_api_key"])
            .await,
        None,
        "no key configured: refused, not forwarded as ciphertext"
    );
    assert_eq!(
        with_key
            .workspace_credential(&other, &["anthropic_api_key"])
            .await,
        None,
        "a ciphertext moved to another workspace does not open there"
    );

    let _: () = raw.del(&[hash_key(&ws), hash_key(&other)]).await.unwrap();
}

#[tokio::test]
async fn values_stored_before_encryption_still_read() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("note: VALKEY_URL not set or unreachable — skipped");
        return;
    };
    let mut raw = conn.as_ref().clone();
    let ws = unique_ws("legacy");
    let _: () = raw
        .hset(hash_key(&ws), "openai_api_key", "test-provider-key-legacy")
        .await
        .unwrap();

    let store = ValkeyStore::new(conn.clone())
        .with_credential_keyring(Some(CredentialKeyring::from_secrets(KEY, &[])));
    assert_eq!(
        store.workspace_credential(&ws, &["openai_api_key"]).await,
        Some("test-provider-key-legacy".to_string())
    );

    let _: () = raw.del(hash_key(&ws)).await.unwrap();
}

#[tokio::test]
async fn a_captured_credential_is_stored_sealed() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("note: VALKEY_URL not set or unreachable — skipped");
        return;
    };
    let mut raw = conn.as_ref().clone();
    let ws = unique_ws("capture");
    let store = ValkeyStore::new(conn.clone())
        .with_credential_keyring(Some(CredentialKeyring::from_secrets(KEY, &[])));

    store
        .set_workspace_credential(&ws, "anthropic_oauth_token", "test-session-token-0001")
        .await;

    let stored: String = raw
        .hget(hash_key(&ws), "anthropic_oauth_token")
        .await
        .unwrap();
    assert!(stored.starts_with("enc:v1:"), "stored sealed");
    assert!(!stored.contains("test-session-token-0001"));
    assert_eq!(
        store
            .workspace_credential(&ws, &["anthropic_oauth_token"])
            .await,
        Some("test-session-token-0001".to_string())
    );

    let _: () = raw.del(hash_key(&ws)).await.unwrap();
}
