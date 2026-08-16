# OpenTelemetry <Badge type="tip" text="Open-Core" />

Export distributed traces and metrics from Intutic's own components to your OpenTelemetry collector.

---

## Overview

Every long-running Intutic process — the Rust proxy, the control plane, the self-hosted gateway daemon, and the MCP daemon — can export OTLP traces. All of it is **opt-in and off by default**: nothing initializes unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a deployment that hasn't configured a collector pays no cost.

| Component | Protocol | Default endpoint | Scope |
|---|---|---|---|
| Proxy (`packages/proxy`) | OTLP/gRPC | `http://127.0.0.1:4317` | Open-Core |
| Control plane | OTLP/HTTP | `http://localhost:4318/v1/traces` | Enterprise |
| Self-hosted gateway daemon | OTLP/HTTP | `http://localhost:4318/v1/traces` | Open-Core |
| MCP daemon (`intutic-mcp-daemon`) | OTLP/HTTP | `http://localhost:4318/v1/traces` | Open-Core |

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector's URL and `OTEL_SERVICE_NAME` to override the reported service name (each component defaults to its own name — `control-plane`, `gateway-daemon`, `mcp-daemon`).

## What's instrumented

The Node-based components (control plane, gateway daemon, MCP daemon) use the standard `@opentelemetry/auto-instrumentations-node` package, which covers HTTP, Postgres, and Valkey/Redis calls automatically — filesystem instrumentation is disabled everywhere, since it's noisy and rarely useful for these workloads.

The Rust proxy uses `tracing` + `tracing-opentelemetry`, with `AlwaysOn` sampling and a batch exporter.

## Metrics

Metrics ship over the same endpoint and the same opt-in gate as traces — OTLP push, nothing initializes without `OTEL_EXPORTER_OTLP_ENDPOINT`, and there is deliberately no `/metrics` pull endpoint on any component.

The proxy exports a small, deliberate instrument set (`packages/proxy/src/metrics.rs` — every exported name lives in that one file, next to the test that pins its Prometheus exposition name):

| Instrument | Kind | Labels | What it measures |
|---|---|---|---|
| `snip_compression_ratio` | histogram | `input_type`, `strategy` | Context-compaction effectiveness per event |
| `snip_input_bytes` / `snip_output_bytes` | histograms | `input_type`, `strategy` | Compaction sizes before/after |
| `snip_compacted` | counter | `input_type`, `strategy` | Compaction event count |
| `egress_denied` / `egress_would_deny` | observable counters | — | Egress policy denials (enforcing and shadow) |
| `policy_refusals` | counter | `source` ∈ anomaly\|wasm, `action` ∈ kill\|ask\|reask\|reask_exhausted | Requests governance actually refused |

No instrument carries a `workspace_id` or per-detector label — per-workspace accounting is the control plane's job, and unbounded label values are how a metrics pipeline becomes the outage. The Node components export the auto-instrumentation metric set (HTTP/Postgres/Valkey durations and the like); they register no custom instruments.

## Trace-context propagation

Every component that receives a `traceparent` header (W3C Trace Context) on an inbound request propagates it correctly to its own outbound calls and emitted spans — this is what lets a single trace span the harness, the proxy, and the control plane.

The `intutic connect` CLI daemon is a special case: it's software every open-core user installs locally, so it does not pull in the full auto-instrumentation package (that would meaningfully bloat install size and startup time for the vast majority who never configure a collector). Instead it does propagation only — if the CLI process itself was launched with an active trace context (a `TRACEPARENT` environment variable set by an already-instrumented parent process), it carries that context onto every request it makes to the control plane. It does not create its own spans.

## Log correlation

`@intutic/logger` (the shared pino wrapper used by every TypeScript component) automatically injects `trace_id` and `span_id` into every log line when an active span exists, so logs and traces can be correlated in your observability backend without any extra configuration.

## What's not covered yet

A logs pipeline is not packaged — traces and metrics only; log/trace correlation happens via the `@intutic/logger` trace-ID mixin described above rather than OTLP log export. `services/sync-daemon` as a library has no process of its own to instrument (see the CLI propagation note above); `packages/mcp-proxy`'s stdio JSON-RPC proxy (`intutic-mcp-proxy`, as opposed to the daemon) is deliberately not instrumented with auto-instrumentation, since that process reserves stdout exclusively for protocol frames and any library that patches console/process behavior is a real risk on that channel.
