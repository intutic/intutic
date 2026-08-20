//! Integration tests for session-scoped SOP advisory pinning (TD-348).
//!
//! `sops::resolve_injection_block` is what keeps the injected governance
//! block's bytes stable across a session's requests — even when the
//! underlying SOP set would render differently mid-session — so the
//! provider-side KV-cache prefix `routing::bandit::route_model`'s session
//! lock protects for the model choice isn't undermined by the SOP text
//! moving underneath it.
//!
//! Like `reward_test.rs`, these run over *both* `LocalStore` implementations:
//! `MemoryStore` always, `ValkeyStore` additionally when `VALKEY_URL` is set.
//! No `#[ignore]` anywhere in this file — the skip is a runtime check, so
//! `cargo test --package intutic-proxy` stays green without Valkey installed.

use intutic_proxy::sops::resolve_injection_block;
use intutic_proxy::store::{
    ControlPlaneCache, LocalStore, MemoryStore, NullControlPlaneCache, PinScope, PinnedSopBlock,
    ValkeyControlPlaneCache, ValkeyStore,
};
use redis::AsyncCommands;
use std::sync::Arc;
use std::time::Duration;

type Backend = (&'static str, Arc<dyn LocalStore>, Arc<dyn ControlPlaneCache>);

async fn valkey_conn() -> Option<Arc<redis::aio::ConnectionManager>> {
    let url = std::env::var("VALKEY_URL").ok()?;
    let client = redis::Client::open(url).ok()?;
    let mgr = redis::aio::ConnectionManager::new(client).await.ok()?;
    Some(Arc::new(mgr))
}

/// Every backend under test. Memory always; Valkey when reachable.
async fn backends() -> Vec<Backend> {
    let mut out: Vec<Backend> = vec![(
        "memory",
        Arc::new(MemoryStore::new()),
        Arc::new(NullControlPlaneCache),
    )];
    if let Some(conn) = valkey_conn().await {
        out.push((
            "valkey",
            Arc::new(ValkeyStore::new(conn.clone())),
            Arc::new(ValkeyControlPlaneCache::new(conn)),
        ));
    } else {
        eprintln!("note: VALKEY_URL not set or unreachable — Valkey backend skipped");
    }
    out
}

/// Unique tag per test run so parallel/repeated runs against a shared Valkey
/// never collide — same rationale as `reward_test.rs`'s `unique_ws`.
fn unique_tag(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("test-sop-pin-{}-{}", tag, nanos)
}

/// Valkey-only cleanup for a scope's pin key; `MemoryStore` drops with the
/// test. Reconstructs the key with `PinScope::storage_key`'s own formula
/// rather than a hardcoded string, so this cannot drift from what the store
/// impls actually write.
async fn cleanup(scope: &PinScope) {
    let Some(valkey) = valkey_conn().await else {
        return;
    };
    let mut conn = valkey.as_ref().clone();
    let _: Result<(), _> = conn.del(format!("v2:sopblock:{}", scope.storage_key())).await;
}

fn pinned(block: &str, fingerprint: &str) -> PinnedSopBlock {
    PinnedSopBlock {
        block: block.to_string(),
        fingerprint: fingerprint.to_string(),
        pinned_at: chrono::Utc::now().timestamp(),
    }
}

/// 1. A pin outlives an SOP-set change within its TTL, and re-pins once the
///    TTL elapses.
#[tokio::test]
async fn a_pin_survives_a_changed_render_within_its_ttl_and_refreshes_after_it_expires() {
    for (name, store, _cp) in backends().await {
        let scope = PinScope::new(&unique_tag("ttl"), "deployer");
        let short_ttl = 1u64; // seconds — sleep past it rather than manipulating the clock.

        // First request in the window: nothing pinned yet, so the fresh
        // render becomes the pin.
        let first = resolve_injection_block(
            store.as_ref(),
            &scope,
            Some("BLOCK_V1".to_string()),
            "fp1",
            short_ttl,
        )
        .await;
        assert_eq!(first, Some("BLOCK_V1".to_string()), "[{name}] first request pins its own render");

        // Simulate the underlying SOP set changing mid-session (a SOP
        // edited, a tier flipped) — a fresh render now produces different
        // bytes. Still within the TTL, resolution must keep serving the
        // ORIGINAL pinned bytes, not the new render.
        let still_pinned = resolve_injection_block(
            store.as_ref(),
            &scope,
            Some("BLOCK_V2_DIFFERENT".to_string()),
            "fp2",
            short_ttl,
        )
        .await;
        assert_eq!(
            still_pinned,
            Some("BLOCK_V1".to_string()),
            "[{name}] a changed render must not disturb an unexpired pin"
        );

        // Past the TTL: the pin has lapsed, so the (now-current) fresh
        // render is served and becomes the new pin.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let refreshed = resolve_injection_block(
            store.as_ref(),
            &scope,
            Some("BLOCK_V2_DIFFERENT".to_string()),
            "fp2",
            short_ttl,
        )
        .await;
        assert_eq!(
            refreshed,
            Some("BLOCK_V2_DIFFERENT".to_string()),
            "[{name}] an expired pin must fall back to a fresh render"
        );

        // And that fresh render re-pinned: a third, differently-worded
        // render offered immediately after must NOT win.
        let re_pinned = resolve_injection_block(
            store.as_ref(),
            &scope,
            Some("BLOCK_V3_SHOULD_NOT_WIN".to_string()),
            "fp3",
            short_ttl,
        )
        .await;
        assert_eq!(
            re_pinned,
            Some("BLOCK_V2_DIFFERENT".to_string()),
            "[{name}] the refreshed render must itself have been pinned"
        );

        cleanup(&scope).await;
    }
}

/// 2. The anti-leakage test neither `tool_history_scope` nor
///    `judge_session_scope` had before their two prior cross-tenant defects
///    were found — two different (workspace, role) combinations that share
///    the exact same degenerate, session-derived agent label ("anonymous",
///    `tool_history_scope`'s real fallback for unidentified traffic) must
///    still land on two completely distinct pins. If this test used a scope
///    keyed on the bare session id alone, it would pass by accident; keying
///    through `{workspace_id}:{agent}` (as `tool_history_scope` already
///    resolves it) is what makes it actually catch cross-tenant bleed.
#[tokio::test]
async fn distinct_workspace_role_combinations_never_share_a_pin_despite_a_shared_degenerate_agent_label(
) {
    for (name, store, _cp) in backends().await {
        let ws_a = unique_tag("ws-alpha");
        let ws_b = unique_tag("ws-beta");

        // Both workspaces' traffic is anonymous — the exact same
        // session-derived label `tool_history_scope` falls back to when no
        // session id, loop run id, or member id is available.
        let scope_a = PinScope::new(&format!("{ws_a}:anonymous"), "deployer");
        let scope_b = PinScope::new(&format!("{ws_b}:anonymous"), "deployer");
        // A third scope: same workspace as A, but a different role — proves
        // the role half of the key is load-bearing too, not just workspace.
        let scope_a_other_role = PinScope::new(&format!("{ws_a}:anonymous"), "reviewer");

        let a = resolve_injection_block(store.as_ref(), &scope_a, Some("ALPHA_BLOCK".into()), "fp_a", 600)
            .await;
        let b = resolve_injection_block(store.as_ref(), &scope_b, Some("BETA_BLOCK".into()), "fp_b", 600)
            .await;
        let a_other_role = resolve_injection_block(
            store.as_ref(),
            &scope_a_other_role,
            Some("ALPHA_REVIEWER_BLOCK".into()),
            "fp_a2",
            600,
        )
        .await;

        assert_eq!(a, Some("ALPHA_BLOCK".to_string()), "[{name}]");
        assert_eq!(
            b,
            Some("BETA_BLOCK".to_string()),
            "[{name}] workspace B must not see workspace A's pin despite the identical \
             degenerate agent label"
        );
        assert_eq!(
            a_other_role,
            Some("ALPHA_REVIEWER_BLOCK".to_string()),
            "[{name}] a different role within the SAME workspace/agent must also get its own pin"
        );

        // Re-resolving each scope with a would-be-different render must
        // still return its OWN pinned bytes, not another scope's — proof
        // the pins are genuinely distinct storage entries, not the same one
        // read three times by coincidence of test ordering.
        let a_again =
            resolve_injection_block(store.as_ref(), &scope_a, Some("SHOULD_NOT_WIN".into()), "x", 600)
                .await;
        assert_eq!(a_again, Some("ALPHA_BLOCK".to_string()), "[{name}]");

        cleanup(&scope_a).await;
        cleanup(&scope_b).await;
        cleanup(&scope_a_other_role).await;
    }
}

/// 3. `max_age_secs = 0` is the kill switch: behaviour must be identical to
///    no pinning at all, always serving whatever was just rendered.
#[tokio::test]
async fn zero_max_age_disables_pinning_entirely() {
    for (name, store, _cp) in backends().await {
        let scope = PinScope::new(&unique_tag("killswitch"), "deployer");

        let first =
            resolve_injection_block(store.as_ref(), &scope, Some("BLOCK_A".into()), "fp_a", 0).await;
        assert_eq!(first, Some("BLOCK_A".to_string()), "[{name}]");

        // If pinning were active, this would still return "BLOCK_A". With
        // max_age_secs=0 it must reflect the fresh render every time.
        let second =
            resolve_injection_block(store.as_ref(), &scope, Some("BLOCK_B".into()), "fp_b", 0).await;
        assert_eq!(
            second,
            Some("BLOCK_B".to_string()),
            "[{name}] max_age_secs=0 must always return the fresh render, never a pin"
        );

        let third = resolve_injection_block(store.as_ref(), &scope, None, "fp_c", 0).await;
        assert_eq!(
            third, None,
            "[{name}] max_age_secs=0 must pass a None render straight through too"
        );

        // Confirm no pin was ever actually written under this scope.
        assert!(
            store.pinned_sop_block(&scope).await.is_none(),
            "[{name}] the kill switch must never write a pin"
        );

        cleanup(&scope).await;
    }
}

/// 4. Two concurrent "first" pin attempts for the same scope converge on one
///    winner's bytes. Meaningful mainly for the Valkey backend (its `SET NX
///    ... GET` semantics are what actually arbitrate a real race); trivially
///    true for `MemoryStore` too since its mutex serialises every writer, but
///    running the same assertion over both backends is what the standing
///    dual-backend convention asks for, and it costs nothing extra.
#[tokio::test]
async fn concurrent_first_pins_for_the_same_scope_converge_on_one_winner() {
    for (name, store, _cp) in backends().await {
        let scope = Arc::new(PinScope::new(&unique_tag("race"), "deployer"));

        let mut handles = Vec::new();
        for i in 0..8u32 {
            let store = store.clone();
            let scope = scope.clone();
            handles.push(tokio::spawn(async move {
                resolve_injection_block(
                    store.as_ref(),
                    &scope,
                    Some(format!("RACER_{i}_BLOCK")),
                    &format!("fp_{i}"),
                    600,
                )
                .await
            }));
        }

        let mut results = Vec::new();
        for h in handles {
            results.push(h.await.expect("task must not panic"));
        }

        let winner = results[0].clone();
        assert!(winner.is_some(), "[{name}] a race among first-pins must still produce a block");
        for (i, r) in results.iter().enumerate() {
            assert_eq!(
                r, &winner,
                "[{name}] racer {i} disagreed with the converged winner — every concurrent \
                 first-pin attempt must return the SAME bytes"
            );
        }

        // And the store itself agrees with what every racer was handed back.
        let stored = store.pinned_sop_block(&scope).await;
        assert_eq!(
            stored.map(|p| p.block),
            winner,
            "[{name}] the persisted pin must match what every racer converged on"
        );

        cleanup(&scope).await;
    }
}

/// Sanity check on `pin_sop_block`'s NX contract directly (not through
/// `resolve_injection_block`): a losing writer gets the WINNER's block back,
/// not its own, and a second call after the first pin is a true no-op on the
/// stored value.
#[tokio::test]
async fn pin_sop_block_nx_contract_returns_the_winner_not_the_caller() {
    for (name, store, _cp) in backends().await {
        let scope = PinScope::new(&unique_tag("nx"), "deployer");

        let first_write = store.pin_sop_block(&scope, &pinned("FIRST", "fp1"), 600).await;
        assert_eq!(first_write.block, "FIRST", "[{name}] the first writer wins its own value");

        let second_write = store.pin_sop_block(&scope, &pinned("SECOND", "fp2"), 600).await;
        assert_eq!(
            second_write.block, "FIRST",
            "[{name}] a second write against an already-pinned scope must return the \
             EXISTING winner, not its own value"
        );

        let read_back = store.pinned_sop_block(&scope).await;
        assert_eq!(
            read_back.map(|p| p.block),
            Some("FIRST".to_string()),
            "[{name}] the stored value must still be the first writer's"
        );

        cleanup(&scope).await;
    }
}
