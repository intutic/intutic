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
 * Raised when a tool call must not run.
 *
 * The structured fields (`reason`, `code`, `incidentId`) carry the
 * machine-readable version of the refusal; `.message` carries the
 * human-readable, prefix-recognisable one.
 */
export class IntuticGateRefusal extends GateError {
  public readonly reason: string
  public readonly code: string
  public readonly incidentId: string | undefined

  constructor(reason: string, code: string, incidentId?: string) {
    super(`[Intutic Governance] BLOCKED: ${reason}`)
    this.name = 'IntuticGateRefusal'
    this.reason = reason
    this.code = code
    this.incidentId = incidentId
  }
}
