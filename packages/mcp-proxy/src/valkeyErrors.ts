/**
 * valkeyErrors.ts — one-line rendering of an ioredis connection error.
 *
 * Not just `err.message`: Node's dual-stack connect reports a refused Valkey
 * as an AggregateError holding one child error per address family, and an
 * AggregateError's own `.message` is the empty string — so the most common
 * outage was logged `"err":""` and told an operator nothing. Message text
 * only, so a credentialed VALKEY_URL cannot reach the log through an error
 * property bag.
 *
 * Shared by the daemon's policy cache and telemetry batcher and by the stdio
 * proxy's session store (Wave 5.3) — three Valkey clients, one description.
 *
 * @module
 */
export function describeConnectionError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('; ')
  }
  if (err instanceof Error) return err.message || err.name
  return String(err)
}
