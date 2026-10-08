"""The Python half of the SSO-group conformance suite.

packages/shared-types/fixtures/sso-group-clearance-vectors.json is run by the
control plane's resolveSsoGroupPrivilege, the MCP proxy, the emitted harness
gates and @intutic/gate. This runs it through this package's port of the
evaluator, and then through Gate.guard reading a real policy-snapshot file,
which is how the port is reached in production.

The file is read from the monorepo checkout. A missing file is a failure, not a
skip: a skip would read as "every vector agrees".
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest

from intutic_clawde.gate import snapshot as snap
from intutic_clawde.gate import sso_groups
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "sso-group-clearance-vectors.json"


def _vectors() -> dict:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing — this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


VECTORS = _vectors()
CASES = VECTORS["cases"]


def record_line(policy, member_groups) -> str:
    """The @sso_groups line exactly as the sync daemon writes it."""
    record = {
        "policy": policy,
        "member": None if member_groups is None else {"memberId": "mem_1", "ssoGroups": member_groups},
        "issuedAt": "2026-10-08T00:00:00.000Z",
    }
    return "@sso_groups\t" + base64.b64encode(json.dumps(record).encode("utf-8")).decode("ascii")


def snapshot_file(tmp_path, body: list[str], digest_of: list[str] | None = None) -> str:
    digest = hashlib.sha256("\n".join(body if digest_of is None else digest_of).encode("utf-8")).hexdigest()[:32]
    p = tmp_path / "policy-snapshot.rules"
    p.write_text("\n".join([f"#digest {digest}", "#workspace ws_test", *body]) + "\n", encoding="utf-8")
    return str(p)


def guard(monkeypatch, path: str, tool: str):
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", path)
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=False, use_sop_rules=False))
    try:
        gate.guard(tool, {})
    except IntuticGateRefusal as refusal:
        return refusal
    return None


def test_vector_file_covers_all_three_clearances() -> None:
    assert len(CASES) >= 20
    assert {c["clearance"] for c in CASES} == {"GRANTED", "DENIED", "REQUIRES_OBO"}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_evaluator_reaches_the_vector(case: dict) -> None:
    d = sso_groups.evaluate(
        sso_groups.parse_policy(VECTORS["policies"][case["policy"]]), case["toolName"], case["memberGroups"],
    )
    assert d.clearance == case["clearance"]
    assert d.rule_id == case["ruleId"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_gate_over_a_snapshot_reaches_the_vector(case: dict, tmp_path, monkeypatch) -> None:
    policy = VECTORS["policies"][case["policy"]]
    # No policy is no record, which is what the daemon writes for it.
    body = [] if policy is None else [record_line(policy, case["memberGroups"])]
    refusal = guard(monkeypatch, snapshot_file(tmp_path, body), case["toolName"])
    if case["clearance"] == "GRANTED":
        assert refusal is None, refusal and refusal.reason
    else:
        assert refusal is not None and refusal.code == "SSO_GROUP"
        assert refusal.reason.endswith(f"[{case['ruleId']}]")


class TestEditedSnapshot:
    POLICY = {"highRiskTools": ["Bash"], "requiredGroups": ["sre-oncall"], "requireOboFor": []}

    def test_an_edited_group_list_fails_the_digest_and_clears_nothing(self, tmp_path, monkeypatch) -> None:
        original = record_line(self.POLICY, ["eng"])
        edited = record_line(self.POLICY, ["eng", "sre-oncall"])
        path = snapshot_file(tmp_path, [edited], digest_of=[original])

        s = snap.load_snapshot("ws_test", path)
        assert s.state == "invalid"
        assert s.sso_groups is not None and s.sso_groups.member_groups is None

        refusal = guard(monkeypatch, path, "Bash")
        assert refusal is not None
        assert refusal.reason == (
            "SSO group policy: Bash requires one of the SSO groups sre-oncall, and this gate does not know "
            "the member's groups [sso_group.high_risk.Bash]"
        )

    def test_a_cleared_member_is_refused_once_the_snapshot_fails_its_check(self, tmp_path, monkeypatch) -> None:
        cleared = record_line(self.POLICY, ["sre-oncall"])
        assert guard(monkeypatch, snapshot_file(tmp_path, [cleared]), "Bash") is None
        assert guard(monkeypatch, snapshot_file(tmp_path, [cleared], digest_of=["something else"]), "Bash") is not None

    def test_not_disarmed_by_guard_disable(self, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv("INTUTIC_GUARD_DISABLE", "1")
        assert guard(monkeypatch, snapshot_file(tmp_path, [record_line(self.POLICY, ["eng"])]), "Bash") is not None

    def test_a_damaged_record_is_ignored_rather_than_fatal(self) -> None:
        assert sso_groups.decode_record("@sso_groups\tnot-base64!") is None
        assert sso_groups.decode_record("sop.x\tblock\t-\ttool\tr\t (Bash) ") is None
