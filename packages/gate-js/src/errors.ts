/**
 * Error hierarchy for `@intutic/gate`.
 *
 * Port of `packages/intutic-clawde/intutic_clawde/errors.py` +
 * `intutic_clawde/gate/gate.py`'s `IntuticGateRefusal`.
 *
 * `IntuticGateRefusal` is the load-bearing one: {@link Gate.guard} THROWS this
 * on a refused call rather than returning a verdict object. That is the
 * "JS-throw contract" already used elsewhere in this repo's gate vocabulary —
 * see `services/sync-daemon/src/harness/gateBody.ts`'s emitted gates, which
 * either `process.exit(2)` or write a `{cancel:true,...}` stdout envelope, and
 * `packages/mcp-proxy/src/policy.ts`, which throws a `PolicyBlockedError` for
 * the same reason: a tool call that must not run is an exceptional control
 * flow event, not a value the caller might forget to check.
 *
 * `.message` is prefixed `[Intutic Governance] BLOCKED:` — the same family the
 * Open WebUI filter and the Python SDK raise — so harnesses and log scrapers
 * that already recognise that prefix recognise this refusal too.
 */

/** Base class for every error this package throws. */
export class GateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateError'
  }
}

/** Thrown when the SDK cannot reach the Intutic control plane. */
export class GateConnectionError extends GateError {
  constructor(message: string) {
    super(message)
    this.name = 'GateConnectionError'
  }
}

/**
 * Every `code` an {@link IntuticGateRefusal} can carry: the tier that refused,
 * or for the image-integrity tier the specific failure. Held to
 * `packages/shared-types/fixtures/refusal-codes.json` (`gate`) by a test, as
 * the Python gate's list and the gate SDK reference are.
 */
export const GATE_REFUSAL_CODES = [
  'SSO_GROUP',
  'SNAPSHOT',
  'HELD',
  // The MCP server registry and allowlist, from the policy snapshot or the
  // control plane's hook gate.
  'SERVER_BLOCKED',
  'SERVER_HELD',
  'SERVER_NOT_APPROVED',
  'TOOL_DISABLED',
  'SERVER_NOT_ALLOWED',
  'SOP_RULE',
  'HOOK_GATE',
  // The call is too large to evaluate (limits.ts), before any tier runs.
  'COMMAND_TOO_LARGE',
  'E_UNPINNED_LATEST',
  'E_UNPINNED_TAG',
  'E_UNKNOWN_REGISTRY',
  'E_UNKNOWN_IMAGE',
  'E_DIGEST_MISMATCH',
  'E_MANIFEST_UNPARSEABLE',
  // The Workflow DevKit adapter (workflow.ts), before any tier runs.
  'WORKFLOW_SANDBOX',
  'NO_GATE',
] as const

export type GateRefusalCode = (typeof GATE_REFUSAL_CODES)[number]

/**
 * Raised when a tool call must not run.
 *
 * The structured fields (`reason`, `code`, `incidentId`) carry the
 * machine-readable version of the refusal; `.message` carries the
 * human-readable, prefix-recognisable one.
 */
export class IntuticGateRefusal extends GateError {
  public readonly reason: string
  public readonly code: GateRefusalCode
  public readonly incidentId: string | undefined

  constructor(reason: string, code: GateRefusalCode, incidentId?: string) {
    super(`[Intutic Governance] BLOCKED: ${reason}`)
    this.name = 'IntuticGateRefusal'
    this.reason = reason
    this.code = code
    this.incidentId = incidentId
  }
}

/**
 * Raised when a hold rule stopped the call to ask a person first (`code`
 * `HELD`). A subclass, so a caller that stops on every refusal stops on this
 * too; one that tells the user about holds catches it first.
 *
 * `holdId` names the hold in the review queue, and is `undefined` when the
 * hold could not be recorded (no control plane to record it in), in which
 * case there is nothing to approve yet. `.message` starts
 * `[Intutic Governance] HELD:`, as the hook gates print a hold, and says who
 * can approve it and when a retry passes. See hold.ts.
 */
export class IntuticGateHold extends IntuticGateRefusal {
  public readonly holdId: string | undefined

  constructor(reason: string, holdId: string | undefined) {
    super(reason, 'HELD')
    this.name = 'IntuticGateHold'
    this.message = `[Intutic Governance] HELD: ${reason}`
    this.holdId = holdId
  }
}
