from typing import Optional


class ClawdeError(Exception):
    """Base exception for intutic-clawde SDK."""
    pass

class ClawdeConnectionError(ClawdeError):
    """Raised when the proxy is unreachable, times out, or answers with an
    error that is not a governance refusal."""
    pass

class ClawdeVerdictError(ClawdeError):
    """A governance verdict stopped the call: a proxy refusal
    (ClawdeBlockedError) or the circuit breaker's budget check."""
    def __init__(self, verdict: str, message: str):
        super().__init__(message)
        self.verdict = verdict

class ClawdeBlockedError(ClawdeVerdictError):
    """The proxy refused the request: a policy block, a reask, a loop run held
    for review, a spend cap, a DLP block, or a tool call the model made that
    the proxy withheld. Never retried — the same request would be refused
    again. `verdict` is `kill`, `reask` or `hold`, `code` the proxy's refusal
    code, `rule_id` the rule that decided when the proxy names one (every
    refusal it answers with a 200 does), and the message its reason."""
    def __init__(self, verdict: str, code: str, status: int, message: str, rule_id: Optional[str] = None):
        super().__init__(verdict, message)
        self.code = code
        self.status = status
        self.rule_id = rule_id
