//! Key rate limits and spend-counter reads against the stores, Valkey
//! included: what every proxy replica sharing one Valkey relies on.
//!
//! `MemoryStore` always, `ValkeyStore` additionally when `VALKEY_URL` is set
//! (a runtime skip, not `#[ignore]`, as in `sop_pin_test.rs`).

use std::sync::Arc;

use intutic_proxy::key_limits::{RateDecision, RateLimit, RateLimitKind};
use intutic_proxy::store::{
    ControlPlaneCache, LocalStore, MemoryStore, ValkeyControlPlaneCache, ValkeyStore,
};

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

fn unique(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("key_test_{tag}_{nanos}")
}

/// One store per proxy replica: separate connections to the same Valkey.
async fn replicas() -> Vec<(&'static str, Vec<Arc<dyn LocalStore>>)> {
    let memory: Arc<dyn LocalStore> = Arc::new(MemoryStore::new());
    let mut out = vec![("memory", vec![memory])];
    match (valkey_conn().await, valkey_conn().await) {
        (Some(a), Some(b)) => out.push((
            "valkey",
            vec![
                Arc::new(ValkeyStore::new(a)) as Arc<dyn LocalStore>,
                Arc::new(ValkeyStore::new(b)) as Arc<dyn LocalStore>,
            ],
        )),
        _ => eprintln!("note: VALKEY_URL not set or unreachable — Valkey backend skipped"),
    }
    out
}

#[tokio::test]
async fn replicas_racing_for_a_minute_admit_exactly_the_limit() {
    for (name, stores) in replicas().await {
        let key_id = unique("rpm");
        let limit = RateLimit {
            rpm: Some(10),
            tpm: None,
        };
        let minute = 29_000_000;
        let mut tasks = Vec::new();
        for i in 0..40 {
            let store = Arc::clone(&stores[i % stores.len()]);
            let key_id = key_id.clone();
            tasks.push(tokio::spawn(async move {
                store.admit_rate(&key_id, limit, minute).await
            }));
        }
        let mut admitted = 0;
        let mut limited = 0;
        for t in tasks {
            match t.await.unwrap() {
                RateDecision::Admitted => admitted += 1,
                RateDecision::Limited {
                    kind: RateLimitKind::Requests,
                    limit: 10,
                    used,
                } => {
                    assert_eq!(used, 10, "{name}: a refusal reports the minute's count");
                    limited += 1;
                }
                other => panic!("{name}: unexpected {other:?}"),
            }
        }
        assert_eq!((admitted, limited), (10, 30), "{name}");

        // The next minute starts from zero.
        assert_eq!(
            stores[0].admit_rate(&key_id, limit, minute + 1).await,
            RateDecision::Admitted,
            "{name}"
        );
    }
}

#[tokio::test]
async fn tokens_recorded_in_a_minute_refuse_the_next_request_until_it_ends() {
    for (name, stores) in replicas().await {
        let key_id = unique("tpm");
        let limit = RateLimit {
            rpm: Some(100),
            tpm: Some(1_000),
        };
        let minute = 29_000_100;
        let (a, b) = (&stores[0], stores.last().unwrap());
        assert_eq!(
            a.admit_rate(&key_id, limit, minute).await,
            RateDecision::Admitted
        );
        // A completed call's tokens, recorded by another replica.
        b.add_rate_tokens(&key_id, 600, minute).await;
        assert_eq!(
            a.admit_rate(&key_id, limit, minute).await,
            RateDecision::Admitted
        );
        b.add_rate_tokens(&key_id, 600, minute).await;
        assert_eq!(
            a.admit_rate(&key_id, limit, minute).await,
            RateDecision::Limited {
                kind: RateLimitKind::Tokens,
                limit: 1_000,
                used: 1_200
            },
            "{name}"
        );
        // A refusal for tokens counts no request: the RPM count is still 2.
        let rpm_only = RateLimit {
            rpm: Some(3),
            tpm: None,
        };
        assert_eq!(
            a.admit_rate(&key_id, rpm_only, minute).await,
            RateDecision::Admitted,
            "{name}"
        );
        assert!(matches!(
            a.admit_rate(&key_id, rpm_only, minute).await,
            RateDecision::Limited {
                kind: RateLimitKind::Requests,
                ..
            }
        ));
        assert_eq!(
            a.admit_rate(&key_id, limit, minute + 1).await,
            RateDecision::Admitted,
            "{name}: a new minute"
        );
    }
}

#[tokio::test]
async fn spend_counters_read_in_order_and_an_unwritten_one_is_zero() {
    let Some(conn) = valkey_conn().await else {
        eprintln!("note: VALKEY_URL not set or unreachable — skipped");
        return;
    };
    let cache = ValkeyControlPlaneCache::new(Arc::clone(&conn));
    let written = format!("v2:budget:{}:daily", unique("ws"));
    let unwritten = format!("v2:budget:{}:monthly", unique("ws"));
    let mut c = conn.as_ref().clone();
    let _: () = redis::cmd("SET")
        .arg(&written)
        .arg("12.5")
        .arg("EX")
        .arg(60)
        .query_async(&mut c)
        .await
        .unwrap();
    assert_eq!(
        cache
            .spend_counters(&[unwritten.clone(), written.clone()])
            .await,
        Some(vec![0.0, 12.5])
    );
    assert_eq!(cache.spend_counters(&[]).await, Some(vec![]));
}
