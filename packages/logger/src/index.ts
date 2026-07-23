/**
 * @intutic/logger — Structured logging with trace context
 *
 * Provides a pino-based logger factory that outputs structured JSON to stdout.
 * 12-factor app compliant — no file transports, stdout only.
 *
 * **MCP proxy exception:** When `PINO_DEST=stderr` is set in the environment,
 * all log output is redirected to stderr (fd 2). This is required by processes
 * that reserve stdout exclusively for JSON-RPC frames (e.g., MCP stdio servers).
 *
 * @example
 * ```ts
 * import { createLogger } from '@intutic/logger'
 * const log = createLogger('circuit-breaker')
 * log.info({ workspaceId: 'wk_abc123' }, 'Tool call evaluated')
 * ```
 *
 * @module
 */

import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'
import { trace } from '@opentelemetry/api'

/** Structured logger interface — re-exported pino Logger */
export type Logger = PinoLogger

/**
 * Resolve the pino destination stream.
 * - Default: process.stdout (fd 1) — normal 12-factor behaviour.
 * - PINO_DEST=stderr: process.stderr (fd 2) — used by MCP proxy to avoid
 *   polluting the JSON-RPC channel on stdout.
 */
function resolveDestination(): pino.DestinationStream | undefined {
  if (process.env['PINO_DEST'] === 'stderr') {
    return pino.destination({ fd: 2, sync: true })
  }
  return undefined // pino default → stdout
}

/** Base configuration for all loggers */
const BASE_CONFIG: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    try {
      const activeSpan = trace.getActiveSpan()
      if (activeSpan) {
        const spanContext = activeSpan.spanContext()
        return {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
        }
      }
    } catch {
      // Safe fallback if OpenTelemetry is not initialized
    }
    return {}
  },
}

/** Resolved destination (evaluated once at module load, before any logger is created) */
const DEST = resolveDestination()

/**
 * Creates a named, structured logger instance.
 *
 * @param name - Component name (e.g., 'control-plane', 'circuit-breaker')
 * @param bindings - Optional default key-value pairs attached to every log line
 * @returns Configured pino logger
 */
export function createLogger(
  name: string,
  bindings?: Record<string, unknown>,
): Logger {
  const logger = DEST
    ? pino({ ...BASE_CONFIG, name }, DEST)
    : pino({ ...BASE_CONFIG, name })
  return bindings ? logger.child(bindings) : logger
}

