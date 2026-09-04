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

/** Providers that pull documents on a schedule (and, where the provider allows, write SOPs back). */
export const SOURCE_PROVIDERS = ['notion', 'confluence', 'github', 'gdrive'] as const

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number]

/**
 * Every provider a `policy_source_documents` row can carry: the syncable
 * sources plus `upload`, a one-off file with no connector row behind it —
 * never swept by the cron, never scheduled, never written back. Kept out of
 * `SOURCE_PROVIDERS` on purpose: that list is what the connector routes, the
 * sync cron and the provider picker widen from, and none of them should
 * offer "upload" as something to connect.
 */
export const DOCUMENT_PROVIDERS = [...SOURCE_PROVIDERS, 'upload'] as const

export type DocumentProvider = (typeof DOCUMENT_PROVIDERS)[number]

/**
 * Source providers only a workspace OWNER or ADMIN may connect, reschedule,
 * sync or remove. A Google service-account key reads every document it has
 * been shared, so the member-level connector route must not create one — the
 * same reasoning that keeps VirusTotal off the generic provider enum.
 */
export const PRIVILEGED_SOURCE_PROVIDERS: ReadonlySet<string> = new Set(['gdrive'])

/** Type guard for a string arriving off the wire or from a config row. */
export function isSourceProvider(value: unknown): value is SourceProvider {
  return typeof value === 'string' && (SOURCE_PROVIDERS as readonly string[]).includes(value)
}

export function isDocumentProvider(value: unknown): value is DocumentProvider {
  return typeof value === 'string' && (DOCUMENT_PROVIDERS as readonly string[]).includes(value)
}
