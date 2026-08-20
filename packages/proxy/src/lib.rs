pub mod commands;
pub mod config;
pub mod dlp;
pub mod manifest;
pub mod memory;
pub mod posture;
pub mod graph;
pub mod injection;
pub mod metering;
pub mod metrics;
pub mod otel_propagation;
pub mod plugins;
pub mod protocol;
pub mod probes;
pub mod proxy;
pub mod router;
pub mod snip;
pub mod sops;
pub mod snip_code;
pub mod snip_json;
pub mod telemetry;
pub mod tool_pin;
pub mod tool_poison;
pub mod wasm;
// TLS MITM for Windsurf Cascade AI traffic interception
pub mod ca_manager;
pub mod hostname_filter;
/// Offline model pricing — compile-time bundle + family prefix fallback (WS-5OP)
pub mod pricing;
pub mod routing;
/// Provider token-usage parsing, normalized to disjoint billing buckets (TD-347)
pub mod usage;
/// Storage abstraction — Valkey-backed or in-memory (SPIKE, bandit slice only)
pub mod store;
pub mod tls_mitm;
/// L1 egress enforcement — the deny decision consulted on every CONNECT (LLD #63)
pub mod egress_policy;
pub mod firewall;
/// L2 hosted-gateway front door — vk_-only enforcement (LLD #64)
pub mod gateway;
/// Self-hosted gateway heartbeat client (LLD #66, gateway phase 4)
pub mod heartbeat;
pub mod k8s_token_writer;
/// Local judge for self-hosted gateways (LLD #68 §2 phase 2)
pub mod judge_local;
pub mod local_spend;

// Phase 7: Intelligence Engine (LLDs #45, #47, #49)
/// Response post-processor — appends governance notifications after LLM responses (LLD #45)
pub mod postprocessor;
/// Request pre-processor — slash commands and prompt quality gate (LLD #49)
pub mod quality;
/// Token intelligence — tiktoken counting, reasoning extraction, cost prediction (LLD #47)
pub mod token;
