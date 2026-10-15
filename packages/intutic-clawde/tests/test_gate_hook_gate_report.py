"""What ``Gate.guard`` reports after the hook gate answered.

The Python twin of packages/gate-js/src/__tests__/hookGateReport.test.ts:
every answer is reported (``tool_blocked`` / ``tool_allowed``), carrying the
answer's ``decision_id`` as ``gateDecisionId``, so the control plane files the
decision's incident once (the hook gate's own, for its DLP check) and exports
it to SIEM once.
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
        self.events: list[tuple] = []
        self.verdict = verdict

    def emit(self, event, tool_name, reason="", tool_input=None, incident_id=None, file_path=None,
             gate_decision_id=None):
        self.events.append((event, tool_name, reason, gate_decision_id))
        return True

    def hook_gate(self, tool_name, tool_input):
        return self.verdict


def guard(tmp_path, monkeypatch, verdict: GateResponse):
    digest = hashlib.sha256(RULE.encode("utf-8")).hexdigest()[:32]
    snap = tmp_path / "snap.rules"
    snap.write_text(f"#digest {digest}\n#workspace ws_test\n{RULE}\n", encoding="utf-8")
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(snap))
    client = RecordingClient(verdict)
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=True, use_sop_rules=False), client)
    try:
        gate.guard("Bash", {"command": "echo hi"})
        return client, None
    except IntuticGateRefusal as refusal:
        return client, refusal


def reports(client):
    return [e for e in client.events if e[0] in ("tool_blocked", "tool_allowed")]


def test_a_dlp_refusal_naming_an_incident_is_reported_with_its_decision_id(tmp_path, monkeypatch):
    client, refusal = guard(tmp_path, monkeypatch, GateResponse(
        allowed=False, reason="DLP: AWS key detected", incident_id="gi_1", decision_id="hgd_1"))
    assert refusal.code == "HOOK_GATE"
    assert refusal.incident_id == "gi_1"
    assert reports(client) == [("tool_blocked", "Bash", "DLP: AWS key detected", "hgd_1")]


def test_a_rule_refusal_is_reported_with_its_decision_id(tmp_path, monkeypatch):
    client, _ = guard(tmp_path, monkeypatch, GateResponse(
        allowed=False, reason="no shell on prod [sop.r1]", decision_id="hgd_2"))
    assert reports(client) == [("tool_blocked", "Bash", "no shell on prod [sop.r1]", "hgd_2")]


def test_a_key_without_the_hook_gate_scope_is_refused_as_insufficient_scope(tmp_path, monkeypatch):
    reason = "hook-gate refused the API key (INSUFFICIENT_SCOPE): it needs the gateway:use scope"
    client, refusal = guard(tmp_path, monkeypatch, GateResponse(
        allowed=False, reason=reason, code="INSUFFICIENT_SCOPE"))
    assert refusal.code == "INSUFFICIENT_SCOPE"
    assert "gateway:use" in refusal.reason
    assert reports(client) == [("tool_blocked", "Bash", reason, None)]


def test_an_allow_is_reported_with_its_decision_id(tmp_path, monkeypatch):
    client, refusal = guard(tmp_path, monkeypatch, GateResponse(allowed=True, decision_id="hgd_3"))
    assert refusal is None
    assert reports(client) == [("tool_allowed", "Bash", "", "hgd_3")]


def test_an_answer_without_a_decision_id_is_reported_without_one(tmp_path, monkeypatch):
    client, _ = guard(tmp_path, monkeypatch, GateResponse(
        allowed=False, reached=False, reason="hook-gate unreachable — failing closed (fail_closed=True)"))
    assert reports(client) == [
        ("tool_blocked", "Bash", "hook-gate unreachable — failing closed (fail_closed=True)", None)]
