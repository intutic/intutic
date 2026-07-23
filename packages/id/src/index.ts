import { nanoid } from 'nanoid'

/**
 * Generate a prefixed unique ID.
 *
 * All IDs in Intutic use a short prefix followed by an underscore and a
 * nanoid-generated string. This makes IDs human-readable and debuggable
 * while remaining globally unique.
 *
 * @param prefix - 2–3 character prefix (e.g., `'wk'` for workspace, `'tc'` for tool call)
 * @returns A prefixed unique ID like `wk_V1StGXR8_Z5jdHi6B-myT`
 *
 * @example
 * ```typescript
 * import { newId } from '@intutic/id'
 *
 * const workspaceId = newId('wk')  // → 'wk_V1StGXR8_Z5jdHi6B-myT'
 * const toolCallId = newId('tc')   // → 'tc_1SRtkN_8KbFh3GtyU2xz9'
 * const eventId = newId('ev')      // → 'ev_qWeR7y_AsDfGhJkLzXcVb'
 * ```
 */
export function newId(prefix: string): string {
  return `${prefix}_${nanoid(21)}`
}

/**
 * Generate an ISO 8601 timestamp string.
 *
 * Always use this function instead of `Date.now()` or manual date formatting.
 * This ensures consistent timestamp format across the entire codebase.
 *
 * @returns An ISO 8601 timestamp like `2025-06-08T21:38:09.000Z`
 *
 * @example
 * ```typescript
 * import { newIso } from '@intutic/id'
 *
 * const createdAt = newIso()  // → '2025-06-08T21:38:09.123Z'
 * ```
 */
export function newIso(): string {
  return new Date().toISOString()
}
