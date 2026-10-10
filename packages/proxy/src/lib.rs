pub mod commands;
pub mod config;
/// The caller's credential, typed by where it may be sent
pub mod credential;
pub mod dlp;
pub mod graph;
pub mod injection;
/// The per-key `/auth/key-context` answer the workspace policy rides on
pub mod key_context;
pub mod manifest;
pub mod memory;
pub mod metering;
pub mod metrics;
pub mod otel_propagation;
/// The single Intutic config/state directory resolution — see this
/// module's own doc comment for the Windows path-mismatch bug it fixes.
pub mod paths;
pub mod plugins;
pub mod posture;
pub mod probes;
pub mod protocol;
pub mod proxy;
/// In-band refusals: the codes, headers and stream marker that name them
pub mod refusal;
pub mod router;
pub mod snip;
pub mod snip_code;
pub mod snip_json;
pub mod sops;
/// SSO-group tool clearance, applied by the response gate
pub mod sso_groups;
pub mod telemetry;
pub mod tool_pin;
pub mod tool_poison;
pub mod wasm;
// TLS MITM for Windsurf Cascade AI traffic interception
pub mod ca_manager;
/// L1 egress enforcement — the deny decision consulted on every CONNECT
pub mod egress_policy;
pub mod firewall;
/// L2 hosted-gateway front door — vk_-only enforcement
pub mod gateway;
/// Self-hosted gateway heartbeat client
pub mod heartbeat;
pub mod hostname_filter;
/// Local judge for self-hosted gateways
pub mod judge_local;
pub mod k8s_token_writer;
/// Local `~/.intutic/config.json` reader — cached daily-budget cap and
/// approved-models allowlist for standalone deployments (Wave 6.3,
/// audit-remediation).
pub mod local_config;
pub mod local_spend;
/// Offline model pricing — compile-time bundle + family prefix fallback (WS-5OP)
pub mod pricing;
pub mod routing;
/// Storage abstraction — Valkey-backed or in-memory (SPIKE, bandit slice only)
pub mod store;
pub mod tls_mitm;
/// Provider token-usage parsing, normalized to disjoint billing buckets
pub mod usage;

/// Test-only shared state that would otherwise be duplicated per-module.
///
/// `local_spend.rs` and `local_config.rs` both have tests that mutate the
/// process-global `HOME` env var to point at a scratch directory. A
/// module-private lock in each file cannot see the other module's lock, so
/// running both test suites in the same binary (the normal `cargo test`
/// case) races: one test's `HOME` leaks into the other's assertions. This
/// was a real, observed flake — not a hypothetical — the first time a
/// second module needed the same pattern `local_spend.rs`'s own tests
/// already used. One shared lock closes it for every module that needs it,
/// including ones added later.
#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

// Phase 7: Intelligence Engine
/// Response post-processor — appends governance notifications after LLM responses
pub mod postprocessor;
/// Request pre-processor — slash commands and prompt quality gate
pub mod quality;
/// Token intelligence — tiktoken counting, reasoning extraction, cost prediction
pub mod token;
