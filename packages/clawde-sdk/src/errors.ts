import type { RefusalVerdict } from './types'

export class ClawdeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClawdeError'
  }
}

/** The proxy is unreachable, timed out, or answered with an error that is not a governance refusal. */
export class ClawdeConnectionError extends ClawdeError {
  constructor(message: string) {
    super(message)
    this.name = 'ClawdeConnectionError'
  }
}

export class ClawdeBudgetExceededError extends ClawdeError {
  constructor(message: string) {
    super(message)
    this.name = 'ClawdeBudgetExceededError'
  }
}

/** A governance verdict stopped the call: a proxy refusal (`ClawdeBlockedError`) or the circuit breaker's budget check. */
export class ClawdeVerdictError extends ClawdeError {
  public verdict: string

  constructor(verdict: string, message: string) {
    super(message)
    this.name = 'ClawdeVerdictError'
    this.verdict = verdict
  }
}

/**
 * The proxy refused the request: a policy block, a reask, a loop run held for
 * review, a spend cap or a DLP block. Never retried — the same request would be
 * refused again. `code` is the proxy's error code and `message` its reason.
 */
export class ClawdeBlockedError extends ClawdeVerdictError {
  declare public verdict: RefusalVerdict
  public readonly code: string
  public readonly status: number

  constructor(verdict: RefusalVerdict, code: string, status: number, message: string) {
    super(verdict, message)
    this.name = 'ClawdeBlockedError'
    this.code = code
    this.status = status
  }
}
