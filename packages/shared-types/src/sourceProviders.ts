/**
 * Source connector providers — the one definition.
 *
 * Providers that pull documents into the SOP registry. This list used to be
 * restated by hand in three places — the connector service, the sync cron and
 * the dashboard hook — and the dashboard's copy is what the operator sees in
 * the provider picker, so a provider added server-side was invisible until
 * someone remembered the third copy. `LLD #71` widens the list (Google Drive,
 * upload) and moves it here so every reader imports it.
 *
 * `MEMORY_PROVIDERS` is deliberately NOT here: memory providers share the
 * `connector_credentials` table but are queried at `/fix` time, never synced,
 * and their list is owned by `services/memoryProviders.ts` beside the adapters
 * that read it.
 *
 * @module
 */

/** Providers that pull documents on a schedule and write SOPs back. */
export const SOURCE_PROVIDERS = ['notion', 'confluence', 'github'] as const

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number]

/** Type guard for a string arriving off the wire or from a config row. */
export function isSourceProvider(value: unknown): value is SourceProvider {
  return typeof value === 'string' && (SOURCE_PROVIDERS as readonly string[]).includes(value)
}
