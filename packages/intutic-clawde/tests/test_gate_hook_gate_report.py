"""What ``Gate.guard`` reports when the hook gate refuses a call.

The Python twin of packages/gate-js/src/__tests__/hookGateReport.test.ts: a
refusal that names an incident was filed by the hook gate itself (its DLP
check) and is not reported again; every other refusal is filed only by the
``tool_blocked`` event the gate sends, so that event is still sent.
"""

from __future__ import annotations

import hashlib

import pytest

from intutic_clawde.gate.client import GateClient, GateResponse
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal

RULE = "\t".join(["sop.s_write", "block", "", "tool", "no writes to the ledger", " (Write) "])


class RecordingClient(GateClient):
    def __init__(self, verdict: GateResponse):
        super().__init__(base_url="http://127.0.0.1:9", workspace_id="ws_test", session_id="sess_hookgate")
        self.events: list[tuple[str, str, str]] = []
        self.verdict = verdict

    def emit(self, event, tool_name, reason="", tool_input=None, incident_id=None, file_path=None):
        self.events.append((event, tool_name, reason))
        return True

    def hook_gate(self, tool_name, tool_input):
        return self.verdict


def refuse(tmp_path, monkeypatch, verdict: GateResponse):
    digest = hashlib.sha256(RULE.encode("utf-8")).hexdigest()[:32]
    snap = tmp_path / "snap.rules"
    snap.write_text(f"#digest {digest}\n#workspace ws_test\n{RULE}\n", encoding="utf-8")
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(snap))
    client = RecordingClient(verdict)
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=True, use_sop_rules=False), client)
    with pytest.raises(IntuticGateRefusal) as refusal:
        gate.guard("Bash", {"command": "echo hi"})
    return client, refusal.value


def blocked(client):
    return [e for e in client.events if e[0] == "tool_blocked"]


def test_a_refusal_naming_an_incident_is_not_reported_again(tmp_path, monkeypatch):
    client, refusal = refuse(tmp_path, monkeypatch, GateResponse(allowed=False, reason="DLP: AWS key detected", incident_id="gi_1"))
    assert refusal.code == "HOOK_GATE"
    assert blocked(client) == []


def test_a_refusal_naming_none_is_reported(tmp_path, monkeypatch):
    client, _ = refuse(tmp_path, monkeypatch, GateResponse(allowed=False, reason="no shell on prod [sop.r1]"))
    assert blocked(client) == [("tool_blocked", "Bash", "no shell on prod [sop.r1]")]
