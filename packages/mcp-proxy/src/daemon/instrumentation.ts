/**
 * OpenTelemetry Code-Level Instrumentation — mcp-daemon only.
 *
 * Same pattern as gateway-daemon/src/instrumentation.ts and
 * services/control-plane/src/instrumentation.ts. Deliberately NOT imported
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

import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { createLogger } from '@intutic/logger'

const log = createLogger('instrumentation')

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces'
const serviceName = process.env.OTEL_SERVICE_NAME ?? 'mcp-daemon'

// The env var may name either the collector base or the full traces path;
// derive the base once so traces and metrics land on their own signal paths.
const base = endpoint.replace(/\/v1\/traces$/, '')

const traceExporter = new OTLPTraceExporter({
  url: `${base}/v1/traces`,
})

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
    }),
  ],
})

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk.start()
  log.info({ action: 'otel_init', serviceName, endpoint }, 'Tracing SDK initialized')
}

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => log.info({ action: 'otel_shutdown' }, 'Tracing SDK terminated gracefully'))
    .catch((err: unknown) => log.error({ err, action: 'otel_shutdown_failed' }, 'Error terminating Tracing SDK'))
})
