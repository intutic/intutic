/**
 * The verdicts a gate decision records (the SIEM `gate_decisions` source),
 * and what each means. Every one is a gate's verdict on a tool call except
 * `TAMPER`, the verdict on the gate's own files.
 *
 * @module
 */

export const GATE_DECISION_VERDICTS = {
  ALLOW: 'the call ran',
  BLOCK: 'the call was refused',
  FLAG: 'the call ran, flagged by an advisory rule',
  WOULD_BLOCK: 'the call ran; a shadow rule would have refused it',
  HOLD: 'the call waits for a reviewer',
  BYPASS_APPROVED: 'the call ran on an approved hold',
  TAMPER: 'a governance file (a gate, a hook registration, the policy snapshot, a VS Code hook setting) changed outside the sync daemon, which restored it',
} as const

export type GateDecisionVerdict = keyof typeof GATE_DECISION_VERDICTS
