"""Tests for the AWS Strands Agents adapter (`IntuticHookProvider` / `install`).

Real framework: `strands-agents==1.52.0` was installed live to confirm the
veto mechanism (see strands.py's module doc; the floor is now 1.57.2) and
every test here drives Strands' OWN dispatcher — never a hand-rolled call to
the adapter's internal callback. Three layers, in increasing realism:

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

Plus the two surfaces beyond a single `Agent`: a `strands.bidi.BidiAgent`
(TD-422 — same `BeforeToolCallEvent`, driven offline through a fake
`BidiModel` that never connects), and real `GraphBuilder`/`Swarm`
orchestrators gated through `install_multiagent()` (TD-423), driven by
`_ScriptedModel`.

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

from intutic_clawde.gate.adapters.strands import (  # noqa: E402
    IntuticHookProvider,
    install,
    install_multiagent,
)
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
        with pytest.raises(RuntimeError, match=r"pip install intutic-clawde\[strands\]"):
            mod.install_multiagent(object())


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


# --------------------------------------------------------------------------
# TD-422: strands.bidi.BidiAgent
# --------------------------------------------------------------------------


def _offline_bidi_model():
    """A `BidiModel` that never opens a connection. Direct tool calls never
    touch the model, so every connection method fails loudly if reached —
    proving the test needs no network and no Bedrock."""
    from strands.bidi.models import BidiModel

    class _OfflineBidiModel(BidiModel):
        def __init__(self):
            self._config = {"model_id": "offline-test"}

        def update_config(self, **model_config):  # pragma: no cover - interface stub
            self._config.update(model_config)

        def get_config(self):
            return self._config

        async def start(self, system_prompt=None, tools=None, messages=None, **kwargs):
            raise AssertionError("offline test model must not connect")  # pragma: no cover

        async def stop(self):  # pragma: no cover - interface stub
            pass

        def receive(self):
            raise AssertionError("offline test model must not receive")  # pragma: no cover

        async def send(self, content):
            raise AssertionError("offline test model must not send")  # pragma: no cover

    return _OfflineBidiModel()


class TestBidiAgent:
    """Since strands-agents 1.55.0 the shared ToolExecutor fires the stable
    BeforeToolCallEvent for BidiAgent too, so the same provider gates it."""

    def _bidi_agent(self, ran, **kwargs):
        from strands.bidi import BidiAgent

        return BidiAgent(model=_offline_bidi_model(), tools=[_make_shell_tool(ran)], **kwargs)

    def test_blocked_call_is_cancelled_and_allowed_call_runs(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        bidi_agent = self._bidi_agent(ran, hooks=[IntuticHookProvider(gate=g)])

        blocked = bidi_agent.tool.shell(command=BLOCKED_COMMAND, record_direct_tool_call=False)
        allowed = bidi_agent.tool.shell(command=ALLOWED_COMMAND, record_direct_tool_call=False)

        assert blocked["status"] == "error"
        assert "[Intutic Governance] BLOCKED:" in blocked["content"][0]["text"]
        assert allowed["status"] == "success"
        assert ran == [ALLOWED_COMMAND]  # the blocked body never ran

    def test_install_on_an_existing_bidi_agent_gates_the_same_way(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        bidi_agent = self._bidi_agent(ran)
        install(bidi_agent, gate=g)

        blocked = bidi_agent.tool.shell(command=BLOCKED_COMMAND, record_direct_tool_call=False)

        assert blocked["status"] == "error"
        assert ran == []


# --------------------------------------------------------------------------
# TD-423: install_multiagent() over real Graph / Swarm orchestrators
# --------------------------------------------------------------------------


def _node_agent(name: str, command: str, ran: list, **kwargs) -> Agent:
    return Agent(name=name, model=_ScriptedModel(command), tools=[_make_shell_tool(ran)],
                 callback_handler=None, **kwargs)


def _tool_results(agent: Agent) -> list:
    return [
        c["toolResult"]
        for m in agent.messages if m["role"] == "user"
        for c in m["content"] if "toolResult" in c
    ]


def _graph(*edges_and_nodes):
    """Builds a real Graph. Args: (node_id, executor) pairs, then
    ("->", from_id, to_id) edges."""
    from strands.multiagent import GraphBuilder

    builder = GraphBuilder()
    for item in edges_and_nodes:
        if item[0] == "->":
            builder.add_edge(item[1], item[2])
        else:
            builder.add_node(item[1], item[0])
    return builder.build()


class _RemoteAgentStub:
    """Stands in for a remote (A2A-style) `AgentBase`: satisfies Strands'
    runtime-checkable protocol, but its tools would run elsewhere."""

    async def invoke_async(self, prompt=None, **kwargs):  # pragma: no cover - never run
        raise AssertionError("must not run")

    def __call__(self, prompt=None, **kwargs):  # pragma: no cover - never run
        raise AssertionError("must not run")

    async def stream_async(self, prompt=None, **kwargs):  # pragma: no cover - never run
        raise AssertionError("must not run")
        yield


class TestInstallMultiagentGraph:
    def test_every_node_is_gated(self, tmp_path, monkeypatch):
        from strands.multiagent import Status

        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran_a: list = []
        ran_b: list = []
        a = _node_agent("a", ALLOWED_COMMAND, ran_a)
        b = _node_agent("b", BLOCKED_COMMAND, ran_b)
        graph = _graph(("a", a), ("b", b), ("->", "a", "b"))

        installed = install_multiagent(graph, gate=g)
        result = graph("deploy")

        assert len(installed) == 2
        assert result.status == Status.COMPLETED
        assert ran_a == [ALLOWED_COMMAND]
        assert ran_b == []  # b's blocked call was vetoed by its own gate
        assert "[Intutic Governance] BLOCKED:" in _tool_results(b)[0]["content"][0]["text"]

    def test_nested_graph_is_covered(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran_inner: list = []
        ran_outer: list = []
        inner_agent = _node_agent("inner", BLOCKED_COMMAND, ran_inner)
        inner = _graph(("inner", inner_agent))
        outer = _graph(("first", _node_agent("first", ALLOWED_COMMAND, ran_outer)),
                       ("nested", inner), ("->", "first", "nested"))

        installed = install_multiagent(outer, gate=g)
        outer("deploy")

        assert len(installed) == 2
        assert ran_outer == [ALLOWED_COMMAND]
        assert ran_inner == []
        assert _tool_results(inner_agent)[0]["status"] == "error"

    def test_an_ungated_node_is_cancelled_before_it_runs(self, tmp_path, monkeypatch):
        from strands.multiagent import Status

        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        graph = _graph(("a", _node_agent("a", ALLOWED_COMMAND, ran)),
                       ("b", _node_agent("b", ALLOWED_COMMAND, ran)), ("->", "a", "b"))
        install_multiagent(graph, gate=g)
        # A node replaced after install_multiagent() carries no gate.
        late = _node_agent("late", ALLOWED_COMMAND, ran)
        graph.nodes["b"].executor = late

        # Strands' Graph fails a cancelled node and stops (fail-fast).
        with pytest.raises(RuntimeError, match=r"\[Intutic Governance\] BLOCKED: multi-agent node 'b'"):
            graph("go")

        assert graph.state.status == Status.FAILED
        assert ran == [ALLOWED_COMMAND]  # only gated node a ran
        assert late.model.calls == 0  # the ungated agent never even reached its model

    def test_second_call_is_idempotent_and_honours_preexisting_providers(
        self, tmp_path, monkeypatch
    ):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        guarded: list = []
        real_guard = g.guard
        monkeypatch.setattr(g, "guard", lambda name, args: (guarded.append(name), real_guard(name, args)))
        ran: list = []
        pre = _node_agent("pre", ALLOWED_COMMAND, ran, hooks=[IntuticHookProvider(gate=g)])
        fresh = _node_agent("fresh", ALLOWED_COMMAND, ran)
        graph = _graph(("pre", pre), ("fresh", fresh))

        first = install_multiagent(graph, gate=g)
        second = install_multiagent(graph, gate=g)
        _direct_call(pre, ALLOWED_COMMAND)
        _direct_call(fresh, ALLOWED_COMMAND)

        assert len(first) == 1  # only `fresh`; `pre` already carried a provider
        assert second == []
        assert guarded == ["shell", "shell"]  # one gate check per call, never doubled

    def test_an_executor_it_cannot_gate_raises_and_installs_nothing(self, tmp_path, monkeypatch):
        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        local = _node_agent("local", BLOCKED_COMMAND, ran)
        graph = _graph(("local", local), ("remote", _RemoteAgentStub()))

        with pytest.raises(TypeError, match=r"nodes\['remote'\].*_RemoteAgentStub.*cannot govern"):
            install_multiagent(graph, gate=g)

        # Validation happens before any mutation: `local` was left ungated.
        _direct_call(local, BLOCKED_COMMAND)
        assert ran == [BLOCKED_COMMAND]

    def test_a_non_orchestrator_is_rejected(self):
        with pytest.raises(TypeError, match="not a strands Graph/Swarm"):
            install_multiagent(object())


class TestInstallMultiagentSwarm:
    def test_every_node_is_gated(self, tmp_path, monkeypatch):
        from strands.multiagent import Swarm

        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        entry = _node_agent("entry", BLOCKED_COMMAND, ran)
        other = _node_agent("other", BLOCKED_COMMAND, ran)
        swarm = Swarm([entry, other])

        installed = install_multiagent(swarm, gate=g)
        swarm("deploy")
        blocked_other = _direct_call(other, BLOCKED_COMMAND)

        assert len(installed) == 2
        assert ran == []
        assert _tool_results(entry)[0]["status"] == "error"
        assert blocked_other["status"] == "error"

    def test_an_ungated_node_is_cancelled_before_it_runs(self, tmp_path, monkeypatch):
        from strands.multiagent import Status, Swarm

        g = make_gate(tmp_path, monkeypatch, rules=[BLOCK_RULE])
        ran: list = []
        swarm = Swarm([_node_agent("entry", ALLOWED_COMMAND, ran)])
        install_multiagent(swarm, gate=g)
        late = _node_agent("late", ALLOWED_COMMAND, ran)
        swarm.nodes["entry"].executor = late

        result = swarm("go")

        assert result.status == Status.FAILED
        assert ran == []
        assert late.model.calls == 0
