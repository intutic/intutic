"""The proxy's upstream retry headers, read off a chat response."""
from typing import Any, Dict, Mapping, Optional

UPSTREAM_ATTEMPTS_HEADER = "x-intutic-upstream-attempts"
"""Set by the proxy when its retry layer made more than one upstream call."""

UPSTREAM_FALLBACK_HEADER = "x-intutic-upstream-fallback-from"
"""Set by the proxy when a fallback answered: the model whose retries ran out."""


def upstream_calls(headers: Mapping[str, str]) -> Optional[Dict[str, Any]]:
    """``{"attempts": n, "fallback_from": model}``, or None on the ordinary single-call response."""
    try:
        attempts = int(headers.get(UPSTREAM_ATTEMPTS_HEADER) or 0)
    except ValueError:
        attempts = 0
    fallback_from = headers.get(UPSTREAM_FALLBACK_HEADER)
    if attempts <= 1 and fallback_from is None:
        return None
    calls: Dict[str, Any] = {"attempts": max(attempts, 1)}
    if fallback_from is not None:
        calls["fallback_from"] = fallback_from
    return calls
