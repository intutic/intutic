"""PROXY_REFUSALS checked against the one shared list of refusal codes and
against the proxy's own source, so a refusal the proxy adds or renames fails
here rather than turning back into an allow or a retried connection error."""

import json
import re
from pathlib import Path

from intutic_clawde.refusals import (
    PROXY_REFUSALS,
    REFUSAL_HEADER,
    REFUSAL_RULE_HEADER,
    STREAM_REFUSAL_MARKER,
    parse_refusal,
    stream_refusal,
)

PACKAGES = Path(__file__).resolve().parents[2]
PROXY_RS = PACKAGES / "proxy" / "src" / "proxy.rs"
SHARED = json.loads((PACKAGES / "shared-types" / "fixtures" / "refusal-codes.json").read_text(encoding="utf-8"))["proxy"]

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


def _proxy_errors():
    source = PROXY_RS.read_text(encoding="utf-8")
    found = []
    for name, code in re.findall(r'json_error\(\s*StatusCode::([A-Z_]+),\s*"([A-Za-z_]+)"', source):
        assert name in STATUS, f"unmapped StatusCode::{name}"
        found.append((STATUS[name], code))
    assert len(found) > 20
    return found


def test_the_table_is_the_shared_list():
    assert PROXY_REFUSALS == {r["code"]: (r["status"], r["verdict"]) for r in SHARED["refusals"]}
    assert (REFUSAL_HEADER, REFUSAL_RULE_HEADER, STREAM_REFUSAL_MARKER) == (
        SHARED["header"], SHARED["ruleHeader"], SHARED["streamMarker"],
    )


def test_every_error_body_refusal_has_the_status_the_proxy_sends_it_with():
    errors = _proxy_errors()
    for code, (status, _verdict) in PROXY_REFUSALS.items():
        if status == 200:
            continue
        assert {s for s, c in errors if c == code} == {status}, code


def test_every_4xx_code_the_proxy_sends_is_classified():
    not_refusals = set(SHARED["notRefusals"])
    unclassified = [
        f"{status} {code}"
        for status, code in _proxy_errors()
        if status < 500 and code not in PROXY_REFUSALS and code not in not_refusals
    ]
    assert unclassified == []


def test_status_and_code_must_agree():
    body = json.dumps({"error": {"type": "policy_denied", "message": "no"}})
    assert parse_refusal(403, body) == {"verdict": "kill", "code": "policy_denied", "message": "no"}
    assert parse_refusal(409, body) is None
    assert parse_refusal(403, "not json") is None
    assert parse_refusal(403, json.dumps({"error": "policy_denied"})) is None
    assert parse_refusal(403, json.dumps(["policy_denied"])) is None


def test_the_stream_marker_is_found_in_a_body_or_a_line():
    line = STREAM_REFUSAL_MARKER + json.dumps({"code": "TOOL_DENIED", "rule": "deny_tools.Bash", "message": "no Bash"})
    expected = {"verdict": "kill", "code": "TOOL_DENIED", "message": "no Bash", "rule_id": "deny_tools.Bash"}
    assert stream_refusal(line) == expected
    assert stream_refusal(f'data: {{"choices":[]}}\n\n{line}\n\ndata: [DONE]\n\n') == expected


def test_the_stream_marker_ignores_every_other_line():
    assert stream_refusal('data: {"choices":[]}\n\n: keep-alive\n\ndata: [DONE]\n\n') is None
    assert stream_refusal(STREAM_REFUSAL_MARKER + "{not json") is None
    assert stream_refusal(STREAM_REFUSAL_MARKER + '{"rule":"x"}') is None
    assert stream_refusal(STREAM_REFUSAL_MARKER + '["TOOL_DENIED"]') is None
