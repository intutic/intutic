"""The Python half of the MCP registry conformance suite.

packages/shared-types/fixtures/mcp-registry-vectors.json is run by
evaluateMcpRegistry, the MCP proxy, the control plane's hook gate, the emitted
hook gates and @intutic/gate. This runs it through mcp_registry.py, which the
bash hook gates also run, and through Gate.guard reading a real policy-snapshot
file, and checks the tamper rule the hook gates apply: a snapshot that fails
its digest keeps the registry's and the allowlist's refusals and drops what
they admit. The Python twin of packages/gate-js/src/__tests__/mcpRegistry.test.ts.

The file is read from the monorepo checkout. A missing file is a failure, not a
skip: a skip would read as "every vector agrees".
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest

from intutic_clawde.gate import mcp_registry
from intutic_clawde.gate import snapshot as snap
from intutic_clawde.gate.client import GateClient, GateResponse
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal

VECTORS_PATH = Path(__file__).resolve().parents[2] / "shared-types" / "fixtures" / "mcp-registry-vectors.json"


def _vectors() -> dict:
    assert VECTORS_PATH.is_file(), f"{VECTORS_PATH} is missing — this test would assert nothing"
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


VECTORS = _vectors()
CASES = VECTORS["cases"]
ALLOWLIST_CASES = VECTORS["allowlistCases"]

# A block SOP rule on Write, so a test can see whether the snapshot was read as valid.
WRITE_RULE = "\t".join(["sop.s_write", "block", "", "tool", "no writes", " (Write) "])


def registry_line(registry: dict) -> str:
    """The @mcp_registry line exactly as the sync daemon writes it."""
    return "@mcp_registry\t" + base64.b64encode(json.dumps(registry).encode("utf-8")).decode("ascii")


def allowlist_line(allowlist: dict) -> str:
    """The @mcp_allowlist line exactly as the sync daemon writes it."""
    return "@mcp_allowlist\t" + allowlist["severity"] + "\t" + ",".join(allowlist["servers"])


def snapshot_file(tmp_path, body: list[str], digest_of: list[str] | None = None) -> str:
    digest = hashlib.sha256("\n".join(body if digest_of is None else digest_of).encode("utf-8")).hexdigest()[:32]
    p = tmp_path / "policy-snapshot.rules"
    p.write_text("\n".join([f"#digest {digest}", "#workspace ws_test", *body]) + "\n", encoding="utf-8")
    return str(p)


class RecordingClient(GateClient):
    def __init__(self, verdict: GateResponse | None = None):
        super().__init__(base_url="http://127.0.0.1:9", workspace_id="ws_test", session_id="sess_mcp")
        self.events: list[tuple[str, str, str]] = []
        self.verdict = verdict or GateResponse(allowed=True)

    def emit(self, event, tool_name, reason="", tool_input=None, incident_id=None, file_path=None):
        self.events.append((event, tool_name, reason))
        return True

    def hook_gate(self, tool_name, tool_input):
        return self.verdict


def guard(monkeypatch, path: str, tool: str, client: GateClient | None = None):
    monkeypatch.setenv("INTUTIC_SNAPSHOT_RULES", path)
    gate = Gate(GateConfig(workspace_id="ws_test", use_hook_gate=client is not None, use_sop_rules=False), client)
    try:
        gate.guard(tool, {})
    except IntuticGateRefusal as refusal:
        return refusal
    return None


def expect_case(refusal, case: dict) -> None:
    if case["code"] is None:
        assert refusal is None, refusal and refusal.reason
    else:
        assert refusal is not None and refusal.code == case["code"]
        assert refusal.reason == f"{case['reason']} [{case['ruleId']}]"


def test_vectors_cover_every_code() -> None:
    assert {c["code"] for c in CASES} == {None, "SERVER_BLOCKED", "SERVER_HELD", "SERVER_NOT_APPROVED", "TOOL_DISABLED"}
    assert {c["code"] for c in ALLOWLIST_CASES} == {None, "SERVER_NOT_ALLOWED"}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_registry_evaluator_reaches_the_vector(case: dict) -> None:
    server, tool = mcp_registry.split_mcp_tool_name(case["toolName"])
    d = mcp_registry.evaluate_registry(mcp_registry.parse_registry(VECTORS["registries"][case["registry"]]), server, tool)
    assert (d or (None, None, None)) == (case["code"], case["ruleId"], case["reason"])


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_gate_over_a_registry_snapshot_reaches_the_vector(case: dict, tmp_path, monkeypatch) -> None:
    path = snapshot_file(tmp_path, [registry_line(VECTORS["registries"][case["registry"]]), WRITE_RULE])
    expect_case(guard(monkeypatch, path, case["toolName"]), case)


@pytest.mark.parametrize("case", ALLOWLIST_CASES, ids=[c["name"] for c in ALLOWLIST_CASES])
def test_allowlist_evaluator_reaches_the_vector(case: dict) -> None:
    server, _ = mcp_registry.split_mcp_tool_name(case["toolName"])
    d = mcp_registry.evaluate_allowlist(VECTORS["allowlists"][case["allowlist"]], server)
    assert (d or (None, None, None)) == (case["code"], case["ruleId"], case["reason"])


@pytest.mark.parametrize("case", ALLOWLIST_CASES, ids=[c["name"] for c in ALLOWLIST_CASES])
def test_gate_over_an_allowlist_snapshot_reaches_the_vector(case: dict, tmp_path, monkeypatch) -> None:
    path = snapshot_file(tmp_path, [allowlist_line(VECTORS["allowlists"][case["allowlist"]]), WRITE_RULE])
    expect_case(guard(monkeypatch, path, case["toolName"]), case)


class TestRecords:
    def test_split_takes_the_server_before_the_first_double_underscore(self) -> None:
        assert mcp_registry.split_mcp_tool_name("mcp__pg-prod__drop__all") == ("pg-prod", "drop__all")
        assert mcp_registry.split_mcp_tool_name("mcp____x") is None
        assert mcp_registry.split_mcp_tool_name("Bash") is None

    def test_a_damaged_record_is_none(self) -> None:
        assert mcp_registry.decode_registry_record("@mcp_registry\tnot-base64!") is None
        assert mcp_registry.decode_registry_record("@sso_groups\te30=") is None
        assert mcp_registry.decode_allowlist_record("@mcp_allowlist\tblock") is None

    def test_an_unknown_allowlist_severity_reads_as_block(self) -> None:
        assert mcp_registry.decode_allowlist_record("@mcp_allowlist\tSHADOW\tgithub") == {"severity": "block", "servers": ["github"]}

    def test_a_non_mcp_tool_is_left_alone(self, tmp_path, monkeypatch) -> None:
        path = snapshot_file(tmp_path, [registry_line(VECTORS["registries"]["denyNothingApproved"]), WRITE_RULE])
        assert guard(monkeypatch, path, "Read") is None


class TestEditedSnapshot:
    DENY = VECTORS["registries"]["deny"]

    def test_an_approval_added_by_hand_clears_nothing(self, tmp_path, monkeypatch) -> None:
        edited = dict(self.DENY, approvedServers=[*self.DENY["approvedServers"], "newcomer"])
        path = snapshot_file(tmp_path, [registry_line(edited), WRITE_RULE], digest_of=[registry_line(self.DENY), WRITE_RULE])
        assert snap.load_snapshot("ws_test", path).state == "invalid"
        assert guard(monkeypatch, path, "mcp__newcomer__query").code == "SERVER_NOT_APPROVED"
        assert guard(monkeypatch, path, "mcp__github__create_issue").code == "SERVER_NOT_APPROVED"
        assert guard(monkeypatch, path, "mcp__pastebin__paste").code == "SERVER_BLOCKED"
        assert guard(monkeypatch, path, "Write") is None

    def test_a_server_added_to_the_allowlist_by_hand_admits_nothing(self, tmp_path, monkeypatch) -> None:
        original = [allowlist_line({"severity": "block", "servers": ["github"]}), WRITE_RULE]
        path = snapshot_file(tmp_path, [allowlist_line({"severity": "block", "servers": ["github", "newcomer"]}), WRITE_RULE], digest_of=original)
        assert guard(monkeypatch, path, "mcp__newcomer__query").code == "SERVER_NOT_ALLOWED"
        assert guard(monkeypatch, path, "mcp__github__create_issue").code == "SERVER_NOT_ALLOWED"
        assert guard(monkeypatch, path, "Write") is None

    def test_block_edited_to_shadow_still_refuses(self, tmp_path, monkeypatch) -> None:
        original = [allowlist_line({"severity": "block", "servers": ["github"]}), WRITE_RULE]
        path = snapshot_file(tmp_path, [allowlist_line({"severity": "shadow", "servers": ["github"]}), WRITE_RULE], digest_of=original)
        assert guard(monkeypatch, path, "mcp__pastebin__paste").code == "SERVER_NOT_ALLOWED"


class TestReporting:
    def test_a_shadow_allowlist_records_and_allows(self, tmp_path, monkeypatch) -> None:
        client = RecordingClient()
        path = snapshot_file(tmp_path, [allowlist_line({"severity": "shadow", "servers": ["github"]}), WRITE_RULE])
        assert guard(monkeypatch, path, "mcp__pastebin__paste", client) is None
        assert (
            "tool_would_block",
            "mcp__pastebin__paste",
            'MCP server "pastebin" is not on the MCP server allowlist for this workspace [mcp_allowlist]',
        ) in client.events

    def test_an_unapproved_server_is_reported_for_the_approval_queue(self, tmp_path, monkeypatch) -> None:
        client = RecordingClient()
        path = snapshot_file(tmp_path, [registry_line(VECTORS["registries"]["denyNothingApproved"]), WRITE_RULE])
        assert guard(monkeypatch, path, "mcp__ide__getDiagnostics", client).code == "SERVER_NOT_APPROVED"
        blocked = [e for e in client.events if e[0] == "tool_blocked"]
        # hookEvents.ts queues the server from the bracketed rule id.
        assert blocked and blocked[0][1] == "mcp__ide__getDiagnostics" and blocked[0][2].endswith("[mcpDefaultPolicy]")

    def test_the_hook_gate_code_is_kept_for_the_registry_only(self, tmp_path, monkeypatch) -> None:
        path = snapshot_file(tmp_path, [WRITE_RULE])
        named = RecordingClient(GateResponse(allowed=False, reason="blocked [mcp_registry.pastebin]", code="SERVER_BLOCKED"))
        assert guard(monkeypatch, path, "mcp__pastebin__paste", named).code == "SERVER_BLOCKED"
        unnamed = RecordingClient(GateResponse(allowed=False, reason="DLP: AWS key"))
        assert guard(monkeypatch, path, "Bash", unnamed).code == "HOOK_GATE"
        other = RecordingClient(GateResponse(allowed=False, reason="x", code="SOMETHING_ELSE"))
        assert guard(monkeypatch, path, "Bash", other).code == "HOOK_GATE"
