import time
import requests
from typing import Dict, Any, Optional
from .errors import ClawdeConnectionError

class BudgetChecker:
    """
    Historically called a `/v1/budget/check` route on the proxy that never
    existed anywhere in the backend -- every real call raised. The only real
    budget endpoint is `GET /api/v1/budget` on the control plane, which
    reports current workspace-level spend/remaining, not a per-request
    allow/decision for a specific model+estimated_tokens pair (the real
    endpoint takes no such params). This is therefore a narrower, honestly
    different check than the name implies: "does this workspace currently
    have budget headroom at all", not "would this specific call fit" --
    model/estimated_tokens are kept only as the existing cache key shape,
    for API/cache-behavior compatibility with callers already using them.
    """

    def __init__(self, control_plane_url: str, api_key: str):
        self.control_plane_url = control_plane_url
        self.api_key = api_key
        self.cache: Dict[str, Dict[str, Any]] = {}
        self.cache_ttl = 30.0 # 30s TTL

    def check_budget(self, model: str, estimated_tokens: int) -> Dict[str, Any]:
        cache_key = f"{model}:{estimated_tokens}"
        now = time.time()
        cached = self.cache.get(cache_key)

        if cached and (now - cached["timestamp"]) < self.cache_ttl:
            return cached["result"]

        try:
            url = f"{self.control_plane_url}/api/v1/budget"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            }
            res = requests.get(url, headers=headers, timeout=5.0)
            if res.status_code != 200:
                raise Exception(f"Budget check returned status {res.status_code}")
            body = res.json()
            result = {
                "allowed": body["budget_remaining_usd"] > 0,
                "remaining_usd": body["budget_remaining_usd"],
            }
            if body.get("alert_triggered"):
                result["reason"] = "Workspace is at or above its budget alert threshold"
            self.cache[cache_key] = {"result": result, "timestamp": now}
            return result
        except Exception as e:
            raise ClawdeConnectionError(f"Could not reach control-plane budget endpoint: {str(e)}")

    def update_cached_budget(self, model: str, estimated_tokens: int, remaining_usd: float, allowed: bool) -> None:
        cache_key = f"{model}:{estimated_tokens}"
        self.cache[cache_key] = {
            "result": {"allowed": allowed, "remaining_usd": remaining_usd},
            "timestamp": time.time(),
        }
