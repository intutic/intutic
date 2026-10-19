# intutic-proxy

> High-performance AI agent proxy with WebAssembly-based governance policies.

## Overview

intutic-proxy is a high-performance AI agent proxy written in Rust (edition 2021) that intercepts agent-to-LLM traffic and enforces governance policies through a pluggable WASM sandbox. It is the local enforcement engine for the [Intutic](https://github.com/intutic/intutic) governance control plane.

## Features

### WASM Plugin Sandbox

- **Runtime**: wasmtime 36 with pre-compiled module caching
- **Memory limit**: 16 MB per plugin invocation
- **Fuel limit**: the limit a rule is held to, deterministic on any machine: 1,000,000 instructions for a native rule, 100,000,000 for a Rego rule
- **Wall-clock backstop**: 1 s for a native rule, 2 s for a Rego rule, enforced by epoch interruption for stalls fuel cannot see; set far above the time it takes to use up the fuel on a loaded machine
- **No verdict refuses**: a rule stopped by either limit, or one that traps or returns something that is not a verdict, refuses the request with `GOVERNANCE_UNAVAILABLE`, whatever the fail setting
- **Isolation**: Each plugin runs in a dedicated WASM store

### Governance Steps

There is no plugin chain. Each step is called directly where it applies on the
request or response path:

| Step | Where | Purpose |
|------|-------|---------|
| Budget Gate | `plugins/budget_gate.rs`, called from `proxy.rs` | Refuse a request that would pass this machine's daily spend cap (standalone); workspace, key and member budgets are checked beside it in `proxy.rs` |
| DLP | `dlp::scan`, inline on the request path | Block or redact sensitive data (secrets, PII, credentials); findings reach `DlpEscalationDetector` |
| Tool authorisation | `UnauthorizedToolDetector`, `plugins/response_gate.rs` and `plugins/hook_rules.rs` | Refuse tools an SOP's `deny_tools` names, and calls a hook-rule guardrail (a `hook_rule:` SOP line) refuses by tool and argument literals, on the request and before a response's tool call reaches the client (`TOOL_DENIED`, naming `deny_tools.<tool>` or `guardrail.<id>`). A hook rule scoped to workspace roles applies by the member role the caller's key resolves to; an unknown role is held to every rule |
| Destructive SQL | `plugins/sql_guard.rs`, called from the response gate | Refuse or warn on `DROP`, `TRUNCATE` or an unqualified `DELETE` in a model-emitted shell command against a database outside the allowlist, when an SOP declares `sql_guard:` |
| Response Cache | `plugins/semantic_cache.rs` | Replay the answer to an identical request (exact match, Valkey), or to a reworded plain-text question in the same context (semantic match, TurboVec). An exchange whose prompt or answer has a DLP match is served but not cached |
| SOP injection | `sops.rs` | Resolve SOPs by role and inject their content into system prompts |
| Decision traffic | `decision_traffic.rs`, with `protocol/systemone.rs` and `protocol/decisions.rs` | Govern customer calls to decision models (`POST /v1/systemone`, `POST /v1/decisions`) like LLM calls: DLP on the state, the egress policy, and a version pin that refuses a moving model alias before the call; after it, abstentions under a floor and consequential calls are named in `x-intutic-decision-*` headers, the body unchanged. Each call is metered and written to the decision-traffic log |
| Decide rules | `decide/gateway.rs` | Ask the SOPs' `decide:` rules of the self-hosted decide engine (`~/.intutic/decide/engine.json`, `INTUTIC_DECIDE_*`): `on: tool_call` rules about each tool call in a response once the deterministic gates allowed it (`DECIDE_REFUSED`, `DECIDE_ESCALATED`), `on: response` rules about the complete response, written into it as a `VIOLATION` or `AMBIGUOUS` note. A rule enforces only under its effective rollout and a pin for the engine's model digest; otherwise it runs as shadow |
| Rule records | `plugins/response_gate.rs`, `plugins/anomaly/detectors.rs` | Withhold a tool call a qualified `requires_before:` (`action:run_tests[ok] -> …`) gates while its prerequisite is unmet (`PREREQUISITE_UNMET`), and a file-changing call outside `scope_paths` under `scope_paths_mode: enforce` (`OUT_OF_SCOPE`); re-ask a turn whose tool calls leave the declared plan under `plan_steps_mode: enforce` |
| Reversibility lanes | `sops.rs`, `key_context.rs`, `proxy.rs` | Hold for review the actions in a lane an SOP's `closed_lanes:` (or the workspace's `closedLanes`) closes, as a `review_before:` action is held; under the workspace's `revertLane` setting, hold (`enforce`) or record as a shadowed hold (`shadow`) a reversible-wide action whose revert or rejection rate for the role is over the threshold. Workspace settings come from the control plane's key context |
| Node kinds | `node_kind.rs`, `plugins/anomaly/graph_detectors.rs` | Hold each agent-graph node to its kind (`node_kind:` SOP key, `x-intutic-node-kind` header): a `code` node may not call a model, a `gate` node may not write files, run shell commands or start a child agent, and a `worker` node may not start a child agent (`NODE_KIND_DENIED`). A header can only add limits |
| Context isolation | `plugins/anomaly/graph_detectors.rs` | Flag sibling workers handed nearly the same context; advisory by default, re-asks under `context_isolation: enforce` |

### Model Selection

- **Thompson Sampling bandit**: selects a model per task cell from observed
  **availability, latency, cost and response integrity**.

  `RewardSignals` (`src/routing/reward.rs:32`) carries `upstream_ok`,
  `latency_ms`, `token_anomaly`, `raw_cost_usd`, `actual_cost_usd` and
  `response_integrity`. The cost term is two-sided: a cheaper route earns more
  than an equal-cost one (`cheaper_routed_model_earns_a_bonus`), and a costlier
  one less. `response_integrity` is the only signal about the answer itself: it
  catches malformed, truncated and unusable responses, and a faulted response
  loses more than any price advantage can return
  (`quality_fault_outweighs_any_price_advantage`). It does **not** catch a
  wrong but well-formed answer.

  So the router optimises for responding *usably* and *cheaply*, not for
  responding *well*. Do not describe it as preserving quality until there is a
  measurement behind the word.

### Network Enforcement

- **TLS MITM**: Selective interception on `CONNECT` tunnels, for Windsurf and other harnesses that use the proxy as an HTTPS proxy: AI-provider hosts (plus `INTUTIC_EXTRA_AI_HOSTS`) are terminated and governed, every other host is tunnelled uninspected
- **OS-level firewall rules**: Generates platform-native default-deny egress rules, so traffic leaves the machine only through the proxy (`intutic-proxy enforce`, `intutic enforce`)
  - macOS: `pf` (Packet Filter) anchor
  - Linux: `nftables`, or `iptables` when `nft` is absent
  - Windows: not implemented (`generate` says so, `apply` refuses)

### Security & Observability

- **DLP scanner**: Prefix-anchored secret patterns (no entropy-based matching), plus validated PII detectors for payment cards (Luhn), IBANs (mod 97) and US Social Security numbers (issued ranges), on by default, and email addresses and phone numbers, off by default. `intutic_settings.dlp.detectors` in this machine's config sets each detector's action, and a connected workspace's `piiDetectors` setting sets a baseline the local config may only make stricter. What the proxy keeps (replay contexts, change-manifest targets) is redacted for every detector, email and phone included, whatever the live action (`stored_action` in `src/dlp/pii_detectors.json`). See [PII detectors](https://docs.intutic.ai/guide/policies#pii-detectors)
- **Code skeleton extraction**: Uses `tree-sitter` and `syn` for AST-level code analysis
- **Token counting**: Accurate pre-flight token estimation via `tiktoken-rs`
- **Telemetry**: OpenTelemetry OTLP export for traces and metrics, on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set — a `SpanExporter` and `SdkMeterProvider` ship in `src/main.rs`, with the exported instrument set declared in `src/metrics.rs` (snip compaction histograms, egress counters, policy refusals, upstream retries and fallbacks). No logs pipeline

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

On npm, `@intutic/proxy` ships no binary: its launcher (`bin/proxy.js`) downloads this version's release asset for the platform on first run, verifies it against the release's `checksums.json`, and caches it in `~/.intutic/bin`.

## Part of Intutic

This package is part of the [Intutic](https://github.com/intutic/intutic) monorepo — an open-core AI governance control plane for developer teams.

## License

MIT — see [LICENSE](../../LICENSE) for details.
