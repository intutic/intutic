/**
 * The refusal a control-plane command prints when no credentials are set.
 *
 * Nine command files carried this exact string as an independent literal —
 * `skill.ts`'s `getClient()` a tenth, `integrity.ts` an eleventh (its own
 * file-local const, reused four times internally) — with zero drift between
 * them, which is the good case of a message that should have been one
 * constant from the start. Extracted here rather than left duplicated.
 *
 * `init.ts`, `connect.ts` and `traces.ts` deliberately do NOT use this: each
 * has its own more specific message (`connect.ts`'s carries an inline
 * comment explaining why the generic "run `intutic login`" framing sent
 * standalone users looking for an account that doesn't exist). Do not fold
 * those in.
 *
 * @module
 */

export const NOT_AUTHENTICATED =
  'Not authenticated. This command needs an Intutic control plane, which open core does not include. ' +
  'To run the proxy without one: `intutic start`. See https://docs.intutic.ai/guide/tier-matrix for what standalone includes.'
