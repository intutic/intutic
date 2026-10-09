"""Every gate rule this reader can load, decided as the shared vectors say and
in bounded time. packages/shared-types/fixtures/gate-rule-vectors.json is
generated from the rule tables in the sync daemon, which runs the same cases
through the hook gates' JavaScript, Python and grep. The Python twin of
packages/gate-js/src/__tests__/gateRuleVectors.test.ts.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from linear_time import assert_linear_time

from intutic_clawde.gate import snapshot as snapshot_mod
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal
from intutic_clawde.gate.limits import ARGUMENTS_SIZE_LIMIT, COMMAND_SIZE_LIMIT

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages" / "shared-types" / "fixtures"
VECTORS = json.loads((FIXTURES / "gate-rule-vectors.json").read_text(encoding="utf-8"))

# The rules a .rules reader decides on its own: not `content` (the serialized
# arguments, which this reader has no subject for; those rules live in the hook
# gates' compiled floor) and not one with an argument condition (which this
# reader does not read; see snapshot.py).
READABLE = [v for v in VECTORS["rules"] if v["subject"] != "content" and not v["argPattern"]]


def build_text(c: dict, scale: int = 4) -> str:
    """The adversarial text, length characters at most; a quarter of that at scale 1."""
    length = c["length"] // 4 * scale
    n = (length - len(c["prefix"]) - len(c["suffix"])) // len(c["unit"])
    return c["prefix"] + c["unit"] * n + c["suffix"]


def decide(tmp_path: Path, v: dict, call: dict) -> bool:
    path = tmp_path / "rule.rules"
    path.write_text(v["line"] + "\n", encoding="utf-8")
    snap = snapshot_mod.load_snapshot("", str(path))
    assert len(snap.rules) == 1, f"{v['id']} did not load"
    inp = call["input"]
    d = snapshot_mod.evaluate(call["tool"], inp.get("file_path", ""), inp.get("command", ""), snap)
    return d.severity == snapshot_mod.SEV_BLOCK


def test_every_readable_rule_is_covered():
    assert len(READABLE) > 30


@pytest.mark.parametrize("v", READABLE, ids=[v["id"] for v in READABLE])
def test_rule_decides_its_vectors(tmp_path, v):
    for k, call in enumerate(v["held"]):
        assert decide(tmp_path, v, call), f"{v['id']} held[{k}]"
    for k, call in enumerate(v["benign"]):
        assert not decide(tmp_path, v, call), f"{v['id']} benign[{k}]"
    for c in v["adversarial"]:
        calls = {scale: {"tool": c["tool"], "input": {**c["input"], c["fill"]: build_text(c, scale)}} for scale in (1, 4)}
        assert decide(tmp_path, v, calls[4]) == c["held"], f"{v['id']} adversarial {c['name']!r}"
        assert_linear_time(f"{v['id']} adversarial {c['name']!r}", lambda scale: decide(tmp_path, v, calls[scale]))


def test_limits_are_the_shared_limits():
    assert {"commandBytes": COMMAND_SIZE_LIMIT, "argumentsBytes": ARGUMENTS_SIZE_LIMIT} == {
        k: VECTORS["limits"][k] for k in ("commandBytes", "argumentsBytes")
    }


@pytest.fixture
def gate(tmp_path, monkeypatch):
    # No snapshot, no control plane: only the size check can refuse.
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(tmp_path / "absent.rules"))
    return Gate(GateConfig(workspace_id="ws", use_sop_rules=False, use_hook_gate=False))


def test_a_command_over_the_limit_is_refused_as_too_large(gate):
    with pytest.raises(IntuticGateRefusal) as exc:
        gate.guard("Bash", {"command": "é" * (COMMAND_SIZE_LIMIT // 2 + 1)})
    assert exc.value.code == "COMMAND_TOO_LARGE"


def test_arguments_over_the_limit_are_refused_as_too_large(gate):
    with pytest.raises(IntuticGateRefusal) as exc:
        gate.guard("Write", {"file_path": "notes.md", "content": "x" * ARGUMENTS_SIZE_LIMIT})
    assert exc.value.code == "COMMAND_TOO_LARGE"


def test_a_command_at_the_limit_is_evaluated(gate):
    gate.guard("Bash", {"command": "x" * COMMAND_SIZE_LIMIT})
