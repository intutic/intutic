//! The raw break-glass token must never reach a log line.
//!
//! Both the success and failure paths used to interpolate `token = %bg_token`
//! directly into a `tracing` event — the live credential, in the clear, in
//! whatever log sink the deployment ships to. A leaked log line was then as
//! good as the token itself for the rest of its TTL.
//!
//! Source-text assertion, same caveat as `shadow_reports_reach_the_trace.rs`:
//! it pins the specific defect (`%bg_token` as a tracing field value) rather
//! than proving no log path anywhere can leak it.

const PROXY_RS: &str = include_str!("../src/proxy.rs");

#[test]
fn the_raw_token_variable_is_never_interpolated_into_a_log_line() {
    assert!(
        !PROXY_RS.contains("%bg_token"),
        "bg_token (the raw override token) must never appear as a tracing field value — \
         hash it first (see sha256_hex in store/valkey.rs)"
    );
    assert!(
        !PROXY_RS.contains("token = %bg_token"),
        "the break-glass log lines must not log the raw token"
    );
}

#[test]
fn the_break_glass_denial_log_carries_only_a_truncated_hash() {
    let marker = "Expired, invalid, unscoped, or unreachable break-glass token header provided";
    let at = PROXY_RS
        .find(marker)
        .expect("break-glass denial log message vanished from proxy.rs");
    // The tracing::warn! call starts a few lines above its message literal.
    let block_start = PROXY_RS[..at].rfind("tracing::warn!").expect("no tracing::warn! before the denial message");
    let block = &PROXY_RS[block_start..at];
    assert!(
        block.contains("token_hash"),
        "the denial log must carry a hash of the failed token for correlation, not silence"
    );
    assert!(
        !block.contains("%bg_token"),
        "the denial log must not carry the raw token"
    );
}
