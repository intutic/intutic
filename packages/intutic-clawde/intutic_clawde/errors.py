class ClawdeError(Exception):
    """Base exception for intutic-clawde SDK."""
    pass

class ClawdeConnectionError(ClawdeError):
    """Raised when the SDK cannot reach the Intutic proxy."""
    pass

class ClawdeVerdictError(ClawdeError):
    """Raised when the Intutic proxy returns a blocked verdict (KILL)."""
    def __init__(self, verdict: str, message: str):
        super().__init__(message)
        self.verdict = verdict
