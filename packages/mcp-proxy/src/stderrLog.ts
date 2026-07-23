/**
 * stderrLog.ts — Lightweight structured logger for the MCP governance proxy.
 *
 * CRITICAL: In an MCP stdio server, stdout is exclusively for JSON-RPC frames.
 * This module bypasses pino (which defaults to stdout) and writes structured
 * JSON logs directly to process.stderr (fd 2).
 *
 * Do NOT use @intutic/logger anywhere in packages/mcp-proxy — it routes to
 * stdout unless PINO_DEST=stderr is set, which is fragile across harnesses.
 *
 * @module
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogBindings {
  [key: string]: unknown
}

/**
 * A stderr-only structured logger that matches the @intutic/logger call surface.
 */
export class StderrLogger {
  private readonly name: string
  private readonly staticBindings: LogBindings

  constructor(name: string, bindings: LogBindings = {}) {
    this.name = name
    this.staticBindings = bindings
  }

  private write(level: LogLevel, bindings: LogBindings, msg: string): void {
    const entry = {
      level,
      time: new Date().toISOString(),
      name: this.name,
      ...this.staticBindings,
      ...bindings,
      msg,
    }
    process.stderr.write(JSON.stringify(entry) + '\n')
  }

  debug(bindings: LogBindings, msg: string): void { this.write('debug', bindings, msg) }
  info(bindings: LogBindings, msg: string): void  { this.write('info',  bindings, msg) }
  warn(bindings: LogBindings, msg: string): void  { this.write('warn',  bindings, msg) }
  error(bindings: LogBindings, msg: string): void { this.write('error', bindings, msg) }

  child(bindings: LogBindings): StderrLogger {
    return new StderrLogger(this.name, { ...this.staticBindings, ...bindings })
  }
}

export function createStderrLogger(name: string, bindings?: LogBindings): StderrLogger {
  return new StderrLogger(name, bindings)
}
