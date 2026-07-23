import os
from typing import Callable, Any, Optional, TypeVar
from .errors import ClawdeVerdictError

T = TypeVar('T')

class CircuitBreaker:
    def __init__(self, client: Any):
        self.client = client

    def wrap(self, tool_name: str, max_cost_usd: Optional[float] = None, fail_open: bool = False) -> Callable[[Callable[[], T]], T]:
        def decorator(fn: Callable[[], T]) -> T:
            # 1. Pre-Check: Context & pre-flight budget validation
            try:
                if max_cost_usd is not None:
                    budget = self.client.check_budget("default", 1)
                    if not budget.get("allowed", True):
                        raise ClawdeVerdictError(
                            "kill", 
                            f"Circuit breaker tripped for tool '{tool_name}': budget exceeded. Remaining: ${budget.get('remaining_usd')}"
                        )
            except Exception as e:
                if not fail_open:
                    raise e
                if os.environ.get("INTUTIC_DEBUG") == "true":
                    print(f"[Clawde SDK] Circuit breaker pre-check failed (failing open): {str(e)}")
                    
            # 2. Execute the function
            try:
                result = fn()
                
                # 3. Post-Check: If the result is a dict with verdict key, inspect it
                if isinstance(result, dict) and result.get("verdict") == "kill":
                    raise ClawdeVerdictError("kill", "Execution blocked by governance policy (Verdict: KILL)")
                    
                return result
            except Exception as e:
                if isinstance(e, ClawdeVerdictError) and not fail_open:
                    raise e
                if not fail_open:
                    raise e
                if os.environ.get("INTUTIC_DEBUG") == "true":
                    print(f"[Clawde SDK] Circuit breaker execution failed (failing open): {str(e)}")
                return None # type: ignore
        return decorator # type: ignore
