# intutic-proxy

> High-performance AI agent proxy with WebAssembly-based governance policies.

## Overview

intutic-proxy is a high-performance AI agent proxy written in Rust (edition 2021) that intercepts agent-to-LLM traffic and enforces governance policies through a pluggable WASM sandbox. It is the local enforcement engine for the [Intutic](https://github.com/intutic/intutic) governance control plane.

## Features

### WASM Plugin Sandbox

- **Runtime**: wasmtime v21 with pre-compiled module caching
- **Memory limit**: 1 MB per plugin invocation
- **Execution timeout**: 5 ms hard wall-clock cutoff
- **Isolation**: Each plugin runs in a dedicated WASM store

### Plugin Chain

The proxy processes every request through an ordered plugin chain:

| Plugin | Purpose |
|--------|---------|
| Budget Gate | Enforce per-ticket and per-team token budgets |
| DLP Gate | Block or redact sensitive data (secrets, PII, credentials) |
| PCAS Gate | Prior Consent and Autonomy Scope enforcement |
| Semantic Cache | Deduplicate semantically similar prompts via Valkey |
| SOP Prompt Injector | Inject workspace governance SOPs into system prompts |

### Model Selection

- **Thompson Sampling bandit**: Selects the optimal model per-task based on historical cost, latency, and quality signals

### Network Enforcement

- **TLS MITM**: Transparent interception for Windsurf and other harnesses
- **OS-level firewall rules**: Generates platform-native rules to redirect agent traffic through the proxy
  - macOS: `pf` (Packet Filter)
  - Linux: `iptables` / `nftables`
  - Windows: `netsh`

### Security & Observability

- **DLP scanner**: Pattern-based and entropy-based secret detection
- **Code skeleton extraction**: Uses `tree-sitter` and `syn` for AST-level code analysis
- **Token counting**: Accurate pre-flight token estimation via `tiktoken-rs`
- **Telemetry**: OpenTelemetry OTLP export for traces, metrics, and logs

## Dependencies

| Crate | Purpose |
|-------|---------|
| `axum` | HTTP server framework |
| `wasmtime` | WASM runtime |
| `reqwest` | Upstream LLM HTTP client |
| `redis` | Valkey / Redis connection |
| `tree-sitter` | Source code parsing |
| `tiktoken-rs` | Token counting |
| `rcgen` | TLS certificate generation |

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Run benchmarks
cargo bench
```

## Binary

The crate produces a single binary:

```
intutic-proxy
```

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
