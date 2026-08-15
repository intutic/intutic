/**
 * OpenTelemetry trace-context propagation for outbound CLI HTTP calls.
 *
 * Deliberately lighter than the NodeSDK instrumentation used by
 * control-plane/gateway-daemon/mcp-daemon: `intutic connect` is a daemon
 * every open-core user installs, and the auto-instrumentations-node
 * meta-package is heavy (dozens of instrumented libraries the CLI doesn't
 * use) for a benefit only the minority who run a collector would see.
 *
 * This does the propagation half only -- the same class of fix as
 * packages/proxy/src/otel_propagation.rs's `install_default_propagator`:
 * register the W3C Trace Context propagator globally, and if this process
 * was itself launched with an active trace context (a parent process sets
 * TRACEPARENT/TRACESTATE -- the standard way an already-instrumented
 * pipeline hands context to a child process), carry it forward onto every
 * outbound request to the control plane. No local spans are created here.
 *
 * @module
 */

import { propagation, context, type Context } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

propagation.setGlobalPropagator(new W3CTraceContextPropagator())

/** The active context for this process, seeded once from TRACEPARENT/TRACESTATE env vars if present. */
const processContext: Context = propagation.extract(context.active(), process.env, {
  get: (carrier, key) => carrier[key.toUpperCase()] ?? carrier[key],
  keys: (carrier) => Object.keys(carrier),
})

/**
 * Mutates `headers` in place, adding `traceparent`/`tracestate` if this
 * process has an active trace context to propagate. A no-op (adds nothing)
 * when the CLI was launched standalone, which is the common case.
 */
export function injectTraceHeaders(headers: Record<string, string>): void {
  propagation.inject(processContext, headers, {
    set: (carrier, key, value) => {
      carrier[key] = value
    },
  })
}
