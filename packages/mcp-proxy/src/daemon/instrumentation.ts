/**
 * OpenTelemetry Code-Level Instrumentation — mcp-daemon only.
 *
 * Same pattern as the control plane.
 * Deliberately NOT imported
 * by src/index.ts (the `intutic-mcp-proxy` stdio JSON-RPC proxy) -- that
 * process reserves stdout exclusively for protocol frames, and
 * auto-instrumentations-node's console/process patching is not a risk worth
 * taking on that channel. This file only instruments `intutic-mcp-daemon`
 * (daemon/index.ts), the long-lived companion process that already owns its
 * own telemetryBatcher.ts and talks to the control plane over a Unix socket,
 * not stdio.
 *
 * Opt-in only -- off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Must be imported at the very top of daemon/index.ts, before other
 * modules, to allow monkey-patching.
 */

import { metrics } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { createLogger } from '@intutic/logger'

const log = createLogger('instrumentation')

// The env var may name either the collector base or the full traces path;
// derive the base once so traces and metrics land on their own signal paths.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

if (endpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'mcp-daemon'
  const base = endpoint.replace(/\/v1\/traces$/, '')
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })

  // Not `NodeSDK` or `auto-instrumentations-node`: both depend on every exporter
  // including gRPC, which puts protobufjs and its install script on every
  // `npm install -g @intutic/cli`, for a feature that is off by default.
  // shortcut: sdk-trace-base and sdk-trace-node are deprecated for sdk-trace 3,
  // which needs Node >= 22.15; move to it when the CLI's engines drop Node 20.
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces` }))],
  })
  tracerProvider.register()
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }) })],
  })
  metrics.setGlobalMeterProvider(meterProvider)
  registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new IORedisInstrumentation(),
      new RuntimeNodeInstrumentation(),
    ],
  })
  log.info({ action: 'otel_init', serviceName, endpoint }, 'Tracing SDK initialized')

  process.on('SIGTERM', () => {
    Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()])
      .then(() => log.info({ action: 'otel_shutdown' }, 'Tracing SDK terminated gracefully'))
      .catch((err: unknown) => log.error({ err, action: 'otel_shutdown_failed' }, 'Error terminating Tracing SDK'))
  })
}
