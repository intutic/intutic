/**
 * The OPAQUE intervention mode: an agent is refused without being told which
 * rule refused it.
 *
 * A refusal that names its rule, quotes the rule's text, or says which pattern
 * matched teaches an agent the policy, and an agent that knows the policy can
 * route around it. In an OPAQUE workspace every gate that refuses on workspace
 * policy shows the agent {@link OPAQUE_REFUSAL_MESSAGE} instead, through the
 * same refusal contract: the same exit code, HTTP status and refusal code, so
 * harnesses and clients behave exactly as they would in a TRANSPARENT one.
 * Only the text the agent reads changes. Audit records, trace records,
 * `enforcement_log`, detector findings and the dashboard keep the full reason.
 *
 * Refusals that say nothing about the policy are not changed: a call too large
 * to evaluate, a gate past its deadline, an unreadable payload, a crashed gate,
 * a snapshot that failed its integrity check, and a chaos run's injected fault.
 *
 * `@intutic/gate` carries a byte-identical copy of this module
 * (`packages/gate-js/src/opaqueRefusal.ts`); the Rust proxy (`refusal.rs`)
 * and the Python SDK (`intutic_clawde/gate/opaque.py`) mirror the sentence.
 * `refusal-codes.json` carries it as `opaqueMessage`, and
 * `opaqueRefusalParity.test.ts` holds every copy to it. It carries no quote,
 * dollar sign or backtick, so the hook gates can embed it in generated shell
 * inside single quotes.
 */
export const OPAQUE_REFUSAL_MESSAGE =
  'Blocked by workspace policy. Ask a workspace admin if you need this action.'

/**
 * The policy snapshot's record of an OPAQUE workspace: a data line inside the
 * digest, `@intervention_mode<TAB>OPAQUE`, written only when the mode is
 * OPAQUE, so the snapshot of a TRANSPARENT or SILENT_LOG workspace is
 * unchanged. Two columns, so every rule parser skips it.
 */
export const INTERVENTION_MODE_RECORD_TAG = '@intervention_mode'

/** Whether a workspace's resolved intervention mode is OPAQUE. Any case. */
export function isOpaqueInterventionMode(mode: unknown): boolean {
  return typeof mode === 'string' && mode.trim().toUpperCase() === 'OPAQUE'
}

/** The `.rules` line of an OPAQUE workspace. */
export function encodeInterventionModeRecord(): string {
  return `${INTERVENTION_MODE_RECORD_TAG}\tOPAQUE`
}

/** Whether a `.rules` line is the record of an OPAQUE workspace. */
export function isOpaqueInterventionModeRecord(line: string): boolean {
  const [tag, mode, ...rest] = line.split('\t')
  return tag === INTERVENTION_MODE_RECORD_TAG && rest.length === 0 && isOpaqueInterventionMode(mode)
}
