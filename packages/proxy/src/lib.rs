pub mod config;
pub mod dlp;
pub mod metering;
pub mod plugins;
pub mod protocol;
pub mod proxy;
pub mod router;
pub mod snip;
pub mod snip_code;
pub mod snip_json;
pub mod telemetry;
pub mod wasm;
// TLS MITM for Windsurf Cascade AI traffic interception
pub mod ca_manager;
pub mod hostname_filter;
/// Offline model pricing — compile-time bundle + family prefix fallback (WS-5OP)
pub mod pricing;
pub mod routing;
pub mod tls_mitm;
// WS-6NC: Network Controls + MDM Agent
pub mod dns_interceptor;
pub mod firewall;
pub mod local_spend;
pub mod mdm_agent;

// Phase 7: Intelligence Engine (LLDs #45, #47, #49)
/// Response post-processor — appends governance notifications after LLM responses (LLD #45)
pub mod postprocessor;
/// Request pre-processor — slash commands and prompt quality gate (LLD #49)
pub mod quality;
/// Token intelligence — tiktoken counting, reasoning extraction, cost prediction (LLD #47)
pub mod token;
