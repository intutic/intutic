import os
from typing import Callable, Any, TypeVar
from .errors import ClawdeVerdictError

T = TypeVar('T')

class CircuitBreaker:
    def __init__(self, client: Any):
        self.client = client

    def wrap(self, tool_name: str, require_budget: bool = False, fail_open: bool = False) -> Callable[[Callable[[], T]], T]:
        def decorator(fn: Callable[[], T]) -> T:
            # 1. Pre-check: workspace budget, when asked for. `fail_open` covers
            # a check that could not be made; a check that answered "no budget"
            # is a verdict and refuses either way, or the breaker would let
            # every call through exactly when the budget is gone.
            if require_budget:
                budget = None
                try:
                    budget = self.client.check_budget("default", 1)
                except Exception as e:
                    if not fail_open:
                        raise e
                    if os.environ.get("INTUTIC_DEBUG") == "true":
                        print(f"[Clawde SDK] Circuit breaker pre-check failed (failing open): {str(e)}")
                if budget is not None and not budget.get("allowed", False):
                    raise ClawdeVerdictError(
                        "kill",
                        f"Circuit breaker tripped for tool '{tool_name}': budget exceeded. Remaining: ${budget.get('remaining_usd')}"
                    )

            # 2. Run the function. A refusal from chat() arrives as a raised
            # ClawdeBlockedError, so fail-closed needs nothing beyond re-raising.
            try:
                return fn()
            except Exception as e:
                if not fail_open:
                    raise e
                if os.environ.get("INTUTIC_DEBUG") == "true":
                    print(f"[Clawde SDK] Circuit breaker execution failed (failing open): {str(e)}")
                return None # type: ignore
        return decorator # type: ignore
