"""A chaos run's faults in Gate.guard, held to the table every gate runs.

packages/shared-types/fixtures/chaos-gate-vectors.json holds the cases;
test_chaos_gate_vectors.py replays them through chaos.py as the vectors
decide. Here every vector whose calls governance allows replays end to end
through Gate.guard, the plan and events file in the environment as a chaos
run's runner sets them, and then Gate.guard's own refusals, holds and
destructive calls, from a snapshot. The Python twin of
packages/gate-js/src/__tests__/chaos.test.ts.
"""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path

import pytest

from intutic_clawde.gate import snapshot as snapshot_mod
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateHold, IntuticGateRefusal

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "packages" / "shared-types" / "fixtures" / "chaos-gate-vectors.json").read_text(encoding="utf-8"))
TS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
HELD = "Permission held for approval; retrying this exact call passes once it is approved [E-INTUTIC-C0FFEE]"
BASE = {"v": 1, "runId": "run_gate_sdk", "repetition": 1, "canary": "E-INTUTIC-C0FFEE"}

# Every vector whose calls governance allows as they are.
REPLAYABLE = [v for v in VECTORS["valid"] if all(
    c["decision"] == "allow" and not c.get("ruleId") and not c["destructive"] and not c["policyHit"] for c in v["calls"])]


def encode(value) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode("utf-8")).decode("ascii").rstrip("=")


def benign(tool: str) -> dict:
    return {"command": "ls -la"} if tool == "Bash" else (
        {"file_path": "notes.txt", "content": "hello"} if tool == "Write" else {"title": "x"})


def advance_clock(events: str, seconds: float) -> None:
    """Moves the clock forward: every counter file's modification time goes back by seconds."""
    directory = events + ".gate-counters"
    if not seconds or not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        t = os.stat(path).st_mtime - seconds
        os.utime(path, (t, t))


def read_events(events: str, run_id: str) -> list:
    if not os.path.exists(events):
        return []
    out = []
    for line in Path(events).read_text(encoding="utf-8").splitlines():
        e = json.loads(line)
        assert TS.match(e.pop("ts"))
        assert e.pop("runId") == run_id
        assert e.pop("component") == "gate"
        out.append(e)
    return out


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(tmp_path / "absent.rules"))
    monkeypatch.delenv("INTUTIC_GUARD_DISABLE", raising=False)
    monkeypatch.delenv("INTUTIC_CHAOS_PLAN", raising=False)
    monkeypatch.delenv("INTUTIC_CHAOS_EVENTS", raising=False)


def chaos_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, plan, raw=None):
    """A gate under a chaos run: the plan and a fresh events file in the environment, no client."""
    events = str(tmp_path / ("events-" + os.urandom(4).hex() + ".jsonl"))
    monkeypatch.setenv("INTUTIC_CHAOS_PLAN", raw if raw is not None else encode(plan))
    monkeypatch.setenv("INTUTIC_CHAOS_EVENTS", events)
    return Gate(GateConfig(repo_root=str(tmp_path), use_hook_gate=False, use_sop_rules=False)), events


def outcome(gate: Gate, tool: str, tool_input: dict) -> dict:
    """What a guarded call ended as, in the vectors' terms."""
    try:
        gate.guard(tool, tool_input)
        return {"outcome": "allow"}
    except IntuticGateHold as e:
        return {"outcome": "hold", "reason": e.reason, "hold_id": e.hold_id, "code": e.code}
    except IntuticGateRefusal as e:
        return {"outcome": "deny", "reason": e.reason, "code": e.code}


def with_snapshot(gate: Gate, rules: list) -> None:
    gate._snapshot = snapshot_mod.Snapshot(rules=[
        snapshot_mod.Rule(id=i, severity=sev, subject=subj, reason=reason, pattern=re.compile(pat, re.I))
        for i, sev, subj, reason, pat in rules], state="ok")


def test_replays_enough_vectors() -> None:
    assert len(REPLAYABLE) >= 7


@pytest.mark.parametrize("v", REPLAYABLE, ids=[v["name"] for v in REPLAYABLE])
def test_replays_the_shared_vectors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, v: dict) -> None:
    gate, events = chaos_gate(tmp_path, monkeypatch, v["plan"])
    for c in v["calls"]:
        advance_clock(events, c.get("advanceS", 0))
        got = outcome(gate, c["tool"], c.get("input") or benign(c["tool"]))
        assert {k: got[k] for k in ("outcome", "reason") if k in got} == {k: c[k] for k in ("outcome", "reason") if k in c}
        # A fault is never a governance code, and a held call has nothing to approve.
        if got["outcome"] == "deny":
            assert got["code"] == "CHAOS_FAULT"
        if got["outcome"] == "hold":
            assert got["hold_id"] is None and got["code"] == "HELD"
    assert read_events(events, v["plan"]["runId"]) == v["events"]


@pytest.mark.parametrize("v", VECTORS["invalid"], ids=[v["name"] for v in VECTORS["invalid"]])
def test_refuses_every_call_under_a_plan_it_cannot_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, v: dict) -> None:
    gate, events = chaos_gate(tmp_path, monkeypatch, None, v["raw"] if "raw" in v else encode(v["plan"]))
    got = outcome(gate, "Bash", benign("Bash"))
    assert got["outcome"] == "deny" and got["code"] == "CHAOS_FAULT"
    assert got["reason"].startswith("INTUTIC_CHAOS_PLAN is not")
    assert not os.path.exists(events)


def test_refuses_a_plan_with_no_events_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTUTIC_CHAOS_PLAN", encode(dict(BASE, faults=[])))
    got = outcome(Gate(GateConfig(use_hook_gate=False, use_sop_rules=False)), "Bash", benign("Bash"))
    assert got["code"] == "CHAOS_FAULT" and "INTUTIC_CHAOS_EVENTS is not" in got["reason"]


def test_changes_nothing_without_a_plan() -> None:
    assert outcome(Gate(GateConfig(use_hook_gate=False, use_sop_rules=False)), "Bash", benign("Bash")) == {"outcome": "allow"}


def test_messages_match_the_hook_gates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    held, _ = chaos_gate(tmp_path, monkeypatch, dict(BASE, faults=[{"id": "permission.deny_or_delay", "mode": "delay", "delay_s": 600}]))
    with pytest.raises(IntuticGateHold, match=re.escape("[Intutic Governance] HELD: " + HELD)):
        held.guard("Bash", benign("Bash"))
    failed, _ = chaos_gate(tmp_path, monkeypatch, dict(BASE, faults=[{"id": "tool.error", "message": "disk full"}]))
    with pytest.raises(IntuticGateRefusal, match=re.escape("[Intutic Governance] BLOCKED: disk full [E-INTUTIC-C0FFEE]")):
        failed.guard("Bash", benign("Bash"))


def test_reports_governance_decisions_and_faults_only_what_it_allowed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gate, events = chaos_gate(tmp_path, monkeypatch, dict(BASE, faults=[{"id": "tool.error", "message": "disk full"}]))
    with_snapshot(gate, [
        ("sop.local.review_before.notebookedit", "hold", "tool", "review notebooks", "notebookedit"),
        ("sop.s_edit", "block", "tool", "no edits", "edit"),
        ("destructive.sql_drop", "block", "command", "drops a table", "drop table"),
        ("destructive.rm_rf_root", "warn", "command", "removes everything", r"rm -rf /"),
    ])
    assert outcome(gate, "Edit", {"file_path": "a.txt"})["code"] == "SNAPSHOT"
    # A hold with no control plane to record it in: held, nothing to approve.
    assert outcome(gate, "NotebookEdit", {"notebook_path": "a.ipynb"})["hold_id"] is None
    # A destructive command at the warn tier: allowed by governance, then faulted.
    assert outcome(gate, "Bash", {"command": "rm -rf /"}) == {
        "outcome": "deny", "reason": "disk full [E-INTUTIC-C0FFEE]", "code": "CHAOS_FAULT"}
    assert outcome(gate, "Bash", {"command": 'psql -c "DROP TABLE users"'})["code"] == "SNAPSHOT"
    # Too large to read: refused before any tier, by no rule.
    assert outcome(gate, "Bash", {"command": "x" * (300 * 1024)})["code"] == "COMMAND_TOO_LARGE"
    assert read_events(events, BASE["runId"]) == [
        {"type": "plan_loaded", "faults": 1},
        {"type": "gate_decision", "tool": "Edit", "decision": "deny", "ruleId": "sop.s_edit", "destructive": False, "policyHit": True},
        {"type": "gate_decision", "tool": "NotebookEdit", "decision": "hold", "ruleId": "sop.local.review_before.notebookedit",
         "destructive": False, "policyHit": True},
        {"type": "gate_decision", "tool": "Bash", "decision": "allow", "ruleId": "destructive.rm_rf_root", "destructive": True, "policyHit": False},
        {"type": "fault_injected", "faultId": "tool.error", "call": 1, "target": "Bash"},
        {"type": "gate_decision", "tool": "Bash", "decision": "deny", "ruleId": "destructive.sql_drop", "destructive": True, "policyHit": True},
        {"type": "gate_decision", "tool": "Bash", "decision": "deny", "destructive": False, "policyHit": False},
    ]


def test_sees_a_destructive_command_the_escape_hatch_lets_through(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTUTIC_GUARD_DISABLE", "1")
    gate, events = chaos_gate(tmp_path, monkeypatch, dict(BASE, faults=[]))
    with_snapshot(gate, [("destructive.rm_rf_root", "block", "command", "removes everything", r"rm -rf /")])
    assert outcome(gate, "Bash", {"command": "rm -rf /"}) == {"outcome": "allow"}
    assert read_events(events, BASE["runId"]) == [
        {"type": "plan_loaded", "faults": 0},
        {"type": "gate_decision", "tool": "Bash", "decision": "allow", "destructive": True, "policyHit": False},
        {"type": "tool_call", "tool": "Bash", "ok": True},
    ]


def test_keys_a_held_call_by_its_tool_and_arguments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    gate, events = chaos_gate(tmp_path, monkeypatch, dict(BASE, faults=[{"id": "permission.deny_or_delay", "mode": "delay", "delay_s": 30}]))
    assert outcome(gate, "Write", {"file_path": "a.txt", "content": "x"})["outcome"] == "hold"
    advance_clock(events, 30)
    # The same arguments in another order: the held call's retry.
    assert outcome(gate, " write ", {"content": "x", "file_path": "a.txt"})["outcome"] == "allow"
