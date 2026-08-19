"""Tests for the AWS Strands Agents adapter (`IntuticHookProvider` / `install`).

Real framework: `strands-agents==1.52.0` was installed live to confirm the
veto mechanism (see strands.py's module doc) and every test here drives
Strands' OWN dispatcher — never a hand-rolled call to the adapter's internal
callback. Three layers, in increasing realism:

  * direct tool calls (`agent.tool.<name>(...)`) — Strands routes these
    through the same `ToolExecutor._stream` pipeline (hooks + middleware +
    terminal) the agent loop uses per tool_use, with no model involved
    (`strands/tools/_caller.py`);
  * a full `Agent()` event-loop run, driven by a minimal deterministic
    `Model` stand-in (Strands has no built-in `FunctionModel`-style test
    double the way pydantic-ai does, so this file supplies its own — a small
    explicit fixture emitting Bedrock-shape stream events, not a mock of
    anything inside this adapter), proving a blocked call surfaces to the
    model as an error-status toolResult and the run CONTINUES;
  * MCP: a real stdio FastMCP server (the `mcp` package is a hard dependency
    of strands-agents, so this needs no extra install and no network),
    proving MCP-materialised tools flow through the identical
    `BeforeToolCallEvent` — the per-run-rewrap gap the OpenAI-TS research
    found does not exist here because the hook attaches to the agent, not to
    tool objects.

Also covers the exception posture the adapter deliberately relies on:
Strands' dispatcher propagates a raising hook and the tool never runs
(fail-CLOSED — the opposite of CrewAI's swallow-and-allow hazard, see
crewai.py), so no-gate-configured and unexpected-gate-error both abort
rather than run unguarded.

`pytest.importorskip` skips cleanly on a machine without the optional
dependency installed.
"""

from __future__ import annotations

import json
import sys
import textwrap

import pytest

pytest.importorskip("strands")

from strands import Agent, tool  # noqa: E402
from strands.models.model import Model  # noqa: E402

from intutic_clawde.gate.adapters.strands import IntuticHookProvider, install  # noqa: E402
from conftest import BLOCK_RULE, make_gate  # noqa: E402

BLOCKED_COMMAND = "kubectl apply -f k8s/x.yaml"
ALLOWED_COMMAND = "git status"


def _make_shell_tool(ran: list):
    """A real strands @tool named `shell`, matching conftest.BLOCK_RULE's
    `^shell$` toolPattern — same convention as every other adapter test."""

    @tool
    def shell(command: str) -> str:
        """Run a shell command (recorded, not actually executed)."""
        ran.append(command)
        return f"ran: {command}"

    return shell


def _direct_call(agent: Agent, command: str) -> dict:
    """Drive Strands' real ToolExecutor._stream via a direct tool call."""
    return agent.tool.shell(command=command, record_direct_tool_call=False)


class TestIntuticHookProviderDirect:
    def test_blocked_call_is_cancelled_by_strands_own_executor(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        agent = Agent(tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider(gate=g)], callback_handler=None)

        result = _direct_call(agent, BLOCKED_COMMAND)

        # Strands' own cancel contract: error-status ToolResult carrying the
        # cancel message; the tool body never ran.
        assert result["status"] == "error"
        assert "[Intutic Governance] BLOCKED:" in result["content"][0]["text"]
        assert ran == []

    def test_allowed_call_runs_the_real_tool(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        agent = Agent(tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider(gate=g)], callback_handler=None)

        result = _direct_call(agent, ALLOWED_COMMAND)

        assert result["status"] == "success"
        assert ran == [ALLOWED_COMMAND]

    def test_install_on_an_existing_agent_gates_the_same_way(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        agent = Agent(tools=[_make_shell_tool(ran)], callback_handler=None)
        install(agent, gate=g)

        blocked = _direct_call(agent, BLOCKED_COMMAND)
        allowed = _direct_call(agent, ALLOWED_COMMAND)

        assert blocked["status"] == "error"
        assert allowed["status"] == "success"
        assert ran == [ALLOWED_COMMAND]

    def test_no_gate_configured_aborts_instead_of_running_unguarded(self, tmp_path, monkeypatch):
        # No gate= and none installed via intutic_clawde.gate.install().
        # Strands propagates the hook's RuntimeError (verified fail-closed —
        # see strands.py's module doc); the tool must never run.
        ran: list = []
        agent = Agent(tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider()], callback_handler=None)

        with pytest.raises(RuntimeError, match="No gate configured"):
            _direct_call(agent, ALLOWED_COMMAND)
        assert ran == []

    def test_an_unexpected_gate_error_also_fails_closed(self, tmp_path, monkeypatch):
        """Strands' dispatcher (unlike CrewAI's) PROPAGATES a raising hook —
        the run aborts and the tool never runs, so the adapter deliberately
        does not need crewai.py's broad catch. This test pins that posture:
        if a future strands-agents release started swallowing hook
        exceptions, `ran` would become non-empty and this would go red."""
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])

        def _boom(*_a, **_kw):
            raise ValueError("boom")

        monkeypatch.setattr(g, "guard", _boom)
        ran: list = []
        agent = Agent(tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider(gate=g)], callback_handler=None)

        with pytest.raises(ValueError, match="boom"):
            _direct_call(agent, ALLOWED_COMMAND)
        assert ran == []

    def test_constructing_without_strands_raises_clear_error(self, monkeypatch):
        import intutic_clawde.gate.adapters.strands as mod
        monkeypatch.setattr(mod, "_HAS_STRANDS", False)
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[strands\]"):
            mod.IntuticHookProvider()
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[strands\]"):
            mod.install(object())


class _ScriptedModel(Model):
    """Deterministic Strands `Model`: first call emits one `shell` tool_use,
    every later call ends the turn. Emits the same Bedrock-shape stream
    events a real provider does, so the REAL event loop, tool executor, and
    hook registry all run unmodified."""

    def __init__(self, command: str):
        self._command = command
        self.calls = 0

    def update_config(self, **model_config):  # pragma: no cover - interface stub
        pass

    def get_config(self):  # pragma: no cover - interface stub
        return {}

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError  # pragma: no cover - never called here
        yield  # pragma: no cover

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            yield {"contentBlockStart": {
                "start": {"toolUse": {"toolUseId": "t1", "name": "shell"}}}}
            yield {"contentBlockDelta": {
                "delta": {"toolUse": {"input": json.dumps({"command": self._command})}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": "done"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


class TestFullAgentLoop:
    def test_blocked_call_surfaces_as_error_tool_result_and_the_run_continues(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        agent = Agent(model=_ScriptedModel(BLOCKED_COMMAND),
                      tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider(gate=g)], callback_handler=None)

        result = agent("deploy it")

        assert result.stop_reason == "end_turn"  # the run continued past the block
        assert ran == []
        tool_results = [
            c["toolResult"]
            for m in agent.messages if m["role"] == "user"
            for c in m["content"] if "toolResult" in c
        ]
        assert len(tool_results) == 1
        assert tool_results[0]["status"] == "error"
        assert "[Intutic Governance] BLOCKED:" in tool_results[0]["content"][0]["text"]

    def test_allowed_call_runs_for_real_through_the_full_loop(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        agent = Agent(model=_ScriptedModel(ALLOWED_COMMAND),
                      tools=[_make_shell_tool(ran)],
                      hooks=[IntuticHookProvider(gate=g)], callback_handler=None)

        result = agent("status please")

        assert result.stop_reason == "end_turn"
        assert ran == [ALLOWED_COMMAND]


#: A minimal FastMCP stdio server exposing a `shell` tool, run as a child
#: python process — no network, no extra dependency (`mcp` is a hard
#: dependency of strands-agents itself).
_MCP_SERVER = textwrap.dedent("""
    from mcp.server.fastmcp import FastMCP
    mcp = FastMCP("intutic-test")

    @mcp.tool()
    def shell(command: str) -> str:
        "Run a shell command (fake)."
        return f"ran: {command}"

    mcp.run(transport="stdio")
""")


class TestMcpTools:
    def test_mcp_materialised_tools_flow_through_the_same_gate(self, tmp_path, monkeypatch):
        from mcp import StdioServerParameters, stdio_client
        from strands.tools.mcp import MCPClient

        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        client = MCPClient(lambda: stdio_client(
            StdioServerParameters(command=sys.executable, args=["-c", _MCP_SERVER])))

        with client:
            tools = client.list_tools_sync()
            assert [t.tool_name for t in tools] == ["shell"]
            agent = Agent(tools=tools, hooks=[IntuticHookProvider(gate=g)],
                          callback_handler=None)

            blocked = _direct_call(agent, BLOCKED_COMMAND)
            allowed = _direct_call(agent, ALLOWED_COMMAND)

        assert blocked["status"] == "error"
        assert "[Intutic Governance] BLOCKED:" in blocked["content"][0]["text"]
        assert allowed["status"] == "success"
        # The real MCP round trip happened for the allowed call only.
        assert "ran: git status" in str(allowed["content"])
