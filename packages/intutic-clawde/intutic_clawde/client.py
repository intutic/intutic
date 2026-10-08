import os
import time
import warnings
import requests
from typing import List, Dict, Any, Callable, Optional
from .errors import ClawdeBlockedError, ClawdeConnectionError
from .refusals import REFUSAL_HEADER, header_refusal, parse_refusal
from .context_resolver import resolve_context
from .budget_checker import BudgetChecker
from .circuit_breaker import CircuitBreaker

class ClawdeClient:
    def __init__(
        self,
        api_key: str,
        base_url: Optional[str] = None,
        control_plane_url: Optional[str] = None,
        provider: Optional[str] = None,
        auto_context: bool = True,
        timeout: float = 30.0,
        retries: int = 2
    ):
        if not api_key:
            raise ValueError("API key is required to initialize ClawdeClient.")
        self.api_key = api_key
        self.base_url = base_url or os.environ.get("INTUTIC_BASE_URL") or "http://localhost:4000"
        # Control plane is a different origin from the proxy base_url above --
        # used by checkBudget() (see budget_checker.py's doc comment).
        self.control_plane_url = (
            control_plane_url
            or os.environ.get("INTUTIC_CONTROL_PLANE_URL")
            or "https://app.intutic.ai"
        )
        self.provider = provider
        self.auto_context = auto_context
        self.timeout = timeout
        self.retries = retries

        self.budget_checker = BudgetChecker(self.control_plane_url, self.api_key)
        self.circuit_breaker_wrapper = CircuitBreaker(self)
        # kill/reask/hold fire on a proxy refusal. hijack/enhance/bypass are
        # deprecated and never fire: the proxy applies them inside the response
        # without telling the client. Kept so existing registrations still work.
        self.listeners: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {
            "kill": [], "reask": [], "hold": [], "hijack": [], "enhance": [], "bypass": []
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

    def circuit_breaker(
        self,
        tool_name: str,
        max_cost_usd: Optional[float] = None,
        fail_open: bool = False,
        require_budget: bool = False,
    ) -> Callable[[Callable[[], Any]], Any]:
        """`require_budget=True` runs check_budget() first and refuses to run the
        function when the workspace has no budget left. `max_cost_usd` is the
        deprecated spelling of the same switch: the amount is not compared with
        anything, because nothing reports a call's cost before it is made."""
        if max_cost_usd is not None:
            warnings.warn(
                "max_cost_usd is deprecated and its amount is ignored; pass require_budget=True",
                DeprecationWarning,
                stacklevel=2,
            )
            require_budget = True
        return self.circuit_breaker_wrapper.wrap(tool_name, require_budget, fail_open)

    def chat(self, model: str, messages: List[Dict[str, str]], **kwargs: Any) -> Dict[str, Any]:
        """Send a chat request through the proxy's /v1/chat/completions route.

        Returns the completion with `verdict` set to "allow" when the proxy let
        the request through. A governance refusal, including one the proxy
        answers with a 200 and names in `x-intutic-refusal`, fires the matching
        event and raises ClawdeBlockedError, unretried. Transport failures, timeouts and
        5xx answers are retried; anything else raises ClawdeConnectionError.
        """
        request_payload = {
            "model": model,
            "messages": messages,
            **kwargs
        }
        url = f"{self.base_url}/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        max_attempts = self.retries + 1
        last_error = ""

        for attempt in range(1, max_attempts + 1):
            if attempt > 1:
                if os.environ.get("INTUTIC_DEBUG") == "true":
                    print(f"[Clawde SDK] Attempt {attempt - 1} failed, retrying... Error: {last_error}")
                time.sleep((attempt - 1) * 0.1)

            try:
                res = requests.post(url, json=request_payload, headers=headers, timeout=self.timeout)
            except requests.RequestException as e:
                last_error = str(e)
                continue

            if 200 <= res.status_code < 300:
                try:
                    result = res.json()
                except ValueError:
                    raise ClawdeConnectionError(
                        f"Proxy answered {res.status_code} with a body that is not JSON: {res.text}"
                    )
                # A refusal answered as an assistant turn (the cost-prediction gate).
                answered = header_refusal(res.headers.get(REFUSAL_HEADER), _first_message_text(result))
                if answered is not None:
                    self.emit(answered["verdict"], {**answered, "status": res.status_code})
                    raise ClawdeBlockedError(
                        answered["verdict"], answered["code"], res.status_code, answered["message"]
                    )
                result["verdict"] = "allow"
                return result

            refusal = parse_refusal(res.status_code, res.text)
            if refusal is not None:
                self.emit(refusal["verdict"], {**refusal, "status": res.status_code})
                raise ClawdeBlockedError(
                    refusal["verdict"], refusal["code"], res.status_code, refusal["message"]
                )

            last_error = f"HTTP error {res.status_code}: {res.text}"
            # A 4xx that is not a refusal (bad key, malformed body) fails the
            # same way every time; only a 5xx is worth another attempt.
            if res.status_code < 500:
                raise ClawdeConnectionError(last_error)

        raise ClawdeConnectionError(f"Request failed after {max_attempts} attempts. Last error: {last_error}")


def _first_message_text(completion: Any) -> str:
    """The first choice's message text of an OpenAI-format completion, or ''."""
    try:
        content = completion["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    return content if isinstance(content, str) else ""
