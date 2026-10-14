"""The OPAQUE intervention mode in the Python gate.

A snapshot carrying the ``@intervention_mode`` record makes every refusal on
workspace policy tell the agent ``OPAQUE_REFUSAL_MESSAGE``, with the same code,
while the emitted event keeps the rule. Without the record the refusal names
the rule. The Python twin of packages/gate-js/src/__tests__/opaque.test.ts.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import io

from intutic_clawde.gate import soprules
from intutic_clawde.gate.client import GateClient, GateResponse
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateHold, IntuticGateRefusal
from intutic_clawde.gate.opaque import INTERVENTION_MODE_RECORD_TAG, OPAQUE_REFUSAL_MESSAGE

FIXTURE = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "refusal-codes.json"

WRITE_RULE = "\t".join(["sop.s_write", "block", "", "tool", "no writes to the ledger", " (Write) "])
HOLD_RULE = "\t".join(["sop.s_deploy", "hold", "", "tool", "deploys need a reviewer", " (Deploy) "])
REGISTRY = "@mcp_registry\t" + base64.b64encode(json.dumps({
    "defaultPolicy": "allow", "approvedServers": [], "blockedServers": ["pastebin"],
    "heldServers": [], "disabledTools": {},
}).encode("utf-8")).decode("ascii")
OPAQUE_LINE = f"{INTERVENTION_MODE_RECORD_TAG}\tOPAQUE"


def snapshot_file(tmp_path, body: list[str], digest_of: list[str] | None = None) -> str:
    digest = hashlib.sha256("\n".join(body if digest_of is None else digest_of).encode("utf-8")).hexdigest()[:32]
    p = tmp_path / f"snap-{len(list(tmp_path.iterdir()))}.rules"
    p.write_text("\n".join([f"#digest {digest}", "#workspace ws_test", *body]) + "\n", encoding="utf-8")
    return str(p)


class RecordingClient(GateClient):
    def __init__(self, verdict: GateResponse | None = None):
        super().__init__(base_url="http://127.0.0.1:9", api_key="k", workspace_id="ws_test", session_id="sess_opaque")
        self.events: list[tuple[str, str, str]] = []
        self.verdict = verdict or GateResponse(allowed=True)

    def emit(self, event, tool_name, reason="", tool_input=None, incident_id=None, file_path=None):
        self.events.append((event, tool_name, reason))
        return True

    def hook_gate(self, tool_name, tool_input):
        return self.verdict


def guard(monkeypatch, path: str, tool: str, client: GateClient | None = None, sop_rules=None):
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", path)
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=client is not None,
                           use_sop_rules=sop_rules is not None), client)
    if sop_rules is not None:
        gate._sop_rules = sop_rules
    try:
        gate.guard(tool, {})
    except IntuticGateRefusal as refusal:
        return refusal
    return None


def test_the_sentence_is_the_shared_one():
    assert json.loads(FIXTURE.read_text(encoding="utf-8"))["opaqueMessage"] == OPAQUE_REFUSAL_MESSAGE


def test_a_snapshot_rule_is_refused_without_naming_it(tmp_path, monkeypatch):
    client = RecordingClient()
    r = guard(monkeypatch, snapshot_file(tmp_path, [OPAQUE_LINE, WRITE_RULE]), "Write", client)
    assert r.code == "SNAPSHOT"
    assert r.reason == OPAQUE_REFUSAL_MESSAGE
    assert str(r) == f"[Intutic Governance] BLOCKED: {OPAQUE_REFUSAL_MESSAGE}"
    assert ("tool_blocked", "Write", "no writes to the ledger [sop.s_write]") in client.events


def test_a_transparent_workspace_still_names_the_rule(tmp_path, monkeypatch):
    r = guard(monkeypatch, snapshot_file(tmp_path, [WRITE_RULE]), "Write")
    assert r.code == "SNAPSHOT"
    assert r.reason == "no writes to the ledger [sop.s_write]"


def test_the_mcp_registry_rule_is_hidden_and_its_code_kept(tmp_path, monkeypatch):
    client = RecordingClient()
    r = guard(monkeypatch, snapshot_file(tmp_path, [OPAQUE_LINE, REGISTRY, WRITE_RULE]), "mcp__pastebin__paste", client)
    assert r.code == "SERVER_BLOCKED"
    assert r.reason == OPAQUE_REFUSAL_MESSAGE
    blocked = [e for e in client.events if e[0] == "tool_blocked"]
    assert blocked[-1][2].endswith("[mcp_registry.pastebin]")


def test_an_sop_register_rule_is_hidden(tmp_path, monkeypatch):
    rule = soprules.SopRule(id="r1", tool_pattern="^Bash$", action="block", reason="no shell on prod")
    client = RecordingClient()
    r = guard(monkeypatch, snapshot_file(tmp_path, [OPAQUE_LINE, WRITE_RULE]), "Bash", client, [rule])
    assert r.code == "SOP_RULE"
    assert r.reason == OPAQUE_REFUSAL_MESSAGE
    assert ("tool_blocked", "Bash", "[sop:r1] no shell on prod") in client.events
    t = guard(monkeypatch, snapshot_file(tmp_path, [WRITE_RULE]), "Bash", None, [rule])
    assert t.reason == "[sop:r1] no shell on prod"


def test_the_hook_gates_reason_is_hidden_and_its_code_kept(tmp_path, monkeypatch):
    client = RecordingClient(GateResponse(allowed=False, reason="blocked [mcp_registry.pastebin]", code="SERVER_BLOCKED"))
    r = guard(monkeypatch, snapshot_file(tmp_path, [OPAQUE_LINE, WRITE_RULE]), "mcp__pastebin__paste", client)
    assert r.code == "SERVER_BLOCKED"
    assert r.reason == OPAQUE_REFUSAL_MESSAGE


def test_a_hold_is_worded_without_the_rule(tmp_path, monkeypatch):
    r = guard(monkeypatch, snapshot_file(tmp_path, [OPAQUE_LINE, HOLD_RULE]), "Deploy")
    assert isinstance(r, IntuticGateHold)
    assert r.code == "HELD"
    assert OPAQUE_REFUSAL_MESSAGE in str(r)
    assert "sop.s_deploy" not in str(r) and "deploys need a reviewer" not in str(r)
    t = guard(monkeypatch, snapshot_file(tmp_path, [HOLD_RULE]), "Deploy")
    assert "deploys need a reviewer [sop.s_deploy]" in str(t)


def test_a_refusal_that_says_nothing_about_the_policy_is_unchanged(tmp_path, monkeypatch):
    path = snapshot_file(tmp_path, [OPAQUE_LINE, REGISTRY], digest_of=["something else"])
    r = guard(monkeypatch, path, "mcp__github__create_issue")
    assert r.code == "POLICY_SNAPSHOT_UNVERIFIED"
    assert r.reason != OPAQUE_REFUSAL_MESSAGE


RULES = [{"id": "r1", "toolPattern": "^Bash$", "action": "block", "reason": "no shell on prod"}]


def guard_register(tmp_path, monkeypatch, body):
    """A gate with no snapshot whose SOP register answers ``body`` over HTTP."""
    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(soprules.urllib.request, "urlopen", lambda req, timeout=None: Resp(json.dumps(body).encode()))
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", str(tmp_path / "no-such-snapshot.rules"))
    client = RecordingClient()
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=False), client)
    try:
        gate.guard("Bash", {})
    except IntuticGateRefusal as refusal:
        return refusal, client.events
    return None, client.events


def test_with_no_snapshot_the_register_mode_hides_a_register_rule(tmp_path, monkeypatch):
    r, events = guard_register(tmp_path, monkeypatch, {"rules": RULES, "interventionMode": "OPAQUE"})
    assert r.code == "SOP_RULE"
    assert r.reason == OPAQUE_REFUSAL_MESSAGE
    assert ("tool_blocked", "Bash", "[sop:r1] no shell on prod") in events


def test_with_no_snapshot_a_transparent_or_older_register_names_the_rule(tmp_path, monkeypatch):
    for body in ({"rules": RULES, "interventionMode": "TRANSPARENT"}, {"rules": RULES}):
        r, _ = guard_register(tmp_path, monkeypatch, body)
        assert r.reason == "[sop:r1] no shell on prod"


def test_the_register_parses_the_mode_beside_the_rules():
    assert soprules.parse_register({"rules": RULES, "interventionMode": "opaque"}).opaque is True
    assert soprules.parse_register({"rules": RULES, "interventionMode": "SILENT_LOG"}).opaque is False
    assert soprules.parse_register(RULES).opaque is False
    assert len(soprules.parse_register({"rules": RULES}).rules) == 1
