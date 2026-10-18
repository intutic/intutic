"""The guardrail layer vectors through the Python gate's decision path.

Each vector is a set of hook-rule guardrails, the rules ``GET /api/v1/sop/rules``
serves for them, one tool call and the decision every layer must reach. The
served envelope comes back from a stubbed ``urlopen``, so the rules go through
the real register fetch and parser into the real SOP-rule tier of
``Gate.guard``: ``block`` is a refusal naming the rule, ``warn`` lets the call
on with a ``tool_flagged`` event naming it, ``allow`` does neither. A refusal
wins over a shadow match wherever it sits in the list. The Python twin of
packages/gate-js/src/__tests__/guardrailLayerVectors.test.ts.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from intutic_clawde.gate import gate as gate_mod, snapshot as snapshot_mod, soprules
from intutic_clawde.gate.client import GateClient, GateResponse
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal

FIXTURE = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "guardrail-layer-vectors.json"
# A missing or unreadable fixture raises at collection and fails the module: never a skip.
VECTORS = json.loads(FIXTURE.read_text(encoding="utf-8"))["vectors"]

_EMPTY_SNAPSHOT = snapshot_mod.Snapshot(rules=[], state="ok", workspace_id="ws_layer")
_CONFIG_MAP = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: layer\ndata:\n  k: v\n"


class RecordingClient(GateClient):
    def __init__(self):
        super().__init__(base_url="http://127.0.0.1:9", api_key="k", workspace_id="ws_layer", session_id="sess_layer")
        self.events: list[tuple[str, str, str]] = []

    def emit(self, event, tool_name, reason="", tool_input=None, incident_id=None, file_path=None):
        self.events.append((event, tool_name, reason))
        return True

    def hook_gate(self, tool_name, tool_input):
        return GateResponse(allowed=True)


def _guard(v, tmp_path, monkeypatch):
    # The image-integrity tier runs on every deploy-shaped call (the terraform
    # and kubectl vectors). An allowlist and image-free manifests keep it out
    # of the decision, so the vectors measure the SOP-rule tier alone.
    (tmp_path / ".intutic").mkdir()
    (tmp_path / ".intutic" / "image-allowlist.json").write_text(
        json.dumps({"require_digest": True, "registries_allowed": [], "images": {}}))
    for name in ("deploy.yaml", "a.yaml"):
        (tmp_path / name).write_text(_CONFIG_MAP)

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    urls: list[str] = []

    def urlopen(req, timeout=None):
        urls.append(req.full_url)
        return Resp(json.dumps({"rules": v["served"]["hookRules"]}).encode("utf-8"))

    monkeypatch.setattr(soprules.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(gate_mod.snapshot, "load_snapshot", lambda _ws, **_kw: _EMPTY_SNAPSHOT)
    client = RecordingClient()
    gate = Gate(GateConfig(repo_root=str(tmp_path), workspace_id="ws_layer", use_hook_gate=False), client)
    call = v["toolCall"]
    try:
        gate.guard(call["tool"], call["toolInput"])
    except IntuticGateRefusal as refusal:
        return refusal, client.events, urls
    return None, client.events, urls


def test_reads_the_vector_file_with_every_decision_represented():
    assert len(VECTORS) >= 32
    # Rules scoped to roles, as served to a member of the vector's role: the
    # control plane serves a member's key only its role's rules.
    scoped = [v for v in VECTORS if '"roles":' in json.dumps(v, separators=(",", ":"))]
    assert len(scoped) >= 8
    assert {v["expected"]["decision"] for v in scoped} >= {"block", "allow"}
    assert {v["expected"]["decision"] for v in VECTORS} >= {"block", "warn", "allow"}


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_layer_vector(v, tmp_path, monkeypatch):
    refusal, events, urls = _guard(v, tmp_path, monkeypatch)
    assert any("/api/v1/sop/rules" in u for u in urls), "the rules came from the register"
    flagged = [reason for event, _tool, reason in events if event == "tool_flagged"]
    decision, rule_id = v["expected"]["decision"], v["expected"]["ruleId"]
    if decision == "block":
        assert refusal is not None, "refused"
        assert refusal.code == "SOP_RULE"
        assert f"[sop:{rule_id}]" in refusal.reason
        assert flagged == []
    elif decision == "warn":
        assert refusal is None, f"not refused: {refusal and refusal.reason}"
        assert any(f"[sop:{rule_id}]" in r for r in flagged)
    else:
        assert refusal is None, f"not refused: {refusal and refusal.reason}"
        assert not any("[sop:" in r for r in flagged)
    # No rule other than the deciding one is named by a refusal or a flag.
    for r in v["served"]["hookRules"]:
        if r["id"] == rule_id:
            continue
        assert f"[sop:{r['id']}]" not in (refusal.reason if refusal else "")
        assert not any(f"[sop:{r['id']}]" in f for f in flagged)
