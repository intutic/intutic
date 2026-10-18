"""The Python gate's decide rules against the shared vectors.

packages/shared-types/fixtures/decide-vectors.json is run by the TypeScript
module, the proxy and this package; each must reach the same answers, reason
text included. The file is read from the monorepo checkout. A missing file is
a failure, not a skip: a skip would read as "every vector agrees".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from intutic_clawde.gate import decide, decide_record

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "decide-vectors.json"


def _vectors() -> dict:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing — this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


V = _vectors()


def test_every_group_this_layer_claims_has_cases() -> None:
    for group, layers in V["layers"].items():
        if "python" not in layers:
            continue
        cases = V[group]
        n = len(cases) if isinstance(cases, list) else sum(len(c) for c in cases.values())
        assert n > 0, group
    assert len(V["validate"]) >= 100


@pytest.mark.parametrize("case", V["validate"], ids=[c["name"] for c in V["validate"]])
def test_validate(case: dict) -> None:
    raw = case["raw"] if "raw" in case else json.dumps(case["rule"], ensure_ascii=False)
    d = decide.parse_decide_line(raw)
    if d["kind"] == "rule":
        got = {"ok": True, "when": decide.canonical_when(d["expr"])}
    else:
        got = {"ok": False, "id": d["id"], "error": d["error"]}
    assert got == case["expect"]


HASH_BY_NAME = {c["name"]: c for c in V["hash"]}


@pytest.mark.parametrize("case", V["hash"], ids=[c["name"] for c in V["hash"]])
def test_hash(case: dict) -> None:
    assert decide.validate_decide_rule(case["rule"])["ok"]
    assert decide.decide_hash_input(case["rule"]) == case["input"]
    assert decide.decide_rule_hash(case["rule"]) == case["ruleHash"]
    if "sameAs" in case:
        assert case["ruleHash"] == HASH_BY_NAME[case["sameAs"]]["ruleHash"]
    if "differsFrom" in case:
        assert case["ruleHash"] != HASH_BY_NAME[case["differsFrom"]]["ruleHash"]


def test_kleene() -> None:
    assert len(V["compose"]["kleene"]) == 9
    for r in V["compose"]["kleene"]:
        assert [decide.k_and(r["a"], r["b"]), decide.k_or(r["a"], r["b"]), decide.k_not(r["a"])] == [r["and"], r["or"], r["notA"]]


def test_bands() -> None:
    for r in V["compose"]["band"]:
        assert decide.band_value(r["p"], r["band"]) == r["value"], r["p"]


def test_choice_orders() -> None:
    for r in V["compose"]["orders"]:
        assert decide.choice_orders(r["n"]) == r["orders"]


@pytest.mark.parametrize("case", V["compose"]["choice"], ids=[c["name"] for c in V["compose"]["choice"]])
def test_choice(case: dict) -> None:
    assert decide.choice_atoms(case["options"], case["perOrder"], case["band"]) == case["atoms"]


@pytest.mark.parametrize("case", V["compose"]["rule"], ids=[c["name"] for c in V["compose"]["rule"]])
def test_rule(case: dict) -> None:
    v = decide.validate_decide_rule(case["rule"])
    assert v["ok"], v
    got = decide.decide_rule_outcome(v["rule"], v["expr"], case["answers"], case.get("combiner"))
    want = case["expect"]
    assert {k: got[k] for k in ("value", "outcome", "code", "via")} == {k: want[k] for k in ("value", "outcome", "code", "via")}
    if want.get("score") is not None:
        assert abs(got["score"] - want["score"]) < 1e-9
    else:
        assert got["score"] is None


@pytest.mark.parametrize("case", V["compose"]["call"], ids=[c["name"] for c in V["compose"]["call"]])
def test_call(case: dict) -> None:
    sel = decide.select_decide_rules(case["candidates"], case["tool"])
    out = decide.decide_call_outcome(sel, case["results"])
    got = {"evaluate": [c["ref"] for c in sel["evaluate"]], "skipped": [c["ref"] for c in sel["skipped"]], **out}
    assert got == case["expect"]


def test_nan_and_infinity_are_not_json() -> None:
    assert decide.parse_decide_line('{"id":"x","band":{"yes_at":NaN}}')["error"].startswith("decide: the value is not JSON")


# The snapshot's @format and @decide records (decide_record.py).

@pytest.mark.parametrize("case", V["record"]["format"], ids=[c["name"] for c in V["record"]["format"]])
def test_record_format(case: dict) -> None:
    assert decide_record.decode_snapshot_format_record(case["line"]) == case["format"]


@pytest.mark.parametrize("case", V["record"]["valid"], ids=[c["name"] for c in V["record"]["valid"]])
def test_record_valid(case: dict) -> None:
    assert decide_record.decode_decide_record(case["line"]) == case["record"]


@pytest.mark.parametrize("case", V["record"]["damaged"], ids=[c["name"] for c in V["record"]["damaged"]])
def test_record_damaged(case: dict) -> None:
    assert decide_record.decode_decide_record(case["line"]) is None
