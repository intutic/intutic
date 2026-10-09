/**
 * The shape the operator commands share (`settings`, `mcp`, `notifications`,
 * `siem`, `compliance`, `usage`, `inventory`, `gate-liveness`): one call to
 * an existing control-plane route, the response as JSON with `--json` or
 * rendered for a person without it, and any failure printed with the
 * server's own message and exit code 1.
 *
 * The server's message is the useful part of a failure here: a 403 says
 * which role or plan the route needs ("Upgrade required — …"), a 400 names
 * the field it refused, and the CLI adds nothing to either.
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { ApiClient } from '../lib/api.js'
import { log } from '../lib/logger.js'
import { getClient } from './skill.js'

export interface ApiCommandOpts {
  dev?: boolean
  json?: boolean
}

/** Prints `message` as an error and exits 1. */
export function fail(message: string): never {
  log.error(message)
  process.exit(1)
}

/**
 * Runs `call` against the control plane, then prints its result: as JSON
 * with `--json`, through `render` otherwise. `failure` begins the error line
 * ("Failed to list MCP servers"), followed by the server's message.
 */
export async function runApiCommand<T>(
  opts: ApiCommandOpts,
  failure: string,
  call: (client: ApiClient) => Promise<T>,
  render: (result: T) => void,
): Promise<void> {
  const client = await getClient(opts.dev)
  let result: T
  try {
    result = await call(client)
  } catch (err) {
    fail(`${failure}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  render(result)
}

/** Splits a comma-separated flag value, dropping empty entries. */
export function list(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

/** Parses a positive integer flag, or fails naming the flag. */
export function positiveInt(value: string, flag: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive whole number, got "${value}"`)
  return n
}

/** Reads a JSON file named by a flag, or fails saying why it could not. */
export function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    fail(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Writes a downloaded report to `out`, or to stdout when there is none, so it
 * can be piped. `what` names it in the confirmation.
 */
export function writeOutput(bytes: Uint8Array, out: string | undefined, what: string): void {
  if (!out) {
    process.stdout.write(bytes)
    return
  }
  writeFileSync(out, bytes)
  log.success(`Wrote ${what} to ${out}.`)
}

/** Prints a signing secret the server returned, which it never shows again. */
export function printSigningSecret(secret: string | undefined): void {
  if (!secret) return
  log.field('Signing secret', secret)
  log.warn('Copy the signing secret now: it is not shown again. Verify each delivery\'s signature with it.')
}
