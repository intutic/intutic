"""Fault injection in the hook gates, decided as the shared vectors say.

packages/shared-types/fixtures/chaos-gate-vectors.json holds the cases;
chaos.py is the Python the bash gates emit, and chaosGate.ts the JavaScript
the JS gates emit, which runs the same file. The Python twin of
packages/shared-types/src/__tests__/chaosGate.test.ts.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import pytest

from intutic_clawde.gate import chaos

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "packages" / "shared-types" / "fixtures" / "chaos-gate-vectors.json").read_text(encoding="utf-8"))
TS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def encode(value) -> str:
    """base64url without padding, as encodeChaosPlan writes it."""
    return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")


def raw_of(v: dict) -> str:
    return v["raw"] if "raw" in v else encode(v["plan"])


@pytest.mark.parametrize("v", VECTORS["valid"], ids=[v["name"] for v in VECTORS["valid"]])
def test_valid(tmp_path: Path, v: dict) -> None:
    events = str(tmp_path / "events.jsonl")
    outcomes = []
    for c in v["calls"]:
        # Decoded on every call, as a gate process does.
        plan, error = chaos.chaos_decode(encode(v["plan"]))
        assert error is None
        fault = chaos.chaos_call(plan, events, c, chaos.chaos_now())
        if fault is None:
            outcomes.append({"outcome": c["decision"]})
        elif fault["kind"] == "delay":
            outcomes.append({"outcome": "allow", "delayS": fault["delayS"]})
        else:
            out = {"outcome": "deny", "reason": fault["reason"]}
            if fault["delayS"]:
                out["delayS"] = fault["delayS"]
            outcomes.append(out)
    expected = [{k: c[k] for k in ("outcome", "reason", "delayS") if k in c} for c in v["calls"]]
    assert outcomes == expected

    lines = [json.loads(line) for line in Path(events).read_text(encoding="utf-8").splitlines() if line]
    for e in lines:
        assert TS.match(e["ts"])
        assert e["runId"] == v["plan"]["runId"]
        assert e["component"] == "gate"
    assert [{k: x for k, x in e.items() if k not in ("ts", "runId", "component")} for e in lines] == v["events"]


@pytest.mark.parametrize("v", VECTORS["invalid"], ids=[v["name"] for v in VECTORS["invalid"]])
def test_invalid(v: dict) -> None:
    plan, error = chaos.chaos_decode(raw_of(v))
    assert plan is None
    assert error.startswith("INTUTIC_CHAOS_PLAN is not")


def test_padded_base64url() -> None:
    raw = encode({"v": 1, "runId": "run_padding", "repetition": 0, "canary": "E-INTUTIC-C0FFEE", "faults": []})
    plan, error = chaos.chaos_decode(raw + "=" * ((4 - len(raw) % 4) % 4))
    assert error is None and plan["runId"] == "run_padding"


def test_events_file_it_cannot_write(tmp_path: Path) -> None:
    plan, _ = chaos.chaos_decode(encode(VECTORS["valid"][2]["plan"]))
    events = str(tmp_path / "missing" / "events.jsonl")
    call = {"tool": "Bash", "decision": "allow", "destructive": False, "policyHit": False}
    # Never raises; the counters cannot be kept either, so no fault is due.
    assert chaos.chaos_call(plan, events, call, chaos.chaos_now()) is None
