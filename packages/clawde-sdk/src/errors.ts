export class ClawdeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClawdeError'
  }
}

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

export class ClawdeVerdictError extends ClawdeError {
  public verdict: string
  
  constructor(verdict: string, message: string) {
    super(message)
    this.name = 'ClawdeVerdictError'
    this.verdict = verdict
  }
}
