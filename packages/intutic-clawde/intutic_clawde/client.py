import os
import time
import requests
import json
from typing import List, Dict, Any, Callable, Optional, Union
from .errors import ClawdeConnectionError, ClawdeVerdictError
from .context_resolver import resolve_context
from .budget_checker import BudgetChecker
from .circuit_breaker import CircuitBreaker

class ClawdeClient:
    def __init__(
        self, 
        api_key: str, 
        base_url: Optional[str] = None, 
        provider: Optional[str] = None, 
        auto_context: bool = True, 
        timeout: float = 30.0, 
        retries: int = 2
    ):
        if not api_key:
            raise ValueError("API key is required to initialize ClawdeClient.")
        self.api_key = api_key
        self.base_url = base_url or os.environ.get("INTUTIC_BASE_URL") or "http://localhost:4000"
        self.provider = provider
        self.auto_context = auto_context
        self.timeout = timeout
        self.retries = retries
        
        self.budget_checker = BudgetChecker(self.base_url, self.api_key)
        self.circuit_breaker_wrapper = CircuitBreaker(self)
        self.listeners: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {
            "hijack": [], "enhance": [], "kill": [], "bypass": []
        }

    def on(self, event: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        if event in self.listeners:
            self.listeners[event].append(callback)

    def off(self, event: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        if event in self.listeners and callback in self.listeners[event]:
            self.listeners[event].remove(callback)

    def emit(self, event: str, payload: Dict[str, Any]) -> None:
        if event in self.listeners:
            for cb in self.listeners[event]:
                try:
                    cb(payload)
                except Exception:
                    pass

    def check_budget(self, model: str, estimated_tokens: int) -> Dict[str, Any]:
        return self.budget_checker.check_budget(model, estimated_tokens)

    def resolve_context(self) -> Dict[str, Any]:
        if not self.auto_context:
            return {}
        return resolve_context()

    def circuit_breaker(self, tool_name: str, max_cost_usd: Optional[float] = None, fail_open: bool = False) -> Callable[[Callable[[], Any]], Any]:
        return self.circuit_breaker_wrapper.wrap(tool_name, max_cost_usd, fail_open)

    def chat(self, model: str, messages: List[Dict[str, str]], **kwargs: Any) -> Dict[str, Any]:
        # 1. Resolve context
        context = self.resolve_context()
        
        # 2. Prepare payload
        request_payload = {
            "model": model,
            "messages": messages,
            **kwargs
        }
        
        # 3. Request logic with retries
        max_attempts = self.retries + 1
        last_error = None
        
        for attempt in range(1, max_attempts + 1):
            try:
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                    "X-Intutic-Context": json.dumps(context),
                }
                
                if "max_cost_usd" in kwargs:
                    headers["X-Intutic-Cost-Limit"] = str(kwargs["max_cost_usd"])
                if "sensitivity_tier" in kwargs:
                    headers["X-Intutic-Sensitivity"] = str(kwargs["sensitivity_tier"])
                    
                url = f"{self.base_url}/v1/chat/completions"
                res = requests.post(url, json=request_payload, headers=headers, timeout=self.timeout)
                
                if res.status_code != 200:
                    raise Exception(f"HTTP error {res.status_code}: {res.text}")
                    
                result = res.json()
                
                # Extract headers
                verdict = res.headers.get("x-intutic-verdict", "allow")
                remaining = res.headers.get("x-intutic-budget-remaining")
                pct = res.headers.get("x-intutic-budget-pct")
                
                result["verdict"] = verdict
                if remaining:
                    result["budget_remaining_usd"] = float(remaining)
                if pct:
                    result["budget_pct_used"] = float(pct)
                    
                # Update budget cache
                if "budget_remaining_usd" in result:
                    self.budget_checker.update_cached_budget(
                        model,
                        len(messages),
                        result["budget_remaining_usd"],
                        verdict != "kill"
                    )
                    
                # Emit events
                if verdict and verdict != "allow":
                    self.emit(verdict, result)
                    
                # Enforcement check
                if verdict == "kill":
                    raise ClawdeVerdictError("kill", "Request blocked by policy (Verdict: KILL)")
                    
                return result
            except Exception as e:
                last_error = e
                if isinstance(e, ClawdeVerdictError):
                    raise e
                if attempt < max_attempts:
                    if os.environ.get("INTUTIC_DEBUG") == "true":
                        print(f"[Clawde SDK] Attempt {attempt} failed, retrying... Error: {str(e)}")
                    time.sleep(attempt * 0.1)
                    continue
                    
        raise ClawdeConnectionError(f"Request failed after {max_attempts} attempts. Last error: {str(last_error)}")
