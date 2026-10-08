"""The proxy's governance refusals, and how to recognise one in an error response.

Each entry is the `error.type` of the proxy's JSON error body
(`{"error": {"type", "message"}}`, `json_error` in packages/proxy/src/proxy.rs),
the status it always pairs that type with, and the verdict it represents.

Matching on the pair rather than the status alone matters because the same
statuses also carry errors that are not decisions: a provider's own 429 rate
limit, a 403 for a key used against the wrong workspace, a 400 for a malformed
body. Those are not refusals and must not be reported as one.

`tests/test_refusals.py` checks this table against proxy.rs, so a refusal the
proxy adds or renames fails the build instead of silently turning back into a
retried connection error.
"""

import json
from typing import Dict, Optional, Tuple, TypedDict

#: error code -> (HTTP status, verdict). The same table as PROXY_REFUSALS in the TypeScript SDK.
PROXY_REFUSALS: Dict[str, Tuple[int, str]] = {
    "policy_denied": (403, "kill"),
    "model_not_allowed": (403, "kill"),
    "LOOP_RUN_TERMINATED": (403, "kill"),
    "LOOP_RUN_PENDING_REVIEW": (403, "hold"),
    "policy_reask": (409, "reask"),
    "BUDGET_EXCEEDED": (429, "kill"),
    "OVERAGE_HARD_CAP_EXCEEDED": (429, "kill"),
    "COST_GATE_EXCEEDED": (402, "kill"),
    "dlp_policy_violation": (400, "kill"),
}


class ProxyRefusal(TypedDict):
    verdict: str
    code: str
    message: str


def parse_refusal(status: int, body: str) -> Optional[ProxyRefusal]:
    """The refusal an error response carries, or None when it is any other kind of failure."""
    try:
        error = json.loads(body).get("error")
    except (ValueError, AttributeError):
        return None
    if not isinstance(error, dict) or not isinstance(error.get("type"), str):
        return None
    known = PROXY_REFUSALS.get(error["type"])
    if known is None or known[0] != status:
        return None
    message = error.get("message")
    return {
        "verdict": known[1],
        "code": error["type"],
        "message": message if isinstance(message, str) else error["type"],
    }


#: The header the proxy sets on a 200 that is a refusal in the shape of an
#: answer: the cost-prediction gate replies to a non-streaming request with an
#: assistant turn explaining the estimate, so a chat client shows the reason.
#: Its value is the refusal's code.
REFUSAL_HEADER = "x-intutic-refusal"


def header_refusal(code: Optional[str], message: str) -> Optional[ProxyRefusal]:
    """The refusal a 2xx response names in REFUSAL_HEADER, or None for a real answer."""
    if not code:
        return None
    known = PROXY_REFUSALS.get(code)
    return {
        "verdict": known[1] if known else "kill",
        "code": code,
        "message": message or code,
    }
