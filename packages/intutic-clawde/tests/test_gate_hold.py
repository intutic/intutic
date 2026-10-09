"""Holds in the SDK gate: a hold rule records a hold through the decisions API
and raises IntuticGateHold, unless an approved bypass covers this exact call.
The Python twin of packages/gate-js/src/__tests__/hold.test.ts.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from intutic_clawde.gate import gate as gate_mod
from intutic_clawde.gate import snapshot as snapshot_mod
from intutic_clawde.gate import soprules
from intutic_clawde.gate.client import GateClient
from intutic_clawde.gate.gate import GATE_REFUSAL_CODES, Gate, GateConfig, IntuticGateHold, IntuticGateRefusal
from intutic_clawde.gate.hold import canonical_json, hold_key

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages" / "shared-types" / "fixtures"
VECTORS = json.loads((FIXTURES / "hold-key-vectors.json").read_text(encoding="utf-8"))["vectors"]
CODES = json.loads((FIXTURES / "refusal-codes.json").read_text(encoding="utf-8"))["gate"]["refusals"]

RULE_ID = "sop.local.review_before.deploy"
DEPLOY = {"target": "prod", "image": "api@sha256:abc"}


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_hold_key_matches_the_shared_vectors(vector):
    assert canonical_json(vector["toolInput"]) == vector["canonical"]
    assert hold_key(" Deploy ", vector["toolInput"]) == ("deploy", vector["targetHash"])


def test_refusal_codes_are_the_shared_list():
    assert list(GATE_REFUSAL_CODES) == [c["code"] for c in CODES if c.get("only") != "typescript"]


def test_every_gate_refusal_code_is_documented():
    doc = (ROOT / "apps" / "docs" / "reference" / "gate-sdk.md").read_text(encoding="utf-8")
    assert re.findall(r"^\| `([A-Z_]+)` \|", doc, re.MULTILINE) == [c["code"] for c in CODES]


class FakeControlPlane:
    """Stands in for the control plane on both transports."""

    def __init__(self, bypasses=(), decisions_status=200, down=False):
        self.bypasses = list(bypasses)
        self.decisions_status = decisions_status
        self.down = down
        self.posts = []   # (path, body)

    def post(self, url, body, headers, timeout):
        if self.down:
            raise ConnectionError("connection refused")
        path = "/" + url.split("/", 3)[3]
        self.posts.append((path, body))
        if path == "/api/v1/decisions":
            return self.decisions_status, {"accepted": 1, "dropped": 0, "entryIds": ["dm_1"]}
        return 200, {}

    def get(self, url, headers, timeout):
        if self.down:
            raise ConnectionError("connection refused")
        return 200, {"ok": True, "bypasses": self.bypasses}

    def holds(self):
        return [b["holds"][0] for p, b in self.posts if p == "/api/v1/decisions"]

    def events(self):
        return [b["events"][0]["event"] for p, b in self.posts if p == "/api/v1/hook-events"]


def holding_gate(monkeypatch, cp, sop_rules=(), fail_closed=True):
    client = None
    if cp is not None:
        client = GateClient(base_url="http://cp.test", api_key="k", workspace_id="ws_1",
                            session_id="s_1", fail_closed=fail_closed,
                            transport=cp.post, get_transport=cp.get)
    snap = snapshot_mod.Snapshot(state="ok", workspace_id="ws_1", rules=[snapshot_mod.Rule(
        id=RULE_ID, severity="hold", subject="tool", reason="Held for human review: deploy",
        pattern=re.compile(r"(deploy)", re.IGNORECASE),
    )])
    monkeypatch.setattr(gate_mod.snapshot, "load_snapshot", lambda _ws: snap)
    g = Gate(GateConfig(workspace_id="ws_1", use_hook_gate=False), client=client)
    g._sop_rules = soprules.parse_rules({"rules": list(sop_rules)})
    return g


def bypass_for(tool_input, **extra):
    name, target_hash = hold_key("deploy", tool_input)
    entry = {
        "workspaceId": "ws_1", "sopRuleId": RULE_ID, "toolNameNormalized": name, "targetHash": target_hash,
        "holdId": "hold_prev", "decidedBy": "mem_admin",
        "decidedAt": datetime.now(timezone.utc).isoformat(),
        "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
    }
    entry.update(extra)
    return entry


def test_records_a_hold_and_raises_with_its_id_and_approval_instructions(monkeypatch):
    cp = FakeControlPlane()
    with pytest.raises(IntuticGateHold) as e:
        holding_gate(monkeypatch, cp).guard("deploy", DEPLOY)

    err = e.value
    # Callers that stop on every refusal stop on a hold too.
    assert isinstance(err, IntuticGateRefusal)
    assert err.code == "HELD"
    assert re.fullmatch(r"hold_[0-9a-z]+_[0-9a-f]{8}", err.hold_id)
    assert str(err).startswith(
        "[Intutic Governance] HELD: HELD for approval: Held for human review: deploy "
        "[sop.local.review_before.deploy]"
    )
    assert f"intutic decision approve {err.hold_id}" in str(err)
    assert "owner, admin or engineering manager" in str(err)
    assert "reviewHoldBypassEnabled" in str(err)

    name, target_hash = hold_key("deploy", DEPLOY)
    [hold] = cp.holds()
    assert hold == {
        "v": 1, "holdId": err.hold_id, "reason": RULE_ID, "tool": "deploy", "sessionId": "s_1",
        "at": hold["at"], "toolNameNormalized": name, "targetHash": target_hash,
        "context": {"source": "gate_sdk", "harness": "langgraph", "tool": "deploy",
                    "rule": "Held for human review: deploy"},
    }
    assert cp.events() == ["tool_held"]


def test_lets_the_identical_call_through_on_an_approved_bypass(monkeypatch):
    # Same arguments, other key order: still the identical call.
    cp = FakeControlPlane(bypasses=[bypass_for({"image": "api@sha256:abc", "target": "prod"})])
    holding_gate(monkeypatch, cp).guard("deploy", DEPLOY)
    assert cp.holds() == []
    assert cp.events() == ["hold_approved_bypass_used", "tool_allowed"]


@pytest.mark.parametrize("bypass", [
    bypass_for({"target": "staging", "image": "api@sha256:abc"}),
    bypass_for(DEPLOY, sopRuleId="sop.other"),
    bypass_for(DEPLOY, workspaceId="ws_2"),
    bypass_for(DEPLOY, expiresAt=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()),
], ids=["other arguments", "another rule", "another workspace", "expired"])
def test_holds_again_when_the_only_approval_is_for_another_call(monkeypatch, bypass):
    cp = FakeControlPlane(bypasses=[bypass])
    with pytest.raises(IntuticGateHold):
        holding_gate(monkeypatch, cp).guard("deploy", DEPLOY)
    assert len(cp.holds()) == 1


def test_stays_held_with_nothing_to_approve_when_the_hold_is_not_recorded(monkeypatch):
    cp = FakeControlPlane(decisions_status=503)
    with pytest.raises(IntuticGateHold) as e:
        holding_gate(monkeypatch, cp).guard("deploy", DEPLOY)
    assert e.value.hold_id is None
    assert "could not be recorded" in str(e.value)
    assert "intutic decision approve" not in str(e.value)


def test_stays_held_whatever_fail_closed_says_when_the_control_plane_is_down(monkeypatch):
    cp = FakeControlPlane(down=True)
    with pytest.raises(IntuticGateHold) as e:
        holding_gate(monkeypatch, cp, fail_closed=False).guard("deploy", DEPLOY)
    assert e.value.hold_id is None


def test_stays_held_without_a_client(monkeypatch):
    with pytest.raises(IntuticGateHold) as e:
        holding_gate(monkeypatch, None).guard("deploy", DEPLOY)
    assert e.value.hold_id is None


def test_holds_a_register_rule_under_its_snapshot_id(monkeypatch):
    cp = FakeControlPlane()
    rule = {"id": "deploys", "toolPattern": "^ship$", "action": "require_approval", "reason": "Ships need review"}
    g = holding_gate(monkeypatch, cp, sop_rules=[rule])
    with pytest.raises(IntuticGateHold):
        g.guard("ship", DEPLOY)
    assert [h["reason"] for h in cp.holds()] == ["sop.deploys"]


def test_one_approval_covers_a_rule_in_both_the_snapshot_and_the_register(monkeypatch):
    cp = FakeControlPlane(bypasses=[bypass_for(DEPLOY)])
    rule = {"id": "local.review_before.deploy", "toolPattern": "^deploy$", "action": "require_approval", "reason": "r"}
    holding_gate(monkeypatch, cp, sop_rules=[rule]).guard("deploy", DEPLOY)
    assert cp.holds() == []
