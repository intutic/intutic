"""Tests for the framework layer: @guard, guard_tools, intutic_headers.

The contract under test: on deny, IntuticGateRefusal is raised BEFORE the tool
body runs and the deny has been reported via hook-events; on allow, the body
runs and its return value passes through; on a hook-gate transport failure the
client's fail_closed setting decides, defaulting to closed.

All HTTP goes through a recording stub transport — no server, no network.
"""

from __future__ import annotations

import json

import pytest

from intutic_clawde.gate import framework, gate as gate_mod, soprules
from intutic_clawde.gate.client import GateClient
from intutic_clawde.gate.gate import Gate, GateConfig, IntuticGateRefusal, install
from intutic_clawde.gate import snapshot as snapshot_mod

_REGISTRY = "us-central1-docker.pkg.dev/intutic/intutic"
_IMAGE = f"{_REGISTRY}/sockshop/catalogue"
_DIGEST = "sha256:" + "a" * 64

BLOCK_RULE = {
    "id": "sp_pin",
    "toolPattern": "^shell$",
    "argPattern": r"kubectl\s+apply(?!.*@sha256:)",
    "action": "block",
    "reason": "deploy must reference a digest-pinned image",
}

_EMPTY_SNAPSHOT = snapshot_mod.Snapshot(rules=[], state="ok", workspace_id="ws_1")


class StubTransport:
    """Recording transport. Each queued behaviour is either a (status, body)
    tuple or an exception instance to raise; the default is 200/{}."""

    def __init__(self, gate_response=None, fail=False):
        self.calls = []          # (path, body)
        self.gate_response = gate_response or {"allowed": True}
        self.fail = fail         # raise on /hook-gate to model a dead network

    def __call__(self, url, body, headers, timeout):
        path = "/" + url.split("/", 3)[3]
        self.calls.append((path, body))
        if path.endswith("/hook-gate"):
            if self.fail:
                raise ConnectionError("connection refused")
            return 200, self.gate_response
        return 200, {}

    def posts_to(self, suffix):
        return [(p, b) for p, b in self.calls if p.endswith(suffix)]


def make_gate(tmp_path, monkeypatch, *, rules=(), transport=None,
              use_hook_gate=False, fail_closed=True):
    pol = tmp_path / ".intutic"
    pol.mkdir(exist_ok=True)
    (pol / "image-allowlist.json").write_text(json.dumps({
        "version": 1,
        "require_digest": True,
        "registries_allowed": [_REGISTRY],
        "images": {_IMAGE: {"approved_digests": [_DIGEST]}},
    }))
    client = None
    if transport is not None:
        client = GateClient(base_url="http://cp.test", api_key="k",
                            workspace_id="ws_1", session_id="s_1",
                            fail_closed=fail_closed, transport=transport)
    cfg = GateConfig(repo_root=str(tmp_path), workspace_id="ws_1",
                     use_hook_gate=use_hook_gate)
    g = Gate(cfg, client=client)
    g._sop_rules = soprules.parse_rules({"rules": list(rules)})
    monkeypatch.setattr(gate_mod.snapshot, "load_snapshot",
                        lambda _ws: _EMPTY_SNAPSHOT)
    return g


@pytest.fixture(autouse=True)
def _no_installed_gate():
    """Each test decides its own gate; none leaks between tests."""
    yield
    install(None)  # type: ignore[arg-type]


class TestGuardDecorator:
    def test_deny_raises_before_the_body_runs(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran = []

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            ran.append(command)
            return "ran"

        with pytest.raises(IntuticGateRefusal) as e:
            shell(command="kubectl apply -f k8s/x.yaml")
        assert ran == []                      # body never executed
        assert e.value.code == "SOP_RULE"
        assert str(e.value).startswith("[Intutic Governance] BLOCKED:")

    def test_allow_runs_and_returns(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch)

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return f"ran: {command}"

        assert shell(command="git status") == "ran: git status"

    def test_positional_args_render_like_kwargs(self, tmp_path, monkeypatch):
        """An argPattern must not be dodgeable by calling convention."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(IntuticGateRefusal):
            shell("kubectl apply -f k8s/x.yaml")

    def test_bare_decorator_uses_function_name(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        install(g)

        @framework.guard
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(IntuticGateRefusal):
            shell(command="kubectl apply -f k8s/x.yaml")
        # tool name resolved from __name__, so the ^shell$ rule matched
        assert shell(command="ls -la") == "ran"

    def test_no_gate_configured_refuses_to_run_unguarded(self):
        @framework.guard
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(RuntimeError, match="No gate configured"):
            shell(command="ls")

    def test_deny_is_reported_via_hook_events(self, tmp_path, monkeypatch):
        t = StubTransport()
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE], transport=t)

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(IntuticGateRefusal):
            shell(command="kubectl apply -f k8s/x.yaml")
        events = [b["events"][0] for _, b in t.posts_to("/hook-events")]
        blocked = [e for e in events if e["event"] == "tool_blocked"]
        assert blocked and blocked[0]["toolName"] == "shell"
        assert blocked[0]["harnessType"] == "langgraph"
        assert "digest-pinned" in blocked[0]["reason"]

    def test_fail_closed_transport_error_raises(self, tmp_path, monkeypatch):
        t = StubTransport(fail=True)
        g = make_gate(tmp_path, monkeypatch, transport=t,
                      use_hook_gate=True, fail_closed=True)

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(IntuticGateRefusal) as e:
            shell(command="git status")
        assert e.value.code == "HOOK_GATE"
        assert "failing closed" in e.value.reason

    def test_fail_open_transport_error_allows(self, tmp_path, monkeypatch):
        t = StubTransport(fail=True)
        g = make_gate(tmp_path, monkeypatch, transport=t,
                      use_hook_gate=True, fail_closed=False)

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return "ran"

        assert shell(command="git status") == "ran"

    def test_hook_gate_deny_carries_incident_id(self, tmp_path, monkeypatch):
        t = StubTransport(gate_response={"allowed": False, "reason": "DLP match",
                                         "incidentId": "inc_42"})
        g = make_gate(tmp_path, monkeypatch, transport=t, use_hook_gate=True)

        @framework.guard(name="shell", gate=g)
        def shell(command: str) -> str:
            return "ran"

        with pytest.raises(IntuticGateRefusal) as e:
            shell(command="git status")
        assert e.value.code == "HOOK_GATE" and e.value.incident_id == "inc_42"


class FakeStructuredTool:
    """Duck-type of a LangChain StructuredTool: .name + .func."""

    def __init__(self, name, func):
        self.name = name
        self.func = func


class FakeBaseTool:
    """Duck-type of a LangChain BaseTool subclass: .name + ._run."""

    name = "shell"

    def __init__(self):
        self.ran = []

    def _run(self, command: str) -> str:
        self.ran.append(command)
        return "ran"


class TestGuardTools:
    def test_wraps_structured_tool_func(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran = []

        def run(command: str) -> str:
            ran.append(command)
            return "ran"

        tool = FakeStructuredTool("shell", run)
        [wrapped] = framework.guard_tools([tool], gate=g)
        assert wrapped is tool                       # mutated in place
        with pytest.raises(IntuticGateRefusal):
            tool.func(command="kubectl apply -f k8s/x.yaml")
        assert ran == []
        assert tool.func(command="ls -la") == "ran"

    def test_wraps_base_tool_run(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        tool = FakeBaseTool()
        framework.guard_tools([tool], gate=g)
        with pytest.raises(IntuticGateRefusal):
            tool._run(command="kubectl apply -f k8s/x.yaml")
        assert tool.ran == []
        assert tool._run(command="make test") == "ran"

    def test_wraps_plain_callable(self, tmp_path, monkeypatch):
        """The CrewAI/AutoGen path: a tool is just a callable."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        def shell(command: str) -> str:
            return "ran"

        [wrapped] = framework.guard_tools([shell], gate=g)
        with pytest.raises(IntuticGateRefusal):
            wrapped(command="kubectl apply -f k8s/x.yaml")
        assert wrapped(command="ls") == "ran"

    def test_double_wrap_is_idempotent(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch)
        tool = FakeStructuredTool("shell", lambda command: "ran")
        framework.guard_tools([tool], gate=g)
        once = tool.func
        framework.guard_tools([tool], gate=g)
        assert tool.func is once

    def test_rejects_a_non_tool(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch)
        with pytest.raises(TypeError):
            framework.guard_tools([object()], gate=g)


class TestIntuticHeaders:
    def test_default_harness_is_langgraph(self):
        h = framework.intutic_headers(session_id="s_1", workspace_id="ws_1")
        assert h == {"x-intutic-harness": "langgraph",
                     "x-session-id": "s_1",
                     "x-workspace-id": "ws_1"}

    def test_harness_override(self):
        assert framework.intutic_headers(session_id="s")["x-intutic-harness"] == "langgraph"
        assert framework.intutic_headers(session_id="s", harness="crewai")[
            "x-intutic-harness"] == "crewai"

    def test_env_fallback(self, monkeypatch):
        monkeypatch.setenv("INTUTIC_SESSION_ID", "s_env")
        monkeypatch.setenv("INTUTIC_WORKSPACE_ID", "ws_env")
        h = framework.intutic_headers()
        assert h["x-session-id"] == "s_env" and h["x-workspace-id"] == "ws_env"

    def test_omits_what_it_does_not_know(self, monkeypatch):
        monkeypatch.delenv("INTUTIC_SESSION_ID", raising=False)
        monkeypatch.delenv("INTUTIC_WORKSPACE_ID", raising=False)
        assert framework.intutic_headers() == {"x-intutic-harness": "langgraph"}
