"""The proxy's governance refusals, and how to recognise one in a response.

Each entry is a refusal code, the status the proxy sends it with, and the
verdict it represents.

Most arrive as an error: the code is the `error.type` of the proxy's JSON
error body (`{"error": {"type", "message"}}`, `json_error` in
packages/proxy/src/proxy.rs). Matching on the status and the code together
matters because the same statuses also carry errors that are not decisions: a
provider's own 429 rate limit, a 403 for a key used against the wrong
workspace, a 400 for a malformed body. Those are not refusals and must not be
reported as one.

The rest (status 200, and COST_GATE_EXCEEDED on a non-streaming request)
arrive in band: an assistant turn explaining the refusal, named by
REFUSAL_HEADER, or on a stream by the STREAM_REFUSAL_MARKER comment line.

`tests/test_refusals.py` holds this table to
packages/shared-types/fixtures/refusal-codes.json, the one list the proxy and
the TypeScript SDK are held to as well, so a refusal the proxy adds or renames
fails the build instead of silently turning back into an allow or a retried
connection error.
"""

import json
from typing import Dict, Optional, Tuple, TypedDict

#: refusal code -> (HTTP status, verdict). The same table as PROXY_REFUSALS in the TypeScript SDK.
PROXY_REFUSALS: Dict[str, Tuple[int, str]] = {
    "policy_denied": (403, "kill"),
    "model_not_allowed": (403, "kill"),
    "LOOP_RUN_TERMINATED": (403, "kill"),
    "LOOP_RUN_PENDING_REVIEW": (403, "hold"),
    "policy_held": (403, "hold"),
    "policy_reask": (409, "reask"),
    "GOVERNANCE_UNAVAILABLE": (403, "kill"),
    "BUDGET_EXCEEDED": (429, "kill"),
    "OVERAGE_HARD_CAP_EXCEEDED": (429, "kill"),
    "COST_GATE_EXCEEDED": (402, "kill"),
    "dlp_policy_violation": (400, "kill"),
    "TOOL_DENIED": (200, "kill"),
    "SSO_GROUP": (200, "kill"),
    "SQL_GUARD": (200, "kill"),
    "RESPONSE_UNPARSEABLE": (200, "kill"),
    "OUTPUT_DLP": (200, "kill"),
}


class _ProxyRefusalBase(TypedDict):
    verdict: str
    code: str
    message: str


class ProxyRefusal(_ProxyRefusalBase, total=False):
    #: The rule that decided, for a refusal the proxy answered in band.
    rule_id: str


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


#: The headers the proxy sets on a 200 that is a refusal in the shape of an
#: answer: the response gate withheld a tool call the model made, output DLP
#: withheld the body, or the cost-prediction gate answered instead of the
#: model. The first names the refusal's code, the second the rule that decided.
REFUSAL_HEADER = "x-intutic-refusal"
REFUSAL_RULE_HEADER = "x-intutic-refusal-rule"


def header_refusal(code: Optional[str], rule_id: Optional[str], message: str) -> Optional[ProxyRefusal]:
    """The refusal a 2xx response names in REFUSAL_HEADER, or None for a real answer."""
    if not code:
        return None
    return _named(code, rule_id, message)


#: The prefix of the SSE comment line that names a refusal on a stream:
#: `: intutic-refusal {"code", "rule", "message"}`. The response headers went
#: out before the refusal happened, so a stream says it in band; every SSE
#: parser skips comment lines, so clients that do not look for it are
#: unaffected.
STREAM_REFUSAL_MARKER = ": intutic-refusal "


def stream_refusal(text: str) -> Optional[ProxyRefusal]:
    """The refusal named anywhere in a stream's text, or None when there is
    none. Pass the whole body, or each line as it arrives."""
    for line in text.split("\n"):
        if not line.startswith(STREAM_REFUSAL_MARKER):
            continue
        try:
            payload = json.loads(line[len(STREAM_REFUSAL_MARKER):])
        except ValueError:
            continue
        if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
            continue
        rule = payload.get("rule")
        message = payload.get("message")
        return _named(
            payload["code"],
            rule if isinstance(rule, str) else None,
            message if isinstance(message, str) else "",
        )
    return None


def _named(code: str, rule_id: Optional[str], message: str) -> ProxyRefusal:
    # A code this SDK version does not know is still a refusal: the proxy only
    # names a response it did not let through.
    known = PROXY_REFUSALS.get(code)
    refusal: ProxyRefusal = {
        "verdict": known[1] if known else "kill",
        "code": code,
        "message": message or code,
    }
    if rule_id:
        refusal["rule_id"] = rule_id
    return refusal
