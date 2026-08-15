# OpenTelemetry <Badge type="tip" text="Open-Core" />

Export distributed traces from Intutic's own components to your OpenTelemetry collector.

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

## Trace-context propagation

Every component that receives a `traceparent` header (W3C Trace Context) on an inbound request propagates it correctly to its own outbound calls and emitted spans — this is what lets a single trace span the harness, the proxy, and the control plane.

The `intutic connect` CLI daemon is a special case: it's software every open-core user installs locally, so it does not pull in the full auto-instrumentation package (that would meaningfully bloat install size and startup time for the vast majority who never configure a collector). Instead it does propagation only — if the CLI process itself was launched with an active trace context (a `TRACEPARENT` environment variable set by an already-instrumented parent process), it carries that context onto every request it makes to the control plane. It does not create its own spans.

## Log correlation

`@intutic/logger` (the shared pino wrapper used by every TypeScript component) automatically injects `trace_id` and `span_id` into every log line when an active span exists, so logs and traces can be correlated in your observability backend without any extra configuration.

## What's not covered yet

Metrics export is not currently packaged — everything above is traces only. `services/sync-daemon` as a library has no process of its own to instrument (see the CLI propagation note above); `packages/mcp-proxy`'s stdio JSON-RPC proxy (`intutic-mcp-proxy`, as opposed to the daemon) is deliberately not instrumented with auto-instrumentation, since that process reserves stdout exclusively for protocol frames and any library that patches console/process behavior is a real risk on that channel.
