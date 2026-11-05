"""The shared shell-parse vectors, run against this port."""

import json
from pathlib import Path

import pytest

from intutic_clawde.gate.shell_parse import commands_outside_allow, parse_shell

_VECTORS = Path(__file__).resolve().parents[2] / "shared-types/fixtures/shell-parse-vectors.json"
_DOC = json.loads(_VECTORS.read_text(encoding="utf-8")) if _VECTORS.exists() else {"cases": [], "allow": []}
_CASES = _DOC["cases"]


@pytest.mark.skipif(not _VECTORS.exists(), reason="the monorepo fixture is not in this checkout")
@pytest.mark.parametrize("case", _CASES, ids=lambda c: repr(c["text"])[:40])
def test_shared_vector_parses_as_listed(case):
    got = parse_shell(case["text"])
    if got is not None:
        got = [[{"argv": c.argv, "literal": c.literal} for c in p] for p in got]
    assert got == case["parsed"]


@pytest.mark.parametrize("case", _DOC["allow"], ids=lambda c: repr(c["text"])[:40])
def test_shared_allow_vector(case):
    assert commands_outside_allow(case["text"], case["allow"]) == case["outside"]
