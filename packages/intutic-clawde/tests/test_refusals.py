"""PROXY_REFUSALS checked against the proxy's own source, so a refusal the
proxy adds or renames fails here rather than turning back into a retried
connection error."""

import json
import re
from pathlib import Path

from intutic_clawde.refusals import PROXY_REFUSALS, parse_refusal

PROXY_RS = Path(__file__).resolve().parents[2] / "proxy" / "src" / "proxy.rs"

STATUS = {
    "BAD_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "PAYMENT_REQUIRED": 402,
    "FORBIDDEN": 403,
    "CONFLICT": 409,
    "TOO_MANY_REQUESTS": 429,
    "INTERNAL_SERVER_ERROR": 500,
    "BAD_GATEWAY": 502,
    "SERVICE_UNAVAILABLE": 503,
}

#: 4xx errors the proxy returns that are not governance decisions: credentials,
#: workspace binding, a malformed request or route. A new 4xx code in proxy.rs
#: must land here or in PROXY_REFUSALS.
NOT_REFUSALS = {
    "missing_key",
    "vk_required",
    "unauthorized",
    "workspace_mismatch",
    "org_mismatch",
    "invalid_body",
    "unsupported_route",
    "byok_required",
    "no_upstream_credential",
}


def _proxy_errors():
    source = PROXY_RS.read_text(encoding="utf-8")
    found = []
    for name, code in re.findall(r'json_error\(\s*StatusCode::([A-Z_]+),\s*"([A-Za-z_]+)"', source):
        assert name in STATUS, f"unmapped StatusCode::{name}"
        found.append((STATUS[name], code))
    assert len(found) > 20
    return found


def test_every_refusal_has_the_status_the_proxy_sends_it_with():
    errors = _proxy_errors()
    for code, (status, _verdict) in PROXY_REFUSALS.items():
        assert {s for s, c in errors if c == code} == {status}, code


def test_every_4xx_code_the_proxy_sends_is_classified():
    unclassified = [
        f"{status} {code}"
        for status, code in _proxy_errors()
        if status < 500 and code not in PROXY_REFUSALS and code not in NOT_REFUSALS
    ]
    assert unclassified == []


def test_status_and_code_must_agree():
    body = json.dumps({"error": {"type": "policy_denied", "message": "no"}})
    assert parse_refusal(403, body) == {"verdict": "kill", "code": "policy_denied", "message": "no"}
    assert parse_refusal(409, body) is None
    assert parse_refusal(403, "not json") is None
    assert parse_refusal(403, json.dumps({"error": "policy_denied"})) is None
    assert parse_refusal(403, json.dumps(["policy_denied"])) is None
