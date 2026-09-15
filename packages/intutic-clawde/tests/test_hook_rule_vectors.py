"""The Python SDK gate against the shared hook-rule vectors (LLD #71).

A generated hook rule is matched by the control plane's matchSopRule, the MCP
proxy's PolicyClient.matchRule, the emitted harness gates and the two SDK
gates. The first three already run
packages/shared-types/fixtures/hook-rule-vectors.json; this runs it through
this package's own envelope parser and matcher, with Python's `re` and the
JSON.stringify-shaped serialisation, so a vector Python reads differently from
JavaScript goes red here.

The file is read from the monorepo checkout. A missing file is a failure, not
a skip: a skip would read as "every vector agrees".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from intutic_clawde.gate import soprules

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "hook-rule-vectors.json"


def _vectors() -> list[dict]:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing — this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["vectors"]


VECTORS = _vectors()


def test_vector_file_is_not_empty() -> None:
    assert len(VECTORS) >= 8
    assert sum(len(v["cases"]) for v in VECTORS) >= 35


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector_fires_exactly_as_written(vector: dict) -> None:
    rendered = vector["rendered"]
    row = {"id": "guardrail.pgr_vector", "toolPattern": rendered["toolPattern"], "action": "block", "reason": rendered["reason"]}
    if rendered.get("argPattern"):
        row["argPattern"] = rendered["argPattern"]
    rules = soprules.parse_rules({"rules": [row]})
    assert len(rules) == 1, "the parser kept the rule"
    rule = rules[0]
    assert rule.arg_pattern == rendered.get("argPattern")
    for case in vector["cases"]:
        got = rule.matches(case["tool"], soprules.serialise_tool_input(case["toolInput"]))
        assert got is case["fires"], f'{case["tool"]} {json.dumps(case["toolInput"])}'
