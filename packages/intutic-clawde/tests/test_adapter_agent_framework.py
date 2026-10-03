"""Tests for the Microsoft Agent Framework adapter (`IntuticFunctionMiddleware` / `install`).

Real framework: `agent-framework-core==1.20.0` was installed live to confirm
the veto mechanism (see agent_framework.py's module doc). Every test drives a
real `agent_framework.Agent.run()` — the framework's own function-calling
loop, function-middleware pipeline, and tool invocation — never a
hand-rolled call to `process()`. The only stand-in is the model: `_StubClient`
subclasses the framework's own `BaseChatClient`, composed with
`FunctionInvocationLayer` + `ChatMiddlewareLayer` the way the shipped
provider clients are, and scripts one `shell` function call followed by a
plain-text turn. No hosted model API is called.

`pytest.importorskip` skips cleanly on a machine without the optional
dependency installed.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("agent_framework")

from agent_framework import (  # noqa: E402
    Agent,
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    Content,
    FunctionInvocationLayer,
    Message,
    MiddlewareFailure,
    tool,
)

from intutic_clawde.gate.adapters.agent_framework import (  # noqa: E402
    IntuticFunctionMiddleware,
    install,
)
from conftest import BLOCK_RULE, make_gate  # noqa: E402

BLOCKED_COMMAND = "kubectl apply -f k8s/x.yaml"
ALLOWED_COMMAND = "git status"


class _StubClient(FunctionInvocationLayer, ChatMiddlewareLayer, BaseChatClient):
    """Deterministic chat client: the first model turn requests one `shell`
    call, every later turn answers "done". Records the messages each turn
    was sent, so a test can see exactly what the model received."""

    def __init__(self, command: str, **kwargs):
        super().__init__(**kwargs)
        self._command = command
        self.turns: list = []

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        async def _respond():
            self.turns.append(list(messages))
            if len(self.turns) == 1:
                call = Content.from_function_call(
                    call_id="call_1", name="shell",
                    arguments=json.dumps({"command": self._command}))
                return ChatResponse(messages=[Message(role="assistant", contents=[call])])
            return ChatResponse(messages=[Message(role="assistant", contents=["done"])])

        return _respond()

    def function_results_seen_by_model(self) -> list:
        return [c for turn in self.turns[1:] for m in turn for c in m.contents
                if c.type == "function_result"]


def _make_shell_tool(ran: list):
    """A real agent_framework @tool named `shell`, matching conftest.BLOCK_RULE's
    `^shell$` toolPattern — same convention as every other adapter test."""

    @tool(approval_mode="never_require")
    def shell(command: str) -> str:
        """Run a shell command (recorded, not actually executed)."""
        ran.append(command)
        return f"ran: {command}"

    return shell


def _run(agent: Agent):
    return asyncio.run(agent.run("do it"))


class TestIntuticFunctionMiddleware:
    def test_blocked_call_never_runs_and_the_model_sees_the_refusal(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        client = _StubClient(BLOCKED_COMMAND)
        agent = Agent(client=client, tools=[_make_shell_tool(ran)],
                      middleware=[IntuticFunctionMiddleware(gate=g)])

        result = _run(agent)

        assert ran == []
        # The loop continued: the model got a second turn and finished.
        assert len(client.turns) == 2
        assert result.text == "done"
        seen = client.function_results_seen_by_model()
        assert len(seen) == 1
        assert str(seen[0].result).startswith("[Intutic Governance] BLOCKED:")

    def test_allowed_call_runs_the_real_tool(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        client = _StubClient(ALLOWED_COMMAND)
        agent = Agent(client=client, tools=[_make_shell_tool(ran)],
                      middleware=[IntuticFunctionMiddleware(gate=g)])

        result = _run(agent)

        assert ran == [ALLOWED_COMMAND]
        assert result.text == "done"
        assert [str(c.result) for c in client.function_results_seen_by_model()] == [
            f"ran: {ALLOWED_COMMAND}"]

    def test_install_on_an_existing_agent_gates_the_same_way(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        blocked_agent = Agent(client=_StubClient(BLOCKED_COMMAND), tools=[_make_shell_tool(ran)])
        allowed_agent = Agent(client=_StubClient(ALLOWED_COMMAND), tools=[_make_shell_tool(ran)])
        install(blocked_agent, gate=g)
        install(allowed_agent, gate=g)

        _run(blocked_agent)
        _run(allowed_agent)

        assert ran == [ALLOWED_COMMAND]

    def test_process_wide_gate_is_used_when_none_is_passed(self, tmp_path, monkeypatch):
        from intutic_clawde.gate.gate import install as install_gate

        install_gate(make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE]))
        ran: list = []
        agent = Agent(client=_StubClient(BLOCKED_COMMAND), tools=[_make_shell_tool(ran)],
                      middleware=[IntuticFunctionMiddleware()])

        _run(agent)

        assert ran == []

    def test_no_gate_configured_aborts_instead_of_running_unguarded(self):
        ran: list = []
        agent = Agent(client=_StubClient(ALLOWED_COMMAND), tools=[_make_shell_tool(ran)],
                      middleware=[IntuticFunctionMiddleware()])

        with pytest.raises(MiddlewareFailure, match="No gate configured"):
            _run(agent)
        assert ran == []

    def test_an_unexpected_gate_error_fails_closed(self, tmp_path, monkeypatch):
        """Agent Framework converts an ORDINARY middleware exception into a
        tool-error result and keeps looping; the adapter turns gate errors
        into `MiddlewareFailure`, which the framework propagates out of
        `Agent.run()` instead. Pins both halves: the run aborts AND the tool
        never runs."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        def _boom(*_a, **_kw):
            raise ValueError("boom")

        monkeypatch.setattr(g, "guard", _boom)
        ran: list = []
        client = _StubClient(ALLOWED_COMMAND)
        agent = Agent(client=client, tools=[_make_shell_tool(ran)],
                      middleware=[IntuticFunctionMiddleware(gate=g)])

        with pytest.raises(MiddlewareFailure, match="failing closed: boom") as info:
            _run(agent)
        assert isinstance(info.value.__cause__, ValueError)
        assert ran == []
        assert len(client.turns) == 1  # the model was not called again

    def test_constructing_without_agent_framework_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.agent_framework as mod
        monkeypatch.setattr(mod, "_HAS_AGENT_FRAMEWORK", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[agent-framework\]"):
            mod.IntuticFunctionMiddleware()
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[agent-framework\]"):
            mod.install(object())
