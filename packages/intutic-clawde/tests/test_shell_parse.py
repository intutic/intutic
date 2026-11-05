"""The shared shell-parse vectors, run against this port."""

import json
from pathlib import Path

import pytest

from intutic_clawde.gate.shell_parse import parse

_VECTORS = Path(__file__).resolve().parents[2] / "shared-types/fixtures/shell-parse-vectors.json"
_CASES = json.loads(_VECTORS.read_text(encoding="utf-8"))["cases"] if _VECTORS.exists() else []


@pytest.mark.skipif(not _VECTORS.exists(), reason="the monorepo fixture is not in this checkout")
@pytest.mark.parametrize("case", _CASES, ids=lambda c: repr(c["text"])[:40])
def test_shared_vector_parses_as_listed(case):
    got = parse(case["text"])
    if got is not None:
        got = [[{"argv": c.argv, "literal": c.literal} for c in p] for p in got]
    assert got == case["parsed"]
