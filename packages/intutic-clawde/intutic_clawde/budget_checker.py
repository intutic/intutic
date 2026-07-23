import time
import requests
from typing import Dict, Any, Optional
from .errors import ClawdeConnectionError

class BudgetChecker:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
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
            url = f"{self.base_url}/v1/budget/check"
            params = {"model": model, "estimated_tokens": str(estimated_tokens)}
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            }
            res = requests.get(url, params=params, headers=headers, timeout=5.0)
            if res.status_code != 200:
                raise Exception(f"Budget check returned status {res.status_code}")
            result = res.json()
            self.cache[cache_key] = {"result": result, "timestamp": now}
            return result
        except Exception as e:
            raise ClawdeConnectionError(f"Could not reach budget check endpoint: {str(e)}")

    def update_cached_budget(self, model: str, estimated_tokens: int, remaining_usd: float, allowed: bool) -> None:
        cache_key = f"{model}:{estimated_tokens}"
        self.cache[cache_key] = {
            "result": {"allowed": allowed, "remaining_usd": remaining_usd},
            "timestamp": time.time(),
        }
