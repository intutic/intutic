/**
 * Building blocks of the control plane's response schemas.
 *
 * Each schema in `src/responses/` describes a response body as the client
 * receives it: JSON, so a timestamp is a string and a field the handler left
 * `undefined` is absent (`.optional()`), not `null` (`.nullable()`). A route
 * declares its schema by answering through `respond(c, Schema, body)`
 * (`services/control-plane/src/lib/respond.ts`); the OpenAPI document
 * publishes it, `tsc` holds the handler's body to it, and the control plane's
 * tests reject a body that does not match it or carries a field it does not
 * declare. Write one from the handler and the service code it returns, never
 * from what a client expects: where the two disagree, the handler is right.
 *
 * Conventions:
 * - Top-level schemas are named `<Thing>Response` and exported with their
 *   inferred type under the same name.
 * - No transforms, defaults or coercions: a schema describes, it does not
 *   convert.
 * - In a union, put the branch with more fields first: zod keeps the first
 *   branch that matches and drops the fields it does not declare, which the
 *   tests then report as undeclared.
 *
 * @module
 */
import { z } from 'zod'

/** A timestamp: a `Date` the handler returned, serialized by `JSON.stringify`. */
export const IsoTimestamp = z.string().datetime({ offset: true })

/** How a list response's row keys are cased (`lib/listEnvelope.ts` in the control plane). */
export const RowCase = z.enum(['snake', 'camel', 'mixed'])

/**
 * The two keys `applyListEnvelope` adds to a list response: the key that
 * holds the rows, and how their keys are cased.
 */
export function listEnvelope<K extends string, C extends z.infer<typeof RowCase>>(listProperty: K, rowCase: C) {
  return z.object({ listProperty: z.literal(listProperty), rowCase: z.literal(rowCase) })
}

/** `{ deleted: true }`, the answer of a delete that has nothing else to say. */
export const DeletedResponse = z.object({ deleted: z.literal(true) })
export type DeletedResponse = z.infer<typeof DeletedResponse>
