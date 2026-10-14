//! The "no cache fields reported" observation (`record_session_cache_unreported`)
//! against both stores: it gives a scope its first observation, without a
//! ratio, and never replaces one that exists.
//!
//! `MemoryStore` always, `ValkeyStore` additionally when `VALKEY_URL` is set
//! (a runtime skip, not `#[ignore]`, as in `key_limits_valkey_test.rs`).

use std::sync::Arc;

use intutic_proxy::store::{LocalStore, MemoryStore, ValkeyStore};

async fn stores() -> Vec<(&'static str, Arc<dyn LocalStore>)> {
    let mut out: Vec<(&'static str, Arc<dyn LocalStore>)> =
        vec![("memory", Arc::new(MemoryStore::new()))];
    let valkey = async {
        let client = redis::Client::open(std::env::var("VALKEY_URL").ok()?).ok()?;
        redis::aio::ConnectionManager::new(client).await.ok()
    };
    match valkey.await {
        Some(conn) => out.push(("valkey", Arc::new(ValkeyStore::new(Arc::new(conn))))),
        None => eprintln!("note: VALKEY_URL not set or unreachable — Valkey backend skipped"),
    }
    out
}

fn scope(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("ws_cache_{tag}_{nanos}:agent")
}

#[tokio::test]
async fn an_unreported_observation_is_a_first_observation_without_a_ratio() {
    for (name, store) in stores().await {
        let scope = scope("first");
        store
            .record_session_cache_unreported(&scope, "gpt-4o")
            .await
            .unwrap();
        let session = store.session_routing(&scope).await.unwrap();
        assert_eq!(
            session.cache_warm_model.as_deref(),
            Some("gpt-4o"),
            "{name}"
        );
        assert_eq!(
            session.cache_read_bp, None,
            "{name}: unreported is not a measured cold cache"
        );
        assert!(session.cache_observed_at.is_some(), "{name}");
    }
}

#[tokio::test]
async fn an_unreported_observation_never_replaces_an_existing_one() {
    for (name, store) in stores().await {
        let scope = scope("keep");
        store
            .record_session_cache(&scope, "claude-sonnet-4-5", 9_000)
            .await
            .unwrap();
        store
            .record_session_cache_unreported(&scope, "gpt-4o")
            .await
            .unwrap();
        let session = store.session_routing(&scope).await.unwrap();
        assert_eq!(
            session.cache_warm_model.as_deref(),
            Some("claude-sonnet-4-5"),
            "{name}"
        );
        assert_eq!(session.cache_read_bp, Some(9_000), "{name}");

        // And a measurement replaces an unreported observation.
        let scope = self::scope("replace");
        store
            .record_session_cache_unreported(&scope, "gpt-4o")
            .await
            .unwrap();
        store
            .record_session_cache(&scope, "gpt-4o", 7_000)
            .await
            .unwrap();
        let session = store.session_routing(&scope).await.unwrap();
        assert_eq!(session.cache_read_bp, Some(7_000), "{name}");
    }
}
